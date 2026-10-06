// The free report source (solana.mjs) against real Solana transactions: solana-fixtures.json holds what the public
// endpoint answered around three 15-minute boundaries, and a stand-in endpoint serves it at the (mocked) host time.
// The keeper runs against sim.mjs with the production market list (BTC 15-minute rounds only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SolanaReports, reportOf, withFallback } from './solana.mjs';
import { decodeReport, covers, StreamsClient } from './streams.mjs';
import { classify } from './errors.mjs';
import { step, settings } from './main.mjs';
import { simulate, BTC } from './sim.mjs';

const fixtures = JSON.parse(await readFile(new URL('./solana-fixtures.json', import.meta.url), 'utf8')).boundaries;
const JUPITER = '2SoQchZSfocDAagJDCpfzP3cYyrV6MzAUuAMH1vsmyt1', BACKUP = '2DeGBCAiEJd1MgMuPGDKh7svBikZa9izbnTn5p7ESzPt';
// 2026-10-06 08:00 UTC: both sources 1 s after the boundary, their copies byte for byte the same. 07:15 UTC: the
// primary's first copy carries another subset of the DON's signatures than the backup's. 2026-10-05 23:00 UTC: the
// backup is left out, and the primary posts 101 s late, after a copy of the report of five minutes earlier.
const FRESH = 1791273600, SUBSETS = 1791270900, LATE = 1791241200;
const signature = (boundary, prefix) => Object.keys(fixtures[boundary].transactions).find(s => s.startsWith(prefix));
const copyIn = (boundary, prefix) => fixtures[boundary].transactions[signature(boundary, prefix)].transaction.message.instructions
  .flatMap(i => { try { return [reportOf(i.data)]; } catch { return []; } })[0];
const honest = copyIn(FRESH, '5P6f5mmg');

// An independent base58 and the plainest valid Snappy block (one literal), to build instruction data.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const decode58 = text => { let n = 0n; for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c)); const hex = n.toString(16);
  return Buffer.concat([Buffer.alloc(text.match(/^1*/)[0].length), Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')]); };
const encode58 = bytes => { let n = BigInt(`0x${bytes.toString('hex') || '0'}`), text = ''; for (; n > 0n; n /= 58n) text = ALPHABET[Number(n % 58n)] + text;
  return '1'.repeat(bytes.findIndex(b => b !== 0) < 0 ? bytes.length : bytes.findIndex(b => b !== 0)) + text; };
const varint = n => { const out = []; for (; n >= 0x80; n = Math.floor(n / 128)) out.push(n % 128 | 0x80); out.push(n); return Buffer.from(out); };
const instruction = (discriminator, block) => { const length = Buffer.alloc(4); length.writeUInt32LE(block.length); return encode58(Buffer.concat([discriminator, length, block])); };
const literal = bytes => Buffer.concat([varint(bytes.length), Buffer.from([61 << 2, (bytes.length - 1) & 0xff, (bytes.length - 1) >> 8]), bytes]);
// A copy with its body changed: a well-formed report whose signatures no longer match it. forge: the price one dollar higher.
const envelope = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }];
const bodyTypes = ['bytes32', 'uint32', 'uint32', 'uint192', 'uint192', 'uint32', 'int192', 'int192', 'int192'].map(type => ({ type }));
const edit = (payload, change) => { const fields = decodeAbiParameters(envelope, payload), body = [...decodeAbiParameters(bodyTypes, fields[1])]; change(body);
  return encodeAbiParameters(envelope, [fields[0], encodeAbiParameters(bodyTypes, body), fields[2], fields[3], fields[4]]); };
const forge = payload => edit(payload, body => { body[6] += 10n ** 18n; });
const lie = tx => { for (const i of tx.transaction.message.instructions) try { i.data = instruction(decode58(i.data).subarray(0, 8), literal(Buffer.from(forge(reportOf(i.data)).slice(2), 'hex'))); } catch { /* not a report */ } return tx; };

// A third party's transaction that succeeds for one signature fee: an instruction of `program` (a no-op program of
// its own unless given) and `method` carrying `payload` as a report, in the listing of each source it names.
const NOOP = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', PAYER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
function planted(tag, blockTime, addresses, payload, { program = NOOP, method = '0102030405060708' } = {}) {
  const signature = encode58(createHash('sha512').update(`planted:${tag}`).digest()), accountKeys = [PAYER, ...addresses, program];
  const data = instruction(Buffer.from(method, 'hex'), literal(Buffer.from(payload.slice(2), 'hex')));
  return { signature, addresses, tx: { blockTime, slot: 0, meta: { err: null },
    transaction: { signatures: [signature], message: { accountKeys, instructions: [{ programIdIndex: accountKeys.length - 1, accounts: addresses.map((_, i) => i + 1), data }] } } } };
}

