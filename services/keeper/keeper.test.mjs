import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, chmod, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { authentication, StreamsClient, decodeReport, validateBoundary } from './streams.mjs';
import { chooseAction, schedules, orderedActions } from './lifecycle.mjs';
import { Journal, privateFile, validateJournal } from './journal.mjs';
import { validateReceipt, sendOnce } from './chain.mjs';
import { options, preflightStreams, reconcileTransactions, discover, reportUnavailable, step } from './main.mjs';
const feed = `0x0003${'1'.repeat(60)}`;
const secret = 'test-only-not-a-real-secret';
const docs = await readFile(new URL('../../research/chainlink-streams-base.md', import.meta.url), 'utf8');
const fixtures = JSON.parse(docs.match(/```json\n([\s\S]*?)\n```/)[1]);
const btc = fixtures.find(x => x.feedId.startsWith('0x00039d9e'));
const observation = decodeReport(btc.payload, btc.feedId);

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
  const r = { start: 900, end: 1200, openingDeadline: 1110, resolutionDeadline: 4860, openedAt: 0, phase: 2 };
  assert.equal(chooseAction(r, 899, false, false), null);
  assert.equal(chooseAction(r, 900, false, false).kind, 'publish');
  assert.equal(chooseAction(r, 1110, true, true).kind, 'open');
  assert.equal(chooseAction(r, 1111, true, true).kind, 'void');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 3 }, 1199, false, false), null);
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 1200, false, true).kind, 'await-delivery');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 4860, true, true).kind, 'resolve');
  assert.equal(chooseAction({ ...r, openedAt: 920, phase: 5 }, 4861, true, true).kind, 'void');
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
    const second = await Journal.acquire(directory, 'fixture-release'); assert.equal(second.data.transactions[0].status, 'signed'); await second.close();
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
  const make = () => ({ schemaVersion: 1, identity: 'fixture', activeRounds: {}, transactions: [{ ...receiptFixture().record, chain: 'base', key: 'publish:fixture', maximumFeeWei: '2700000', status: 'signed' }] });
  validateJournal(make(), 'fixture');
  for (const mutate of [r => r.maximumFeeWei = '-1000000000000000', r => r.maximumFeeWei = '0', r => delete r.maximumFeeWei,
    r => r.maximumFeeWei = '2699999', r => r.transaction.chainId = 1, r => r.transaction.value = '1', r => r.transaction.nonce = -1,
    r => r.transaction.gas = '9999999', r => r.transaction.maxPriorityFeePerGas = '10', r => r.hash = 'bad']) {
    const data = make(); mutate(data.transactions[0]); assert.throws(() => validateJournal(data, 'fixture'));
  }
});

test('canonical revert consumes its original budget/nonce and permits restart without resubmission', async () => {
  const f = receiptFixture(); f.receipt.status = 'reverted';
  const record = { ...f.record, chain: 'base', key: 'open:fixture', status: 'submitted', maximumFeeWei: '2700000' };
  let saves = 0;
  const reader = { waitForTransactionReceipt: async () => f.receipt, getTransactionReceipt: async () => f.receipt,
    getTransaction: async () => f.tx, getBlock: async () => ({ ...f.block, timestamp: 1791100805n }), getBlockNumber: async () => 92n };
  const journal = { data: { transactions: [record] }, save: async () => { saves++; } };
  await reconcileTransactions({ readers: { base: reader } }, journal);
  assert.equal(record.status, 'reverted'); assert.equal(record.maximumFeeWei, '2700000'); assert.equal(record.transaction.nonce, 2); assert.equal(saves, 1);
  reader.waitForTransactionReceipt = async () => { throw Error('must not wait/re-submit an already final receipt'); };
  await reconcileTransactions({ readers: { base: reader } }, journal); assert.equal(saves, 1);
});

test('persisted create intent remains discoverable after a crash and a long restart gap', async t => {
  const now = 1791200805, old = Math.floor((now - 86400) / 300) * 300; t.mock.method(Date, 'now', () => now * 1000);
  const seen = [];
  const access = { clients: { horizen: { getBlock: async () => ({ timestamp: BigInt(now), number: 10n, hash: 'fixture-block' }) } },
    config: { feeds: { btcFeedId: feed, ethFeedId: feed } },
    read: async (_, fn, args) => {
      if (fn === 'roundIdFor') { seen.push(Number(args[2])); return `0x${BigInt(args[2]).toString(16).padStart(64, '0')}`; }
      if (fn === 'phase') return Number(BigInt(args[0])) === old ? 8 : 0;
      return { asset: 0, duration: 300, start: BigInt(old), end: BigInt(old + 300), openedAt: 0n, openingDeadline: BigInt(old + 210), resolutionDeadline: BigInt(old + 3960) };
    } };
  const result = await discover(access, { old: { asset: 0, duration: 300, start: old } });
  assert(seen.includes(old)); assert.equal(chooseAction(result.rounds.find(r => r.start === old), now, false, false).kind, 'void');
});

