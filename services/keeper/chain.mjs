import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, keccak256, toHex, encodeFunctionData,
  decodeFunctionData, decodeFunctionResult, parseAbi, serializeTransaction } from 'viem';
import { requireCondition } from './streams.mjs';
import { FINAL, TX_GAS_CAP, TX_SHARE, spent } from './journal.mjs';

const ROOT = new URL('../../', import.meta.url);
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const CHAIN_IDS = { base: 8453, horizen: 26514 };
const HOME = { ChainlinkStreamsBoundaryOracle: 'base', BaseStreamsPublisher: 'base', HorizenStreamsOracle: 'horizen', StreamsRoundRegistry: 'horizen' };
const ALLOWED = { BaseStreamsPublisher: ['publishBoundary', 'resendBoundary'], StreamsRoundRegistry: ['createRound', 'recordOpening', 'resolveRound', 'voidRound'] };
const IDENTITY_TTL = 60000; // a send relies on an identity check at most this old
const STUCK_AFTER = 20000; // an unmined hash holds its chain's lane this long (doubling per unmined hash), then its nonce is signed again
const PRESEND_LIMIT = 8000; // signing and the journal write must fit in this before the send, measured on the local clock only
const SIGNER_PROOF = 30000; // a nonce that looks spent by somebody else must go on looking so this long before the process stops
// The canonical Multicall3: the same address and runtime on every chain that has it (read on Base and Horizen on
// 2026-10-05: 3,808 bytes, this hash). Where a chain's code at that address is exactly this, a tick's views go
// through it in one eth_call; anywhere else they are asked one by one in a batch, as before. Never a reason to stop.
const MULTICALL3 = { address: '0xcA11bde05977b3631167028862bE2a173976CA11', codeHash: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
  abi: parseAbi(['function getBlockNumber() view returns (uint256)', 'function getCurrentBlockTimestamp() view returns (uint256)']) };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const readJSON = async path => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'));
const loopback = url => /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?(?:\/|$)/.test(url);