// The public endpoint as it answered for one boundary, at the host time: a transaction exists from its block time on.
// without: sources that post nothing. failed: transactions that failed on chain. newer: that many failed transactions
// of the primary's, evenly from ten minutes after the boundary to the host time (a boundary hours old). moved: block
// times changed ({ signature: blockTime }). added: planted transactions. change: what a lying endpoint does to a
// transaction. answer: a whole HTTP response instead (rate limits, outages). calls: "<method> <address>" per
// signature page, the signature per transaction.
function endpoint(boundary, { without = [], failed = [], newer = 0, moved = {}, added = [], change, answer } = {}) {
  const transactions = { ...fixtures[boundary].transactions, ...Object.fromEntries(added.map(a => [a.signature, a.tx])) }, calls = [], at = Date.now() / 1000;
  const padding = Array.from({ length: newer }, (_, i) => ({ signature: encode58(createHash('sha512').update(`${boundary}:${i}`).digest()), slot: 0, err: { InstructionError: [0, 'InvalidArgument'] },
    memo: null, blockTime: Math.floor(at - (at - boundary - 600) * i / newer), confirmationStatus: 'confirmed' }));
  const listed = { ...fixtures[boundary].signatures, [JUPITER]: [...padding, ...fixtures[boundary].signatures[JUPITER] ?? []] };
  for (const a of added) for (const address of a.addresses) listed[address] = [...listed[address] ?? [], { signature: a.signature, slot: 0, err: null, memo: null, blockTime: a.tx.blockTime, confirmationStatus: 'confirmed' }];
  const time = (signature, blockTime) => moved[signature] ?? blockTime;
  const signatures = Object.fromEntries(Object.entries(listed).map(([address, list]) => [address, list.map(s => ({ ...s, blockTime: time(s.signature, s.blockTime) })).sort((a, b) => b.blockTime - a.blockTime)]));
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body), now = Date.now() / 1000;
    calls.push(method === 'getTransaction' ? params[0] : `${method} ${params[0]}`);
    const custom = answer?.(method, params); if (custom) return custom;
    let result = null;
    if (method === 'getSignaturesForAddress') {
      const list = without.includes(params[0]) ? [] : (signatures[params[0]] ?? []).filter(s => s.blockTime <= now)
        .map(s => failed.includes(s.signature) ? { ...s, err: { InstructionError: [1, { Custom: 6000 }] } } : s);
      result = list.slice(params[1].before ? list.findIndex(s => s.signature === params[1].before) + 1 : 0).slice(0, params[1].limit);
    } else { const tx = transactions[params[0]]; if (tx && time(params[0], tx.blockTime) <= now) result = change ? change(structuredClone(tx)) : tx; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  };
  return { calls, reads: () => calls.filter(c => !c.startsWith('get')), harvester: new SolanaReports({ fetchImpl }) };
}
// The host clock, in seconds, mocked once per test.
function clock(t, at) { const c = { now: at }; t.mock.method(Date, 'now', () => Math.round(c.now * 1000)); return c; }

test('every report instruction of both sources decodes to the full signed report it carries; other instructions do not', () => {
  const kinds = new Set(), feeds = {};
  for (const { transactions } of Object.values(fixtures)) for (const tx of Object.values(transactions)) for (const i of tx.transaction.message.instructions) {
    assert.equal(encode58(decode58(i.data)), i.data, 'the test helpers round-trip');
    let payload; try { payload = reportOf(i.data); } catch { continue; }
    kinds.add(decode58(i.data).subarray(0, 8).toString('hex'));
    const feed = decodeAbiParameters(bodyTypes, decodeAbiParameters(envelope, payload)[1])[0]; feeds[feed] = (feeds[feed] ?? 0) + 1;
    if (feed === BTC) decodeReport(payload, BTC); else assert.throws(() => decodeReport(payload, BTC), /STREAMS_FEED/);
  }
  // RecordOpen and ResolveRound (backup), ResolveMarketWithChainlink and UpdateMarketWithChainlink (primary).
  assert.deepEqual([...kinds].sort(), ['17ac99beddcf3a9c', '2b1e2f2f66a03c59', '629c5b230fd5d8fc', 'a572ed9e012446fe']);
  assert.deepEqual(Object.entries(feeds).map(([feed, n]) => [feed.slice(0, 10), n]).sort(), [['0x00039d9e', 17], ['0x0003b778', 6]], 'BTC/USD and SOL/USD');
  const o = decodeReport(honest, BTC);
  assert.deepEqual([o.validFromTimestamp, o.observationsTimestamp, o.expiresAt, o.price], [FRESH, FRESH, FRESH + 30 * 86400, 85535797775814930000000n]);
  assert.equal(decodeAbiParameters(envelope, honest)[2].length, 6, 'six signatures');
});

