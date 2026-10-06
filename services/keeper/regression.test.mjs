// One regression test per keeper finding of the 2026-10-05 audit. Each runs the real keeper (createChainAccess,
// viem clients, StreamsClient, step, sendOnce, reconcile) against sim.mjs and asserts the behaviour the audit's
// proof showed was missing. Under the audited code every one of these scenarios ended in a process exit, a
// permanent wedge or an abandoned boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { HttpRequestError, TimeoutError, RpcRequestError, CallExecutionError, ContractFunctionExecutionError, toFunctionSelector, keccak256, toHex, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { simulate, fixture, BTC, ETH, RECEIPTS, MULTICALL3 } from './sim.mjs';
import { step, plan, settings } from './main.mjs';
import { createChainAccess } from './chain.mjs';
import { Journal, spent } from './journal.mjs';
import { StreamsClient } from './streams.mjs';
import { classify } from './errors.mjs';

const T = 1_800_000_000; // aligned to 300 and 900: four rounds open here and four close here
const REGISTRY = 'StreamsRoundRegistry', PUBLISHER = 'BaseStreamsPublisher';

// A keeper on a pinned host clock starting `at` (seconds); run(until) ticks it once per simulated second.
// Date.now is mocked once per test and follows the newest keeper's clock: the runner restores mocks oldest first,
// so a second mock of the same method would leave the first one in place for every test that follows.
const clocks = new WeakMap();
async function keeper(t, at, journal) {
  const clock = { now: at * 1000 };
  if (!clocks.has(t)) { clocks.set(t, {}); t.mock.method(Date, 'now', () => clocks.get(t).current.now); }
  clocks.get(t).current = clock;
  const s = await simulate(), k = { s, clock, journal: journal ?? s.journal(), world: {}, log: [] };
  k.run = async until => {
    for (; clock.now <= until * 1000; clock.now += 1000) k.log.push({ at: clock.now / 1000 - T, ...await step(s.access, k.journal, s.auth, k.world) });
    assert.equal(s.defect, undefined, 'the simulator answered every request the keeper made');
  };
  // The same at the keeper's own pace: after each tick the clock moves on by the wait that tick asked for.
  k.pace = async until => {
    while (clock.now <= until * 1000) { const line = await step(s.access, k.journal, s.auth, k.world); k.log.push({ at: clock.now / 1000 - T, ...line }); clock.now += line.next; }
    assert.equal(s.defect, undefined, 'the simulator answered every request the keeper made');
  };
  k.sent = () => k.log.flatMap(tick => tick.sent.map(x => x.action));
  k.waits = (from = 0) => new Set(k.log.slice(from).flatMap(tick => [...tick.waiting.map(w => `${w.action ?? w.chain}=${w.wait}`), ...Object.entries(tick.chains).map(([chain, c]) => `${chain}=${c.wait}`)]));
  k.round = (asset, duration, start) => s.rounds.get(s.roundId(asset, duration, start));
  k.opened = start => [0, 1].flatMap(asset => [300, 900].map(duration => k.round(asset, duration, start))).filter(Boolean).every(round => round.openedAt > 0);
  return k;
}

test('D1: a pumped deposit fee or base fee is priced in wei; over the cap the keeper waits with a reason and Horizen carries on', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  // The portal's deposit fee at 2.5 gwei: the estimate is 2.56M gas. The audited keeper refused anything whose
  // limit passed a fixed 2.5M and exited. Now the limit follows the estimate and only its price in wei is capped.
  s.depositFee = 2.5;
  await k.run(T + 40);
  const publishes = s.sent.filter(x => x.fn === 'publishBoundary');
  assert.equal(publishes.length, 2); assert(publishes.every(x => x.ok && x.tx.gas > 2_500_000n));
  assert(k.opened(T), 'all four rounds opened');
  for (const record of k.journal.history.filter(r => r.chain === 'base')) assert(BigInt(record.maximumFeeWei) <= s.auth.budgets.base / 20n);
  // Base fee x100 (0.5 gwei, over the old fixed 1 gwei max-fee ceiling once doubled): the reservation no longer fits
  // one transaction's share of the budget. Publication waits; new rounds are still created on Horizen.
  k.clock.now = (T + 298) * 1000; s.depositFee = 1; s.baseFee.base = 500_000_000n; let from = k.log.length;
  await k.run(T + 310);
  assert(k.waits(from).has(`publish:${BTC}:${T + 300}=KEEPER_FEE_CAP`) && k.waits(from).has(`publish:${ETH}:${T + 300}=KEEPER_FEE_CAP`));
  assert(k.sent().includes(`create:0:300:${T + 900}`) && k.sent().includes(`create:1:300:${T + 900}`), 'Horizen work continued');
  // A deposit fee so high that no gas limit under the chain's own 2^24 cap leaves headroom: wait, do not exit.
  s.baseFee.base = 5_000_000n; s.depositFee = 17; from = k.log.length;
  await k.run(T + 345);
  assert(k.waits(from).has(`publish:${BTC}:${T + 300}=KEEPER_GAS_CAP`));
  assert.equal(s.sent.filter(x => x.fn === 'publishBoundary').length, 2, 'nothing was signed while over the cap');
  // The fee comes back down: the same boundary is published and its rounds open inside their window.
  s.depositFee = 1;
  await k.run(T + 420);
  assert(k.opened(T + 300)); assert(k.round(0, 300, T + 300).openedAt <= T + 510);
});

test('D2: a step somebody else took first is success, and a simulation past a deadline is a wait; neither stops the keeper', async t => {
  const k = await keeper(t, T + 10), { s } = k; s.schedule(T);
  for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 5);
  s.rounds.delete(s.roundId(0, 300, T + 600)); // one round the keeper has to create
  s.seed(1, 300, T - 600); // one round nobody opened: Voidable
  // Between the keeper's read and its simulation an outsider lands the very same call (once per method).
  const raced = new Set();
  s.beforeEstimate = (name, fn, args) => { if (name === REGISTRY && !raced.has(fn)) { raced.add(fn); s.outsider(name, fn, args); } };
  await k.run(T + 10);
  const [tick] = k.log;
  assert.deepEqual(tick.done.map(d => d.already), ['REVERT_OPENING_ALREADY_RECORDED']);
  assert.equal(tick.sent.length, 1, 'the same tick went on to the next opening and sent it');
  assert(tick.sent[0].action.startsWith('open:')); assert.equal(k.journal.data.transactions.length, 1, 'nothing was signed for the raced call');
  await k.run(T + 40);
  assert.deepEqual(k.log.flatMap(l => l.done.map(d => d.already)).sort(), ['REVERT_ALREADY_FINALIZED', 'REVERT_ALREADY_FINALIZED', 'REVERT_OPENING_ALREADY_RECORDED', 'REVERT_ROUND_EXISTS']);
  assert(k.opened(T)); assert.equal(k.round(1, 300, T - 600).outcome, 3); assert(k.round(0, 300, T + 600));
  assert([0, 1].every(asset => [300, 900].every(duration => k.round(asset, duration, T - duration).outcome === 1)), 'every round ending at T resolved');
  assert.equal(s.sent.filter(x => !x.ok).length, 0, 'no transaction was spent on a step that was already done');
  // The simulation runs one second past an inclusive deadline: OutsideOpeningWindow is "not now", and the round is voided next.
  const late = await keeper(t, T + 210); late.s.schedule(T); late.s.deliver(BTC, T, T + 205);
  late.s.beforeEstimate = (name, fn) => { if (fn === 'recordOpening') late.clock.now += 1000; };
  await late.run(T + 210);
  assert(late.waits().has(`open:0:300:${T}=REVERT_OUTSIDE_OPENING_WINDOW`)); assert.equal(late.s.sent.filter(x => x.fn === 'recordOpening').length, 0);
  late.s.beforeEstimate = null; await late.run(T + 225);
  assert.equal(late.round(0, 300, T).outcome, 3); assert.equal(late.round(0, 900, T).outcome, 3);
});

test('D3: a reverted publication is attempted again under the next attempt number, a bounded number of times', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  let first = true; // the first BTC publication runs out of gas in the portal: mined, reverted, nothing stored
  s.inclusion = (tx, name, fn, args) => fn === 'publishBoundary' && args[0] === BTC && first ? (first = false, 'revert') : undefined;
  await k.run(T + 70);
  const keys = k.journal.history.filter(r => r.key.startsWith(`publish:${BTC}`)).map(r => `${r.key}=${r.status}`);
  assert.deepEqual(keys, [`publish:${BTC}:${T}:1=reverted`, `publish:${BTC}:${T}:2=confirmed`]);
  assert(k.opened(T), 'the boundary was not abandoned: every round that needed it opened');
  assert.equal(s.sent.filter(x => x.fn === 'voidRound').length, 0);
  assert(k.waits().has(`publish:${BTC}:${T}=KEEPER_RETRY_SPACING`), 'the retry was spaced, not immediate');
  // Every attempt and its cost is on record and charged to the rolling budget; the revert burned its whole gas limit.
  const cost = status => BigInt(k.journal.history.find(r => r.chain === 'base' && r.status === status).receipt.feeWei);
  assert(cost('reverted') > cost('confirmed'));
  assert.equal(spent(k.journal.data, 'base'), k.journal.history.filter(r => r.chain === 'base').reduce((sum, r) => sum + BigInt(r.receipt.feeWei), 0n));

  // A publication that reverts every time is tried five times in a day, then left alone with a reason; the keeper lives on.
  const stubborn = await keeper(t, T + 2); stubborn.s.schedule(T);
  stubborn.s.inclusion = (tx, name, fn, args) => fn === 'publishBoundary' && args[0] === ETH ? 'revert' : undefined;
  await stubborn.run(T + 260);
  assert.equal(stubborn.s.sent.filter(x => x.fn === 'publishBoundary' && x.args[0] === ETH).length, 5);
  assert(stubborn.waits().has(`publish:${ETH}:${T}=KEEPER_ATTEMPTS_EXHAUSTED`));
  assert(stubborn.round(0, 300, T).openedAt > 0, 'the other feed was never held up');
  assert.equal(stubborn.round(1, 300, T).outcome, 3, 'and the unopened ETH round was voided once the registry called it Voidable');
});

test('D3: an observation somebody else published on Base is relayed again when it does not arrive', async t => {
  const k = await keeper(t, T + 3), { s } = k; s.schedule(T);
  // A third party publishes BTC at T; its bridge message is lost. The audited keeper only ever resent its own publications.
  s.relay = null; s.outsider(PUBLISHER, 'publishBoundary', [BTC, BigInt(T), s.report(BTC, T).fullReport], T + 1); s.relay = 24;
  await k.run(T + 60);
  assert(k.waits().has(`resend:${BTC}:${T}=AWAITING_DELIVERY`));
  assert.equal(s.sent.filter(x => x.args[0] === BTC).length, 0, 'no relay inside the first minute, and never a second publication');
  await k.run(T + 100);
  assert.deepEqual(s.sent.filter(x => x.args[0] === BTC).map(x => `${x.fn}:${x.ok}`), ['resendBoundary:true']);
  assert(k.journal.history.some(r => r.key === `resend:${BTC}:${T}:1` && r.status === 'confirmed'));
  assert(k.opened(T)); assert(k.round(0, 300, T).openedAt <= T + 210);
  // Relays are bounded per day.
  k.journal.data.attempts[`resend:${ETH}:${T + 300}`] = { count: 4, reverts: 0, last: T };
  s.relay = null; s.outsider(PUBLISHER, 'publishBoundary', [ETH, BigInt(T + 300), s.report(ETH, T + 300).fullReport], T + 301);
  k.clock.now = (T + 303) * 1000; const from = k.log.length; await k.run(T + 306);
  assert(k.waits(from).has(`resend:${ETH}:${T + 300}=KEEPER_RESENDS_EXHAUSTED`));
});

