/** Signing, receipt and recovery helpers shared by the deployment broadcasters, and the reviewed
 * constructors of the three route contracts. The four-contract broadcast that lived here ran once on
 * 2026-10-04 and cannot run again; the registry is broadcast by broadcast-registry.mjs.
 * Keys are read from the local ignored 0600 file, never arguments, output or artifacts.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { keccak256, getContractAddress, encodeDeployData, serializeTransaction, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const validBlockHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const demand = condition => { if (!condition) throw new Error('Preflight mismatch'); };

// Rebuild the three route constructors from the reviewed profile and CREATE predictions, independently of plan args.
export function expectedConstructors(config, plan) {
  const nonce = key => {
    const value = plan.chains[key].nonce;
    demand(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER);
    return value;
  };
  const baseNonce = nonce('base');
  const horizenNonce = nonce('horizen');
  const predicted = {
    baseAdapter: getContractAddress({ from: plan.deployer, nonce: BigInt(baseNonce) }),
    basePublisher: getContractAddress({ from: plan.deployer, nonce: BigInt(baseNonce + 1) }),
    horizenCache: getContractAddress({ from: plan.deployer, nonce: BigInt(horizenNonce) }),
  };
  const feeds = config.feeds;
  const rules = config.rules;
  demand(feeds.btcDecimals === 18 && feeds.ethDecimals === 18);
  demand(rules.observationWindow === 60 && rules.openingGrace === 150
    && rules.voidGrace === 604800 && rules.cutoffBuffer === 30 && rules.minimumGasLimit === 600000);
  const route = {
    sourceChainId: 8453n,
    destinationChainId: 26514n,
    sourceMessenger: config.dependencies.sourceMessenger.address,
    destinationMessenger: config.dependencies.destinationMessenger.address,
    sourceOracle: predicted.baseAdapter,
    publisher: predicted.basePublisher,
    destinationOracle: predicted.horizenCache,
    btcFeedId: feeds.btcFeedId,
    ethFeedId: feeds.ethFeedId,
    btcDecimals: feeds.btcDecimals,
    ethDecimals: feeds.ethDecimals,
    observationWindow: rules.observationWindow,
    minimumGasLimit: rules.minimumGasLimit,
  };
  return [
    [config.dependencies.verifier.address, feeds.btcFeedId, feeds.btcDecimals, feeds.ethFeedId, feeds.ethDecimals],
    [route],
    [route],
  ];
}

export function validateConstructorIntent(intent, artifact, expectedArgs) {
  const encoded = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: intent.constructorArgs });
  const expectedEncoded = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: expectedArgs });
  demand(eq(encoded, expectedEncoded));
  demand(eq(encoded, intent.initCode) && eq(keccak256(encoded), intent.initCodeHash));
}

export function demandFreshPlan(plan) {
  const age = Date.now() - Date.parse(plan.createdAt);
  demand(Number.isFinite(age) && age >= 0 && age <= 300000);
}

export function demandSigningAge(plan, runStartedAt, signedCount) {
  if (signedCount === 0) demandFreshPlan(plan);
  demand(Date.now() >= runStartedAt && Date.now() - runStartedAt <= 900000);
}

export function validateRecoveryCheckpoint(checkpoint, plan, planHash) {
  demand(checkpoint.schemaVersion === 1 && checkpoint.status === 'prepared');
  demand(eq(checkpoint.planHash, planHash) && eq(checkpoint.deployer, plan.deployer));
  demand(Array.isArray(checkpoint.transactions) && checkpoint.transactions.length > 0 && checkpoint.transactions.length <= plan.intents.length);
  const startedAt = Date.parse(checkpoint.startedAt);
  demand(Number.isFinite(startedAt) && startedAt >= Date.parse(plan.createdAt)
    && startedAt - Date.parse(plan.createdAt) <= 300000);
  // Signing is bounded in time. Verifying a run whose every transaction is already recorded is not.
  if (checkpoint.transactions.length < plan.intents.length) demandSigningAge(plan, startedAt, checkpoint.transactions.length);
  for (let i = 0; i < checkpoint.transactions.length; i++) {
    const entry = checkpoint.transactions[i]; const intent = plan.intents[i];
    demand(entry.name === intent.name && entry.chainId === intent.chainId && entry.nonce === intent.nonce);
    demand(eq(entry.predictedAddress, intent.predictedAddress) && eq(entry.initCodeHash, intent.initCodeHash));
    // A rehearsal learns its hash from the fork, so only its entry awaiting submission may lack one.
    demand(/^0x[0-9a-f]{64}$/i.test(entry.transactionHash)
      || (checkpoint.rehearsal === true && entry.transactionHash === undefined && entry.status === 'signed-awaiting-submission'));
    demand(['signed-awaiting-submission', 'submitted', 'confirmed'].includes(entry.status));
    // A broadcast can only leave its last recorded entry uncertain.
    demand(i === checkpoint.transactions.length - 1 || entry.status === 'confirmed');
  }
  return startedAt;
}

export function transactionFor(intent) {
  return { type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, data: intent.initCode, value: 0n,
    gas: BigInt(intent.gasLimit), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas) };
}

export async function feeUpperBound(client, intent, blockNumber) {
  const transaction = transactionFor(intent);
  const wire = serializeTransaction(transaction, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
  const l1Fee = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']), functionName: 'getL1FeeUpperBound', args: [BigInt((wire.length - 2) / 2)], blockNumber });
  const operatorFee = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getOperatorFee(uint256) view returns (uint256)']), functionName: 'getOperatorFee', args: [transaction.gas], blockNumber });
  return transaction.gas * transaction.maxFeePerGas + 2n * (l1Fee + operatorFee);
}

export async function verifyRecordedTransaction(reader, client, intent, entry) {
  // getTransactionReceipt fails closed for a pending or unknown hash; recovery never submits it again.
  const receipt = await reader.getTransactionReceipt({ hash: entry.transactionHash });
  demand(validBlockHash(receipt.blockHash));
  demand(eq(receipt.transactionHash, entry.transactionHash) && receipt.status === 'success');
  demand(eq(receipt.contractAddress, intent.predictedAddress));
  const [tx, block, head] = await Promise.all([
    reader.getTransaction({ hash: entry.transactionHash }),
    reader.getBlock({ blockNumber: receipt.blockNumber }),
    reader.getBlockNumber({ cacheTime: 0 }),
  ]);
  demand(validBlockHash(block.hash) && validBlockHash(tx.blockHash));
  demand(head >= receipt.blockNumber + 1n && block.number === receipt.blockNumber && eq(block.hash, receipt.blockHash));
  demand(eq(tx.hash, entry.transactionHash) && eq(tx.blockHash, receipt.blockHash) && tx.blockNumber === receipt.blockNumber);
  demand(tx.to === null && tx.value === 0n && eq(tx.from, intent.from) && tx.nonce === intent.nonce);
  demand(tx.chainId === intent.chainId && tx.type === 'eip1559');
  demand(eq(tx.input, intent.initCode) && eq(keccak256(tx.input), intent.initCodeHash));
  demand(tx.gas === BigInt(intent.gasLimit) && tx.maxFeePerGas === BigInt(intent.maxFeePerGas)
    && tx.maxPriorityFeePerGas === BigInt(intent.maxPriorityFeePerGas));
  const code = await client.getCode({ address: intent.predictedAddress });
  demand(code && code !== '0x' && eq(keccak256(code), intent.simulatedRuntimeHash));
  const historicalMaximum = await feeUpperBound(reader, intent, receipt.blockNumber);
  const bounds = [BigInt(intent.fees.maximumEstimatedWei), historicalMaximum];
  if (entry.feeUpperBoundWei !== undefined) {
    demand(/^[1-9][0-9]*$/.test(String(entry.feeUpperBoundWei)));
    bounds.push(BigInt(entry.feeUpperBoundWei));
  }
  // Keep the greatest conservative estimate; historical rollup fee quoting is not actual-fee accounting.
  const maximum = bounds.reduce((a, b) => a > b ? a : b);
  demand(eq((await reader.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash));
  return { receipt, runtimeCodeHash: keccak256(code), maximum };
}

export async function waitForCanonicalRecordedTransaction(reader, client, intent, entry) {
  const deadline = Date.now() + 180000;
  await reader.waitForTransactionReceipt({ hash: entry.transactionHash, confirmations: 2, timeout: 180000, pollingInterval: 2000 });
  while (Date.now() < deadline) {
    // A wait result with a zero blockHash is incomplete; retry only reads, never the submitted transaction.
    const receipt = await reader.getTransactionReceipt({ hash: entry.transactionHash });
    if (validBlockHash(receipt.blockHash)) return verifyRecordedTransaction(reader, client, intent, entry);
    await new Promise(ok => setTimeout(ok, Math.min(2000, Math.max(0, deadline - Date.now()))));
  }
  demand(false);
}

export async function loadAccount(expected) {
  const handle = await open(resolve(ROOT, 'contracts/.env.deploy.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    demand(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size < 16384);
    bytes = await handle.readFile();
    const value = parseEnv(bytes.toString()).DEPLOYER_PRIVATE_KEY;
    demand(typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value));
    // Wallet exports may omit the RPC-style prefix. Preserve the exact 32 key bytes.
    const account = privateKeyToAccount(`0x${value.replace(/^0x/i, '')}`);
    demand(eq(account.address, expected));
    return account;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}