test('a copy is taken from whichever source has posted it, the primary first, as soon as it lands; another feed is passed over', async t => {
  const c = clock(t, FRESH + 0.5), both = endpoint(FRESH);
  await assert.rejects(both.harvester.report(BTC, FRESH), error => error.message === 'STREAMS_NO_COVERING_REPORT' && classify(error).class === 'retry');
  c.now = FRESH + 1;
  const found = await both.harvester.report(BTC, FRESH);
  assert.equal(found.payload, honest); assert.deepEqual(found.observation, decodeReport(honest, BTC));
  assert.deepEqual(both.calls.slice(-2), [`getSignaturesForAddress ${JUPITER}`, signature(FRESH, '5P6f5mmg')], 'the primary had it: one page, one transaction');
  // The primary quiet: the backup's copy. The SOL/USD copy before it in the same block is read and passed over.
  const backup = endpoint(FRESH, { without: [JUPITER] });
  assert.equal((await backup.harvester.report(BTC, FRESH)).payload, honest);
  assert.deepEqual(backup.reads(), [signature(FRESH, '5RY5ZsaK'), signature(FRESH, '3f4E4Tjo')]);
  // Which source supplied the copy, for the status line: a primary that stops shows there, not only once both have.
  assert.deepEqual([both.harvester.served(BTC), backup.harvester.served(BTC)], [{ primary: Date.now(), backup: null }, { primary: null, backup: Date.now() }]);
});

test('a report is taken only from the four methods that verify it: a third party\'s transaction naming a source is passed over', async t => {
  const c = clock(t, FRESH + 2);
  // Signed for nothing, and passing every local check of the copy: the expiry moved to the boundary itself.
  const bad = edit(honest, body => { body[5] = FRESH; });
  assert(covers(decodeReport(bad, BTC), FRESH) && decodeReport(bad, BTC).expiresAt === FRESH);
  for (const [name, how] of Object.entries({ 'a program of its own': {}, 'another method of the backup\'s program': { program: BACKUP, method: '2b87135d0ee183bc' } })) {
    const e = endpoint(FRESH, { added: [planted(name, FRESH - 3, [JUPITER, BACKUP], bad, how)] });
    assert.equal((await e.harvester.report(BTC, FRESH)).payload, honest, name);
  }
  // Taken, it would have kept the boundary from being published at all (STREAMS_BOUNDARY_WINDOW once Base is past
  // the boundary, five minutes per try) and both rounds would have been voided.
  c.now = FRESH - 5; const s = await deployment(FRESH, endpoint(FRESH, { added: [planted('keeper', FRESH - 3, [JUPITER, BACKUP], bad)] }));
  await s.run(c, FRESH + 40);
  assert.deepEqual(s.sent.filter(x => x.fn === 'publishBoundary').map(x => x.args[2]), [honest]); assert(s.round(FRESH).openedAt > 0);
});

test('an answer no Solana transaction can be (more instruction data than 1,232 bytes) is passed over undecoded', async t => {
  clock(t, FRESH + 2);
  const target = signature(FRESH, '5P6f5mmg'), report = tx => tx.transaction.message.instructions.find(i => { try { return reportOf(i.data); } catch { return false; } });
  // 16 KiB out of 781 bytes: one literal byte, then 256 copies of up to 64 bytes at offset 1.
  const bomb = Buffer.concat([varint(16384), Buffer.from([0, 0x41]), ...Array.from({ length: 256 }, (_, i) => Buffer.from([(i === 255 ? 62 : 63) << 2 | 2, 1, 0]))]);
  const e = endpoint(FRESH, { without: [BACKUP], change: tx => { if (tx.transaction.signatures[0] === target) { const genuine = report(tx);
    tx.transaction.message.instructions = [...Array(900).fill({ ...genuine, data: instruction(decode58(genuine.data).subarray(0, 8), bomb) }), genuine]; } return tx; } });
  assert.equal((await e.harvester.report(BTC, FRESH)).payload, honest);
  assert.deepEqual(e.reads(), [target, signature(FRESH, 'Q3e8X83D')], 'not even the genuine copy after the bombs is taken: the next transaction\'s is');
});