test('D3: one worst-case step of the deposit fee between estimate and inclusion does not run a publication out of gas', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  // The portal's fee can rise x2.125 from one block to the next. The audited limit (estimate x1.25) ran out of gas
  // in exactly that case, and the reverted publication was the one that was never retried.
  s.inclusion = (tx, name, fn) => { if (fn === 'publishBoundary') s.depositFee = 2.125; };
  await k.run(T + 40);
  const [first] = s.sent.filter(x => x.fn === 'publishBoundary');
  assert(first.ok && first.tx.gas >= 247_673n + 924_355n * 2125n / 1000n, 'estimated at 1 gwei, included at 2.125 gwei');
  assert.deepEqual(k.journal.history.filter(r => r.chain === 'base').map(r => r.status), ['confirmed', 'confirmed']); assert(k.opened(T));
});

test('D3: a relay that keeps being lost is sent when due, also while newer boundaries keep the Base lane busy, until its rounds are given up', async t => {
  const k = await keeper(t, T + 3), { s } = k; s.schedule(T);
  // Somebody else publishes ETH at T and every relay of it is lost. The wait before the next relay (60 s, doubling)
  // must not start again each time a newer boundary's publication goes first or holds the lane.
  s.relay = null; s.outsider(PUBLISHER, 'publishBoundary', [ETH, BigInt(T), s.report(ETH, T).fullReport], T + 1); s.relay = 24;
  for (; k.clock.now <= (T + 1100) * 1000; k.clock.now += (k.clock.now / 1000 - T) % 300 < 45 ? 1000 : 5000) {
    s.cache.delete(`${ETH}:${T}`); s.schedule(Math.floor(k.clock.now / 300000) * 300);
    k.log.push({ at: k.clock.now / 1000 - T, ...await step(s.access, k.journal, s.auth, k.world) });
  }
  const relays = k.log.filter(tick => tick.sent.some(x => x.action === `resend:${ETH}:${T}`)).map(tick => tick.at);
  assert.equal(relays.length, 3, `relays at T+${relays}`); assert(relays[2] <= 460, `relays at T+${relays}`);
  // The opened rounds that wanted the price are Voidable from T+361 and given up two minutes on, but never within 90 s
  // of a relay: no fourth relay is needed. (The bound of four a rolling day is the D3 test above.)
  const voids = k.log.filter(tick => tick.sent.some(x => x.action === `void:1:300:${T - 300}` || x.action === `void:1:900:${T - 900}`)).map(tick => tick.at);
  assert.equal(voids.length, 2); assert(voids.every(at => at >= 481 && at >= relays[2] + 90), `voids at T+${voids}`); assert.equal(s.defect, undefined);
});

test('D5: a boundary Base has not reached, a verifier that rejects and a chain clock that disagrees are waits, never exits', async t => {
  // Horizen is at the boundary while Base's head is still a second behind it (Base blocks carry odd seconds).
  const k = await keeper(t, T + 0.5), { s } = k; s.schedule(T);
  await k.run(T + 0.5);
  assert(k.waits().has(`publish:${BTC}:${T}=KEEPER_BASE_BEHIND_BOUNDARY`)); assert.equal(s.requests.streams, 0, 'no report is even requested before Base can verify it');
  await k.run(T + 40);
  assert(k.opened(T), 'one tick later the same boundary is published');

  // The on-chain verifier rejects every report (say a rotated DON digest). Settlement from the cache and voids go on.
  const v = await keeper(t, T + 2); v.s.schedule(T);
  v.s.seed(0, 300, T - 600, T - 570); v.s.deliver(BTC, T - 300, T - 290); // opened, closing price already cached
  v.s.seed(1, 300, T - 900); // never opened: Voidable
  v.s.beforeEstimate = (name, fn) => { if (fn === 'publishBoundary') throw Object.assign(new Error('execution reverted'), { code: 3, data: toFunctionSelector('InvalidOracleResponse()') }); };
  await v.run(T + 12);
  assert(v.waits().has(`publish:${BTC}:${T}=REVERT_INVALID_ORACLE_RESPONSE`) && v.waits().has(`publish:${ETH}:${T}=REVERT_INVALID_ORACLE_RESPONSE`));
  assert.equal(v.round(0, 300, T - 600).outcome, 1); assert.equal(v.round(1, 300, T - 900).outcome, 3); assert.equal(v.s.sent.filter(x => x.chain === 'base').length, 0);

  // A chain head more than a minute from the host clock (paused sequencer, lagging endpoint, wrong host clock): wait.
  const c = await keeper(t, T + 2 + 90); c.s.hostSkew = 90_000; c.s.schedule(T);
  await c.run(T + 2 + 90);
  assert.equal(c.log[0].chains.horizen.wait, 'KEEPER_CHAIN_CLOCK'); assert.equal(c.s.sent.length, 0);
});

test('D6: a rate-limited or failing RPC backs off its own chain, honours Retry-After, and never ends the process', async t => {
  const k = await keeper(t, T - 6), { s } = k; s.schedule(T);
  await k.run(T - 5); // two healthy ticks: the registry has been seen
  // From now until T+20 the Horizen endpoint answers 429 with Retry-After: 30.
  let refused = 0;
  s.rpc = chain => { if (chain === 'horizen' && Date.now() < (T + 20) * 1000) { refused++; return new Response('Bandwidth limit exceeded', { status: 429, headers: { 'retry-after': '30' } }); } };
  const started = performance.now();
  await k.run(T + 20);
  assert(performance.now() - started < 10000, 'nothing slept inside a request');
  assert.equal(refused, 1, 'one refused request, then silence for the 30 s the server asked for');
  const failed = k.log.find(tick => tick.chains.horizen);
  assert.equal(failed.chains.horizen.wait, 'RPC_HTTP_429'); assert.equal(Date.parse(failed.chains.horizen.retryAt), (T + failed.at + 30) * 1000);
  // Base is not held up: both boundaries are published from the last view of the registry while Horizen is silent.
  assert.equal(s.sent.filter(x => x.fn === 'publishBoundary' && x.ok).length, 2); assert.equal(s.sent.filter(x => x.chain === 'horizen').length, 0);
  // The endpoint is back: the rounds open well inside their window.
  await k.run(T + 60);
  assert(k.opened(T));

  // No Retry-After: bounded exponential backoff (1, 2, 4 ... at most 60 s), so an outage costs a handful of requests.
  const o = await keeper(t, T + 2); o.s.schedule(T);
  o.s.rpc = chain => chain === 'horizen' ? new Response('upstream error', { status: 503 }) : undefined;
  await o.run(T + 182);
  assert(o.s.requests.horizen >= 8 && o.s.requests.horizen <= 10, `Horizen requests in 3 minutes of outage: ${o.s.requests.horizen}`);
  // Retry-After as an HTTP date is honoured too, and an absurd value is cut to 15 minutes.
  const http = (headers) => classify(new HttpRequestError({ url: 'https://rpc.example/v2/PRIVATE-KEY', status: 429, headers: new Headers(headers) }));
  assert.deepEqual(http({ 'retry-after': '7' }), { class: 'retry', code: 'RPC_HTTP_429', rpc: true, retryAfter: 7000 });
  assert.equal(http({ 'retry-after': new Date(Date.now() + 120000).toUTCString() }).retryAfter, 120000);
  const d = await keeper(t, T + 2); d.s.schedule(T);
  d.s.rpc = chain => chain === 'horizen' ? new Response('', { status: 429, headers: { 'retry-after': '99999' } }) : undefined;
  await d.run(T + 2);
  assert.equal(Date.parse(d.log[0].chains.horizen.retryAt), (T + 2 + 900) * 1000);
  // Whatever a provider says never reaches a status line: codes only (an endpoint URL can carry an access key).
  assert(!JSON.stringify([http({}), classify(new TimeoutError({ body: {}, url: 'https://rpc.example/v2/PRIVATE-KEY' }))]).includes('PRIVATE-KEY'));
  assert.deepEqual(classify(new TimeoutError({ body: {}, url: 'https://rpc.example' })), { class: 'retry', code: 'RPC_TIMEOUTERROR', rpc: true });
  assert.deepEqual(classify(new TypeError('x is not a function')), { class: 'retry', code: 'UNEXPECTED_TYPEERROR' });
});