// rpc: operator-supplied endpoints (e.g. private ones) replacing the public defaults. rehearsal: local forks only.
// files/fetchFn: in-memory profile + release (and the runtime hash a simulated Multicall3 has) and a transport, for tests.
export async function createChainAccess({ rpc = {}, rehearsal = false, fetchFn = globalThis.fetch, files } = {}) {
  // The default Base endpoint has answered a two-call batch with three entries (the first one repeated). viem sorts a
  // batch answer by id and pairs it by position, so a block read came back as the transaction (seen 2026-10-06).
  // Keep one answer per id.
  const oneAnswerPerId = async (url, init) => {
    const response = await fetchFn(url, init);
    if (typeof init?.body !== 'string' || !init.body.startsWith('[')) return response;
    const answers = await response.clone().json().catch(() => undefined);
    if (!Array.isArray(answers)) return response;
    const seen = new Set(), kept = answers.filter(a => !seen.has(a?.id) && seen.add(a?.id));
    return kept.length === answers.length ? response : new Response(JSON.stringify(kept), { status: response.status, headers: response.headers });
  };
  const text = files?.config ?? await readFile(new URL('contracts/deployment/hybrid-mainnet.json', ROOT), 'utf8'); const config = JSON.parse(text);
  const release = files?.release ?? await readJSON('contracts/deployment/mainnet-addresses.json');
  const hex = (v, bytes) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v);
  const contracts = Array.isArray(release.contracts) ? release.contracts : [], registry = contracts.find(c => c?.name === 'StreamsRoundRegistry');
  requireCondition(release.schemaVersion === 2 && release.configHash === keccak256(toHex(text)) && hex(release.rulesHash, 32)
    && contracts.length === 4 && new Set(contracts.map(c => c?.name)).size === 4
    && contracts.every(c => c && HOME[c.name] === c.chain && c.chainId === CHAIN_IDS[c.chain] && hex(c.address, 20) && hex(c.runtimeCodeHash, 32))
    && hex(registry.proxy?.implementation, 20) && hex(registry.proxy.implementationCodeHash, 32) && hex(registry.proxy.owner, 20)
    // The look-back of a new state directory ends where these two rules say an opened round can no longer be pending.
    && Number.isSafeInteger(config.rules?.observationWindow) && Number.isSafeInteger(config.rules.voidGrace) && config.rules.voidGrace > 0, 'KEEPER_RELEASE');
  // A planned release names contracts that do not exist yet. Only a local rehearsal fork may run against one.
  requireCondition(release.status === 'deployed' || rehearsal && release.status === 'planned', 'KEEPER_RELEASE_NOT_DEPLOYED');
  const clients = {}, receipts = {}, abis = {};
  for (const key of ['base', 'horizen']) {
    // The profile may name a second endpoint for receipts where its default endpoint refuses them (Base's does).
    // An operator's endpoint replaces both and has to serve receipts itself; identify() proves that it does.
    const url = rpc[key] ?? config.chains[key].rpcUrl, receiptUrl = rpc[key] ?? config.chains[key].receiptRpcUrl ?? url;
    // Whichever endpoint answers, identify() below proves the chain and every contract against it.
    requireCondition(config.chains[key].chainId === CHAIN_IDS[key] && [url, receiptUrl].every(u => typeof u === 'string'
      && (rehearsal ? rpc[key] !== undefined && loopback(u) : u.startsWith('https://'))), 'KEEPER_RPC_CONFIG');
    const chain = defineChain({ id: CHAIN_IDS[key], name: key, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    // No transport retries: the run loop owns backoff (and Retry-After) per chain. Reads issued together share one HTTP request.
    const connect = to => createPublicClient({ chain, transport: http(to, { timeout: 12000, retryCount: 0, fetchFn: oneAnswerPerId, batch: { batchSize: 50, wait: 0 } }) });
    clients[key] = connect(url);
    receipts[key] = receiptUrl === url ? clients[key] : connect(receiptUrl);
  }
  for (const contract of release.contracts) abis[contract.name] = await readJSON(`contracts/abi/${contract.name}.json`);
  const contract = name => {
    const c = release.contracts.find(c => c.name === name); requireCondition(c, 'KEEPER_CONTRACT'); return c;
  };
  async function read(name, functionName, args = [], blockNumber) {
    const c = contract(name);
    return clients[c.chain].readContract({ address: c.address, abi: abis[name], functionName, args, blockNumber });
  }
  const verified = { base: 0, horizen: 0 }, served = { base: false, horizen: false }, aggregated = { base: false, horizen: false };
  // Complete identity of this release on one chain: chain id, every runtime (immutables are part of it) and, for
  // the proxied registry, implementation slot, implementation runtime, owner and stored rules. Nothing upstream
  // and nothing on the other chain: a send depends only on this. A mismatch is must-stop; a read failure is not.
  async function identify(chain, force = false) {
    if (!force && Date.now() < verified[chain]) return;
    const client = clients[chain], own = release.contracts.filter(c => c.chain === chain), proxied = chain === 'horizen';
    const known = own.find(c => hex(c.creationTransaction, 32)), first = !served[chain];
    const [id, codes, proxy, , multicall] = await Promise.all([client.getChainId(), Promise.all(own.map(c => client.getCode({ address: c.address }))),
      proxied ? Promise.all([client.getStorageAt({ address: registry.address, slot: IMPLEMENTATION_SLOT }), client.getCode({ address: registry.proxy.implementation }),
        Promise.allSettled([read('StreamsRoundRegistry', 'owner'), read('StreamsRoundRegistry', 'rulesHash')])]) : [],
      // Once per process: nothing sent can be settled without receipts, and some public endpoints refuse them, so
      // the endpoint is asked for one known receipt before anything is sent. "Not found" is an answer (a pruned
      // index); a JSON-RPC refusal is not. A transport failure stays the provider failure it is.
      !first || !known ? null : receipts[chain].getTransactionReceipt({ hash: known.creationTransaction }).catch(error => {
        if (error?.name !== 'TransactionReceiptNotFoundError') throw typeof error?.code === 'number' ? new Error('KEEPER_RPC_RECEIPTS') : error; }),
      // Once per process as well (code at an address does not change): is the canonical Multicall3 on this chain?
      first ? client.getCode({ address: MULTICALL3.address }) : null]);
    requireCondition(id === CHAIN_IDS[chain], 'KEEPER_CHAIN');
    requireCondition(own.every((c, i) => codes[i] && keccak256(codes[i]) === c.runtimeCodeHash), 'KEEPER_CODE');
    if (proxied) {
      // An upgrade or a new owner is a different deployment until a release that names it is installed.
      const [slot, implementation, [owner, rules]] = proxy;
      requireCondition(hex(slot, 32) && same(`0x${slot.slice(-40)}`, registry.proxy.implementation)
        && implementation && keccak256(implementation) === registry.proxy.implementationCodeHash, 'KEEPER_REGISTRY_IMPLEMENTATION');
      // The code is the release's, so a getter that fails now is the endpoint failing, not a different contract.
      for (const answer of [owner, rules]) if (answer.status === 'rejected') throw answer.reason;
      requireCondition(same(owner.value, registry.proxy.owner), 'KEEPER_REGISTRY_OWNER');
      requireCondition(same(rules.value, release.rulesHash), 'KEEPER_REGISTRY_RULES');
    }
    if (first) aggregated[chain] = Boolean(multicall) && keccak256(multicall) === (files?.multicall3 ?? MULTICALL3.codeHash);
    verified[chain] = Date.now() + IDENTITY_TTL; served[chain] = true;
  }
  // The chain's head and any number of views ([contract name, function, arguments]) as one eth_call through
  // Multicall3: one request, and one block for all of them. Undefined where identify() has not found the canonical
  // Multicall3; the caller then asks one by one. batchSize keeps a single eth_call to about 300 views (a tick has a
  // few dozen), far below any endpoint's gas cap for a call; more are split over several calls in one request.
  async function aggregate(chain, calls) {
    if (!aggregated[chain]) return undefined;
    const own = { address: MULTICALL3.address, abi: MULTICALL3.abi };
    const [number, timestamp, ...results] = await clients[chain].multicall({ multicallAddress: MULTICALL3.address, allowFailure: false, batchSize: 16384,
      contracts: [{ ...own, functionName: 'getBlockNumber' }, { ...own, functionName: 'getCurrentBlockTimestamp' },
        ...calls.map(([name, functionName, args]) => ({ address: contract(name).address, abi: abis[name], functionName, args }))] });
    return { number, timestamp, results };
  }
  function call(name, functionName, args) {
    const c = contract(name);
    requireCondition(ALLOWED[name]?.includes(functionName), 'KEEPER_CALL');
    return { chain: c.chain, chainId: c.chainId, to: c.address, value: 0n, data: encodeFunctionData({ abi: abis[name], functionName, args }) };
  }
  return { config, release, clients, receipts, abis, identify, read, aggregate, call };
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

const open = (data, chain) => data.transactions.filter(t => t.chain === chain && !FINAL.includes(t.status));
// A hash that may still be on its way holds its own chain's lane; the other chain never waits for it. Each further
// unmined hash doubles the hold (20 s up to about 11 min), so a chain or endpoint that mines nothing collects
// a hundred-odd small records a day, not thousands, and is retried within minutes of coming back.
export function heldUntil(data, chain) {
  const unmined = open(data, chain).filter(t => t.status !== 'mined');
  return Math.max(0, ...unmined.map(t => Date.parse(t.preparedAt) + STUCK_AFTER * 2 ** Math.min(unmined.length - 1, 5)));
}
export const held = (data, chain) => Date.now() < heldUntil(data, chain);

function settle(data, record, receipt, block) {
  const t = record.transaction, reserved = BigInt(t.gas) * BigInt(t.maxFeePerGas);
  const paid = typeof receipt.gasUsed === 'bigint' && typeof receipt.effectiveGasPrice === 'bigint' ? receipt.gasUsed * receipt.effectiveGasPrice : reserved;
  // Execution is charged as paid; the rollup data/operator part stays at its reserved estimate.
  const fee = BigInt(record.maximumFeeWei) - reserved + (paid < reserved ? paid : reserved);
  record.status = receipt.status === 'success' ? 'confirmed' : 'reverted';
  record.receipt = { status: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, timestamp: block.timestamp.toString(), feeWei: fee.toString() };
  // Booked under the hour of its block, not of the host clock: a wrong host clock cannot move spending between days.
  const book = data.spent[record.chain] ??= {}, hour = String(BigInt(block.timestamp) / 3600n);
  book[hour] = (BigInt(book[hour] ?? 0) + fee).toString();
  data.nonces[record.chain] = Math.max(data.nonces[record.chain] ?? 0, t.nonce + 1);
  (data.settled ??= {})[record.chain] = record; // kept in case a reorganisation takes it out again (rewind)
  // One nonce, one execution: every other hash signed for this nonce can never be mined now.
  for (const other of open(data, record.chain)) if (other.transaction.nonce === t.nonce) other.status = 'dropped';
  const intent = record.key.slice(0, record.key.lastIndexOf(':')), attempt = data.attempts[intent];
  if (record.status === 'confirmed' && !intent.startsWith('resend:')) delete data.attempts[intent];
  else if (attempt) { attempt.last = Math.floor(Date.now() / 1000); if (record.status === 'reverted') attempt.reverts += 1; }
}

// Bring every open record of one chain up to date. Never waits: a transaction seen in a block frees the lane at
// once (`mined`); the exact canonical check and the accounting follow two blocks later. Returns the records settled.
export async function reconcile(access, journal, chain) {
  const data = journal.data, records = open(data, chain), settled = [];
  if (!records.length) return settled;
  const client = access.clients[chain], reader = access.receipts?.[chain] ?? client;
  const [head, ...receipts] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), ...records.map(record =>
    reader.getTransactionReceipt({ hash: record.hash }).catch(error => { if (error?.name === 'TransactionReceiptNotFoundError') return null; throw error; }))]);
  for (const [i, record] of records.entries()) {
    const receipt = receipts[i];
    if (FINAL.includes(record.status)) continue;
    if (!receipt) { if (record.status === 'mined') record.status = 'submitted'; continue; }
    if (head < receipt.blockNumber + 2n) { record.status = 'mined'; continue; }
    const [tx, block] = await Promise.all([client.getTransaction({ hash: record.hash }), client.getBlock({ blockNumber: receipt.blockNumber })]);
    validateReceipt(receipt, tx, block, head, record);
    settle(data, record, receipt, block); settled.push(record);
  }
  const lost = open(data, chain).filter(t => t.status !== 'mined' && Date.now() - Date.parse(t.preparedAt) >= STUCK_AFTER);
  // A nonce spent two blocks deep with none of this journal's hashes in a block was spent by another holder of
  // the key. One answer that misses a receipt reads exactly the same, so it has to hold for SIGNER_PROOF of
  // re-reading before it stops the process; until then this chain waits and nothing is signed on it. The records
  // are left as they are, so a restart re-evaluates them from scratch.
  const deep = lost.length && head >= 2n ? await client.getTransactionCount({ address: lost[0].from, blockNumber: head - 2n }) : 0;
  const foreign = lost.some(t => t.transaction.nonce < deep), since = access.suspected ??= {};
  since[chain] = foreign ? since[chain] ?? Date.now() : undefined;
  if (settled.length) await journal.save();
  requireCondition(!foreign || Date.now() - since[chain] >= SIGNER_PROOF, 'KEEPER_SIGNER_UNCONFIRMED');
  requireCondition(!foreign, 'KEEPER_SIGNER_CHANGED');
  return settled;
}