test('two copies with different signature subsets are one report; asked again, the harvester offers the next copy', async t => {
  clock(t, SUBSETS + 3); const { harvester } = endpoint(SUBSETS);
  const [first, second, third, fourth] = [await harvester.report(BTC, SUBSETS), await harvester.report(BTC, SUBSETS), await harvester.report(BTC, SUBSETS), await harvester.report(BTC, SUBSETS)];
  assert.equal(first.payload, copyIn(SUBSETS, '5hQ7pbCJ')); assert.equal(second.payload, copyIn(SUBSETS, '34zd9Vf1'));
  assert.deepEqual([third.payload, fourth.payload], [first.payload, second.payload], 'and round again');
  assert.notEqual(first.payload, second.payload);
  // The same report context and body (so the same price and report hash on Base); only the signatures differ.
  const [a, b] = [first, second].map(copy => decodeAbiParameters(envelope, copy.payload));
  assert.deepEqual(a.slice(0, 2), b.slice(0, 2)); assert.notDeepEqual(a.slice(2, 4), b.slice(2, 4));
  assert.deepEqual(first.observation, second.observation);
  // The backup's copy first (the primary had posted nothing yet), then refused: the primary's, there by now, is next.
  const quiet = [JUPITER], { harvester: later } = endpoint(SUBSETS, { without: quiet });
  assert.equal((await later.report(BTC, SUBSETS)).payload, second.payload);
  quiet.length = 0; assert.equal((await later.report(BTC, SUBSETS)).payload, first.payload);
});

test('a copy posted late is found when it lands; the copy of an earlier report before it is passed over; nothing is read twice', async t => {
  const c = clock(t, LATE + 80), e = endpoint(LATE);
  await assert.rejects(e.harvester.report(BTC, LATE), /^Error: STREAMS_NO_COVERING_REPORT$/); // +76: the report of LATE - 300
  assert(covers(decodeReport(copyIn(LATE, '3gCgnf7W'), BTC), LATE - 300));
  c.now = LATE + 95; await assert.rejects(e.harvester.report(BTC, LATE), /STREAMS_NO_COVERING_REPORT/); // +78 CreateMarket, +86 CloseMarket2
  c.now = LATE + 101;
  const found = await e.harvester.report(BTC, LATE);
  assert.equal(found.payload, copyIn(LATE, '4yHtukbf')); assert.equal(found.observation.observationsTimestamp, LATE);
  assert.deepEqual(e.reads(), ['3gCgnf7W', '5fgVg67A', '2BmQ5nPh', '4yHtukbf'].map(prefix => signature(LATE, prefix)));
});

test('a listed transaction the endpoint does not serve is asked again twice, then passed over: it cannot hide the copy after it', async t => {
  clock(t, LATE + 110);
  const unserved = ['3gCgnf7W', '5fgVg67A', '2BmQ5nPh', '4yHtukbf'].map(prefix => signature(LATE, prefix));
  const e = endpoint(LATE, { change: tx => unserved.includes(tx.transaction.signatures[0]) ? null : tx });
  for (let i = 0; i < 3; i++) await assert.rejects(e.harvester.report(BTC, LATE), /^Error: STREAMS_NO_COVERING_REPORT$/);
  assert.equal((await e.harvester.report(BTC, LATE)).payload, copyIn(LATE, '4xER7e5u'));
  assert.deepEqual(e.reads(), [...unserved, ...unserved, ...unserved, signature(LATE, '4xER7e5u')]);
});

test('a boundary hours old is searched back through pages of 1,000; one older than the history searched is named as such', async t => {
  clock(t, LATE + 3 * 3600); const e = endpoint(LATE, { newer: 1100 });
  assert.equal((await e.harvester.report(BTC, LATE)).payload, copyIn(LATE, '4yHtukbf'));
  assert.deepEqual(e.calls.filter(call => call.startsWith('get')), [...Array(3).fill(`getSignaturesForAddress ${JUPITER}`)], 'pages of 25, 1,000 and 1,000');
  await assert.rejects(endpoint(LATE, { newer: 3100 }).harvester.report(BTC, LATE), error => error.message === 'STREAMS_SOLANA_HISTORY' && classify(error).class === 'retry');
});