test('D12: the budget is a rolling day that refills, charged at what was paid; when one chain has none left only that chain waits', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  s.seed(1, 300, T - 600); // a Voidable round: Horizen work that must not wait for Base's budget
  // All but 0.00001 ETH of the Base budget was spent an hour ago: less than one publication's reservation is left.
  k.journal.data.spent.base = { [Math.floor(T / 3600) - 1]: (s.auth.budgets.base - 10_000_000_000_000n).toString() };
  await k.run(T + 20);
  assert(k.waits().has(`publish:${BTC}:${T}=KEEPER_BUDGET`) && k.waits().has(`publish:${ETH}:${T}=KEEPER_BUDGET`));
  assert.equal(s.sent.filter(x => x.chain === 'base').length, 0); assert.equal(k.round(1, 300, T - 600).outcome, 3, 'the void on Horizen went through');
  // 25 hours later that spending has left the window. Same journal, no operator action: publication resumes.
  const later = T + 90000; s.schedule(later); k.clock.now = (later + 2) * 1000;
  await k.run(later + 40);
  const publishes = s.sent.filter(x => x.fn === 'publishBoundary' && x.ok); assert(publishes.length >= 2); assert(k.opened(later));
  // A settled transaction is charged what it cost (execution as paid + the rollup fee bound), not its reservation.
  const record = k.journal.history.find(r => r.key.startsWith('publish:') && r.status === 'confirmed'), mined = publishes.find(x => x.hash === record.hash);
  assert.equal(BigInt(record.receipt.feeWei), 1_172_028n * 6_000_000n + (BigInt(record.maximumFeeWei) - mined.tx.gas * mined.tx.maxFeePerGas));
  assert(BigInt(record.receipt.feeWei) * 3n < BigInt(record.maximumFeeWei));
  // The operator sets the daily amounts; they are bounded above, and the old lifetime settings are not silently reused.
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-d12-'));
  try {
    const key = generatePrivateKey(), lines = { KEEPER_ADDRESS: privateKeyToAccount(key).address, KEEPER_PRIVATE_KEY: key, CHAINLINK_STREAMS_USERNAME: 'test-user',
      CHAINLINK_STREAMS_SECRET: 'test-only-not-a-real-secret', KEEPER_BASE_DAILY_BUDGET_WEI: '20000000000000000', KEEPER_HORIZEN_DAILY_BUDGET_WEI: '4000000000000000' };
    const load = async change => { const path = join(directory, 'secrets'); await rm(path, { force: true });
      await writeFile(path, Object.entries({ ...lines, ...change }).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
      return settings({ mode: '--watch', secrets: path, rehearsal: false }); };
    assert.deepEqual((await load({})).budgets, { base: 20000000000000000n, horizen: 4000000000000000n });
    await assert.rejects(load({ KEEPER_BASE_DAILY_BUDGET_WEI: '250000000000000001' }), /KEEPER_BUDGET_CONFIG/);
    await assert.rejects(load({ KEEPER_HORIZEN_DAILY_BUDGET_WEI: '0' }), /KEEPER_BUDGET_CONFIG/);
    await assert.rejects(load({ KEEPER_BASE_DAILY_BUDGET_WEI: null, KEEPER_BASE_BUDGET_WEI: '250000000000000' }), /KEEPER_BUDGET_CONFIG/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('D14: a transaction that never lands cannot wedge the keeper, even across a restart, and Horizen never waits for Base', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-d14-'));
  try {
    const k = await keeper(t, T + 30, await Journal.acquire(directory, 'd14')), { s } = k; s.schedule(T);
    for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 20); // both prices are cached: only Horizen work is left
    s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined; // Base cannot be reached at all
    let count = 0; s.inclusion = () => count++ === 0 ? 'drop' : undefined; // the first transaction is accepted and then never mined
    await k.run(T + 32);
    assert(k.waits().has('horizen=KEEPER_TX_PENDING'), 'the unmined hash holds the Horizen lane for a while');
    // Restart: the journal validates and still holds the hash. The audited keeper waited 120 s for its receipt and exited, every time.
    await k.journal.close(); k.journal = await Journal.acquire(directory, 'd14'); k.world = {};
    const [stuck] = k.journal.data.transactions;
    assert.equal(k.journal.data.transactions.length, 1); assert.match(stuck.key, /^open:[01]:(300|900):1800000000:1$/); assert.equal(stuck.transaction.nonce, 0);
    await k.run(T + 75);
    const history = (await readFile(join(directory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const [second, first] = [history.find(r => r.key === stuck.key.replace(/1$/, '2')), history.find(r => r.key === stuck.key)];
    // The same nonce was signed again (outbidding the lost hash); when it was mined the lost hash was closed as dropped, at no cost.
    assert.equal(second.status, 'confirmed'); assert.equal(second.transaction.nonce, 0); assert.equal(first.status, 'dropped');
    assert(BigInt(second.transaction.maxFeePerGas) * 8n >= BigInt(first.transaction.maxFeePerGas) * 9n);
    assert.equal(spent(k.journal.data, 'horizen'), history.filter(r => r.receipt).reduce((sum, r) => sum + BigInt(r.receipt.feeWei), 0n));
    assert(k.opened(T)); assert([0, 1].every(asset => [300, 900].every(duration => k.round(asset, duration, T - duration).outcome === 1)));
    assert.equal(k.log.at(-1).chains.base.wait, 'RPC_HTTP_503'); assert.equal(s.sent.filter(x => x.chain === 'base').length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).transactions, [], 'settled records left the state file');
    await k.journal.close();
  } finally { await rm(directory, { recursive: true, force: true }); }

  // The one thing that does stop it: the nonce was spent by a transaction this journal never signed.
  const f = await keeper(t, T + 30); f.s.schedule(T); f.s.deliver(BTC, T, T + 20); f.s.inclusion = () => 'drop';
  await f.run(T + 30);
  f.s.foreign = { horizen: 1 }; f.clock.now = (T + 60) * 1000;
  // One such answer reads the same as an endpoint that missed a receipt: at first only this chain stops working ...
  await f.run(T + 61);
  assert.equal(f.log.at(-1).chains.horizen.wait, 'KEEPER_SIGNER_UNCONFIRMED'); assert.equal(f.s.sent.filter(x => x.chain === 'horizen').length, 1, 'nothing more is signed on that chain meanwhile');
  // ... and when it still holds after half a minute of re-reading, the process stops.
  await assert.rejects(f.run(T + 100), error => error.message === 'KEEPER_SIGNER_CHANGED' && classify(error).class === 'stop');
  assert(f.clock.now >= (T + 90) * 1000 && f.clock.now <= (T + 95) * 1000, `stopped at T+${f.clock.now / 1000 - T}`);
  assert.equal(f.journal.data.transactions[0].status, 'submitted', 'the record is left untouched for the operator and for a re-check on restart');
});

test('D20: a boundary second with no report of its own is published from the report that covers it; one feed never starves the other', async t => {
  const k = await keeper(t, T + 3), { s } = k; s.schedule(T);
  s.streams.gaps.add(`${BTC}:${T}`); // the BTC DON skipped second T; its next report covers [T, T+1]
  await k.run(T + 45);
  assert.deepEqual(s.streams.requests.filter(r => r.path.includes(BTC)).map(r => `${r.path.split('?')[0]}=${r.status}`), ['/api/v1/reports=404', '/api/v1/reports/page=200']);
  const { validFromTimestamp, observationsTimestamp } = s.published.get(`${BTC}:${T}`).observation;
  assert.deepEqual([validFromTimestamp, observationsTimestamp], [T, T + 1]); assert(k.opened(T));

  // An API that answers a gap second with the previous, non-covering report ends the same way (the audited keeper crashed).
  const b = await keeper(t, T + 3); b.s.schedule(T); b.s.streams.gaps.add(`${ETH}:${T}`); b.s.streams.lookup = 'atOrBefore';
  await b.run(T + 45);
  assert(b.opened(T)); assert.equal(b.s.published.get(`${ETH}:${T}`).observation.observationsTimestamp, T + 1);

  // A gap longer than the 60 s the contracts accept: no covering report exists. Only that boundary waits. The other
  // feed publishes and opens, and rounds for both feeds are still created (the audited keeper stopped all of it).
  const g = await keeper(t, T + 3); g.s.schedule(T); for (let i = 0; i <= 70; i++) g.s.streams.gaps.add(`${BTC}:${T + i}`);
  for (const [asset, duration] of [[0, 300], [1, 300], [0, 900]]) g.s.rounds.delete(g.s.roundId(asset, duration, T + 2 * duration));
  await g.run(T + 45);
  assert(g.waits().has(`publish:${BTC}:${T}=STREAMS_NO_COVERING_REPORT`));
  assert(g.round(1, 300, T).openedAt > 0 && g.round(1, 900, T).openedAt > 0); assert(g.round(0, 300, T + 600) && g.round(1, 300, T + 600));
  assert(g.round(0, 900, T + 1800).createdAt > T + 3, 'a BTC round was created after the BTC boundary had already missed');
  assert(g.s.streams.requests.filter(r => r.path.includes(BTC) && !r.path.includes('latest')).length <= 16, 'and the waiting boundary is polled with backoff');
});

test('C1-1: verification is this release only, per chain; nothing upstream is read, and Base cannot stop Horizen', async t => {
  const k = await keeper(t, T + 30), { s } = k; s.schedule(T);
  for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 20);
  s.seed(1, 300, T - 600);
  s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined; // Base cannot even be identified
  await k.run(T + 45);
  assert(k.opened(T)); assert.equal(k.round(1, 300, T - 600).outcome, 3); assert.equal(k.round(0, 900, T - 900).outcome, 1);
  assert.equal(k.log.at(-1).chains.base.wait, 'RPC_HTTP_503');
  s.rpc = null; k.clock.now += 61000; await k.run(k.clock.now / 1000); // Base is back, and its backoff has run out
  // Every address the keeper ever read: its four contracts, the registry implementation, the fee-oracle predeploy, its
  // own account and the canonical Multicall3 its views of those contracts go through (used only while its code is
  // exactly the canonical runtime; see the Multicall3 test below for a chain where it is not). No verifier, fee manager,
  // messenger, portal or token: an upstream change has nothing to trip.
  const registry = s.files.release.contracts.find(c => c.name === REGISTRY);
  const own = [...s.files.release.contracts.map(c => c.address), registry.proxy.implementation, '0x420000000000000000000000000000000000000F', s.account.address, MULTICALL3].map(a => a.toLowerCase());
  assert.deepEqual([...s.touched].sort(), own.sort());

  // What is this release is checked completely, and a mismatch is must-stop: the proxied registry by implementation
  // slot, implementation runtime, owner and stored rules; every other contract by its runtime.
  const breaks = { KEEPER_REGISTRY_IMPLEMENTATION: x => { x.implementation = `0x${'be'.repeat(20)}`; }, KEEPER_REGISTRY_OWNER: x => { x.owner = `0x${'0b'.repeat(20)}`; },
    KEEPER_CODE: x => { delete x.codes[registry.address.toLowerCase()]; } }; // nothing deployed at the registry address
  for (const [code, mutate] of Object.entries(breaks)) {
    const x = await simulate(); mutate(x);
    await assert.rejects(x.access.identify('horizen'), error => error.message === code && classify(error).class === 'stop');
    await x.access.identify('base'); // the other chain's identity does not depend on it
  }
  const upgraded = await simulate(); upgraded.codes[registry.proxy.implementation.toLowerCase()] = '0x6002';
  await assert.rejects(upgraded.access.identify('horizen'), /KEEPER_REGISTRY_IMPLEMENTATION/);
  const base = await simulate(); base.codes[s.files.release.contracts[1].address.toLowerCase()] = '0x6003';
  await assert.rejects(base.access.identify('base'), /KEEPER_CODE/); await base.access.identify('horizen');
  // In the run loop the check is repeated every minute: an upgrade mid-run stops the keeper within that time.
  s.implementation = `0x${'be'.repeat(20)}`; k.clock.now += 61000;
  await assert.rejects(step(s.access, k.journal, s.auth, k.world), /KEEPER_REGISTRY_IMPLEMENTATION/);

  // Release gate and endpoints. A planned release runs only against loopback forks in a rehearsal.
  const never = async () => { throw new Error('no request expected'); };
  const loopback = { base: 'http://127.0.0.1:8545', horizen: 'http://localhost:8546' };
  await assert.rejects(createChainAccess({ files: fixture('planned'), fetchFn: never }), /KEEPER_RELEASE_NOT_DEPLOYED/);
  await assert.rejects(createChainAccess({ files: fixture('planned'), fetchFn: never, rehearsal: true }), /KEEPER_RPC_CONFIG/);
  await assert.rejects(createChainAccess({ files: fixture('planned'), fetchFn: never, rehearsal: true, rpc: { ...loopback, base: 'https://base-rpc.publicnode.com' } }), /KEEPER_RPC_CONFIG/);
  await createChainAccess({ files: fixture('planned'), fetchFn: never, rehearsal: true, rpc: loopback });
  await assert.rejects(createChainAccess({ files: fixture(), fetchFn: never, rpc: { horizen: 'http://rpc.example' } }), /KEEPER_RPC_CONFIG/);
  const old = fixture(); old.release.schemaVersion = 1; await assert.rejects(createChainAccess({ files: old, fetchFn: never }), /KEEPER_RELEASE/);
  const edited = fixture(); edited.config = edited.config.replace('"observationWindow":60', '"observationWindow":61'); await assert.rejects(createChainAccess({ files: edited, fetchFn: never }), /KEEPER_RELEASE/);
  // An operator's private endpoint is used as given, and the same identity checks run against it.
  const seen = []; const custom = await createChainAccess({ files: fixture(), rpc: { horizen: 'https://private.example/v1/ACCESS-KEY' }, fetchFn: (url, init) => { seen.push(String(url)); return s.fetchFn('https://horizen.sim.invalid', init); } });
  await assert.rejects(custom.identify('horizen'), /KEEPER_REGISTRY_IMPLEMENTATION/); assert(seen.length > 0 && seen.every(url => url.startsWith('https://private.example/v1/ACCESS-KEY')));
});

test('C2-1: a report newer than the Base head delays one publication by a block; it never switches off creation or the other feed', async t => {
  const k = await keeper(t, T + 2.5), { s } = k; s.schedule(T); s.streams.latency = 0;
  s.streams.gaps.add(`${BTC}:${T}`).add(`${BTC}:${T + 1}`); // BTC's covering report is observed at T+2: ahead of the Base head (T+1) for a block
  s.rounds.delete(s.roundId(0, 300, T + 600)); s.rounds.delete(s.roundId(1, 300, T + 600)); // creations are due as well
  await k.run(T + 2.5);
  const [tick] = k.log;
  assert.deepEqual(tick.waiting.map(w => `${w.action}=${w.wait}`), [`publish:${BTC}:${T}=STREAMS_REPORT_AHEAD_OF_BASE`]);
  assert.deepEqual(tick.sent.map(x => x.action).sort(), [`create:0:300:${T + 600}`, `publish:${ETH}:${T}`], 'the same tick created a BTC round and published ETH');
  await k.run(T + 45);
  assert(k.opened(T)); assert(k.round(1, 300, T + 600));
  assert.equal(s.streams.requests.filter(r => r.path.includes(BTC) && r.path.includes('page')).length, 1, 'the report was fetched once and kept until Base caught up');
});

test('C2-2: a host clock Chainlink rejects is named on every waiting line, credentials likewise, and cached work goes on', async t => {
  // Host clock 30 s fast: inside the keeper's 60 s tolerance against the chains, far outside Chainlink's 5 s for HMAC.
  const k = await keeper(t, T + 3 + 30), { s } = k; s.hostSkew = 30_000; s.schedule(T);
  s.deliver(ETH, T, T + 1); s.rounds.delete(s.roundId(0, 300, T + 600));
  await k.run(T + 3 + 30 + 8);
  assert(k.waits().has(`publish:${BTC}:${T}=STREAMS_HOST_CLOCK_SKEW`) && k.waits().has(`create:0:300:${T + 600}=STREAMS_HOST_CLOCK_SKEW`));
  assert(s.streams.requests.length > 0 && s.streams.requests.every(r => r.status === 401));
  assert(k.round(1, 300, T).openedAt > 0 && k.round(1, 900, T).openedAt > 0, 'rounds whose price is already cached still open');
  // Correct clock, wrong secret: the reason points at the credentials (and still mentions the clock, which Chainlink also checks).
  const bad = await keeper(t, T + 3); bad.s.schedule(T);
  bad.s.auth.streams = new StreamsClient({ username: bad.s.username, secret: 'a-wrong-secret-not-real', fetchImpl: bad.s.streamsFetch });
  await bad.run(T + 4);
  assert(bad.waits().has(`publish:${BTC}:${T}=STREAMS_HTTP_401_CHECK_CREDENTIALS_AND_CLOCK`));
});

// ---- Findings of the reviews of the rewritten keeper (2026-10-05). Each scenario below failed before its fix. ----

test('review: on the default endpoints Base receipts come from Base\'s own endpoint, and an endpoint that serves none is named before anything is sent', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  // The default Base endpoint refuses every eth_getTransactionReceipt, alone or in a batch. The keeper sent one
  // publication through it and then never used Base again: nothing it sent could be settled.
  let asked = 0;
  s.rpc = (chain, body, url) => { if (chain === 'base' && url !== RECEIPTS && [].concat(body).some(q => q.method === 'eth_getTransactionReceipt')) { asked++; return new Response('Archive requests require a personal token', { status: 403 }); } };
  await k.run(T + 40);
  assert.equal(asked, 0, 'the default endpoint is never asked for a receipt');
  assert.deepEqual(k.journal.history.filter(r => r.chain === 'base').map(r => r.status), ['confirmed', 'confirmed']); assert(k.opened(T));

  // An operator's endpoint replaces both, so it has to serve receipts itself. One that refuses them the way the public
  // one does (per item, inside the batch) is named by the identity check, which --check-public and --plan run once
  // and exit on; in the run loop the Base lane waits with that code, having sent nothing, and Horizen carries on.
  const o = await keeper(t, T + 2); o.s.schedule(T); o.s.rounds.delete(o.s.roundId(0, 300, T + 600));
  const refusing = async init => { const queries = JSON.parse(init.body), answers = await (await o.s.fetchFn('https://base.sim.invalid', init)).json();
    return new Response(JSON.stringify(answers.map((answer, i) => queries[i].method !== 'eth_getTransactionReceipt' ? answer
      : { jsonrpc: '2.0', id: answer.id, error: { code: -32602, message: 'Archive requests require a personal token' } })), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const access = await createChainAccess({ files: o.s.files, rpc: { base: 'https://operator.example/v1/ACCESS-KEY' }, fetchFn: (url, init) => String(url).startsWith('https://operator.example') ? refusing(init) : o.s.fetchFn(url, init) });
  await assert.rejects(access.identify('base', true), error => error.message === 'KEEPER_RPC_RECEIPTS' && classify(error).class === 'retry');
  await access.identify('horizen', true);
  const line = await step(access, o.journal, o.s.auth, o.world);
  assert.equal(line.chains.base.wait, 'KEEPER_RPC_RECEIPTS'); assert.deepEqual(line.sent.map(x => x.action), [`create:0:300:${T + 600}`]); assert.equal(o.s.sent.filter(x => x.chain === 'base').length, 0);
  // A transport failure of that one request (here the default receipt endpoint is rate limiting) stays the provider
  // failure it is, with its Retry-After; it is not taken for an endpoint that serves no receipts.
  const limited = await createChainAccess({ files: o.s.files, fetchFn: async (url, init) => String(url).startsWith(RECEIPTS) ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : o.s.fetchFn(url, init) });
  await assert.rejects(limited.identify('base', true), error => classify(error).code === 'RPC_HTTP_429' && classify(error).retryAfter === 7000);
  // The receipt endpoint is the profile's (chains.base.receiptRpcUrl), no longer a constant of the keeper: a profile
  // that names none has its receipts read where everything else is read, and one that is not https is refused.
  const edit = change => { const files = fixture(); files.config = change(files.config); files.release.configHash = keccak256(toHex(files.config)); return files; };
  const urls = [], single = await createChainAccess({ files: edit(config => config.replace(`,"receiptRpcUrl":"${RECEIPTS}"`, '')), fetchFn: (url, init) => { urls.push(String(url)); return o.s.fetchFn(url, init); } });
  assert.equal(single.config.chains.base.receiptRpcUrl, undefined); await single.identify('base', true);
  assert(urls.length > 0 && urls.every(url => url.startsWith('https://base.sim.invalid')));
  await assert.rejects(createChainAccess({ files: edit(config => config.replace(RECEIPTS, 'http://mainnet.base.org')), fetchFn: async () => { throw new Error('no request expected'); } }), /KEEPER_RPC_CONFIG/);
});

test('review: a nonce signed again with unchanged fees and no room for a higher bid is the same transaction, not a second record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-resign-'));
  try {
    const k = await keeper(t, T + 30, await Journal.acquire(directory, 'resign')), { s } = k; s.schedule(T);
    for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 20); // both prices are cached: only Horizen work is left
    s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined;
    // The budget leaves room for a registry call at today's price (about 4.5e11 wei), not for one bid 12.5% higher.
    s.auth.budgets.horizen = 20n * 470_000_000_000n;
    let count = 0; s.inclusion = () => count++ === 0 ? 'drop' : undefined; // the first transaction is accepted and never mined
    await k.run(T + 30);
    const [first] = k.journal.data.transactions; assert.equal(first.status, 'submitted');
    // The hold is over and Horizen's fees have not moved (a quiet chain sits on its floor): the bump does not fit,
    // the live price is bid, and that is byte for byte the first transaction. It used to be journalled as a second
    // record with the same hash, which the journal's own validation then refused on every later start.
    k.clock.now = (T + 51) * 1000; await k.run(T + 51);
    const sent = s.sent.filter(x => x.chain === 'horizen');
    assert.equal(sent.length, 2); assert.equal(sent[1].hash, sent[0].hash, 'the same bytes were broadcast again');
    assert.deepEqual(k.journal.data.transactions.map(r => [r.key, r.hash]), [[first.key, first.hash]]);
    assert.deepEqual(k.journal.data.attempts[first.key.slice(0, -2)], { count: 1, reverts: 0, last: T + 30 }, 'nothing new was numbered');
    assert.equal(Date.parse(k.journal.data.transactions[0].preparedAt), (T + 51) * 1000, 'and the record holds the lane again');
    await k.journal.close(); k.journal = await Journal.acquire(directory, 'resign'); k.world = {}; // any restart: the state loads
    await k.run(T + 75);
    const history = (await readFile(join(directory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(history.filter(r => r.key === first.key).map(r => r.status), ['confirmed']); assert(k.opened(T));
    await k.journal.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('review: a boundary this keeper has published is not published a second time, by a race or by a stale answer', async t => {
  // publishBoundary does not reject a repeat: it sends, and pays for, another bridge message.
  // Race: the first publication is unmined when its 20 s hold ends, and is mined while that tick is still working.
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T); s.deliver(ETH, T, T + 1); // only BTC at T is left to publish
  let first = true; s.inclusion = (tx, name, fn) => fn === 'publishBoundary' && first ? (first = false, 'drop') : undefined;
  await k.run(T + 21);
  const stuck = s.sent.find(x => x.fn === 'publishBoundary'); assert.equal(stuck.tx.nonce, 0); assert(k.waits().has('base=KEEPER_TX_PENDING'));
  k.world.reports.clear(); // the tick fetches the report again, and in that round trip a Base block with the first publication arrives
  s.streams.reject = () => { if (stuck.fate) { const block = Math.floor((k.clock.now / 1000 - 1) / 2) + 1; Object.assign(stuck, { fate: undefined, block, ts: 2 * block + 1 }); k.clock.now += 2000; } return null; };
  await k.run(T + 70);
  // The send batch saw nonce 1: the intent's own open record sits at nonce 0, so its result is awaited, not repeated.
  assert(k.waits().has(`publish:${BTC}:${T}=KEEPER_ATTEMPT_SETTLING`));
  assert.deepEqual(s.sent.filter(x => x.args[0] === BTC).map(x => `${x.fn}:${x.tx.nonce}:${x.ok}`), ['publishBoundary:0:true']);
  assert.deepEqual(k.journal.history.filter(r => r.chain === 'base').map(r => `${r.key}=${r.status}`), [`publish:${BTC}:${T}:1=confirmed`]); assert(k.opened(T));

  // Stale answer: the publication is settled, and one later read is answered by a backend 8 s behind that has not seen it.
  const b = await keeper(t, T + 2); b.s.schedule(T); b.s.deliver(ETH, T, T + 1);
  await b.run(T + 8);
  assert.deepEqual(b.journal.history.filter(r => r.chain === 'base').map(r => `${r.key}=${r.status}`), [`publish:${BTC}:${T}:1=confirmed`]);
  let once = true; b.s.lagFor = (chain, body) => chain === 'base' && once && [].concat(body).some(q => q.method === 'eth_call') ? (once = false, 8) : 0;
  await b.run(T + 45);
  assert.equal(once, false); assert.equal(b.s.sent.filter(x => x.chain === 'base').length, 1, 'what this process saw confirmed is stored, whatever one answer says'); assert(b.opened(T));
});

test('review: a start under a host clock a day fast does not erase what the rolling day has cost', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-clock-')), hour = Math.floor(T / 3600);
  try {
    let now = T * 1000; t.mock.method(Date, 'now', () => now);
    let journal = await Journal.acquire(directory, 'clock');
    journal.data.spent.base = { [hour]: '19000000000000000' }; await journal.save(); await journal.close(); // 0.019 of a 0.02 ETH day, spent this hour
    // The host comes up 26 hours fast and the supervisor starts the keeper. It would wait with KEEPER_CHAIN_CLOCK,
    // but every start saves the journal first, and that save used to drop all hours older than a day by this clock.
    now += 26 * 3600000; journal = await Journal.acquire(directory, 'clock'); await journal.close();
    now -= 26 * 3600000; journal = await Journal.acquire(directory, 'clock');
    assert.equal(spent(journal.data, 'base'), 19000000000000000n);
    // It is still a rolling day: once a later hour is on the books, hours more than a day before it leave the file.
    journal.data.spent.base[hour + 30] = '5'; await journal.save();
    assert.deepEqual(journal.data.spent.base, { [hour + 30]: '5' }); await journal.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('review: a new state directory finds the opened rounds of the last seven days again, a few at a time, and resolves them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-fresh-'));
  try {
    const k = await keeper(t, T + 2, await Journal.acquire(directory, 'fresh')), { s } = k; s.schedule(T);
    // The previous directory is gone (the documented recovery from several stops). Six rounds were trading when its
    // keeper stopped, four two hours ago, one six days ago and one seven days less twenty minutes ago, and nobody has
    // published their closing prices. An empty journal used to look back 80 minutes only, so they were never published
    // or resolved. All six are Voidable by now (nothing cached six minutes after their end), and each is still owed its
    // true result: the keeper works a Voidable round for its price before it gives it up.
    const old = [[0, 300, T - 7200], [1, 300, T - 7200], [0, 900, T - 7200], [1, 900, T - 7200], [1, 900, T - 6 * 86400], [0, 300, T - 603600]];
    for (const [asset, duration, start] of old) s.seed(asset, duration, start, start + 30);
    const unopened = s.seed(0, 300, T - 9000); // never opened: Voidable too, but it holds nothing and is not looked for
    const outcomes = () => old.map(([asset, duration, start]) => k.round(asset, duration, start).outcome);
    const cursors = new Set();
    for (; k.clock.now <= (T + 120) * 1000; k.clock.now += 1000) { await step(s.access, k.journal, s.auth, k.world); cursors.add(k.journal.data.catchUp); }
    assert.deepEqual(outcomes(), [1, 1, 1, 1, 0, 0], 'the four recent ones are published for, relayed and resolved');
    assert(cursors.size >= 7 && cursors.size <= 9, `one look every 15 seconds, not a burst: ${cursors.size} in two minutes`);
    // The position is in the journal: a restart carries on from it, and the walk ends by itself.
    const position = k.journal.data.catchUp; assert(position < T - 7200 && position > T - 6 * 86400);
    await k.journal.close(); k.journal = await Journal.acquire(directory, 'fresh'); k.world = {}; assert.equal(k.journal.data.catchUp, position);
    // At the idle pace, one look per 30 s tick. The walk takes about two hours, and still ends seven days back from
    // where it began: it used to end two hours short of that, and never even read the oldest rounds.
    for (; k.journal.data.catchUp !== undefined; k.clock.now += 30000) { assert(k.clock.now < (T + 7200) * 1000); await step(s.access, k.journal, s.auth, k.world); }
    assert(k.round(0, 300, T - 603600).voidableAfter < k.clock.now / 1000 - 1500, 'Voidable well before the walk reached it');
    await k.run(k.clock.now / 1000 + 60);
    assert.deepEqual(outcomes(), [1, 1, 1, 1, 1, 1]); assert.equal(s.rounds.get(unopened).outcome, 0); assert.equal(s.defect, undefined);
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); assert.equal(state.catchUp, undefined); assert.equal(state.catchUpEnd, undefined);
    await k.journal.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
  // A profile without the void grace is refused: the release gate needs every rule the registry was initialised with.
  const incomplete = fixture(); incomplete.config = incomplete.config.replace('"voidGrace":300,', ''); incomplete.release.configHash = keccak256(toHex(incomplete.config));
  assert(!incomplete.config.includes('voidGrace')); await assert.rejects(createChainAccess({ files: incomplete, fetchFn: async () => { throw new Error('no request expected'); } }), /KEEPER_RELEASE/);
});

test('review: a reorganisation that takes the last settled transaction out again is noticed and repaired; an endpoint that is only behind is waited for', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-reorg-'));
  try {
    const k = await keeper(t, T + 30, await Journal.acquire(directory, 'reorg')), { s } = k; s.schedule(T);
    for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 20);
    await k.run(T + 70); // four openings and four resolutions, all settled two blocks deep
    const mined = () => s.sent.filter(x => x.chain === 'horizen' && x.done), gone = mined().at(-1), round = s.rounds.get(gone.args[0]);
    assert.equal(gone.fn, 'resolveRound'); assert.equal(k.journal.data.transactions.length, 0); assert.equal(k.journal.data.nonces.horizen, 8);
    // A reorganisation deeper than those two blocks drops it: the round is unresolved again and the wallet's nonce is
    // one lower than the journal has settled. That used to be KEEPER_NONCE_BEHIND on every send for good, on that chain.
    s.sent.splice(s.sent.indexOf(gone), 1); Object.assign(round, { outcome: 0, resolvedAt: 0 }); s.reorg.horizen = gone.block;
    const action = `resolve:${round.asset}:${round.duration}:${round.start}`;
    await k.run(T + 73);
    assert(k.waits().has(`${action}=KEEPER_REORGANISED`));
    assert.deepEqual(k.journal.data.transactions.map(r => [r.key, r.hash, r.status]), [[`${action}:1`, gone.hash, 'submitted']], 'its record is open again: if that hash lands after all, it is ours');
    assert.equal(k.journal.data.nonces.horizen, 7);
    await k.journal.close(); k.journal = await Journal.acquire(directory, 'reorg'); k.world = {}; // the repaired state loads
    await k.run(T + 110);
    assert.equal(round.outcome, 1); assert.equal(mined().at(-1).tx.nonce, 7);
    const history = (await readFile(join(directory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(history.filter(r => r.key.startsWith(action)).map(r => `${r.key.slice(action.length)}=${r.status}`).sort(), [':1=confirmed', ':1=dropped', ':2=confirmed']);

    // An endpoint that reports a lower nonce while the block of the last settled transaction is still the chain's
    // is behind, nothing more: wait for it, open nothing again.
    s.seed(1, 300, T - 600); s.foreign = { horizen: -1 }; const from = k.log.length;
    await k.run(T + 115);
    assert(k.waits(from).has(`void:1:300:${T - 600}=KEEPER_NONCE_BEHIND`)); assert.equal(k.journal.data.transactions.length, 0); assert.equal(k.journal.data.nonces.horizen, 8);
    s.foreign = null; await k.run(T + 125);
    assert.equal(k.round(1, 300, T - 600).outcome, 3);
    await k.journal.close();
  } finally { await rm(directory, { recursive: true, force: true }); }

  // The same on Base, where a repeat is not free: a settled publication is taken out again. For a minute the keeper
  // still counts it as stored (the stale-answer case above); then the chain's answer stands again, the publication
  // is repeated at its old nonce and the rounds open inside their window.
  const b = await keeper(t, T + 2); b.s.schedule(T); b.s.deliver(ETH, T, T + 1);
  await b.run(T + 10);
  const lost = b.s.sent.find(x => x.fn === 'publishBoundary' && x.done);
  b.s.sent.splice(b.s.sent.indexOf(lost), 1); b.s.published.delete(`${BTC}:${T}`); b.s.cache.delete(`${BTC}:${T}`); b.s.reorg.base = lost.block;
  await b.run(T + 130);
  assert(b.waits().has(`publish:${BTC}:${T}=KEEPER_REORGANISED`)); assert(b.opened(T)); assert(b.round(0, 300, T).openedAt <= T + 150);
  assert.deepEqual(b.journal.history.filter(r => r.key.startsWith('publish:')).map(r => `${r.key.slice(-2)}=${r.status}`), [':1=confirmed', ':1=dropped', ':2=confirmed']);
  assert.deepEqual(b.s.sent.filter(x => x.fn === 'publishBoundary').map(x => `${x.tx.nonce}:${x.ok}`), ['0:true']);
});

test('review: a cause that clears inside the opening window still finds a retry inside it', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  // The report service answers 503 for BTC until T+130. Retries doubled without regard to the deadline: the last one
  // inside the window was at T+127 and the next at T+255, after the window had closed at T+210.
  s.streams.reject = feed => feed === BTC && Date.now() < (T + 130) * 1000 ? 503 : null;
  await k.run(T + 200);
  assert(k.opened(T)); assert(k.round(0, 300, T).openedAt <= T + 180, `BTC opened at T+${k.round(0, 300, T).openedAt - T}`);
  const waits = k.log.flatMap(tick => tick.waiting.filter(w => w.action === `publish:${BTC}:${T}`).map(w => Date.parse(w.retryAt) / 1000 - T - tick.at));
  assert(waits.length > 8 && Math.max(...waits) <= 15, `longest wait between tries ${Math.max(...waits)} s`);
  // One Base action serves every round that wants a boundary. It is as urgent as the most urgent of them, whichever is read last.
  const opening = { asset: 0, duration: 300, start: T, end: T + 300, phase: 2, feedId: BTC }, closing = { asset: 0, duration: 300, start: T - 300, end: T, phase: 5, feedId: BTC };
  for (const rounds of [[opening, closing], [closing, opening]]) assert.equal(plan({ now: T + 5, rounds }, new Map(), new Map()).base[0].deadline, T);
});

test('review: with nothing it can do for a boundary the keeper idles at its 30 s pace; a pending hash and a late relay say when to look again', async t => {
  const k = await keeper(t, T + 3), { s } = k; s.schedule(T);
  // Both closing prices for T are on Base and the bridge never delivers them. ETH's four relays of the day are used
  // up; BTC has had two and its third is due 240 s after this process first saw the price undelivered (T+3).
  s.relay = null; for (const feed of [BTC, ETH]) s.outsider(PUBLISHER, 'publishBoundary', [feed, BigInt(T), s.report(feed, T).fullReport], T + 1); s.relay = 24;
  Object.assign(k.journal.data.attempts, { [`resend:${ETH}:${T}`]: { count: 4, reverts: 0, last: T + 2 }, [`resend:${BTC}:${T}`]: { count: 2, reverts: 0, last: T + 2 } });
  await k.run(T + 225); // the opening window passes; the four rounds that started at T are voided unopened
  const waiting = at => Object.fromEntries(k.log.find(tick => tick.at === at).waiting.map(w => [`${w.action}=${w.wait}`, w.retryAt]));
  // While an opening waited for BTC the keeper looked every second; since then it says when the next relay is due.
  assert.equal(waiting(100)[`resend:${BTC}:${T}=AWAITING_DELIVERY`], undefined);
  assert.equal(waiting(225)[`resend:${BTC}:${T}=AWAITING_DELIVERY`], new Date((T + 243) * 1000).toISOString());
  assert.equal(waiting(225)[`resend:${ETH}:${T}=KEEPER_RESENDS_EXHAUSTED`], new Date((T + 303) * 1000).toISOString(), 'exhausted: looked at again in five minutes');
  // From here to the next relay nothing can be done. It used to tick every second for as long as the rounds stayed unresolved (up to a day).
  const requests = s.requests.horizen, ticks = [];
  for (k.clock.now = (T + 226) * 1000; k.clock.now < (T + 243) * 1000;) { const line = await step(s.access, k.journal, s.auth, k.world); ticks.push(line.next); k.clock.now += line.next; }
  assert.deepEqual(ticks, [17000]); assert(s.requests.horizen - requests <= 3);
  await k.run(T + 290);
  assert.equal(s.sent.filter(x => x.fn === 'resendBoundary' && x.args[0] === BTC && x.ok).length, 1, 'the relay that was due is sent on time');
  assert.equal(k.round(0, 300, T - 300).outcome, 1); assert.equal(k.round(1, 300, T - 300).outcome, 0);
  // A hash that is not mined holds its chain; the line says until when, and once it is no longer fresh nothing ticks faster than that.
  const p = await keeper(t, T + 30); p.s.schedule(T); p.s.deliver(BTC, T, T + 20); p.s.deliver(ETH, T, T + 20);
  p.s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined; p.s.inclusion = () => 'drop';
  await p.run(T + 31);
  assert.deepEqual(p.log.at(-1).waiting, [{ chain: 'horizen', wait: 'KEEPER_TX_PENDING', retryAt: new Date((T + 50) * 1000).toISOString() }]);
});

test('review: one answer that misses a mined transaction\'s receipt is a wait, not a second holder of the key', async t => {
  const k = await keeper(t, T + 30), { s } = k; s.schedule(T); for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 20);
  s.rpc = chain => chain === 'base' ? new Response('down', { status: 503 }) : undefined;
  await k.run(T + 30); // one recordOpening at nonce 0; it is mined in the next block
  // Horizen rate-limits the keeper for 25 s, so nothing is reconciled meanwhile. In its first answer afterwards the
  // head comes from one backend and the receipt lookup from another, two blocks behind: "no such receipt".
  s.rpc = chain => new Response('', chain === 'horizen' ? { status: 429, headers: { 'retry-after': '25' } } : { status: 503 });
  await k.run(T + 31);
  let missed = 0;
  s.rpc = (chain, body, url) => { if (chain === 'base') return new Response('down', { status: 503 });
    if (missed || !body.some(q => q.method === 'eth_getTransactionReceipt')) return undefined; missed++;
    return s.fetchFn(url, { body: JSON.stringify(body.map(q => q.method === 'eth_getTransactionReceipt' ? { ...q, params: [`0x${'00'.repeat(32)}`] } : q)) }); };
  k.clock.now = (T + 57) * 1000; await k.run(T + 57); // this used to end the process with KEEPER_SIGNER_CHANGED
  assert.equal(missed, 1); assert.equal(k.log.at(-1).chains.horizen.wait, 'KEEPER_SIGNER_UNCONFIRMED'); assert.equal(s.sent.length, 1);
  await k.run(T + 80);
  assert(k.journal.history.some(r => r.key.endsWith(`:${T}:1`) && r.status === 'confirmed'), 'the next read settles it: nothing was wrong'); assert(k.opened(T));
});

// A separate process that takes the journal of `directory` at wall-clock `at`. As the only writer it creates the
// marker directory `holding`; finding it there means two writers hold at once.
const WRITER = `import { Journal } from ${JSON.stringify(new URL('./journal.mjs', import.meta.url).href)};
import { mkdir, rmdir } from 'node:fs/promises';
const [directory, at, hold] = process.argv.slice(1), marker = directory + '/holding';
await new Promise(ok => setTimeout(ok, Math.max(0, Number(at) - Date.now())));
let journal; try { journal = await Journal.acquire(directory, 'lock'); } catch (error) { console.log(error.message); process.exit(0); }
try { await mkdir(marker); } catch { console.log('TWO_WRITERS'); process.exit(0); }
console.log('held');
if (hold === 'forever') setInterval(() => {}, 1000);
else { await new Promise(ok => setTimeout(ok, Number(hold))); await rmdir(marker); await journal.close(); console.log('released'); }`;
const writer = (directory, at = 0, hold = 'forever') => { const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER, directory, String(at), hold], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.output = ''; child.stdout.on('data', chunk => { child.output += chunk; }); return child; };
// A lock left in `directory` by a writer that no longer exists: its record, and (unless told otherwise) its FIFO with nobody holding it.
const leftover = async (directory, name, record, fifo = true) => { await writeFile(join(directory, `keeper.${name}.lock`), typeof record === 'string' ? record : JSON.stringify(record), { mode: 0o600 });
  if (fifo) execFileSync('mkfifo', ['-m', '600', join(directory, `keeper.${name}.live`)]); };
const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(text => text.trim(), () => '');

test('operations: a killed writer\'s lock is taken over on the kernel\'s word only; a live writer is never taken over, whatever pid its record shows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-lock-')), files = async () => (await readdir(directory)).filter(name => name.startsWith('keeper.')).sort();
  const child = writer(directory);
  try {
    await once(child.stdout, 'data'); assert.equal(child.output, 'held\n');
    const theirs = await files(); assert.equal(theirs.length, 2);
    await assert.rejects(Journal.acquire(directory, 'lock'), /KEEPER_LOCKED/);
    // Two containers on one volume are both pid 1 and may share a host name; and a pid may belong to nobody any more.
    // The audited keeper never took a lock over; its first repair read "my own pid, or a dead one" as proof and did.
    const lock = join(directory, theirs.find(name => name.endsWith('.lock'))), record = JSON.parse(await readFile(lock, 'utf8'));
    assert.deepEqual([record.pid, record.host, record.boot], [child.pid, hostname(), boot]);
    for (const pid of [process.pid, spawnSync(process.execPath, ['-e', '']).pid]) {
      await writeFile(lock, JSON.stringify({ ...record, pid }));
      await assert.rejects(Journal.acquire(directory, 'lock'), /KEEPER_LOCKED/);
    }
    assert.deepEqual(await files(), theirs, 'a refused start leaves nothing behind and touches nothing');
    // SIGKILL, OOM kill, power loss: the kernel closes the dead writer's FIFO, and that is the proof. No manual removal.
    child.kill('SIGKILL'); await once(child, 'exit');
    const journal = await Journal.acquire(directory, 'lock');
    assert.equal((await files()).length, 2); assert.equal((await files()).filter(name => theirs.includes(name)).length, 0, 'the dead writer\'s record and FIFO are gone');
    await journal.close(); assert.deepEqual(await files(), []);
    // After a restart of the machine (another boot id, same host name) nothing from before is running: taken over.
    await leftover(directory, '1'.repeat(16), { pid: 1, host: hostname(), boot: 'the-boot-before' });
    await (await Journal.acquire(directory, 'lock')).close(); assert.deepEqual(await files(), []);
    // A replaced container has a new host name but the same kernel, and the kernel's answer covers all its containers.
    if (boot) { await leftover(directory, '2'.repeat(16), { pid: 1, host: 'the-container-before', boot }); await (await Journal.acquire(directory, 'lock')).close(); assert.deepEqual(await files(), []); }
    // Never touched: a record from a machine this kernel cannot answer for, an unreadable one, and one whose FIFO is missing.
    for (const [record, fifo] of [[{ pid: 1, host: 'another-host', boot: 'another-boot' }, true], ['not json', true], [{ pid: 1, host: hostname(), boot }, false]]) {
      await leftover(directory, '3'.repeat(16), record, fifo); const before = await files();
      await assert.rejects(Journal.acquire(directory, 'lock'), /KEEPER_LOCKED/); assert.deepEqual(await files(), before);
      for (const name of before) await rm(join(directory, name));
    }
    // A state file that cannot be read back stops the start with one fixed code, and the refused start holds no lock.
    await writeFile(join(directory, 'state.json'), 'not json', { mode: 0o600 });
    await assert.rejects(Journal.acquire(directory, 'lock'), error => error.message === 'KEEPER_JOURNAL_STORAGE' && classify(error).class === 'stop'); assert.deepEqual(await files(), []);
  } finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('operations: of several keepers started at the same instant over a dead writer\'s lock, two never hold at once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zedge-keeper-race-'));
  try {
    for (let round = 0; round < 3; round++) {
      await leftover(directory, `${round}`.repeat(16), { pid: 1, host: hostname(), boot });
      const at = Date.now() + 400, children = Array.from({ length: 6 }, () => writer(directory, at, '150'));
      await Promise.all(children.map(child => once(child, 'exit')));
      const outcomes = children.map(child => child.output.trim().replace('\n', ' '));
      assert(outcomes.every(outcome => ['held released', 'KEEPER_LOCKED'].includes(outcome)), `round ${round}: ${outcomes}`);
      // Every starter cleaned up after itself. (When all of them saw each other and withdrew, the dead lock may still be there.)
      assert.deepEqual((await readdir(directory)).filter(name => name !== 'state.json' && !/^keeper\.(\d)\1{15}\./.test(name)), []);
    }
    await (await Journal.acquire(directory, 'lock')).close(); // a start on its own always gets through, and clears what is left
    assert.deepEqual(await readdir(directory), ['state.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('operations: every tick reports what was done, what waits and why, the budget, the last report per feed and the chain heads', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  s.streams.reject = feed => feed === ETH ? 503 : null; // the ETH report service is down
  await k.run(T + 40);
  const settled = k.log.flatMap(tick => tick.settled), spentBase = spent(k.journal.data, 'base'), last = k.log.at(-1);
  assert(settled.some(x => x.key === `publish:${BTC}:${T}:1` && x.chain === 'base' && x.status === 'confirmed' && BigInt(x.feeWei) > 0n && /^0x[0-9a-f]{64}$/.test(x.hash)));
  assert.equal(settled.reduce((sum, x) => sum + (x.chain === 'base' ? BigInt(x.feeWei) : 0n), 0n), spentBase, 'what the lines report as settled is what the budget was charged');
  assert.deepEqual([last.spentWei.base, last.remainingWei.base], [spentBase.toString(), (s.auth.budgets.base - spentBase).toString()]);
  assert.equal(BigInt(last.spentWei.horizen) + BigInt(last.remainingWei.horizen), s.auth.budgets.horizen);
  assert.deepEqual(last.heads.horizen, { block: T + 40, time: T + 40 }); assert(last.heads.base.time >= T + 37 && last.heads.base.block > 0);
  assert.deepEqual(last.reports.BTC, { lastOkAt: new Date((T + 2) * 1000).toISOString(), observed: T });
  assert.deepEqual(last.reports.ETH, { lastOkAt: null, observed: null, failing: 'STREAMS_HTTP_503' });
  assert(k.waits().has(`publish:${ETH}:${T}=STREAMS_HTTP_503`));
  JSON.stringify(k.log); // every line is plain JSON: no bigint, nothing circular
});

test('operations: only identity, journal, signer and allow-list failures stop the process', () => {
  for (const code of ['KEEPER_CHAIN', 'KEEPER_CODE', 'KEEPER_REGISTRY_IMPLEMENTATION', 'KEEPER_REGISTRY_OWNER', 'KEEPER_REGISTRY_RULES', 'KEEPER_RELEASE', 'KEEPER_RELEASE_NOT_DEPLOYED',
    'KEEPER_SIGNER_CODE', 'KEEPER_SIGNER_CHANGED', 'KEEPER_JOURNAL_IDENTITY', 'KEEPER_JOURNAL_RECORD', 'KEEPER_JOURNAL_STORAGE', 'KEEPER_JOURNAL_CAPACITY', 'KEEPER_LOCKED',
    'KEEPER_INTENT', 'KEEPER_TARGET', 'KEEPER_CALL', 'KEEPER_DUPLICATE_INTENT']) assert.equal(classify(Error(code)).class, 'stop', code);
  for (const code of ['KEEPER_FEE_CAP', 'KEEPER_GAS_CAP', 'KEEPER_BUDGET', 'KEEPER_BALANCE', 'KEEPER_TX_PENDING', 'KEEPER_NONCE_BEHIND', 'KEEPER_PRESEND_STALE', 'KEEPER_CHAIN_CLOCK',
    'KEEPER_TX_CANONICAL', 'KEEPER_TX_MISMATCH', 'KEEPER_ATTEMPT_SETTLING', 'KEEPER_RETRY_SPACING', 'KEEPER_BASE_BEHIND_BOUNDARY']) assert.equal(classify(Error(code)).class, 'retry', code);
  assert.equal(classify(Error('KEEPER_ATTEMPTS_EXHAUSTED')).class, 'skip');
});

// ---- Follow-ups of 2026-10-05. ----

// A keeper on its old state directory that still tracks an opened BTC five-minute round starting `ago` seconds
// before T, with nothing cached for its end. The registry calls it Voidable from end + 360 (60 s + voidGrace 300).
async function overdue(t, ago = 8 * 86400) {
  const k = await keeper(t, T + 2), old = T - ago, id = k.s.seed(0, 300, old, old + 30);
  k.journal.data.activeRounds[id] = { asset: 0, duration: 300, start: old };
  return Object.assign(k, { id, closing: old + 300, key: `${BTC}:${old + 300}`, old: k.s.rounds.get(id),
    voids: () => k.s.sent.filter(x => x.fn === 'voidRound' && x.args[0] === id).length,
    voidedAt: () => k.s.sent.find(x => x.fn === 'voidRound' && x.args[0] === id && x.ok)?.ts,
    // Base calls that simulate a publication of this round's closing boundary.
    simulates: body => [].concat(body).some(q => q.method === 'eth_call' && q.params[0].data?.startsWith(`${toFunctionSelector('publishBoundary(bytes32,uint64,bytes)')}${BTC.slice(2)}${(old + 300).toString(16).padStart(64, '0')}`)),
    // A feed outage of more than the 60 s the contracts accept, right at the closing boundary: no report covers it.
    lose: () => { for (let i = 0; i <= 70; i++) k.s.streams.gaps.add(`${BTC}:${old + 300 + i}`); } });
}

test('an opened round found Voidable after eight days is published for, relayed and resolved truthfully, not voided', async t => {
  const k = await overdue(t), { s } = k; s.schedule(T);
  assert.equal(await s.access.read(REGISTRY, 'phase', [k.id]), 8);
  const unopened = s.seed(1, 300, T - 8 * 86400); k.journal.data.activeRounds[unopened] = { asset: 1, duration: 300, start: T - 8 * 86400 };
  await k.run(T + 90);
  // The report is still to be had, so the round is owed its true result: within the two minutes the keeper works a
  // Voidable round before it gives it up, the price is published, delivered and the round resolved.
  assert.equal(k.old.outcome, 1, 'resolved, not voided'); assert.equal(k.voids(), 0);
  assert.deepEqual(s.sent.filter(x => x.args[0] === k.id || x.args[0] === BTC && Number(x.args[1]) === k.closing).map(x => `${x.fn}:${x.ok}`), ['publishBoundary:true', 'resolveRound:true']);
  assert.equal(s.cache.get(k.key).observation.observationsTimestamp, k.closing, 'from the report of its own closing second');
  assert(k.old.resolvedAt >= s.cache.get(k.key).at, 'once that price had reached Horizen');
  // A round nobody opened is voided as before, and the boundary under way was not held up by either.
  assert.equal(s.rounds.get(unopened).outcome, 3); assert(k.opened(T));

  // "Never opened" is the registry's answer for as long as the round stays Voidable, not a note kept for good. A
  // round read as unopened and Voidable that turns out opened after all (a reorganisation brought in an opening
  // somebody else had sent) is asked again when it is Voidable a second time: by then it is an opened round to be
  // worked for its price first, not one to void at once.
  const again = await keeper(t, T + 2), start = T - 600, id = again.s.seed(1, 300, start), round = again.s.rounds.get(id);
  again.s.streams.reject = feed => feed === ETH ? 503 : null; // and the ETH report service is down throughout
  again.s.balance = 0n; await again.run(T + 4); // it would void, but cannot pay for it
  assert(again.waits().has(`void:1:300:${start}=KEEPER_BALANCE`)); assert.equal(again.world.view.rounds.find(r => r.roundId === id).openedAt, 0);
  round.openedAt = start + 30; again.s.balance = 10n ** 18n; await again.run(T + 6);
  assert.equal(again.world.view.rounds.find(r => r.roundId === id).phase, 5);
  // Eight days without a tick (a paused host): the attempts before the pause do not count towards the two minutes.
  again.clock.now += 8 * 86400000; const back = again.clock.now / 1000; await again.run(back + 5);
  assert.deepEqual((({ phase, openedAt }) => [phase, openedAt])(again.world.view.rounds.find(r => r.roundId === id)), [8, start + 30]);
  assert.equal(round.outcome, 0, 'not voided at once'); assert(again.waits().has(`publish:${ETH}:${start + 300}=STREAMS_HTTP_503`));
  await again.run(back + 150); // two minutes on its price is still not to be had: given up
  assert.equal(round.outcome, 3); assert(round.resolvedAt >= back + 120, `voided ${round.resolvedAt - back} s after it was found Voidable`);
});

test('void rule: a signed report proving the closing window was skipped voids the round as soon as the registry allows, on the Base adapter\'s word', async t => {
  // The BTC feed produced no report for 71 s across the closing second of a round that ended at T-300 (Voidable from
  // T+61). The first report after it starts its window at the boundary and closes 71 s after it, so no report can ever
  // cover the boundary. The Base adapter rejects that report in a simulation; the keeper voids without the two-minute wait.
  const k = await overdue(t, 600), { s } = k; k.lose(); let simulations = 0;
  s.rpc = (chain, body) => { if (chain === 'base' && k.simulates(body)) simulations++; };
  await k.pace(T + 300);
  assert.deepEqual([k.old.outcome, k.voids()], [3, 1]); assert(simulations >= 1, 'the Base adapter was asked');
  assert(k.voidedAt() > T + 60 && k.voidedAt() < T + 60 + 120, `voided at T+${k.voidedAt() - T}, before the two minutes ran out`);
  assert.equal(s.sent.filter(x => x.fn === 'publishBoundary' && Number(x.args[1]) === k.closing).length, 0);
  assert(k.waits().has(`publish:${k.key}=STREAMS_NO_COVERING_REPORT`));

  // No proof without the adapter's own answer: while that simulation cannot be made, only the two minutes void it.
  const b = await overdue(t, 600); b.lose();
  b.s.rpc = (chain, body) => chain === 'base' && b.simulates(body) ? new Response('down', { status: 503 }) : undefined;
  await b.pace(T + 400);
  assert.deepEqual([b.old.outcome, b.voids()], [3, 1]); assert(b.voidedAt() > T + 60 + 120, `voided at T+${b.voidedAt() - T}`);

  // No proof either when the report the service calls the first one after the boundary starts its window after it
  // (the DON may have produced a covering report this answer does not show), or closes before it.
  for (const [validFrom, observed] of [[1, 71], [-5, -1]]) {
    const c = await overdue(t, 600), real = c.s.auth.streams; let asked = 0;
    c.s.auth.streams = { report: (feed, boundary, window) => feed === BTC && boundary === c.closing
      ? Promise.reject(Object.assign(new Error('STREAMS_NO_COVERING_REPORT'), { next: { payload: '0x', observation: { validFromTimestamp: c.closing + validFrom, observationsTimestamp: c.closing + observed } } }))
      : real.report(feed, boundary, window) };
    c.s.rpc = (chain, body) => { if (chain === 'base' && c.simulates(body)) asked++; };
    await c.pace(T + 400);
    assert.equal(asked, 0); assert.deepEqual([c.old.outcome, c.voids()], [3, 1]); assert(c.voidedAt() > T + 60 + 120, `voided at T+${c.voidedAt() - T}`);
  }
});

test('void rule: an opened round whose closing price is still not cached two minutes after the registry calls it Voidable is voided, whatever kept it away', async t => {
  // The report service fails for the closing boundary throughout. Voidable from T+61; not voided before T+181.
  const a = await overdue(t, 600); a.s.streams.reject = (feed, path) => path.includes(`imestamp=${a.closing}`) ? 503 : null;
  await a.pace(T + 178);
  assert.equal(a.voids(), 0, 'not within the two minutes'); assert(a.waits().has(`publish:${a.key}=STREAMS_HTTP_503`));
  await a.pace(T + 400);
  assert.deepEqual([a.old.outcome, a.voids()], [3, 1]); assert(a.voidedAt() > T + 180 && a.voidedAt() <= T + 215, `voided at T+${a.voidedAt() - T}`);

  // The price is on Base and its delivery never arrives (audit D4: a pumped deposit fee; or a lost message). The keeper
  // relays it, never voids within 90 s of a relay, and gives the round up once the two minutes have passed.
  const d = await overdue(t, 600), { s } = d;
  s.relay = null; s.outsider(PUBLISHER, 'publishBoundary', [BTC, BigInt(d.closing), s.report(BTC, d.closing).fullReport], d.closing + 5);
  await d.pace(T + 600);
  const relays = s.sent.filter(x => x.fn === 'resendBoundary' && Number(x.args[1]) === d.closing && x.ok && x.ts < d.voidedAt());
  assert.deepEqual([d.old.outcome, d.voids()], [3, 1]); assert(relays.length >= 1, 'relayed first');
  assert(d.voidedAt() >= Math.max(...relays.map(x => x.ts)) + 90 && d.voidedAt() > T + 180, `voided at T+${d.voidedAt() - T}`);

  // Base cannot be read from T+30 on, so nothing can be published or relayed either. The skipped-window proof was in
  // hand before that, but it is not acted on without Base's answer on the tick. Once Base has been silent for the whole
  // two minutes the round is given up all the same, on Horizen's own answer that nothing is cached.
  const e = await overdue(t, 600); e.lose();
  e.s.rpc = chain => chain === 'base' && Date.now() >= (T + 30) * 1000 ? new Response('down', { status: 503 }) : undefined;
  await e.pace(T + 400);
  assert.deepEqual([e.old.outcome, e.voids()], [3, 1]); assert(e.voidedAt() > T + 60 + 120, `voided at T+${e.voidedAt() - T}`);
  // A shorter Base outage across the end of the two minutes only delays the void to Base's next answer.
  const f = await overdue(t, 600); f.s.streams.reject = (feed, path) => path.includes(`imestamp=${f.closing}`) ? 503 : null;
  f.s.rpc = chain => chain === 'base' && Date.now() >= (T + 150) * 1000 && Date.now() < (T + 250) * 1000 ? new Response('down', { status: 503 }) : undefined;
  await f.pace(T + 400);
  assert.deepEqual([f.old.outcome, f.voids()], [3, 1]); assert(f.voidedAt() >= T + 250, `voided at T+${f.voidedAt() - T}, once Base answered again`);
});

test('void rule: a relay or publication the keeper sent is never pre-empted by a void while it is less than 90 s old or not yet in a block', async t => {
  // Found Voidable an hour after its end: the price is on Base, its bridge message lost. The keeper relays it 60 s
  // after first seeing it there, and that relay takes 80 s to arrive: the two minutes run out while it is on its way.
  const k = await overdue(t, 3600), { s } = k;
  s.relay = null; s.outsider(PUBLISHER, 'publishBoundary', [BTC, BigInt(k.closing), s.report(BTC, k.closing).fullReport], k.closing + 5); s.relay = 80;
  await k.pace(T + 400);
  const [relay] = s.sent.filter(x => x.fn === 'resendBoundary' && Number(x.args[1]) === k.closing);
  assert(relay.ok && relay.ts + 80 > T + 2 + 120, `relayed at T+${relay.ts - T}: still on its way when the two minutes ran out`);
  assert.deepEqual([k.old.outcome, k.voids()], [1, 0], 'resolved with its true result, not voided');

  // Nor is somebody else's publication: one that turns up on Base 20 s before the two minutes run out, and takes 60 s
  // to arrive, is counted as on its way for 90 s from when the keeper first sees it there.
  const o = await overdue(t, 3600); o.s.streams.reject = (feed, path) => path.includes(`imestamp=${o.closing}`) ? 503 : null;
  await o.run(T + 100); o.s.relay = 60; o.s.outsider(PUBLISHER, 'publishBoundary', [BTC, BigInt(o.closing), o.s.report(BTC, o.closing).fullReport], T + 101);
  await o.run(T + 200);
  assert.deepEqual([o.old.outcome, o.voids()], [1, 0], 'resolved with its true result, not voided');

  // Nor is one of its own that Base has not included yet, however long ago it was signed (congestion): the 90 s
  // count starts once it is settled. The relay above, signed at T+62, kept out of blocks for two minutes.
  const c = await overdue(t, 3600); let first = true;
  c.s.relay = null; c.s.outsider(PUBLISHER, 'publishBoundary', [BTC, BigInt(c.closing), c.s.report(BTC, c.closing).fullReport], c.closing + 5); c.s.relay = 24;
  c.s.inclusion = (tx, name, fn) => fn === 'resendBoundary' && first ? (first = false, 120) : undefined;
  await c.pace(T + 400);
  const relays = c.s.sent.filter(x => x.fn === 'resendBoundary'), mined = relays.find(x => x.ok);
  assert(mined.ts > relays[0].sentAt + 90, `a relay was mined ${mined.ts - relays[0].sentAt} s after the first was signed`);
  assert.deepEqual([c.old.outcome, c.voids()], [1, 0], 'resolved with its true result, not voided');
  // Base includes none of its transactions until T+400. The publication is signed again and again meanwhile, and at
  // T+302 the next boundary's publication takes its nonce: dropped, it is published again once that one is settled.
  const e = await overdue(t, 3600);
  e.s.inclusion = (tx, name) => name === PUBLISHER ? Math.max(0, T + 400 - Date.now() / 1000) : undefined;
  await e.pace(T + 600);
  const pubs = e.s.sent.filter(x => x.fn === 'publishBoundary' && Number(x.args[1]) === e.closing);
  assert(pubs.length > 2 && pubs.some(x => x.replaced) && pubs.at(-1).sentAt > T + 400, 'signed again while it waited, and after it was dropped');
  assert.deepEqual([e.old.outcome, e.voids()], [1, 0], 'resolved with its true result, not voided');
  // A publication that is never mined holds the void for ten minutes after it was first signed, not for good.
  const g = await overdue(t, 3600); g.s.inclusion = (tx, name, fn) => fn === 'publishBoundary' ? 'drop' : undefined;
  await g.pace(T + 800);
  const signed = Math.min(...g.s.sent.filter(x => x.fn === 'publishBoundary').map(x => x.sentAt));
  assert.deepEqual([g.old.outcome, g.voids()], [3, 1]); assert(g.voidedAt() >= signed + 600 && g.voidedAt() < signed + 700, `voided ${g.voidedAt() - signed} s after the first signature`);
});

test('void rule: a closing price cached after the keeper has given a round up is resolved, never voided', async t => {
  // Given up from T+181, but the void cannot be paid for. Then somebody else's delivery lands.
  const k = await overdue(t, 600), { s } = k; s.streams.reject = (feed, path) => path.includes(`imestamp=${k.closing}`) ? 503 : null;
  await k.run(T + 150); s.balance = 0n; await k.run(T + 200);
  assert(k.waits().has(`void:0:300:${k.closing - 300}=KEEPER_BALANCE`), 'the keeper had given it up');
  s.deliver(BTC, k.closing, T + 201); s.balance = 10n ** 18n;
  await k.run(T + 240);
  assert.deepEqual([k.old.outcome, k.voids()], [1, 0]);
  // The plan itself: a cached price is resolved, whatever was decided for that boundary on the tick.
  const round = { ...k.world.view.rounds.find(r => r.roundId === k.id), phase: 8, resolvedAt: 0 }, view = { now: T + 300, rounds: [round] };
  const yes = new Map([[k.key, true]]), no = new Map([[k.key, false]]), given = new Set([k.key]);
  assert.deepEqual(plan(view, yes, no, given).horizen.map(a => a.kind), ['resolve']); assert.deepEqual(plan(view, no, no, given).horizen.map(a => a.kind), ['void']);
});

test('a tick reads the registry and the cache in one call through Multicall3 and spares rounds that cannot change; without Multicall3 it asks one by one', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  const direct = { base: 0, horizen: 0 }, aggregates = { base: 0, horizen: 0 };
  // Views sent straight to a contract of the release (not the identity check's owner and rules, not a simulation) or through Multicall3.
  const count = x => (chain, body) => { for (const q of [].concat(body)) if (q.method === 'eth_call') { const to = q.params[0].to.toLowerCase();
    if (to === MULTICALL3) x.aggregates[chain]++; else if (!q.params[0].from && !q.params[0].data.startsWith(toFunctionSelector('owner()')) && !q.params[0].data.startsWith(toFunctionSelector('rulesHash()'))
      && to !== '0x420000000000000000000000000000000000000f') x.direct[chain]++; } };
  s.rpc = count({ direct, aggregates });
  await k.pace(T + 291);
  assert(k.opened(T)); assert([0, 1].every(asset => [300, 900].every(duration => k.round(asset, duration, T - duration).outcome === 1)));
  // Phases, round ids and observations were never asked for one by one, on either chain: every tick was one call
  // to each (and on Horizen one more, once, for the round ids).
  assert.deepEqual(direct, { base: 0, horizen: 0 }); assert.deepEqual(aggregates, { base: k.log.length, horizen: k.log.length + 1 });
  // A quiet tick is one call to each chain. In it are what can change before the next boundary (the two
  // five-minute rounds about to end and the two about to start) and what only a reorganisation of somebody else's
  // transaction could change (the rounds resolved four minutes ago and the ones never created), in the same call.
  // The quarter-hour rounds in the middle of trading and the rounds scheduled further ahead are not read again.
  const calls = s.calls.length, views = s.views.length; k.clock.now = (T + 292) * 1000;
  await step(s.access, k.journal, s.auth, k.world);
  assert.deepEqual(s.calls.slice(calls).map(c => `${c.chain}:${c.count}`).sort(), ['base:1', 'horizen:1']);
  const phases = s.views.slice(views).filter(v => v.startsWith('phase ')).map(v => v.slice(6)).sort();
  assert.deepEqual(phases, [0, 1].flatMap(asset => [[300, T - 900], [300, T - 600], [300, T - 300], [300, T], [300, T + 300], [900, T - 900]]
    .map(([duration, start]) => s.roundId(asset, duration, start))).sort());
  // What is spared is still in the view, at the phase it must have: nothing dropped out of sight.
  assert.deepEqual(Object.fromEntries(k.world.view.rounds.filter(r => r.start >= T - 900).map(r => [`${r.asset}:${r.duration}:${r.start - T}`, r.phase]).filter(([name]) => name.startsWith('0:'))),
    { '0:300:-900': 0, '0:300:-600': 0, '0:300:-300': 6, '0:300:0': 4, '0:300:300': 1, '0:300:600': 1, '0:900:-900': 6, '0:900:0': 3, '0:900:900': 1, '0:900:1800': 1 });

  // A chain without Multicall3, or with other code at its address: the same boundary through single reads, as before.
  for (const code of [undefined, '0x6001']) {
    const f = await keeper(t, T + 2), seen = { direct: { base: 0, horizen: 0 }, aggregates: { base: 0, horizen: 0 } }; f.s.schedule(T);
    if (code) f.s.codes[MULTICALL3] = code; else delete f.s.codes[MULTICALL3];
    f.s.rpc = count(seen);
    await f.run(T + 60);
    assert(f.opened(T)); assert.deepEqual(seen.aggregates, { base: 0, horizen: 0 }); assert(seen.direct.horizen > 100 && seen.direct.base > 20);
  }
});

