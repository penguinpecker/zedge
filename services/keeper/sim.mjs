// Test support only (never imported by the keeper): both chains, the native relay and the Chainlink report
// service, simulated at the HTTP boundary so the real createChainAccess, viem clients, StreamsClient, step and
// sendOnce run unmodified. Time comes from Date.now() and setTimeout, so a test can use real timers with a
// pinned clock or the virtual clock below. Nothing here opens a socket or holds a real key.
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, encodeAbiParameters, keccak256, toHex, numberToHex,
  parseAbi, parseTransaction, stringToHex, toFunctionSelector } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createChainAccess } from './chain.mjs';
import { StreamsClient } from './streams.mjs';

export const BTC = '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
export const ETH = '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
const ZERO32 = `0x${'0'.repeat(64)}`, GAS_ORACLE = '0x420000000000000000000000000000000000000f';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const URLS = { base: 'https://base.sim.invalid', horizen: 'https://horizen.sim.invalid' };
export const RECEIPTS = 'https://mainnet.base.org'; // the profile's receipt endpoint for Base (its default endpoint serves none); here it is the same simulated Base
// Multicall3 at its canonical address on both chains, as the keeper calls it: delete s.codes[MULTICALL3] for a chain without it.
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)', 'function getBlockNumber() view returns (uint256)', 'function getCurrentBlockTimestamp() view returns (uint256)']);
const ADDRESS = { ChainlinkStreamsBoundaryOracle: '0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91', BaseStreamsPublisher: '0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006',
  HorizenStreamsOracle: '0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B', StreamsRoundRegistry: '0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744' };
const IMPLEMENTATION = '0x00000000000000000000000000000000000001A1', OWNER = '0x279173ac297aD146bc92f877552C8C2B78334d07';
const CHAIN = { ChainlinkStreamsBoundaryOracle: 'base', BaseStreamsPublisher: 'base', HorizenStreamsOracle: 'horizen', StreamsRoundRegistry: 'horizen' };
const abis = Object.fromEntries(await Promise.all(Object.keys(ADDRESS).map(async name =>
  [name, JSON.parse(await readFile(new URL(`../../contracts/abi/${name}.json`, import.meta.url), 'utf8'))])));
const envelope = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }];
const bodyTypes = ['bytes32', 'uint32', 'uint32', 'uint192', 'uint192', 'uint32', 'int192', 'int192', 'int192'].map(type => ({ type }));
const EMPTY = { price: 0n, validFromTimestamp: 0, observationsTimestamp: 0, expiresAt: 0, reportHash: ZERO32, decimals: 0 };
const code = name => stringToHex(`simulated runtime of ${name}`);
const sleep = ms => ms > 0 ? new Promise(ok => setTimeout(ok, ms)) : undefined;

// A schema-2 release and profile naming the simulated deployment (addresses are the real/planned ones; runtimes are stand-ins).
export function fixture(status = 'deployed') {
  const config = JSON.stringify({ chains: { base: { chainId: 8453, rpcUrl: URLS.base, receiptRpcUrl: RECEIPTS }, horizen: { chainId: 26514, rpcUrl: URLS.horizen } },
    feeds: { btcFeedId: BTC, ethFeedId: ETH, btcDecimals: 18, ethDecimals: 18 },
    rules: { observationWindow: 60, openingGrace: 150, voidGrace: 300, cutoffBuffer: 30, minimumGasLimit: 600000 } });
  const release = { schemaVersion: 2, release: 'simulated', status, configHash: keccak256(toHex(config)), routeHash: `0x${'d1'.repeat(32)}`, rulesHash: `0x${'d2'.repeat(32)}`,
    contracts: Object.keys(ADDRESS).map(name => ({ name, chain: CHAIN[name], chainId: CHAIN[name] === 'base' ? 8453 : 26514, address: ADDRESS[name],
      runtimeCodeHash: keccak256(code(name)), ...(name === 'StreamsRoundRegistry' ? { creationTransaction: null, proxy: { implementation: IMPLEMENTATION, implementationCodeHash: keccak256(code('implementation')), owner: OWNER } }
        : { creationTransaction: keccak256(stringToHex(`creation of ${name}`)) }) })) };
  return { config, release, multicall3: keccak256(code('Multicall3')) };
}

