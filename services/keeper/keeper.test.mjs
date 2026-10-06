import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, chmod, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { authentication, StreamsClient, decodeReport, validateBoundary } from './streams.mjs';
import { chooseAction, schedules, orderedActions } from './lifecycle.mjs';
import { Journal, privateFile, validateJournal, spent } from './journal.mjs';
import { validateReceipt, sendOnce, reconcile, held } from './chain.mjs';
import { options, discover, step } from './main.mjs';
import { classify } from './errors.mjs';
import { simulate, ETH } from './sim.mjs';
const feed = `0x0003${'1'.repeat(60)}`;
const secret = 'test-only-not-a-real-secret';
const docs = await readFile(new URL('../../research/chainlink-streams-base.md', import.meta.url), 'utf8');
const fixtures = JSON.parse(docs.match(/```json\n([\s\S]*?)\n```/)[1]);
const btc = fixtures.find(x => x.feedId.startsWith('0x00039d9e'));
const observation = decodeReport(btc.payload, btc.feedId);
// A journal as the keeper holds it in memory (schema 2), for tests that never touch the disk.
const book = (transactions = []) => ({ data: { transactions, activeRounds: {}, nonces: {}, spent: {}, attempts: {} }, save: async () => {} });

test('HMAC binds the exact historical path, username and millisecond clock', () => {
  const path = `/api/v1/reports?feedID=${feed}&timestamp=1791100805`;
  const headers = authentication(path, 'test-user', secret, 1791100805000);
  assert.equal(headers.Authorization, 'test-user'); assert.equal(headers['X-Authorization-Timestamp'], '1791100805000');
  // Independently calculated with Python hashlib/hmac, not the implementation under test.
  assert.equal(headers['X-Authorization-Signature-SHA256'], 'de9f66207747acbe83972400e8fa8fbfef935845689d2c51384d3c804bb00ee4');
  for (const args of [[path + '&destination=evil', 'test-user', secret], [path, 'bad\nheader', secret], [path, 'test-user', 'short'], [path, 'test-user', secret, NaN]]) assert.throws(() => authentication(...args));
  assert.notEqual(authentication(path, 'test-user', secret, 1791100805001)['X-Authorization-Signature-SHA256'], headers['X-Authorization-Signature-SHA256']);
});

test('genuine report decoding preserves every price atom and rejects alternate envelopes', () => {
  assert.equal(observation.price, 85106875216891330000000n); assert.equal(observation.decimals, 18);
  assert.throws(() => decodeReport(btc.payload + '00', btc.feedId));
  assert.throws(() => decodeReport(btc.payload, feed));
  assert.throws(() => decodeReport(`0x${'00'.repeat(16385)}`, btc.feedId));
});

test('exact boundary containment, no future observation, expiry and fixed maximum window', () => {
  validateBoundary(observation, 1791100805, 1791100805);
  validateBoundary(observation, 1791100805, observation.expiresAt);
  for (const [o, boundary, now, window] of [
    [observation, 1791100804, 1791100805, 60], [observation, 1791100806, 1791100806, 60],
    [observation, 1791100805, 1791100804, 60], [observation, 1791100805, observation.expiresAt + 1, 60],
    [observation, 1791100805, 1791100805, 61],
  ]) assert.throws(() => validateBoundary(o, boundary, now, window));
});

function client(responseFactory, seen = []) {
  return new StreamsClient({ username: 'test-user', secret, clock: () => 1791100805000,
    fetchImpl: async (url, init) => { seen.push({ url, init }); return responseFactory(); } });
}
const successful = () => new Response(JSON.stringify({ report: { feedID: btc.feedId, validFromTimestamp: observation.validFromTimestamp,
  observationsTimestamp: observation.observationsTimestamp, fullReport: btc.payload } }), { status: 200 });