test('malformed instruction data is passed over and never an error: the next copy is found', async t => {
  clock(t, FRESH + 2);
  const target = signature(FRESH, '5P6f5mmg'), report = tx => tx.transaction.message.instructions.find(i => { try { return reportOf(i.data); } catch { return false; } });
  const raw = decode58(report(fixtures[FRESH].transactions[target]).data), block = raw.subarray(12);
  const variants = {
    truncated: data => data.slice(0, 300),
    'not base58': data => `0${data.slice(1)}`,
    'length past the end': () => encode58(Buffer.concat([raw.subarray(0, 8), Buffer.from('ffffffff', 'hex'), block])),
    'block claims 2 GiB': () => instruction(raw.subarray(0, 8), Buffer.concat([varint(2 ** 31), block.subarray(2)])),
    'copy before the start': () => instruction(raw.subarray(0, 8), Buffer.from([0xe0, 0x07, 0x01, 0x05])),
    'not a report': () => instruction(raw.subarray(0, 8), literal(Buffer.from('not a report'))),
    'not a string': () => 42,
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const e = endpoint(FRESH, { without: [BACKUP], change: tx => { if (tx.transaction.signatures[0] === target) { const i = report(tx); i.data = mutate(i.data); } return tx; } });
    assert.equal((await e.harvester.report(BTC, FRESH)).payload, honest, name);
    assert.deepEqual(e.reads(), [target, signature(FRESH, 'Q3e8X83D')], `${name}: passed over, then the next transaction's copy`);
  }
  const shapeless = endpoint(FRESH, { without: [BACKUP], change: tx => tx.transaction.signatures[0] === target ? { transaction: { message: { instructions: 'x' } } } : tx });
  assert.equal((await shapeless.harvester.report(BTC, FRESH)).payload, honest);
  // A transaction that failed on chain is not even read: anybody can send one, with any data, to either address.
  const failed = endpoint(FRESH, { without: [BACKUP], failed: [target] });
  assert.equal((await failed.harvester.report(BTC, FRESH)).payload, honest); assert.deepEqual(failed.reads(), [signature(FRESH, 'Q3e8X83D')]);
});

test('a refusing endpoint is left alone as long as it asks (at most a minute), else 1 s doubling to 15 s; provider text never becomes a code', async t => {
  const c = clock(t, FRESH + 2), secret = 'https://rpc.example/KEY-123';
  let refuse = [];
  const e = endpoint(FRESH, { answer: () => refuse.shift()?.() });
  const fails = async code => { const asked = e.calls.length; await assert.rejects(e.harvester.report(BTC, FRESH), error => error.message === code && classify(error).class === 'retry'); return e.calls.length - asked; };
  refuse = [() => new Response(secret, { status: 429, headers: { 'retry-after': '3' } })];
  assert.equal(await fails('STREAMS_SOLANA_HTTP_429'), 1);
  c.now += 2.9; assert.equal(await fails('STREAMS_SOLANA_HTTP_429'), 0, 'not asked while it said to wait');
  c.now += 0.1; assert.equal((await e.harvester.report(BTC, FRESH)).payload, honest);
  // Without Retry-After: 1 s, then 2 s. Every kind of failure has its fixed code.
  refuse = [() => new Response(secret, { status: 503 }), () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: secret } }))];
  assert.equal(await fails('STREAMS_SOLANA_HTTP_503'), 1); c.now += 0.9; assert.equal(await fails('STREAMS_SOLANA_HTTP_503'), 0);
  c.now += 0.1; assert.equal(await fails('STREAMS_SOLANA_RESPONSE'), 1); c.now += 1.9; assert.equal(await fails('STREAMS_SOLANA_RESPONSE'), 0);
  c.now += 0.1; refuse = [() => new Response('<html>'), () => new Response('', { status: 429, headers: { 'retry-after': '99999' } })];
  assert.equal(await fails('STREAMS_SOLANA_RESPONSE'), 1); c.now += 4;
  assert.equal(await fails('STREAMS_SOLANA_HTTP_429'), 1); c.now += 59.9; assert.equal(await fails('STREAMS_SOLANA_HTTP_429'), 0, 'Retry-After is honoured up to a minute');
  c.now += 0.1; assert.equal((await e.harvester.report(BTC, FRESH)).payload, honest);
  // Without Retry-After the pause stops doubling at 15 s, the keeper's longest wait while an opening depends on a boundary.
  refuse = Array(7).fill(() => new Response('', { status: 503 }));
  assert.equal(await fails('STREAMS_SOLANA_HTTP_503'), 1);
  for (const pause of [1, 2, 4, 8, 15, 15]) { c.now += pause - 0.1; assert.equal(await fails('STREAMS_SOLANA_HTTP_503'), 0); c.now += 0.1; assert.equal(await fails('STREAMS_SOLANA_HTTP_503'), 1, `after ${pause} s`); }
  const down = new SolanaReports({ fetchImpl: async () => { throw new Error(`connect ${secret}`); } });
  await assert.rejects(down.report(BTC, FRESH), error => error.message === 'STREAMS_SOLANA_TRANSPORT');
  assert(!JSON.stringify(new SolanaReports({ url: secret })).includes('KEY-123'));
});