test('a reorganisation deeper than the rounds the keeper still re-reads makes it read every round again', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  await k.pace(T + 291);
  const resolved = s.sent.filter(x => x.fn === 'resolveRound' && x.done); assert.equal(resolved.length, 4);
  // Four minutes on, the quarter-hour rounds that opened at T trade until T+900 and are not read. Now a
  // reorganisation takes all four resolutions out again. The keeper's next transaction finds its nonce four lower
  // and the block of its last settled transaction replaced: whatever else that reorganisation took back, it reads
  // every round again, the trading ones included.
  const trading = [0, 1].map(asset => s.roundId(asset, 900, T));
  const views = s.views.length; k.clock.now = (T + 292) * 1000; await step(s.access, k.journal, s.auth, k.world);
  assert(trading.every(id => !s.views.slice(views).includes(`phase ${id}`)));
  for (const x of resolved) { s.sent.splice(s.sent.indexOf(x), 1); Object.assign(s.rounds.get(x.args[0]), { outcome: 0, resolvedAt: 0 }); }
  s.reorg.horizen = Math.min(...resolved.map(x => x.block)); const from = k.log.length, after = s.views.length;
  await k.pace(T + 380);
  assert([...k.waits(from)].some(wait => wait.endsWith('=KEEPER_REORGANISED')));
  assert(trading.every(id => s.views.slice(after).includes(`phase ${id}`)), 'read again long before their end');
  assert(resolved.every(x => s.rounds.get(x.args[0]).outcome === 1), 'all four are resolved again'); assert(k.opened(T + 300));

  // A shallow one, seconds after a resolution settled: that round is still read on every tick. A resolved round is
  // not expected to wait on anything, so its closing price was not asked for with its phase; on the tick it is
  // found pending again the cache is asked at once, and the round is resolved again, not taken for undelivered.
  const q = await keeper(t, T + 2); q.s.schedule(T); await q.run(T + 60);
  const last = q.s.sent.filter(x => x.fn === 'resolveRound' && x.done).at(-1), round = q.s.rounds.get(last.args[0]);
  q.s.sent.splice(q.s.sent.indexOf(last), 1); Object.assign(round, { outcome: 0, resolvedAt: 0 }); q.s.reorg.horizen = last.block;
  const line = await step(q.s.access, q.journal, q.s.auth, q.world);
  assert.deepEqual(line.waiting.map(w => `${w.action}=${w.wait}`), [`resolve:${round.asset}:${round.duration}:${round.start}=KEEPER_REORGANISED`]);
});