test('report client uses only fixed official HTTPS origin, denies redirects and checks metadata against signed body', async () => {
  const seen = []; const report = await client(successful, seen).report(btc.feedId, 1791100805);
  assert.equal(report.observation.price, observation.price);
  assert.equal(seen[0].url, `https://api.dataengine.chain.link/api/v1/reports?feedID=${btc.feedId}&timestamp=1791100805`);
  assert.equal(seen[0].init.redirect, 'error'); assert.equal(seen[0].init.cache, 'no-store');
  assert(!seen[0].url.includes(secret)); assert(!JSON.stringify(client(successful)).includes(secret));
  await assert.rejects(client(() => new Response(JSON.stringify({ report: { feedID: btc.feedId, validFromTimestamp: 0, observationsTimestamp: 0, fullReport: btc.payload } }))).report(btc.feedId, 1791100805), /STREAMS_RESPONSE_TIMESTAMPS/);
});

test('report errors never echo response bodies or nested transport secrets', async () => {
  for (const code of [301, 401, 403, 404, 429, 503]) await assert.rejects(client(() => new Response(secret, { status: code })).report(btc.feedId), error => error.message === `STREAMS_HTTP_${code}` && !error.message.includes(secret));
  await assert.rejects(client(() => { throw Error(secret); }).report(btc.feedId), /STREAMS_TRANSPORT/);
  await assert.rejects(client(() => new Response('x'.repeat(131073))).report(btc.feedId), /STREAMS_RESPONSE/);
  await assert.rejects(client(() => new Response('{}', { headers: { 'content-length': '999999' } })).report(btc.feedId), /STREAMS_RESPONSE/);
});

test('round lifecycle respects exact deadlines and never substitutes a late price', () => {
  const r = { start: 900, end: 1200, openingDeadline: 1110, voidableAfter: 1560, openedAt: 0, phase: 2 };
  assert.equal(chooseAction(r, 899, false, false), null);
  assert.equal(chooseAction(r, 900, false, false).kind, 'publish');
  assert.equal(chooseAction(r, 1110, true, true).kind, 'open');
  assert.equal(chooseAction(r, 1111, true, true).kind, 'void');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 3 }, 1199, false, false), null);
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 1200, false, true).kind, 'await-delivery');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 4860, true, true).kind, 'resolve');
  // New registry: resolution has no deadline. A cached closing price resolves however late; a missing one is
  // still published.
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 4861, true, true).kind, 'resolve');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 1561, false, false).kind, 'publish');
  // Voidable (phase 8) on an opened round says nothing is cached 60 s + voidGrace after its end. It is still worked
  // for its true result, exactly like a round awaiting resolution, and voided only once the keeper gives it up
  // (main.mjs, step). A round nobody opened in time is voided at once, as before.
  const overdue = { ...r, openedAt: 920, phase: 8 };
  assert.deepEqual([[false, false], [false, true], [true, true]].map(([cache, base]) => chooseAction(overdue, 1561, cache, base).kind), ['publish', 'await-delivery', 'resolve']);
  assert.deepEqual(chooseAction(overdue, 1561, false, false, true), { kind: 'void', deadline: Number.MAX_SAFE_INTEGER, boundary: r.end });
  assert.equal(chooseAction(overdue, 1561, false, true, true).kind, 'void', 'given up while Base holds the price: its delivery did not arrive');
  assert.equal(chooseAction(overdue, 1561, true, false, true).kind, 'resolve', 'a cached price is resolved, whatever was decided before');
  assert.equal(chooseAction({ ...r, phase: 8 }, 1561, false, false).kind, 'void');
  assert.equal(chooseAction({ ...r, phase: 6 }, 5000, true, true), null);
  assert.equal(chooseAction({ ...r, phase: 0 }, 880, false, false), null);
});