test('uncertain and duplicate submissions stop before signer or RPC access', async () => {
  const access = {}, account = {}, call = { chain: 'base', value: 0n };
  await assert.rejects(sendOnce(access, { data: { transactions: [{ key: 'same', status: 'confirmed' }] } }, account, call, 'same', {}, 10), /KEEPER_DUPLICATE_INTENT/);
  await assert.rejects(sendOnce(access, { data: { transactions: [{ key: 'older', status: 'submitted' }] } }, account, call, 'new', {}, 10), /KEEPER_UNCERTAIN_TX/);
});

test('post-fsync expiry, stale chain clocks and changed signer stop with the durable hash and no send', async t => {
  const now = 1800000000; t.mock.method(Date, 'now', () => now * 1000);
  const abi = parseAbi(['function voidRound(bytes32 roundId)']);
  const from = `0x${'1'.repeat(40)}`, to = `0x${'2'.repeat(40)}`;
  const signedFixture = '0x01020304'; // Public invalid transaction bytes; never submitted.
  for (const [mutate, code] of [
    [s => { s.baseTime = now + 11; }, 'KEEPER_PRESEND_EXPIRED'],
    [s => { s.horizenTime = now + 11; }, 'KEEPER_PRESEND_EXPIRED'],
    [s => { s.baseTime = now - 60; }, 'KEEPER_PRESEND_CLOCK'],
    [s => { s.horizenTime = now - 60; }, 'KEEPER_PRESEND_CLOCK'],
    [s => { s.latest = 3; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
    [s => { s.pending = 3; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
    [s => { s.accountCode = '0xef0100'; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
    [s => { s.accountCode = null; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
    [s => { s.accountCode = false; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
    [s => { s.accountCode = 0; }, 'KEEPER_PRESEND_SIGNER_CHANGED'],
  ]) {
    const state = { baseTime: now, horizenTime: now, latest: 2, pending: 2, accountCode: '0x' };
    let signed = 0, saved = 0;
    const signer = { address: from, signTransaction: async () => { signed++; return signedFixture; } };
    const horizen = {
      getBlock: async () => ({ timestamp: BigInt(state.horizenTime) }),
      getTransactionCount: async ({ blockTag }) => state[blockTag === 'latest' ? 'latest' : 'pending'],
      getCode: async () => state.accountCode, call: async () => ({}), estimateGas: async () => 100000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n }),
      readContract: async () => 0n, getBalance: async () => 10000000n,
    };
    const access = { release: { contracts: [{ name: 'StreamsRoundRegistry', address: to, chain: 'horizen', chainId: 26514 }] },
      abis: { StreamsRoundRegistry: abi }, clients: { base: { getBlock: async () => ({ timestamp: BigInt(state.baseTime) }) }, horizen },
      readers: {}, verify: async () => {}, config: { chains: { horizen: { rpcUrl: 'http://127.0.0.1:1' } } } };
    const journal = { data: { transactions: [] }, save: async () => { saved++; mutate(state); } };
    const call = { chain: 'horizen', chainId: 26514, to, value: 0n,
      data: encodeFunctionData({ abi, functionName: 'voidRound', args: [`0x${'a'.repeat(64)}`] }) };
    await assert.rejects(sendOnce(access, journal, signer, call, 'void:fixture', { horizen: 1000000n }, now + 10), error => error.message === code);
    assert.equal(signed, 1); assert.equal(saved, 1);
    assert.equal(journal.data.transactions[0].status, 'signed');
    assert.equal(journal.data.transactions[0].hash, keccak256(signedFixture));
    assert.equal(journal.data.transactions[0].transaction.nonce, 2);
    await assert.rejects(sendOnce(access, journal, signer, call, 'void:another', { horizen: 1000000n }, now + 10), /KEEPER_UNCERTAIN_TX/);
    assert.equal(signed, 1, 'uncertain signed intent must not be signed or submitted again');
  }
});

test('CLI defaults read-only and cannot implicitly load a signer', () => {
  assert.equal(options([]).mode, '--plan');
  assert.throws(() => options(['--watch']), /KEEPER_SECRETS_REQUIRED/);
  assert.throws(() => options(['--broadcast']), /KEEPER_MODE/);
  assert.throws(() => options(['--plan', '--private-key', secret]), /KEEPER_ARGUMENT/);
});

test('feed readiness samples a fresh source block after each independently advancing report', async () => {
  let clock = 1791100805; const events = [];
  const access = { config: { feeds: { btcFeedId: 'btc', ethFeedId: 'eth' } }, clients: { base: { getBlock: async () => { events.push('block'); return { timestamp: BigInt(clock) }; } } },
    authenticateReport: async () => ({ reportHash: observation.reportHash }) };
  const streams = { report: async f => { events.push(f); clock += 2; return { payload: 'test', observation: { ...observation, validFromTimestamp: clock, observationsTimestamp: clock } }; } };
  await preflightStreams(access, streams); assert.deepEqual(events, ['btc', 'block', 'eth', 'block']);
  access.clients.base.getBlock = async () => ({ timestamp: BigInt(clock - 1) });
  await assert.rejects(preflightStreams(access, streams), /KEEPER_STREAMS_AHEAD/);
});

test('report outage classification covers revoked entitlement and all server failures', () => {
  for (const code of [401, 403, 404, 429, 500, 501, 502, 503, 504, 599]) assert(reportUnavailable(Error(`STREAMS_HTTP_${code}`)));
  for (const code of ['STREAMS_TRANSPORT', 'KEEPER_STREAMS_STALE', 'KEEPER_STREAMS_AHEAD']) assert(reportUnavailable(Error(code)));
  for (const code of ['STREAMS_HTTP_200', 'STREAMS_HTTP_400', 'STREAMS_RESPONSE', 'KEEPER_STREAMS_AUTHENTICATION']) assert.equal(reportUnavailable(Error(code)), false);
});

function stepAccess(now, active) {
  const ids = new Map();
  const access = { clients: { horizen: { getBlock: async () => ({ timestamp: BigInt(now), number: 10n, hash: 'test-block' }) } },
    config: { feeds: { btcFeedId: feed, ethFeedId: feed } },
    read: async (name, fn, args) => {
      if (fn === 'roundIdFor') {
        const key = `${args[0]}:${args[1]}:${args[2]}`;
        const id = `0x${BigInt(args[2] * 10000n + BigInt(args[0] * 1000 + args[1])).toString(16).padStart(64, '0')}`;
        ids.set(id, key); return id;
      }
      if (fn === 'phase') return active[ids.get(args[0])]?.phase ?? 0;
      if (fn === 'getRound') return active[ids.get(args[0])];
      if (fn === 'getObservation') return { reportHash: `0x${'0'.repeat(64)}` };
      throw Error('unexpected read');
    } };
  return access;
}

test('revoked entitlement during boundary fetch preserves timeout recovery and blocks new creation', async t => {
  const start = 1791100800, now = start + 20; t.mock.method(Date, 'now', () => now * 1000);
  const old = start - 600;
  const access = stepAccess(now, {
    [`0:300:${start}`]: { asset: 0, duration: 300, start: BigInt(start), end: BigInt(start + 300), phase: 2, openedAt: 0n, openingDeadline: BigInt(start + 210), resolutionDeadline: BigInt(start + 3960) },
    [`1:300:${old}`]: { asset: 1, duration: 300, start: BigInt(old), end: BigInt(old + 300), phase: 8, openedAt: 0n, openingDeadline: BigInt(old + 210), resolutionDeadline: BigInt(old + 3960) },
  });
  const calls = []; access.call = (_, fn) => { calls.push(fn); throw Error('RECOVERY_REACHED'); };
  const journal = { data: { transactions: [], activeRounds: {} }, save: async () => {} };
  const auth = { freshReports: true, streams: { report: async () => { throw Error('STREAMS_HTTP_403'); } } };
  await assert.rejects(step(access, journal, auth), /RECOVERY_REACHED/);
  assert.equal(auth.freshReports, false); assert.deepEqual(calls, ['voidRound']);
});

test('creation tracking is durably saved before entering the signing path', async t => {
  const now = 1791100805; t.mock.method(Date, 'now', () => now * 1000);
  const access = stepAccess(now, {}); const saved = [];
  const journal = { data: { transactions: [], activeRounds: {} }, save: async () => { saved.push(structuredClone(journal.data)); } };
  // A stop at the first signing-path guard models a crash after intent tracking but before signature creation.
  access.call = () => ({ chain: 'base', value: 1n });
  await assert.rejects(step(access, journal, { freshReports: true }), /KEEPER_INTENT/);
  assert.equal(Object.keys(saved.at(-1).activeRounds).length, 1);
  assert.equal(saved.at(-1).transactions.length, 0);
});