test('the committed release and profile are consumed as written; while the release is planned only a rehearsal on loopback forks runs', async () => {
  const never = async () => { throw new Error('no request expected'); }, loopback = { base: 'http://127.0.0.1:8545', horizen: 'http://127.0.0.1:8546' };
  const read = async name => readFile(new URL(`../../contracts/deployment/${name}`, import.meta.url), 'utf8');
  const release = JSON.parse(await read('mainnet-addresses.json')), profile = await read('hybrid-mainnet.json');
  // No `files`: these are the repository's own records, the ones the image ships.
  const access = await createChainAccess({ rehearsal: true, rpc: loopback, fetchFn: never });
  assert.deepEqual(access.release, release); assert.equal(release.schemaVersion, 2); assert.equal(release.configHash, keccak256(toHex(profile)));
  const registry = release.contracts.find(c => c.name === REGISTRY);
  assert.deepEqual(access.call(REGISTRY, 'voidRound', [`0x${'00'.repeat(32)}`]).to, registry.address);
  assert.deepEqual(access.config, JSON.parse(profile));
  // The planned registry voids an opened round with no closing price five minutes after its observation window (owner decision 2026-10-06).
  assert.equal(access.config.rules.voidGrace, 300); assert.equal(access.config.rules.observationWindow, 60);
  if (release.status === 'planned') await assert.rejects(createChainAccess({ fetchFn: never }), error => error.message === 'KEEPER_RELEASE_NOT_DEPLOYED' && classify(error).class === 'stop');
  else { assert.equal(release.status, 'deployed'); await createChainAccess({ fetchFn: never }); }
});