test('scheduler covers both assets/durations with aligned rounds, prioritizing imminent evidence', () => {
  const rows = schedules(1791100805);
  assert(rows.every(r => r.start % r.duration === 0));
  assert.equal(new Set(rows.map(r => `${r.asset}:${r.duration}:${r.start}`)).size, rows.length);
  assert.equal(new Set(rows.map(r => `${r.asset}:${r.duration}`)).size, 4);
  assert.equal(orderedActions([{ kind: 'create', deadline: 10, boundary: 10 }, { kind: 'open', deadline: 20, boundary: 1 }])[0].kind, 'open');
  const backlog = Array.from({ length: 100 }, (_, i) => ({ kind: 'void', deadline: Number.MAX_SAFE_INTEGER, boundary: i }));
  assert.equal(orderedActions([...backlog, { kind: 'create', deadline: 1000, boundary: 1000 }])[0].kind, 'create');
  for (const v of [0, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => schedules(v));
});

test('journal exclusive writer, restart, durable uncertainty and identity binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-test-'));
  try {
    const first = await Journal.acquire(directory, 'fixture-release');
    await assert.rejects(Journal.acquire(directory, 'fixture-release'));
    const f = receiptFixture(); first.data.transactions.push({ ...f.record, chain: 'base', key: 'publish:fixture', maximumFeeWei: '2700000', status: 'signed' }); await first.save(); await first.close();
    const second = await Journal.acquire(directory, 'fixture-release'); assert.equal(second.data.transactions[0].status, 'signed');
    // Attempt counters expire after a day, except while a hash they numbered is still open (its key must stay unique).
    Object.assign(second.data.attempts, { 'publish': { count: 1, reverts: 0, last: 1 }, 'open:old': { count: 3, reverts: 1, last: 1 } }); await second.save();
    assert.deepEqual(Object.keys(second.data.attempts), ['publish']); await second.close();
    await assert.rejects(Journal.acquire(directory, 'different-release'), /KEEPER_JOURNAL_IDENTITY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('credential file loader rejects permissive files and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-file-test-'));
  try {
    const path = join(directory, 'local'); await writeFile(path, 'ONLY_TEST_DATA=yes', { mode: 0o600 });
    assert.equal((await privateFile(path)).toString(), 'ONLY_TEST_DATA=yes');
    await chmod(path, 0o644); await assert.rejects(privateFile(path), /KEEPER_SECRET_PERMISSIONS/);
    await chmod(path, 0o600); await symlink(path, join(directory, 'link')); await assert.rejects(privateFile(join(directory, 'link')));
    // A link, a missing file and a file this user cannot open get the same fixed code as a wrong mode: the operator's first-run mistakes.
    for (const name of ['link', 'missing']) await assert.rejects(privateFile(join(directory, name)), error => error.message === 'KEEPER_SECRET_PERMISSIONS');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function receiptFixture() {
  const hash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`, from = `0x${'1'.repeat(40)}`, to = `0x${'2'.repeat(40)}`;
  const transaction = { type: 'eip1559', chainId: 8453, nonce: 2, to, data: '0x01020304', value: '0', gas: '300000', maxFeePerGas: '9', maxPriorityFeePerGas: '1' };
  return { record: { hash, from, transaction }, receipt: { transactionHash: hash, status: 'success', blockHash, blockNumber: 90n },
    tx: { ...transaction, gas: 300000n, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n, hash, from, blockHash, blockNumber: 90n, value: 0n, input: transaction.data }, block: { hash: blockHash, number: 90n } };
}
test('keeper receipts require canonical three-confirmation exact transactions', () => {
  let f = receiptFixture(); validateReceipt(f.receipt, f.tx, f.block, 92n, f.record);
  for (const mutate of [f => f.receipt.blockHash = `0x${'0'.repeat(64)}`, f => f.tx.value = 1n, f => f.tx.nonce++, f => f.tx.chainId = 1,
    f => f.tx.input = '0xffff', f => f.block.number++, f => f.tx.maxFeePerGas++, f => f.tx.from = f.tx.to, f => f.receipt.status = 'pending']) {
    f = receiptFixture(); mutate(f); assert.throws(() => validateReceipt(f.receipt, f.tx, f.block, 92n, f.record));
  }
  f = receiptFixture(); assert.throws(() => validateReceipt(f.receipt, f.tx, f.block, 91n, f.record));
  f.receipt.status = 'reverted'; validateReceipt(f.receipt, f.tx, f.block, 92n, f.record);
});

test('persisted accounting rejects corrupt negative, zero, missing or understated reservations', () => {
  const make = () => ({ schemaVersion: 2, identity: 'fixture', activeRounds: {}, nonces: { base: 2 }, spent: { base: { 497500: '2700000' } }, attempts: { 'publish:fixture': { count: 1, reverts: 0, last: 1791100805 } },
    transactions: [{ ...receiptFixture().record, chain: 'base', key: 'publish:fixture:1', maximumFeeWei: '2700000', status: 'signed' }] });
  validateJournal(make(), 'fixture');
  // Caps are wei now: the only gas bound left is the chain's own 2^24 per-transaction limit.
  for (const mutate of [r => r.maximumFeeWei = '-1000000000000000', r => r.maximumFeeWei = '0', r => delete r.maximumFeeWei,
    r => r.maximumFeeWei = '2699999', r => r.transaction.chainId = 1, r => r.transaction.value = '1', r => r.transaction.nonce = -1,
    r => r.transaction.gas = '16777217', r => r.transaction.maxPriorityFeePerGas = '10', r => r.hash = 'bad',
    r => r.maximumFeeWei = '12500000000000001', r => r.status = 'unknown']) {
    const data = make(); mutate(data.transactions[0]); assert.throws(() => validateJournal(data, 'fixture'));
  }
  for (const mutate of [d => d.schemaVersion = 1, d => d.spent.base[497500] = '-5', d => d.spent.base[497500] = 2700000, d => d.spent.solana = {},
    d => d.nonces.base = -1, d => d.attempts['publish:fixture'].reverts = -1, d => delete d.attempts]) {
    const data = make(); mutate(data); assert.throws(() => validateJournal(data, 'fixture'));
  }
});

test('canonical revert consumes its original budget/nonce and permits restart without resubmission', async () => {
  const f = receiptFixture(); f.receipt.status = 'reverted';
  const record = { ...f.record, chain: 'base', key: 'open:fixture:1', status: 'submitted', maximumFeeWei: '2700000' };
  let saves = 0;
  const reader = { getTransactionReceipt: async () => f.receipt,
    getTransaction: async () => f.tx, getBlock: async () => ({ ...f.block, timestamp: 1791100805n }), getBlockNumber: async () => 92n };
  const journal = { ...book([record]), save: async () => { saves++; } };
  journal.data.attempts['open:fixture'] = { count: 1, reverts: 0, last: 0 };
  await reconcile({ clients: { base: reader } }, journal, 'base');
  assert.equal(record.status, 'reverted'); assert.equal(record.maximumFeeWei, '2700000'); assert.equal(record.transaction.nonce, 2); assert.equal(saves, 1);
  // The revert stays charged to the rolling budget (under the hour of its block, whatever the host clock says), the
  // nonce is accounted for, and the attempt is counted for a bounded retry.
  assert.equal(spent(journal.data, 'base', 1791100805000), 2700000n); assert.deepEqual(journal.data.spent.base, { [Math.floor(1791100805 / 3600)]: '2700000' }); assert.equal(journal.data.nonces.base, 3); assert.equal(journal.data.attempts['open:fixture'].reverts, 1);
  for (const method of Object.keys(reader)) reader[method] = async () => { throw Error('must not look up or re-submit an already final receipt'); };
  await reconcile({ clients: { base: reader } }, journal, 'base'); assert.equal(saves, 1);
});

test('persisted create intent remains discoverable after a crash and a long restart gap', async t => {
  const now = 1791200805, old = Math.floor((now - 86400) / 300) * 300; t.mock.method(Date, 'now', () => now * 1000);
  const seen = [];
  const access = { clients: { horizen: { getBlock: async () => ({ timestamp: BigInt(now), number: 10n, hash: 'fixture-block' }) } },
    config: { feeds: { btcFeedId: feed, ethFeedId: feed } },
    read: async (_, fn, args) => {
      if (fn === 'roundIdFor') { seen.push(Number(args[2])); return `0x${BigInt(args[2]).toString(16).padStart(64, '0')}`; }
      if (fn === 'phase') return Number(BigInt(args[0])) === old ? 8 : 0;
      return { asset: 0, duration: 300, start: BigInt(old), end: BigInt(old + 300), openedAt: 0n, openingDeadline: BigInt(old + 210), voidableAfter: BigInt(old + 300 + 60 + 300) };
    } };
  const result = await discover(access, { old: { asset: 0, duration: 300, start: old } });
  assert(seen.includes(old)); assert.equal(chooseAction(result.rounds.find(r => r.start === old), now, false, false).kind, 'void');
});

test('uncertain and duplicate submissions stop before signer or RPC access', async () => {
  const access = {}, account = {}, call = { chain: 'base', value: 0n };
  // The attempt number comes from the journal; a record already holding that key means the journal contradicts itself.
  await assert.rejects(sendOnce(access, book([{ key: 'same:1', status: 'confirmed' }]), account, call, 'same', {}), /KEEPER_DUPLICATE_INTENT/);
  // A hash that may still be on its way holds its own chain's lane (try again later), and only that chain's.
  const pending = { key: 'older:1', chain: 'base', status: 'submitted', preparedAt: new Date().toISOString(), transaction: { nonce: 1 } };
  await assert.rejects(sendOnce(access, book([pending]), account, call, 'new', {}), /KEEPER_TX_PENDING/);
  assert.equal(classify(Error('KEEPER_TX_PENDING')).class, 'retry'); assert.equal(classify(Error('KEEPER_DUPLICATE_INTENT')).class, 'stop');
  assert.equal(held(book([pending]).data, 'base'), true); assert.equal(held(book([pending]).data, 'horizen'), false);
  // Seen in a block, or older than the hold: the lane is free again (the old "uncertain forever" stop is gone).
  assert.equal(held(book([{ ...pending, status: 'mined' }]).data, 'base'), false);
  assert.equal(held(book([{ ...pending, preparedAt: new Date(Date.now() - 21000).toISOString() }]).data, 'base'), false);
});

test('after the durable hash only a local stall check stands before the send; a changed signer stops before signing', async t => {
  let now = 1800000000000; t.mock.method(Date, 'now', () => now);
  const abi = parseAbi(['function voidRound(bytes32 roundId)']);
  const from = `0x${'1'.repeat(40)}`, to = `0x${'2'.repeat(40)}`;
  // Public invalid transaction bytes; never submitted. Like a real signature they differ whenever the transaction does
  // (here: its bid), because the same bytes signed again are the same transaction to the keeper, not a new attempt.
  const signedFixture = transaction => `0x01020304${transaction.maxFeePerGas.toString(16).padStart(16, '0')}`;
  const world = (accountCode = '0x', readTime = 0) => {
    const state = { signed: 0, sent: 0, bytes: [] };
    const signer = { address: from, signTransaction: async transaction => { state.signed++; state.bytes.push(signedFixture(transaction)); return state.bytes.at(-1); } };
    const horizen = { getBlock: async () => ({ timestamp: BigInt(now / 1000), baseFeePerGas: 1n }), getTransactionCount: async () => 2,
      getCode: async () => accountCode, estimateGas: async () => { now += readTime; return 100000n; }, estimateMaxPriorityFeePerGas: async () => 1n,
      readContract: async () => { now += readTime; return 0n; }, getBalance: async () => 10000000n, sendRawTransaction: async ({ serializedTransaction }) => { state.sent++; return keccak256(serializedTransaction); } };
    // Any use of the Base client while sending to Horizen is a failure of the test.
    const base = new Proxy({}, { get: () => { throw Error('a Horizen send must not touch Base'); } });
    const access = { release: { contracts: [{ name: 'StreamsRoundRegistry', address: to, chain: 'horizen', chainId: 26514 }] },
      abis: { StreamsRoundRegistry: abi }, clients: { base, horizen }, identify: async () => {} };
    const call = { chain: 'horizen', chainId: 26514, to, value: 0n, data: encodeFunctionData({ abi, functionName: 'voidRound', args: [`0x${'a'.repeat(64)}`] }) };
    return { state, send: journal => sendOnce(access, journal, signer, call, 'void:fixture', { horizen: 1000000000n }) };
  };
  // fsync stalls 9 s: the hash is durable, nothing is sent, and no RPC (on either chain) is consulted about it.
  const stalled = world(), journal = book(); let saves = 0;
  journal.save = async () => { if (++saves === 1) now += 9000; };
  await assert.rejects(stalled.send(journal), error => error.message === 'KEEPER_PRESEND_STALE' && classify(error).class === 'retry');
  assert.equal(stalled.state.signed, 1); assert.equal(stalled.state.sent, 0);
  assert.equal(journal.data.transactions[0].status, 'signed'); assert.equal(journal.data.transactions[0].hash, keccak256(stalled.state.bytes[0]));
  assert.equal(journal.data.transactions[0].transaction.nonce, 2);
  // It holds the lane for a while, without another signature ...
  await assert.rejects(stalled.send(journal), /KEEPER_TX_PENDING/); assert.equal(stalled.state.signed, 1);
  // ... and then the same nonce is signed and sent again, outbidding the withheld hash. Nothing is wedged.
  now += 21000;
  const second = await stalled.send(journal);
  assert.equal(second.status, 'submitted'); assert.equal(second.key, 'void:fixture:2'); assert.equal(second.transaction.nonce, 2);
  assert(second.transaction.maxFeePerGas * 8n >= BigInt(journal.data.transactions[0].transaction.maxFeePerGas) * 9n); assert.equal(stalled.state.sent, 1);
  // A slow endpoint is not a stall. Two round trips of 5 s each (well inside the 12 s request timeout) used to
  // count against the same 8 s, so every transaction was signed, journalled and then withheld.
  const slow = world('0x', 5000), sent = await slow.send(book());
  assert.equal(sent.status, 'submitted'); assert.equal(slow.state.sent, 1);
  // An account that is no longer a plain key (delegated code, or an endpoint answering nonsense) stops before any signature.
  for (const accountCode of ['0xef0100', null, false, 0]) {
    const changed = world(accountCode);
    await assert.rejects(changed.send(book()), error => error.message === 'KEEPER_SIGNER_CODE' && classify(error).class === 'stop');
    assert.equal(changed.state.signed, 0); assert.equal(changed.state.sent, 0);
  }
});

test('CLI defaults read-only and cannot implicitly load a signer', () => {
  assert.equal(options([]).mode, '--plan');
  assert.throws(() => options(['--watch']), /KEEPER_SECRETS_REQUIRED/);
  assert.throws(() => options(['--broadcast']), /KEEPER_MODE/);
  assert.throws(() => options(['--plan', '--private-key', secret]), /KEEPER_ARGUMENT/);
});

test('feed readiness is per feed, and a latest report newer than the Base head is normal', async t => {
  const T = 1800000000; let now = (T + 100) * 1000; t.mock.method(Date, 'now', () => now);
  const s = await simulate(); s.streams.latency = 0; // the latest report carries the current second: always ahead of Base's 2 s blocks
  const journal = s.journal(), world = {}, sent = [], waits = new Set();
  s.streams.reject = feed => feed === ETH ? 503 : null; // one feed's service is down
  s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined; // and Base cannot be read at all
  for (; now < (T + 112) * 1000; now += 1000) { const r = await step(s.access, journal, s.auth, world); sent.push(...r.sent.map(x => x.action)); for (const w of r.waiting) waits.add(`${w.action}=${w.wait}`); }
  assert(sent.length >= 4 && sent.every(a => a.startsWith('create:0:')), 'BTC rounds are scheduled although every BTC report is newer than the Base head');
  assert([...waits].some(w => /^create:1:300:\d+=STREAMS_HTTP_503$/.test(w)), 'ETH rounds wait, with the reason');
  // Readiness never reads Base: the rounds above were scheduled without one answer from it. (This used to count
  // Base requests; the status line now reads the Base head on every tick, so the dependency is tested directly.)
  assert.equal(world.heads.base, null);
  // A feed that only repeats an old report is not ready either.
  s.streams.reject = null; s.streams.latency = 300;
  const stale = await step(s.access, journal, s.auth, {});
  assert(stale.waiting.length >= 4 && stale.waiting.every(w => w.wait === 'KEEPER_STREAMS_STALE')); assert.equal(stale.sent.length, 0);
});

test('report failures are classified: outages, misses and bad responses wait; nothing about a report stops the keeper', () => {
  for (const code of [400, 401, 403, 404, 429, 500, 501, 502, 503, 504, 599]) assert.equal(classify(Error(`STREAMS_HTTP_${code}`)).class, 'retry');
  for (const code of ['STREAMS_TRANSPORT', 'KEEPER_STREAMS_STALE', 'STREAMS_REPORT_AHEAD_OF_BASE', 'STREAMS_NO_COVERING_REPORT', 'STREAMS_RESPONSE',
    'STREAMS_RESPONSE_SIZE', 'STREAMS_RESPONSE_FEED', 'STREAMS_RESPONSE_TIMESTAMPS', 'STREAMS_REPORT_INVALID', 'STREAMS_HOST_CLOCK_SKEW']) assert.equal(classify(Error(code)).class, 'retry');
  // A report that can never be valid for its boundary, or that the on-chain verifier answers differently, is skipped: not fatal.
  for (const code of ['STREAMS_BOUNDARY_WINDOW', 'KEEPER_STREAMS_AUTHENTICATION']) assert.equal(classify(Error(code)).class, 'skip');
  for (const code of [400, 401, 403]) assert.equal(classify(Error(`STREAMS_HTTP_${code}`)).code, `STREAMS_HTTP_${code}_CHECK_CREDENTIALS_AND_CLOCK`);
});

function stepAccess(now, active) {
  const ids = new Map();
  const access = { clients: { horizen: { getBlock: async () => ({ timestamp: BigInt(now), number: 10n, hash: 'test-block' }) }, base: { getBlock: async () => ({ timestamp: BigInt(now) }) } },
    config: { feeds: { btcFeedId: feed, ethFeedId: feed }, rules: { observationWindow: 60 } }, identify: async () => {},
    read: async (name, fn, args) => {
      if (fn === 'roundIdFor') {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        const id = `0x${BigInt(args[2] * 10000n + BigInt(args[0] * 1000 + args[1])).toString(16).padStart(64, '0')}`;
        ids.set(id, key); return id;
      }
      if (fn === 'phase') return active[ids.get(args[0])]?.phase ?? 0;
      if (fn === 'getObservation') return { reportHash: `0x${'0'.repeat(64)}` };
      if (fn === 'getRound') return { openedAt: 0n }; // what a Voidable round is asked: these were never opened
      throw Error('unexpected read');
    } };
  return access;
}

test('revoked entitlement during boundary fetch preserves timeout recovery and blocks new creation', async t => {
  const start = 1791100800, now = start + 20; t.mock.method(Date, 'now', () => now * 1000);
  const old = start - 600;
  const access = stepAccess(now, { [`0:300:${start}`]: { phase: 2 }, [`1:300:${old}`]: { phase: 8 } });
  // Reaching access.call means the keeper decided to make this call. Stop there: nothing is ever signed.
  const calls = []; access.call = (_, fn) => { calls.push(fn); throw Error('RECOVERY_REACHED'); };
  const auth = { streams: { report: async () => { throw Error('STREAMS_HTTP_403'); } } };
  const result = await step(access, book(), auth);
  assert.deepEqual(calls, ['voidRound']);
  // The refusal is no longer silent or global state: every waiting publication and creation says why.
  const reason = 'STREAMS_HTTP_403_CHECK_CREDENTIALS_AND_CLOCK';
  assert(result.waiting.some(w => w.action === `publish:${feed}:${start}` && w.wait === reason));
  assert(result.waiting.filter(w => w.action.startsWith('create:')).length >= 4 && result.waiting.filter(w => w.action.startsWith('create:')).every(w => w.wait === reason));
});

test('creation tracking is durably saved before entering the signing path', async t => {
  const now = 1791100805; t.mock.method(Date, 'now', () => now * 1000);
  const access = stepAccess(now, {}); const saved = [];
  const journal = book(); journal.save = async () => { saved.push(structuredClone(journal.data)); };
  // A stop at the first signing-path guard models a crash after intent tracking but before signature creation.
  access.call = () => ({ chain: 'base', value: 1n });
  const auth = { streams: { report: async () => ({ observation: { observationsTimestamp: now } }) } };
  await assert.rejects(step(access, journal, auth), /KEEPER_INTENT/);
  assert.equal(Object.keys(saved.at(-1).activeRounds).length, 1);
  assert.equal(saved.at(-1).transactions.length, 0);
});