test('readiness: the copy of the last five-minute boundary at least 30 s old, or a code that keeps new rounds from being created', async t => {
  const c = clock(t, FRESH + 65), e = endpoint(FRESH);
  const recent = await e.harvester.report(BTC);
  assert.equal(recent.payload, honest); assert.equal(e.calls.length, 2, 'the primary\'s first transaction after the boundary');
  assert.equal(e.harvester.latestWithin, 600);
  c.now = FRESH - 1; // the five-minute boundary before: the fixture holds none of its transactions
  const quiet = endpoint(FRESH);
  await assert.rejects(quiet.harvester.report(BTC), error => error.message === 'STREAMS_SOLANA_NO_RECENT_REPORT' && classify(error).class === 'retry');
  assert.equal(quiet.reads().length, 4, 'at most four transactions not read before, per source and call (the primary has none here)');
  // Readiness does not count as an offer: asked for that boundary itself next, the primary's copy still comes first.
  c.now = SUBSETS + 31; const { harvester } = endpoint(SUBSETS), primary = copyIn(SUBSETS, '5hQ7pbCJ');
  assert.equal((await harvester.report(BTC)).payload, primary); assert.equal((await harvester.report(BTC, SUBSETS)).payload, primary);
});

test('settings: one line selects the free source, which needs no Chainlink credentials (with them the paid client stands behind it); the paid client stays the default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-solana-'));
  try {
    const key = generatePrivateKey(), lines = { KEEPER_ADDRESS: privateKeyToAccount(key).address, KEEPER_PRIVATE_KEY: key,
      KEEPER_BASE_DAILY_BUDGET_WEI: '20000000000000000', KEEPER_HORIZEN_DAILY_BUDGET_WEI: '4000000000000000' };
    const load = async change => { const path = join(directory, 'settings'); await rm(path, { force: true });
      await writeFile(path, Object.entries({ ...lines, ...change }).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
      return settings({ mode: '--watch', secrets: path, rehearsal: false }); };
    assert((await load({ KEEPER_REPORT_SOURCE: 'solana' })).streams instanceof SolanaReports);
    assert((await load({ KEEPER_REPORT_SOURCE: 'solana', KEEPER_SOLANA_RPC_URL: 'https://solana.example/KEY' })).streams instanceof SolanaReports);
    assert((await load({ KEEPER_REPORT_SOURCE: 'solana', KEEPER_SOLANA_RPC_URL: '' })).streams instanceof SolanaReports, 'an empty line is the public default');
    await assert.rejects(load({ KEEPER_REPORT_SOURCE: 'solana', KEEPER_SOLANA_RPC_URL: 'http://solana.example' }), error => error.message === 'KEEPER_RPC_CONFIG' && classify(error).class === 'stop');
    await assert.rejects(load({ KEEPER_REPORT_SOURCE: 'pyth' }), error => error.message === 'KEEPER_REPORT_SOURCE' && classify(error).class === 'stop');
    await assert.rejects(load({}), /STREAMS_USERNAME/, 'without the line: the paid client, which needs its credentials');
    const credentials = { CHAINLINK_STREAMS_USERNAME: 'test-user', CHAINLINK_STREAMS_SECRET: 'test-only-not-a-real-secret' };
    const both = (await load({ KEEPER_REPORT_SOURCE: 'solana', ...credentials })).streams;
    assert(!(both instanceof SolanaReports) && both.latestWithin === 600 && 'chainlink' in both.served(BTC), 'the copies with the paid client behind them');
    await assert.rejects(load({ KEEPER_REPORT_SOURCE: 'solana', CHAINLINK_STREAMS_USERNAME: 'test-user' }), /STREAMS_SECRET/, 'half of the credentials is an error, not ignored');
    assert.equal((await load({ CHAINLINK_STREAMS_USERNAME: 'test-user', CHAINLINK_STREAMS_SECRET: 'test-only-not-a-real-secret' })).streams.constructor.name, 'StreamsClient');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A simulated deployment that accepts every genuine BTC copy in the fixtures (the real Base adapter verifies their
// signatures; on 2026-10-06 it accepted 24 of 24 by eth_call), with the keeper reading reports from `e`.
async function deployment(boundary, e) {
  const s = await simulate(); s.schedule(boundary); s.auth.streams = e.harvester;
  for (const { transactions } of Object.values(fixtures)) for (const tx of Object.values(transactions)) for (const i of tx.transaction.message.instructions) {
    try { const payload = reportOf(i.data); s.reports.set(payload, { feed: BTC, ...decodeReport(payload, BTC) }); } catch { /* not a BTC report */ }
  }
  const journal = s.journal(), world = {}, log = [];
  s.run = async (c, until) => { for (; c.now <= until; c.now += 1) log.push({ at: c.now - boundary, ...await step(s.access, journal, s.auth, world) }); assert.equal(s.defect, undefined); };
  return Object.assign(s, { journal, log, round: start => s.rounds.get(s.roundId(0, 900, start)), actions: () => log.flatMap(l => l.sent.map(x => x.action)),
    waits: () => new Set(log.flatMap(l => l.waiting.map(w => `${w.action}=${w.wait}`))) });
}

test('the keeper works BTC 15-minute rounds only, each boundary published from a Solana copy', async t => {
  const c = clock(t, FRESH - 5), e = endpoint(FRESH), s = await deployment(FRESH, e);
  s.rounds.delete(s.roundId(0, 900, FRESH + 1800)); // one round to create
  // Rounds of the other markets, left by an earlier build or by somebody else: an opened BTC five-minute round
  // ending at the boundary, an unopened ETH round starting there and an unopened ETH five-minute round already
  // Voidable that the journal still tracks. A keeper of all four markets would resolve, open or void each of them.
  const others = [s.seed(0, 300, FRESH - 300, FRESH - 270), s.seed(1, 900, FRESH), s.seed(1, 300, FRESH - 600)];
  s.journal.data.activeRounds[others[2]] = { asset: 1, duration: 300, start: FRESH - 600 };
  await s.run(c, FRESH + 60);
  const sent = s.actions();
  assert(sent.every(action => action === `publish:${BTC}:${FRESH}` || /^(create|open|resolve):0:900:/.test(action)), sent.join(' '));
  for (const action of [`publish:${BTC}:${FRESH}`, `open:0:900:${FRESH}`, `resolve:0:900:${FRESH - 900}`, `create:0:900:${FRESH + 1800}`]) assert(sent.includes(action), action);
  assert.equal(s.published.get(`${BTC}:${FRESH}`).observation.reportHash, decodeReport(honest, BTC).reportHash);
  assert(s.round(FRESH).openedAt > 0 && s.round(FRESH).openedAt <= FRESH + 60); assert.equal(s.round(FRESH - 900).outcome, 1);
  for (const id of others) assert.equal(s.rounds.get(id).outcome, 0);
  assert.equal(s.rounds.get(others[1]).openedAt, 0); assert(s.sent.every(x => !others.includes(x.args[0])));
  assert.deepEqual(Object.keys(s.log.at(-1).reports), ['BTC']); assert.equal(s.log.at(-1).reports.BTC.observed, FRESH);
  assert.deepEqual(Object.keys(s.log.at(-1).reports.BTC.sources), ['primary', 'backup']); assert.equal(s.log.at(-1).reports.BTC.sources.backup, null);
  assert(Date.parse(s.log.at(-1).reports.BTC.sources.primary) >= FRESH * 1000, 'the primary supplied this boundary');
  // Solana calls for the minute: few, and each transaction read once.
  assert(e.calls.length <= 30, `${e.calls.length} calls`); assert.equal(new Set(e.reads()).size, e.reads().length);
  // Five minutes on is no boundary of a market worked: the keeper idles at its 30 s pace.
  c.now = FRESH + 300; await s.run(c, FRESH + 300); assert.equal(s.log.at(-1).status, 'idle'); assert.equal(s.log.at(-1).next, 30000);
});

test('a copy that lands late is still published inside the opening window; until then the boundary waits, it is not an error', async t => {
  const c = clock(t, LATE - 3), e = endpoint(LATE), s = await deployment(LATE, e);
  await s.run(c, LATE + 160);
  const publishedAt = s.log.find(l => l.sent.some(x => x.action === `publish:${BTC}:${LATE}`)).at;
  assert(publishedAt >= 101 && publishedAt <= 116, `published at +${publishedAt}`);
  assert(s.waits().has(`publish:${BTC}:${LATE}=STREAMS_NO_COVERING_REPORT`));
  assert(s.round(LATE).openedAt > 0 && s.round(LATE).openedAt <= LATE + 160); assert.equal(s.round(LATE - 900).outcome, 1);
  // The miss is retried with backoff (at most 15 s apart while the opening window is open), not polled every tick.
  assert(e.calls.filter(call => call.startsWith('getSignaturesForAddress')).length <= 40, `${e.calls.length} calls`);
  // Readiness takes the copy of the last five-minute boundary, here this one's from 162 s ago: a new round is still created.
  s.rounds.delete(s.roundId(0, 900, LATE + 1800)); c.now = LATE + 162;
  assert.deepEqual((await step(s.access, s.journal, s.auth, {})).sent.map(x => x.action), [`create:0:900:${LATE + 1800}`]);
});

test('an endpoint that lies is refused by the Base adapter before anything is signed; the other source\'s copy is published', async t => {
  const c = clock(t, FRESH - 2), e = endpoint(FRESH, { change: tx => tx.transaction.message.accountKeys[0] === JUPITER ? lie(tx) : tx }), s = await deployment(FRESH, e);
  const forged = forge(honest);
  assert.equal(decodeReport(forged, BTC).price, decodeReport(honest, BTC).price + 10n ** 18n); assert(covers(decodeReport(forged, BTC), FRESH), 'every local check passes');
  await s.run(c, FRESH + 40);
  // The stand-in adapter knows only genuine copies (the real one answered a changed price digit with BadVerification).
  assert(s.waits().has(`publish:${BTC}:${FRESH}=REVERT_INVALID_ORACLE_RESPONSE`));
  const publications = s.sent.filter(x => x.fn === 'publishBoundary');
  assert.deepEqual(publications.map(x => x.args[2]), [honest]); assert(s.round(FRESH).openedAt > 0);
  // Lying about every copy: nothing is ever signed, the keeper goes on, and the round nobody could open is voided.
  c.now = FRESH - 2; const v = await deployment(FRESH, endpoint(FRESH, { change: lie }));
  await v.run(c, FRESH + 215);
  assert.equal(v.sent.filter(x => x.fn === 'publishBoundary').length, 0); assert(v.waits().has(`publish:${BTC}:${FRESH}=REVERT_INVALID_ORACLE_RESPONSE`));
  assert.equal(v.round(FRESH).outcome, 3, 'voided after its opening window'); assert.equal(v.round(FRESH - 900).outcome, 0, 'and the closing round still waits for a price');
});

test('a copy that lands after the opening window is still looked for every 15 s, and the round it closes is resolved', async t => {
  // The primary's copies 230 s late: the opening is lost, the closing price is not (the round is Voidable from +361).
  const moved = Object.fromEntries(['4yHtukbf', '4xER7e5u'].map(prefix => [signature(LATE, prefix), LATE + 230]));
  const c = clock(t, LATE - 3), s = await deployment(LATE, endpoint(LATE, { moved }));
  await s.run(c, LATE + 300);
  const publishedAt = s.log.find(l => l.sent.some(x => x.action === `publish:${BTC}:${LATE}`))?.at;
  assert(publishedAt >= 230 && publishedAt <= 245, `published at +${publishedAt}`);
  assert.equal(s.round(LATE).openedAt, 0); assert.equal(s.round(LATE - 900).outcome, 1, 'resolved');
});

test('with Chainlink credentials too, a boundary no copy has served 60 s after it is published from the paid API', async t => {
  // Filler: 200 successful transactions that only name both sources, ahead of their copies (one signature fee each).
  // Read four per source and call, they would hold the copies back past the opening window.
  const filler = Array.from({ length: 200 }, (_, i) => planted(`filler ${i}`, FRESH, [JUPITER, BACKUP], '0x00'));
  const c = clock(t, FRESH - 5), e = endpoint(FRESH, { added: filler }), s = await deployment(FRESH, e);
  s.auth.streams = withFallback(e.harvester, new StreamsClient({ username: s.username, secret: s.secret, fetchImpl: s.streamsFetch, clock: () => Date.now() }));
  await s.run(c, FRESH + 120);
  const publications = s.sent.filter(x => x.fn === 'publishBoundary'), publishedAt = s.log.find(l => l.sent.some(x => x.action === `publish:${BTC}:${FRESH}`))?.at;
  assert.equal(publications.length, 1); assert.notEqual(publications[0].args[2], honest, 'the paid report');
  assert(publishedAt >= 60 && publishedAt <= 75, `published at +${publishedAt}`);
  assert(s.round(FRESH).openedAt > 0); assert.equal(s.round(FRESH - 900).outcome, 1);
  assert(s.log.at(-1).reports.BTC.sources.chainlink && s.log.at(-1).reports.BTC.sources.primary === null);
  assert(s.streams.requests.length <= 6, `${s.streams.requests.length} paid requests`);
});
