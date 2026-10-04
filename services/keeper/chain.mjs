import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, encodeFunctionData,
  decodeFunctionData, decodeFunctionResult, parseAbi, serializeTransaction } from 'viem';
import { recheckPublicDependencies, verifyCreated } from '../../contracts/scripts/preflight-hybrid.mjs';
import { requireCondition } from './streams.mjs';

const ROOT = new URL('../../', import.meta.url);
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const readJSON = async path => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'));

export async function createChainAccess() {
  const text = await readFile(new URL('contracts/deployment/hybrid-mainnet.json', ROOT), 'utf8'); const config = JSON.parse(text);
  const release = await readJSON('contracts/deployment/mainnet-addresses.json');
  requireCondition(release.schemaVersion === 1 && release.configHash === keccak256(toHex(text)) && release.contracts.length === 4, 'KEEPER_RELEASE');
  const clients = {}, readers = {}, abis = {};
  for (const key of ['base', 'horizen']) {
    const profile = config.chains[key]; const id = key === 'base' ? 8453 : 26514;
    requireCondition(profile.chainId === id, 'KEEPER_CHAIN');
    const chain = defineChain({ id, name: key, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [profile.rpcUrl] } } });
    clients[key] = createPublicClient({ chain, transport: http(profile.rpcUrl, { timeout: 12000, retryCount: 1, batch: { batchSize: 10, wait: 20 } }) });
    readers[key] = key === 'base' ? createPublicClient({ chain, transport: http('https://mainnet.base.org', { timeout: 12000, retryCount: 1 }) }) : clients[key];
  }
  for (const contract of release.contracts) abis[contract.name] = await readJSON(`contracts/abi/${contract.name}.json`);
  async function verify() {
    await recheckPublicDependencies(config);
    for (const contract of release.contracts) {
      const client = clients[contract.chain]; const block = await client.getBlock();
      requireCondition(await client.getChainId() === contract.chainId && Math.abs(Date.now() / 1000 - Number(block.timestamp)) <= 90, 'KEEPER_CHAIN_CLOCK');
      const code = await client.getCode({ address: contract.address, blockNumber: block.number });
      requireCondition(code && keccak256(code) === contract.runtimeCodeHash, 'KEEPER_CODE');
      await verifyCreated(client, { ...contract, predictedAddress: contract.address }, release, config, block.number);
      requireCondition(same((await client.getBlock({ blockNumber: block.number })).hash, block.hash), 'KEEPER_REORG');
    }
  }
  const contract = name => {
    const c = release.contracts.find(c => c.name === name); requireCondition(c, 'KEEPER_CONTRACT'); return c;
  };
  async function read(name, functionName, args = [], blockNumber) {
    const c = contract(name);
    return clients[c.chain].readContract({ address: c.address, abi: abis[name], functionName, args, blockNumber });
  }
  function call(name, functionName, args) {
    const c = contract(name);
    const allowed = name === 'BaseStreamsPublisher' ? ['publishBoundary', 'resendBoundary']
      : name === 'StreamsRoundRegistry' ? ['createRound', 'recordOpening', 'resolveRound', 'voidRound'] : [];
    requireCondition(allowed.includes(functionName), 'KEEPER_CALL');
    return { chain: c.chain, chainId: c.chainId, to: c.address, value: 0n, data: encodeFunctionData({ abi: abis[name], functionName, args }) };
  }
  async function authenticateReport(feed, boundary, payload) {
    const c = contract('ChainlinkStreamsBoundaryOracle'); const abi = abis[c.name];
    const data = encodeFunctionData({ abi, functionName: 'verifyBoundary', args: [feed, BigInt(boundary), BigInt(boundary + config.rules.observationWindow), payload] });
    const result = await clients.base.call({ to: c.address, data });
    return decodeFunctionResult({ abi, functionName: 'verifyBoundary', data: result.data });
  }
  return { config, release, clients, readers, abis, verify, read, call, authenticateReport };
}