// ---- Review of the 2026-10-05 follow-ups. ----

test('review: a resolution somebody else sent, taken out by a reorganisation minutes later, is noticed while the round is in view and resolved again', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T); for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 1);
  const id = s.roundId(0, 300, T - 300), round = s.rounds.get(id); s.outsider(REGISTRY, 'resolveRound', [id, '0x'], T + 1);
  await k.pace(T + 600);
  assert.equal(round.outcome, 1); assert.equal(s.sent.filter(x => x.fn === 'resolveRound' && x.args[0] === id).length, 0);
  // Ten minutes on, a reorganisation takes the outsider's resolution out. The delivery that cached the closing price
  // stays and the keeper's own transactions are all in again, so its nonce says nothing: only the round's phase does.
  Object.assign(round, { outcome: 0, resolvedAt: 0 });
  await k.pace(T + 890);
  assert.equal(round.outcome, 1); assert.deepEqual(s.sent.filter(x => x.fn === 'resolveRound' && x.args[0] === id).map(x => x.ok), [true]);
});

// ---- Dress rehearsal on forks of both chains (2026-10-05, scripts/rehearsal). ----

test('rehearsal: Base refuses an estimate above its 2^24 gas cap; that publication waits with KEEPER_GAS_CAP, Base is not backed off as if its endpoint failed', async t => {
  // A deposit fee of 20 gwei: a publication needs about 18.7M gas, and Base's own estimate refuses it (sim.mjs answers in
  // Base's words). The fork did not apply the cap; the keeper read that answer as an endpoint failure and backed off all
  // of Base for up to 60 s, so a fee falling back could find it asleep for most of the opening window.
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T);
  s.depositFee = 20;
  await k.run(T + 120);
  for (const feed of [BTC, ETH]) assert(k.waits().has(`publish:${feed}:${T}=KEEPER_GAS_CAP`));
  assert(k.log.every(tick => !tick.chains.base), 'the Base lane was never backed off');
  assert.equal(s.sent.filter(x => x.fn === 'publishBoundary').length, 0, 'nothing was signed while over the cap');
  s.depositFee = 1; // the fee falls back: the next try is at most 15 s away, as for any action an opening depends on
  await k.run(T + 240);
  assert(Math.min(...s.sent.filter(x => x.fn === 'publishBoundary').map(x => x.sentAt)) <= T + 121 + 15);
  assert(k.opened(T), 'all four rounds opened inside their window');
  // geth and Anvil word the same answer differently.
  const answer = message => classify(new RpcRequestError({ body: {}, error: { code: -32000, message }, url: 'https://rpc.example' }));
  for (const message of ['gas required exceeds allowance (16777216)', 'Out of gas: gas required exceeds allowance: 16777216']) assert.deepEqual(answer(message), { class: 'retry', code: 'KEEPER_GAS_CAP' });
});