// rtt: milliseconds every HTTP request takes. relay: seconds from a Base publication to the Horizen cache.
export async function simulate({ rtt = 0, relay = 24, status = 'deployed', key = generatePrivateKey() } = {}) {
  const files = fixture(status), account = privateKeyToAccount(key);
  const s = { rtt, relay, account, files, requests: { base: 0, horizen: 0, streams: 0 }, sent: [], rounds: new Map(), published: new Map(), cache: new Map(), reports: new Map(),
    calls: [], // one entry per HTTP request to a chain: { chain, at (host ms), count: the JSON-RPC calls it carried }
    views: [], // every registry or oracle view answered, directly or inside an aggregate3: "<function> <first argument>"
    depositFee: 1, baseFee: { base: 5_000_000n, horizen: 1_000_000n }, balance: 10n ** 18n, owner: OWNER, implementation: IMPLEMENTATION, codes: {},
    hostSkew: 0, // milliseconds the keeper's host clock (Date.now) runs ahead of the true time both chains and Chainlink keep
    touched: new Set(), // every address the keeper read code, storage or a call from
    rpc: null, // (chain, body, url) => Response | undefined : answer a whole HTTP request yourself (rate limits, outages)
    lagFor: null, // (chain, body) => seconds : this request is answered by a backend that many seconds behind the head
    reorg: {}, // chain => block number from which the chain was replaced: those blocks carry another hash
    inclusion: null, // (transaction, name, functionName, args) => 'drop' | 'revert' | seconds | undefined : fate of a broadcast transaction (seconds: left out of blocks that long)
    beforeEstimate: null, // (name, functionName, args) => void : runs between the keeper's state read and its simulation
    streams: { latency: 1, gaps: new Set(), lookup: 'exact', reject: null, skewLimit: 5000, requests: [] } };
  let lag = 0;
  const seconds = () => (Date.now() - s.hostSkew) / 1000 - lag;
  const registry = ADDRESS.StreamsRoundRegistry.toLowerCase();
  for (const [name, at] of Object.entries(ADDRESS)) s.codes[at.toLowerCase()] = code(name);
  s.codes[IMPLEMENTATION.toLowerCase()] = code('implementation'); s.codes[MULTICALL3] = code('Multicall3');
  const feedOf = asset => asset === 0 ? BTC : ETH;
  // Base: 2 s blocks on odd seconds. Horizen: 1 s blocks. Block n of Base carries timestamp 2n+1; of Horizen, n.
  const head = chain => chain === 'base' ? Math.floor((seconds() - 1) / 2) : Math.floor(seconds());
  const stamp = (chain, n) => chain === 'base' ? 2 * n + 1 : n;
  const blockHash = (chain, n) => keccak256(stringToHex(`${chain}:${n}${n >= s.reorg[chain] ? ':replaced' : ''}`));
  const numberOf = (chain, tag) => tag === undefined || ['latest', 'pending', 'safe', 'finalized'].includes(tag) ? head(chain) : Number(tag);
  s.roundId = (asset, duration, start) => keccak256(encodeAbiParameters(['uint256', 'address', 'bytes32', 'uint8', 'uint32', 'uint64'].map(type => ({ type })),
    [26514n, ADDRESS.StreamsRoundRegistry, files.release.rulesHash, asset, duration, BigInt(start)]));
  s.seed = (asset, duration, start, openedAt = 0) => { const id = s.roundId(asset, duration, start);
    s.rounds.set(id, { asset, duration, start, end: start + duration, openingDeadline: start + 210, voidableAfter: start + duration + 60 + 300, openedAt, resolvedAt: 0, outcome: 0 }); return id; };
  // Every market's rounds around boundary T: the one ending there (opened), the one starting there and the next two.
  s.schedule = T => { for (const asset of [0, 1]) for (const duration of [300, 900]) for (let i = -1; i <= 2; i++) s.seed(asset, duration, T + i * duration, i < 0 ? T - duration + 30 : 0); };
  // An observation already published on Base and delivered to the Horizen cache at time `at`.
  s.deliver = (feed, boundary, at) => { const { fullReport } = s.report(feed, boundary), entry = { observation: s.reports.get(fullReport.toLowerCase()), at };
    s.published.set(`${feed}:${boundary}`, entry); s.cache.set(`${feed}:${boundary}`, entry); return fullReport; };
  const cached = (feed, boundary, t) => { const e = s.cache.get(`${feed}:${boundary}`); return e && e.at <= t ? e.observation : null; };
  const opened = (r, t) => r.openedAt !== 0 && r.openedAt <= t;
  const outcome = (r, t) => r.resolvedAt !== 0 && r.resolvedAt <= t ? r.outcome : 0;
  function phase(id, t) { // StreamsRoundRegistry.phase
    const r = s.rounds.get(id); if (!r || r.createdAt > t) return 0; const o = outcome(r, t);
    if (o === 3) return 7; if (o !== 0) return 6;
    if (!opened(r, t) && t > r.openingDeadline) return 8; if (t < r.start) return 1; if (!opened(r, t)) return 2;
    if (t < r.end - 30) return 3; if (t < r.end) return 4;
    return t > r.voidableAfter && !cached(feedOf(r.asset), r.end, t) ? 8 : 5;
  }
  const revert = (name, errorName, args) => Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: abis[name], errorName, args }) });
  // The contracts' own guards at block time t. Throws the revert a real node would return.
  function check(name, fn, args, t) {
    if (name === 'BaseStreamsPublisher') {
      const [feed, boundary] = args, stored = s.published.get(`${feed}:${boundary}`), there = stored && stored.at <= t;
      if (fn === 'resendBoundary') { if (!there) throw revert(name, 'MissingObservation'); return; }
      const o = s.reports.get(args[2].toLowerCase());
      if (Number(boundary) > t) throw revert('ChainlinkStreamsBoundaryOracle', 'InvalidWindow');
      if (!o || o.feed !== feed || o.validFromTimestamp > Number(boundary) || o.observationsTimestamp < Number(boundary)
        || o.observationsTimestamp > Number(boundary) + 60 || o.observationsTimestamp > t || t > o.expiresAt) throw revert('ChainlinkStreamsBoundaryOracle', 'InvalidOracleResponse');
      if (there && stored.observation.reportHash !== o.reportHash) throw revert(name, 'ConflictingObservation');
      return;
    }
    if (fn === 'createRound') { const [asset, duration, start] = args;
      if (![300, 900].includes(duration) || Number(start) <= t || Number(start) % duration) throw revert(name, 'InvalidSchedule');
      const id = s.roundId(asset, duration, Number(start)); if (phase(id, t) !== 0) throw revert(name, 'RoundExists', [id]); return; }
    const r = s.rounds.get(args[0]); if (!r || r.createdAt > t) throw revert(name, 'UnknownRound', [args[0]]);
    if (outcome(r, t) !== 0) throw revert(name, 'AlreadyFinalized');
    if (fn === 'recordOpening') {
      if (opened(r, t)) throw revert(name, 'OpeningAlreadyRecorded');
      if (t < r.start || t > r.openingDeadline) throw revert(name, 'OutsideOpeningWindow');
      if (!cached(feedOf(r.asset), r.start, t)) throw revert('HorizenStreamsOracle', 'MissingObservation');
    } else if (fn === 'resolveRound') {
      if (!opened(r, t)) throw revert(name, 'OpeningMissing'); if (t < r.end) throw revert(name, 'RoundNotEnded');
      if (!cached(feedOf(r.asset), r.end, t)) throw revert('HorizenStreamsOracle', 'MissingObservation');
    } else if (fn === 'voidRound') {
      if (t <= (opened(r, t) ? r.voidableAfter : r.openingDeadline)) throw revert(name, 'TimeoutNotReached');
      if (opened(r, t) && cached(feedOf(r.asset), r.end, t)) throw revert(name, 'ClosingEvidenceAvailable');
    }
  }
  function apply(name, fn, args, t) {
    if (name === 'BaseStreamsPublisher') {
      const k = `${args[0]}:${args[1]}`;
      if (fn === 'publishBoundary' && !s.published.has(k)) s.published.set(k, { observation: s.reports.get(args[2].toLowerCase()), at: t });
      if (s.relay !== null && !s.cache.has(k)) s.cache.set(k, { observation: s.published.get(k).observation, at: t + s.relay });
    } else if (fn === 'createRound') { const id = s.seed(Number(args[0]), Number(args[1]), Number(args[2])); s.rounds.get(id).createdAt = t; }
    else if (fn === 'recordOpening') s.rounds.get(args[0]).openedAt = t;
    else Object.assign(s.rounds.get(args[0]), { outcome: fn === 'voidRound' ? 3 : 1, resolvedAt: t });
  }
  // Someone other than the keeper performs a step, effective at block time t.
  s.outsider = (name, fn, args, t = Math.floor(seconds())) => { check(name, fn, args, t); apply(name, fn, args, t); };
  function settle() { // include broadcast transactions lazily, each at its own block time
    for (const x of s.sent) {
      if (x.done || x.fate === 'drop' || x.replaced || x.ts > seconds()) continue; x.done = true;
      // A limit below what the call needs at the deposit fee in force when it is included runs out of gas in the portal burn.
      try { if (x.fate === 'revert' || x.tx.gas < gasFor(x.name, x.fn)) throw new Error('forced'); check(x.name, x.fn, x.args, x.ts); apply(x.name, x.fn, x.args, x.ts); x.ok = true; } catch { x.ok = false; }
    }
  }
  const mined = (chain, upTo = Infinity) => s.sent.filter(x => x.chain === chain && x.done && x.block <= upTo).length;
  const gasFor = (name, fn) => name === 'BaseStreamsPublisher' ? BigInt(Math.round((fn === 'publishBoundary' ? 247_673 : 220_000) + 924_355 * s.depositFee))
    : { createRound: 150_000n, recordOpening: 180_000n, resolveRound: 160_000n, voidRound: 60_000n }[fn];
  function call(chain, { to, data }, tag) {
    const t = stamp(chain, numberOf(chain, tag)), target = String(to).toLowerCase();
    if (target === GAS_ORACLE) return encodeAbiParameters([{ type: 'uint256' }], [data.startsWith(toFunctionSelector('getOperatorFee(uint256)')) ? 0n : chain === 'base' ? 14_079_536_677n : 300_000_000n]);
    if (!s.codes[target]) return '0x'; // nothing deployed there
    if (target === MULTICALL3) { // every view of one aggregate3 runs at the same block; a view that reverts is reported, not thrown
      const { functionName, args } = decodeFunctionData({ abi: multicallAbi, data }), out = result => encodeFunctionResult({ abi: multicallAbi, functionName, result });
      if (functionName !== 'aggregate3') return out(BigInt(functionName === 'getBlockNumber' ? numberOf(chain, tag) : t));
      return out(args[0].map(view => { s.touched.add(view.target.toLowerCase());
        try { return { success: true, returnData: call(chain, { to: view.target, data: view.callData }, tag) }; }
        catch (error) { if (typeof error.data !== 'string') throw error; return { success: false, returnData: error.data }; } }));
    }
    const name = Object.keys(ADDRESS).find(n => ADDRESS[n].toLowerCase() === target && CHAIN[n] === chain);
    const { functionName: fn, args = [] } = decodeFunctionData({ abi: abis[name], data });
    const out = result => encodeFunctionResult({ abi: abis[name], functionName: fn, result });
    if (['roundIdFor', 'phase', 'getRound', 'getObservation'].includes(fn)) s.views.push(`${fn} ${args[0]}`);
    if (fn === 'owner') return out(s.owner); if (fn === 'rulesHash') return out(files.release.rulesHash);
    if (fn === 'roundIdFor') return out(s.roundId(args[0], args[1], Number(args[2])));
    if (fn === 'phase') return out(phase(args[0], t));
    if (fn === 'getRound') { const r = s.rounds.get(args[0]); if (!r || r.createdAt > t) throw revert(name, 'UnknownRound', [args[0]]);
      return out({ asset: r.asset, duration: r.duration, start: BigInt(r.start), end: BigInt(r.end), cutoff: BigInt(r.end - 30), openingDeadline: BigInt(r.openingDeadline), voidableAfter: BigInt(r.voidableAfter),
        openedAt: BigInt(opened(r, t) ? r.openedAt : 0), resolvedAt: BigInt(outcome(r, t) ? r.resolvedAt : 0), outcome: outcome(r, t), opening: EMPTY, closing: EMPTY }); }
    if (fn === 'getObservation') { const e = (name === 'BaseStreamsPublisher' ? s.published : s.cache).get(`${args[0]}:${args[1]}`); return out(e && e.at <= t ? e.observation : EMPTY); }
    check(name, fn, args, t); // eth_call of a write
    return fn === 'publishBoundary' ? out(s.reports.get(args[2].toLowerCase())) : fn === 'createRound' ? out(s.roundId(args[0], args[1], Number(args[2]))) : '0x';
  }
  function handle(chain, method, p) {
    const h = head(chain);
    if (['eth_call', 'eth_estimateGas', 'eth_getCode', 'eth_getStorageAt'].includes(method)) s.touched.add(String(p[0].to ?? p[0]).toLowerCase());
    switch (method) {
      case 'eth_chainId': return numberToHex(chain === 'base' ? 8453 : 26514);
      case 'eth_blockNumber': return numberToHex(h);
      case 'eth_getBlockByNumber': { const n = numberOf(chain, p[0]); if (n > h) return null;
        return { number: numberToHex(n), hash: blockHash(chain, n), parentHash: blockHash(chain, n - 1), timestamp: numberToHex(stamp(chain, n)), baseFeePerGas: numberToHex(s.baseFee[chain]), gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] }; }
      case 'eth_getCode': return s.codes[String(p[0]).toLowerCase()] ?? '0x';
      case 'eth_getStorageAt': return String(p[0]).toLowerCase() === registry && p[1] === IMPLEMENTATION_SLOT ? `0x${s.implementation.slice(2).toLowerCase().padStart(64, '0')}` : ZERO32;
      case 'eth_call': return call(chain, p[0], p[1]);
      case 'eth_estimateGas': { const name = Object.keys(ADDRESS).find(n => ADDRESS[n].toLowerCase() === p[0].to.toLowerCase() && CHAIN[n] === chain);
        const { functionName, args } = decodeFunctionData({ abi: abis[name], data: p[0].data }); s.beforeEstimate?.(name, functionName, args);
        check(name, functionName, args, stamp(chain, head(chain))); const gas = gasFor(name, functionName);
        // Above the 2^24 per-transaction cap the estimate is refused, in the words mainnet Base used on 2026-10-05.
        if (gas > 2n ** 24n) throw Object.assign(new Error('out of gas: gas required exceeds: 16777216'), { code: -32003 });
        return numberToHex(gas); }
      case 'eth_maxPriorityFeePerGas': return numberToHex(chain === 'base' ? 1_000_000n : 1_000n);
      case 'eth_getBalance': return numberToHex(s.balance);
      case 'eth_getTransactionCount': return numberToHex(mined(chain, numberOf(chain, p[1])) + (s.foreign?.[chain] ?? 0));
      case 'eth_sendRawTransaction': {
        const tx = parseTransaction(p[0]), name = Object.keys(ADDRESS).find(n => ADDRESS[n].toLowerCase() === tx.to.toLowerCase() && CHAIN[n] === chain);
        const { functionName: fn, args } = decodeFunctionData({ abi: abis[name], data: tx.data });
        if (tx.nonce < mined(chain) + (s.foreign?.[chain] ?? 0)) throw Object.assign(new Error('nonce too low'), { code: -32000 });
        const pooled = s.sent.find(x => x.chain === chain && !x.done && !x.replaced && x.fate !== 'drop' && x.tx.nonce === tx.nonce);
        if (pooled) { if (tx.maxFeePerGas * 10n < pooled.tx.maxFeePerGas * 11n) throw Object.assign(new Error('replacement transaction underpriced'), { code: -32000 }); pooled.replaced = true; }
        const fate = s.inclusion?.(tx, name, fn, args), block = h + 1 + (typeof fate === 'number' ? Math.ceil(fate / (chain === 'base' ? 2 : 1)) : 0);
        s.sent.push({ chain, hash: keccak256(p[0]), raw: p[0], tx, name, fn, args, sentAt: seconds(), block, ts: stamp(chain, block), fate });
        return keccak256(p[0]);
      }
      case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
        // The same bytes may have been broadcast twice; a backend that is behind (lagFor) has not seen a newer block.
        const x = s.sent.find(y => y.chain === chain && y.hash === p[0] && y.done); if (!x || x.block > h) return null;
        const used = x.ok ? gasFor(x.name, x.fn) : x.tx.gas;
        if (method === 'eth_getTransactionReceipt') return { transactionHash: x.hash, blockHash: blockHash(chain, x.block), blockNumber: numberToHex(x.block), status: x.ok ? '0x1' : '0x0',
          from: account.address, to: x.tx.to, gasUsed: numberToHex(used), cumulativeGasUsed: numberToHex(used), effectiveGasPrice: numberToHex(s.baseFee[chain] + x.tx.maxPriorityFeePerGas), logs: [], logsBloom: `0x${'0'.repeat(512)}`, transactionIndex: '0x0', type: '0x2', contractAddress: null };
        return { hash: x.hash, from: account.address, to: x.tx.to, input: x.tx.data, nonce: numberToHex(x.tx.nonce), gas: numberToHex(x.tx.gas), maxFeePerGas: numberToHex(x.tx.maxFeePerGas),
          maxPriorityFeePerGas: numberToHex(x.tx.maxPriorityFeePerGas), value: '0x0', type: '0x2', chainId: numberToHex(x.tx.chainId), accessList: [], v: '0x0', r: '0x1', s: '0x1', yParity: '0x0',
          blockHash: blockHash(chain, x.block), blockNumber: numberToHex(x.block), transactionIndex: '0x0' };
      }
      default: throw new Error(`SIM_UNEXPECTED_METHOD ${method}`);
    }
  }
  s.fetchFn = async (url, init) => { // JSON-RPC over "HTTP": half the round trip out, handled, half back
    const to = String(url).replace(/\/$/, ''), chain = to === RECEIPTS ? 'base' : Object.keys(URLS).find(c => to === URLS[c]); if (!chain) throw new Error(`SIM_UNEXPECTED_URL ${url}`);
    s.requests[chain]++; await sleep(s.rtt / 2); settle();
    const body = JSON.parse(init.body), custom = s.rpc?.(chain, body, to);
    s.calls.push({ chain, at: Date.now(), count: [].concat(body).length });
    if (custom) { await sleep(s.rtt / 2); return custom; }
    lag = s.lagFor?.(chain, body) ?? 0;
    const one = q => { try { return { jsonrpc: '2.0', id: q.id, result: handle(chain, q.method, q.params ?? []) }; }
      catch (e) { if (String(e.message).startsWith('SIM_')) s.defect ??= e.message; return { jsonrpc: '2.0', id: q.id, error: { code: e.code ?? -32603, message: e.message, data: e.data } }; } };
    const text = JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)); lag = 0;
    await sleep(s.rtt / 2);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  // Chainlink: one report per second and feed, available `latency` seconds after its observation. A second in
  // `gaps` ("feed:second") has no report of its own; the next report's window starts there instead.
  const exists = (feed, t) => !s.streams.gaps.has(`${feed}:${t}`);
  s.report = (feed, observed, validFrom) => {
    if (validFrom === undefined) { validFrom = observed; while (!exists(feed, validFrom - 1)) validFrom--; }
    const price = 100_000n * 10n ** 18n + BigInt(observed), expires = observed + 2_592_000;
    const body = encodeAbiParameters(bodyTypes, [feed, validFrom, observed, 0n, 0n, expires, price, price, price]);
    const payload = encodeAbiParameters(envelope, [[ZERO32, ZERO32, ZERO32], body, [`0x${'11'.repeat(32)}`], [`0x${'22'.repeat(32)}`], ZERO32]);
    s.reports.set(payload.toLowerCase(), { feed, price, validFromTimestamp: validFrom, observationsTimestamp: observed, expiresAt: expires, reportHash: keccak256(body), decimals: 18 });
    return { feedID: feed, validFromTimestamp: validFrom, observationsTimestamp: observed, fullReport: payload };
  };
  const available = t => t + s.streams.latency <= seconds();
  const nextReport = (feed, from) => { for (let t = from; t <= from + 120; t++) if (exists(feed, t)) return available(t) ? s.report(feed, t) : null; return null; };
  s.username = 'sim-user'; s.secret = 'sim-only-not-a-real-secret';
  s.streamsFetch = async (url, init) => {
    s.requests.streams++; await sleep(s.rtt);
    const u = new URL(url), path = u.pathname + u.search, feed = u.searchParams.get('feedID'), h = init.headers, now = Math.floor(seconds());
    const date = { date: new Date(Date.now() - s.hostSkew).toUTCString() }; // the server's own clock
    const signature = createHmac('sha256', s.secret).update(`GET ${path} ${createHash('sha256').update('').digest('hex')} ${h.Authorization} ${h['X-Authorization-Timestamp']}`).digest('hex');
    const skew = Number(h['X-Authorization-Timestamp']) - (Date.now() - s.hostSkew);
    const status = s.streams.reject?.(feed, path) ?? (signature !== h['X-Authorization-Signature-SHA256'] || Math.abs(skew) > s.streams.skewLimit ? 401 : 200);
    const answer = (status, body) => { s.streams.requests.push({ path, status }); return new Response(JSON.stringify(body), { status, headers: date }); };
    if (status !== 200) return answer(status, { error: 'rejected' });
    let body;
    if (u.pathname.endsWith('/latest')) { let t = now; while (t > now - 120 && !(exists(feed, t) && available(t))) t--; body = { report: s.report(feed, t) }; }
    else if (u.pathname.endsWith('/page')) { const first = nextReport(feed, Number(u.searchParams.get('startTimestamp'))); body = { reports: first ? [first] : [] }; }
    else { const t = Number(u.searchParams.get('timestamp'));
      const found = exists(feed, t) ? (available(t) ? s.report(feed, t) : null) : s.streams.lookup === 'covering' ? nextReport(feed, t) : s.streams.lookup === 'atOrBefore' ? s.report(feed, t - 1) : null;
      if (!found) return answer(404, { error: 'not found' });
      body = { report: found }; }
    return answer(200, body);
  };
  s.access = await createChainAccess({ files, fetchFn: s.fetchFn });
  s.auth = { account, budgets: { base: 20_000_000_000_000_000n, horizen: 4_000_000_000_000_000n },
    streams: new StreamsClient({ username: s.username, secret: s.secret, fetchImpl: s.streamsFetch, clock: () => Date.now() }) };
  // An in-memory journal with the real one's contract: settled records leave the state for the history.
  s.journal = () => ({ data: { schemaVersion: 2, identity: 'sim', transactions: [], activeRounds: {}, nonces: {}, spent: {}, attempts: {} }, saves: 0, history: [],
    async save() { this.saves++; const settled = t => ['confirmed', 'reverted', 'dropped'].includes(t.status);
      this.history.push(...this.data.transactions.filter(settled)); this.data.transactions = this.data.transactions.filter(t => !settled(t)); } });
  return s;
}

// Virtual clock: timers fire in order as soon as nothing else can run, so minutes of keeper time take milliseconds
// and every simulated HTTP request costs exactly its round-trip time.
export function virtualClock(startMs) {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, Date: globalThis.Date };
  let now = startMs, id = 0; const timers = new Map();
  class VirtualDate extends real.Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  globalThis.setTimeout = (fn, ms, ...args) => { timers.set(++id, { id, due: now + Math.max(0, Number(ms) || 0), fn, args }); return id; };
  globalThis.clearTimeout = handle => { timers.delete(handle); }; globalThis.Date = VirtualDate;
  return { now: () => now, restore: () => Object.assign(globalThis, real),
    async run(untilMs, finished = () => false) {
      for (;;) {
        for (let i = 0; i < 5; i++) await turn();
        if (finished()) return;
        let next; for (const t of timers.values()) if (!next || t.due < next.due || t.due === next.due && t.id < next.id) next = t;
        if (!next || next.due > untilMs) { now = Math.max(now, untilMs); return; }
        timers.delete(next.id); now = Math.max(now, next.due); next.fn(...next.args);
      }
    } };
}