export function validateReceipt(receipt, tx, block, head, record) {
  const t = record.transaction;
  requireCondition(['success', 'reverted'].includes(receipt.status) && same(receipt.transactionHash, record.hash), 'KEEPER_TX_FAILED');
  requireCondition(receipt.blockHash && receipt.blockHash !== ZERO_HASH && same(receipt.blockHash, block.hash)
    && same(tx.blockHash, block.hash) && tx.blockNumber === receipt.blockNumber && block.number === receipt.blockNumber
    && head >= block.number + 2n, 'KEEPER_TX_CANONICAL');
  requireCondition(same(tx.hash, record.hash) && same(tx.from, record.from) && same(tx.to, t.to)
    && tx.nonce === t.nonce && tx.chainId === t.chainId && tx.type === 'eip1559' && tx.value === 0n
    && same(tx.input, t.data) && tx.gas === BigInt(t.gas) && tx.maxFeePerGas === BigInt(t.maxFeePerGas)
    && tx.maxPriorityFeePerGas === BigInt(t.maxPriorityFeePerGas), 'KEEPER_TX_MISMATCH');
}

export async function confirmTransaction(reader, record) {
  await reader.waitForTransactionReceipt({ hash: record.hash, confirmations: 3, timeout: 120000, pollingInterval: 2000 });
  const deadline = Date.now() + 30000;
  do {
    const receipt = await reader.getTransactionReceipt({ hash: record.hash });
    const [tx, block, head] = await Promise.all([reader.getTransaction({ hash: record.hash }), reader.getBlock({ blockNumber: receipt.blockNumber }), reader.getBlockNumber({ cacheTime: 0 })]);
    if (receipt.blockHash && receipt.blockHash !== ZERO_HASH && head >= receipt.blockNumber + 2n) {
      validateReceipt(receipt, tx, block, head, record);
      return { status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, timestamp: block.timestamp.toString() };
    }
    await new Promise(ok => setTimeout(ok, 2000));
  } while (Date.now() < deadline);
  throw new Error('KEEPER_TX_UNCONFIRMED');
}