test('rehearsal: a timeout is reported as RPC_TIMEOUTERROR also when a Multicall3 read wraps it', () => {
  // A cold fork's first read timed out and the line said RPC_CONTRACTFUNCTIONEXECUTIONERROR, which reads like a contract failing.
  const abi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
  const wrapped = new ContractFunctionExecutionError(new CallExecutionError(new TimeoutError({ body: {}, url: 'https://rpc.example/v2/PRIVATE-KEY' }), {}),
    { abi, functionName: 'aggregate3', args: [[]], contractAddress: '0xcA11bde05977b3631167028862bE2a173976CA11' });
  assert.deepEqual(classify(wrapped), { class: 'retry', code: 'RPC_TIMEOUTERROR', rpc: true });
});

test('rehearsal: a registry step somebody else takes in the same block reverts the keeper\'s copy; it is booked, not retried, and the keeper carries on', async t => {
  const k = await keeper(t, T + 2), { s } = k; s.schedule(T); for (const feed of [BTC, ETH]) s.deliver(feed, T, T + 1);
  // Every registry transaction the keeper broadcasts is preceded, in its block, by the identical call from another account.
  s.inclusion = (tx, name, fn, args) => { if (name === REGISTRY) s.outsider(name, fn, args); };
  await k.run(T + 60);
  const mine = k.journal.history.filter(r => r.chain === 'horizen');
  assert.equal(mine.length, 8, 'four openings and four resolutions'); assert(mine.every(r => r.status === 'reverted' && r.key.endsWith(':1')), 'each reverted once');
  assert.equal(s.sent.filter(x => x.name === REGISTRY).length, 8, 'and none was sent again');
  assert(k.opened(T)); assert([0, 1].every(asset => [300, 900].every(duration => k.round(asset, duration, T - duration).outcome === 1)));
  assert(k.log.every(tick => !Object.keys(tick.chains).length), 'no chain was backed off');
});