export async function feeBound(client, transaction) {
  const bytes = serializeTransaction(transaction, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
  const [l1, operator] = await Promise.all([
    client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']), functionName: 'getL1FeeUpperBound', args: [BigInt((bytes.length - 2) / 2)] }),
    client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getOperatorFee(uint256) view returns (uint256)']), functionName: 'getOperatorFee', args: [transaction.gas] }),
  ]);
  return transaction.gas * transaction.maxFeePerGas + 2n * (l1 + operator);
}

// Sign and send one allow-listed, zero-value call. `intent` names the action; the journal key adds the attempt number.
// expect: for a publication, the report hash the contract's own verification must return.
//
// Nonce rule. Only the account's latest confirmed nonce is ever signed. A nonce is consumed once, so of all the
// hashes this journal holds for one nonce at most one can ever execute, and each of them is a fee-capped call
// that is idempotent or rejects itself. Signing that nonce again after STUCK_AFTER therefore cannot repeat an
// effect or spend more than one cap, whatever became of the earlier hash (never sent, dropped, still pending).
// The earlier record resolves when the nonce is spent: mined if its receipt exists, dropped if a sibling's does.
export async function sendOnce(access, journal, account, call, intent, budgets, expect) {
  requireCondition(call.value === 0n && ['base', 'horizen'].includes(call.chain), 'KEEPER_INTENT');
  const data = journal.data;
  const key = `${intent}:${(data.attempts[intent]?.count ?? 0) + 1}`;
  requireCondition(!data.transactions.some(t => t.key === key), 'KEEPER_DUPLICATE_INTENT');
  requireCondition(!held(data, call.chain), 'KEEPER_TX_PENDING');
  const target = access.release.contracts.find(c => same(c.address, call.to) && c.chain === call.chain && c.chainId === call.chainId);
  requireCondition(target && ALLOWED[target.name], 'KEEPER_TARGET');
  const decoded = decodeFunctionData({ abi: access.abis[target.name], data: call.data });
  requireCondition(ALLOWED[target.name].includes(decoded.functionName), 'KEEPER_CALL');
  await access.identify(call.chain);
  const client = access.clients[call.chain], from = account.address, request = { account: from, to: call.to, data: call.data, value: 0n };
  // One batched round trip on the target chain only. The simulation is the state and deadline check: a step somebody
  // else already took, or a window that has closed, arrives here as a decoded revert and nothing is signed.
  const [result, estimated, block, tip, nonce, balance, code] = await Promise.all([expect ? client.call(request) : undefined,
    client.estimateGas(request), client.getBlock(), client.estimateMaxPriorityFeePerGas(),
    client.getTransactionCount({ address: from, blockTag: 'latest' }), client.getBalance({ address: from }), client.getCode({ address: from })]);
  requireCondition(code === undefined || code === '0x', 'KEEPER_SIGNER_CODE');
  if (expect) requireCondition(same(decodeFunctionResult({ abi: access.abis[target.name], functionName: decoded.functionName, data: result.data }).reportHash, expect), 'KEEPER_STREAMS_AUTHENTICATION');
  const pending = open(data, call.chain), mark = data.nonces[call.chain] ?? nonce;
  if (nonce < mark) await rewind(client, journal, call.chain, nonce);
  // Every nonce spent since the last settled transaction must be one of ours awaiting its canonical check.
  for (let n = mark; n < nonce; n++) requireCondition(pending.some(t => t.transaction.nonce === n), 'KEEPER_SIGNER_CHANGED');
  // A nonce above an open record of this very intent: that record, or another hash signed for its nonce, went into a
  // block after this tick's reconciliation. Wait for its result. Signing the intent again under the next nonce would
  // run it twice, and a publication does not reject a repeat: it pays for a second bridge message.
  requireCondition(!pending.some(t => t.transaction.nonce < nonce && t.key.startsWith(`${intent}:`)), 'KEEPER_ATTEMPT_SETTLING');
  // The estimate executes the Base portal's deposit-fee burn at its live price, so the cap below follows that fee.
  // The portal fee can rise x2.125 in one block: 2.25x keeps a publication alive through one such step between
  // estimate and inclusion (a larger one reverts and is retried). Unused gas is not charged.
  let gas = estimated * (target.name === 'BaseStreamsPublisher' ? 9n : 5n) / 4n; if (gas > TX_GAS_CAP) gas = TX_GAS_CAP;
  requireCondition(gas * 10n >= estimated * 11n, 'KEEPER_GAS_CAP');
  const transaction = { type: 'eip1559', chainId: call.chainId, to: call.to, data: call.data, value: 0n, nonce, gas,
    maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + tip, maxPriorityFeePerGas: tip };
  const rollup = await feeBound(client, transaction) - gas * transaction.maxFeePerGas, cap = budgets[call.chain] / TX_SHARE;
  // A hash already signed for this nonce may still sit in the pool, and a pool only swaps it for a higher bid. If
  // that bid no longer fits the cap, bid the live price instead: a pool holding the old hash refuses it, an empty one takes it.
  let fee = transaction.maxFeePerGas, priority = tip;
  for (const t of pending) if (t.transaction.nonce === nonce) {
    const [f, p] = [t.transaction.maxFeePerGas, t.transaction.maxPriorityFeePerGas].map(v => BigInt(v) * 9n / 8n + 1n);
    if (f > fee) fee = f; if (p > priority) priority = p;
  }
  if (gas * fee + rollup <= cap) { transaction.maxFeePerGas = fee; transaction.maxPriorityFeePerGas = priority; }
  const maximum = gas * transaction.maxFeePerGas + rollup;
  // Caps are wei, priced from the live estimate and fees: a share of the rolling budget per transaction, and the budget itself.
  requireCondition(maximum <= cap, 'KEEPER_FEE_CAP');
  requireCondition(spent(data, call.chain) + maximum <= budgets[call.chain], 'KEEPER_BUDGET');
  requireCondition(balance >= maximum, 'KEEPER_BALANCE');
  const started = Date.now(), signed = await account.signTransaction(transaction), hash = keccak256(signed);
  // With unchanged fees and the bump over the cap, these are the very bytes of an earlier attempt. One hash is one
  // record: that record takes the lane again and its bytes are broadcast again; nothing new is numbered or reserved.
  let record = data.transactions.find(t => same(t.hash, hash));
  if (record) record.preparedAt = new Date(Date.now()).toISOString();
  else {
    record = { key, chain: call.chain, from, hash, transaction, maximumFeeWei: maximum.toString(), status: 'signed', preparedAt: new Date(Date.now()).toISOString() };
    const attempt = data.attempts[intent] ??= { count: 0, reverts: 0, last: 0 }; attempt.count += 1; attempt.last = Math.floor(Date.now() / 1000);
    data.transactions.push(record); data.nonces[call.chain] ??= nonce;
  }
  await journal.save();
  // fsync or signing may have stalled; the time the endpoint took to answer is not counted. The single check
  // between the durable hash and the single send is local: no RPC and no other chain's clock can stop a send. A
  // hash withheld here is never sent by anyone (its bytes are discarded); it holds the lane like any unmined hash
  // and then its nonce is signed again.
  requireCondition(Date.now() - started <= PRESEND_LIMIT, 'KEEPER_PRESEND_STALE');
  requireCondition(same(await client.sendRawTransaction({ serializedTransaction: signed }), hash), 'KEEPER_SUBMITTED_HASH');
  if (record.status === 'signed') record.status = 'submitted';
  return record;
}

// The endpoint counts fewer transactions than this journal has settled: it is behind, or a reorganisation removed the
// last settled one. The block that held it decides. Still the chain's block: the endpoint is behind, wait. Another
// block at that height: the transaction is gone. Its record is opened again, so the same hash landing later is
// recognised as this journal's, and its nonce may be signed again. A transaction removed before that one is no
// longer on record; if its hash lands again it reads as a foreign transaction (KEEPER_SIGNER_CHANGED).
async function rewind(client, journal, chain, nonce) {
  const data = journal.data, last = data.settled?.[chain];
  requireCondition(last && !same((await client.getBlock({ blockNumber: BigInt(last.receipt.blockNumber) })).hash, last.receipt.blockHash), 'KEEPER_NONCE_BEHIND');
  const { receipt, ...again } = last, cut = last.key.lastIndexOf(':'), intent = last.key.slice(0, cut);
  delete data.settled[chain]; data.nonces[chain] = Math.min(nonce, last.transaction.nonce);
  if (!data.transactions.some(t => t.key === last.key || same(t.hash, last.hash))) {
    data.transactions.push({ ...again, status: 'submitted', preparedAt: new Date(Date.now()).toISOString() });
    const attempt = data.attempts[intent] ??= { count: 0, reverts: 0, last: 0 }; attempt.count = Math.max(attempt.count, Number(last.key.slice(cut + 1)));
  }
  await journal.save();
  throw new Error('KEEPER_REORGANISED');
}

export const defaultStateDirectory = fileURLToPath(new URL('../../evidence/keeper/', import.meta.url));