export async function feeBound(client, transaction) {
  const bytes = serializeTransaction(transaction, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
  const l1 = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']), functionName: 'getL1FeeUpperBound', args: [BigInt((bytes.length - 2) / 2)] });
  const operator = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getOperatorFee(uint256) view returns (uint256)']), functionName: 'getOperatorFee', args: [transaction.gas] });
  return transaction.gas * transaction.maxFeePerGas + 2n * (l1 + operator);
}

export async function sendOnce(access, journal, account, call, key, budgets, deadline) {
  requireCondition(call.value === 0n && ['base', 'horizen'].includes(call.chain), 'KEEPER_INTENT');
  requireCondition(!journal.data.transactions.some(t => t.key === key), 'KEEPER_DUPLICATE_INTENT');
  requireCondition(journal.data.transactions.every(t => ['confirmed', 'reverted'].includes(t.status)), 'KEEPER_UNCERTAIN_TX');
  const target = access.release.contracts.find(c => same(c.address, call.to) && c.chain === call.chain && c.chainId === call.chainId);
  requireCondition(target && ['BaseStreamsPublisher', 'StreamsRoundRegistry'].includes(target.name), 'KEEPER_TARGET');
  const decoded = decodeFunctionData({ abi: access.abis[target.name], data: call.data });
  const methods = target.name === 'BaseStreamsPublisher' ? ['publishBoundary', 'resendBoundary'] : ['createRound', 'recordOpening', 'resolveRound', 'voidRound'];
  requireCondition(methods.includes(decoded.functionName), 'KEEPER_CALL');
  const client = access.clients[call.chain]; const reader = access.readers[call.chain];
  await access.verify();
  const now = await client.getBlock(); requireCondition(Number(now.timestamp) <= deadline && Math.abs(Date.now() / 1000 - Number(now.timestamp)) < 60, 'KEEPER_INTENT_EXPIRED');
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'latest' });
  requireCondition(await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) === nonce, 'KEEPER_PENDING_NONCE');
  const code = await client.getCode({ address: account.address }); requireCondition(code === undefined || code === '0x', 'KEEPER_SIGNER_CODE');
  await client.call({ account: account.address, to: call.to, data: call.data, value: 0n });
  const estimated = await client.estimateGas({ account: account.address, to: call.to, data: call.data, value: 0n });
  const fees = await client.estimateFeesPerGas();
  const transaction = { type: 'eip1559', chainId: call.chainId, to: call.to, data: call.data, value: 0n, nonce,
    gas: (estimated * 125n + 99n) / 100n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  requireCondition(transaction.gas <= 2500000n && transaction.maxFeePerGas <= 1000000000n, 'KEEPER_FEE_LIMIT');
  const maximum = await feeBound(client, transaction);
  // Lifetime allowance never resets at UTC midnight or after restart. Operator must deliberately provision a new session.
  const committed = journal.data.transactions.filter(t => t.chain === call.chain).reduce((sum, t) => sum + BigInt(t.maximumFeeWei), 0n);
  requireCondition(committed + maximum <= budgets[call.chain] && await client.getBalance({ address: account.address }) >= maximum, 'KEEPER_BUDGET');
  const [latest, pending, before, destination] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'latest' }), client.getTransactionCount({ address: account.address, blockTag: 'pending' }), client.getBlock(), access.clients.horizen.getBlock()]);
  requireCondition(latest === nonce && pending === nonce && Number(before.timestamp) <= deadline
    && Number(destination.timestamp) <= deadline, 'KEEPER_SIGNER_CHANGED');
  const signed = await account.signTransaction(transaction);
  const record = { key, chain: call.chain, from: account.address, hash: keccak256(signed), transaction,
    maximumFeeWei: maximum.toString(), status: 'signed', preparedAt: new Date().toISOString() };
  journal.data.transactions.push(record); await journal.save();
  // fsync/signing may stall past a boundary. Recheck AFTER the deterministic
  // hash is durable and BEFORE the sole send; an aborted signed hash stays in
  // the journal for inspection and is never discarded or automatically resent.
  const [baseHead, horizenHead, sendLatest, sendPending, sendCode] = await Promise.all([
    access.clients.base.getBlock(), access.clients.horizen.getBlock(),
    client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    client.getCode({ address: account.address }),
  ]);
  for (const block of [baseHead, horizenHead]) {
    const timestamp = Number(block.timestamp);
    requireCondition(Number.isSafeInteger(timestamp) && timestamp > 0
      && Math.abs(Date.now() / 1000 - timestamp) < 60, 'KEEPER_PRESEND_CLOCK');
    requireCondition(timestamp <= deadline, 'KEEPER_PRESEND_EXPIRED');
  }
  requireCondition(sendLatest === nonce && sendPending === nonce
    && (sendCode === undefined || sendCode === '0x'), 'KEEPER_PRESEND_SIGNER_CHANGED');
  const wallet = createWalletClient({ chain: client.chain, transport: http(access.config.chains[call.chain].rpcUrl, { timeout: 15000, retryCount: 0 }) });
  // No submission retry/replacement. On uncertainty the persisted hash is inspected at the next startup.
  requireCondition(same(await wallet.sendRawTransaction({ serializedTransaction: signed }), record.hash), 'KEEPER_SUBMITTED_HASH');
  record.status = 'submitted'; await journal.save();
  record.receipt = await confirmTransaction(reader, record);
  record.status = record.receipt.status === 'success' ? 'confirmed' : 'reverted'; await journal.save();
  return record;
}

export const defaultStateDirectory = fileURLToPath(new URL('../../evidence/keeper/', import.meta.url));
