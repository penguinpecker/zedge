// D19: does a 900-aligned boundary fit the opening window? The keeper's real run loop (watch -> step -> sendOnce,
// real viem clients and request batching, real StreamsClient) runs against sim.mjs on a virtual clock. Every HTTP
// request to either chain or to Chainlink costs one full round trip; Base makes a block every 2 s, Horizen every
// second, a Base publication reaches the Horizen cache after `relay` seconds, and a report for second T exists at T+1.
// At the boundary T the keeper must publish two prices on Base, see both relayed, record four openings before
// T+210, resolve the four rounds that end at T, and create the four rounds that come into view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, virtualClock, BTC, ETH } from './sim.mjs';
import { watch } from './main.mjs';

const T = 1_800_000_000; // aligned to 900 (and 300)
const markets = [0, 1].flatMap(asset => [300, 900].map(duration => ({ asset, duration })));
// JSON-RPC calls (not HTTP requests: a batch counts each call it carries) sent to one chain between T+from and
// T+to, and the most that fell into any ten seconds. This is what a public endpoint's rate limit counts.
function volume(s, chain, from, to) {
  const list = s.calls.filter(c => c.chain === chain && c.at >= (T + from) * 1000 && c.at < (T + to) * 1000), total = l => l.reduce((n, c) => n + c.count, 0);
  return { calls: total(list), peak: Math.max(0, ...list.map(c => total(list.filter(d => d.at >= c.at && d.at < c.at + 10000)))) };
}

async function boundary({ rtt, relay = 24, from = -40, until = 130 }) {
  const s = await simulate({ rtt, relay }); s.schedule(T);
  for (const { asset, duration } of markets) s.rounds.delete(s.roundId(asset, duration, T + 2 * duration)); // comes into view at T
  const clock = virtualClock((T + from) * 1000), lines = []; let finished = false, stopping = false, failure;
  try {
    // The journal is in memory with a 20 ms write: a real fsync cannot be driven by a simulated clock.
    const journal = s.journal(), save = journal.save.bind(journal);
    journal.save = async () => { await new Promise(ok => setTimeout(ok, 20)); return save(); };
    watch(s.access, journal, s.auth, { stopped: () => stopping, sleep: ms => new Promise(ok => setTimeout(ok, ms)),
      print: status => lines.push({ at: clock.now() / 1000 - T, ...status }) }).catch(error => { failure = error; }).finally(() => { finished = true; });
    await clock.run((T + until) * 1000, () => finished);
    stopping = true; await clock.run((T + until + 30) * 1000, () => finished);
    const at = (fn, filter = () => true) => s.sent.filter(x => x.fn === fn && x.ok && filter(x)).map(x => x.ts - T);
    return { s, journal, lines, failure, finished, publications: at('publishBoundary'), delivered: [BTC, ETH].map(feed => s.cache.get(`${feed}:${T}`)?.at - T),
      openings: markets.map(m => s.rounds.get(s.roundId(m.asset, m.duration, T)).openedAt - T), resolutions: markets.map(m => s.rounds.get(s.roundId(m.asset, m.duration, T - m.duration)).resolvedAt - T),
      creations: at('createRound'), failed: s.sent.filter(x => x.done && !x.ok).length };
  } finally { clock.restore(); }
}

test('D19: at 250 ms per request a 900-aligned boundary is published, relayed and opened well inside the 210 s window', async () => {
  const r = await boundary({ rtt: 250 });
  console.log(`# 250 ms RTT, 24 s relay: publications mined T+${r.publications} | cache T+${r.delivered} | openings T+${r.openings} | resolutions T+${r.resolutions} | creations T+${r.creations}`);
  console.log(`# requests T-40..T+130: Base ${r.s.requests.base}, Horizen ${r.s.requests.horizen}, Chainlink ${r.s.requests.streams}; status lines ${r.lines.length}`);
  assert.equal(r.failure, undefined); assert.equal(r.finished, true); assert.equal(r.s.defect, undefined); assert.equal(r.failed, 0);
  assert.equal(r.publications.length, 2); assert(Math.max(...r.publications) <= 12, 'both prices are on Base within 12 s of the boundary');
  assert(r.openings.every(at => at > 0) && Math.max(...r.openings) <= Math.max(...r.delivered) + 10, 'the last opening is recorded within 10 s of the last delivery');
  assert(Math.max(...r.openings) <= 60, `all four openings by T+60 of 210 (measured T+${Math.max(...r.openings)})`);
  assert(r.resolutions.every(at => at > 0 && at <= 70), 'the four rounds ending at T are resolved too'); assert.equal(r.creations.length, 4);
  // No send waited for another chain or for confirmations: the two publications are consecutive Base blocks apart
  // by at most a few seconds, and the Horizen creations happened while the relay was still under way.
  assert(r.publications[1] - r.publications[0] <= 6); assert(Math.max(...r.creations) < Math.min(...r.delivered));
  // The busiest minute, in calls. Reading every phase and observation one by one it was 853 Horizen calls, 190 in
  // ten seconds, near the rate at which the public endpoint answered 429 with Retry-After: 900. What is left is
  // twelve transactions (ten calls each to price, sign and send, six to settle) and one call per tick.
  const horizen = volume(r.s, 'horizen', 0, 60), base = volume(r.s, 'base', 0, 60);
  console.log(`# JSON-RPC calls in the minute after the boundary: Horizen ${horizen.calls} (at most ${horizen.peak} in 10 s), Base ${base.calls} (at most ${base.peak} in 10 s)`);
  assert(horizen.calls <= 300 && horizen.peak <= 90, `Horizen calls in the boundary minute: ${horizen.calls}, ${horizen.peak} in 10 s`);
  assert(base.calls <= 110 && base.peak <= 60, `Base calls in the boundary minute: ${base.calls}, ${base.peak} in 10 s`);
});

test('D19: the margin holds across request latency, loop phase and a slow relay', async () => {
  for (const rtt of [0, 100, 250, 500, 1000]) {
    const last = [];
    for (const from of [-40, -37.3, -33.1]) { const r = await boundary({ rtt, from }); assert.equal(r.failure, undefined); assert.equal(r.failed, 0); last.push(Math.max(...r.openings)); assert(r.openings.every(at => at > 0)); }
    console.log(`# RTT ${String(rtt).padStart(4)} ms: last of four openings at T+${last.join(', T+')}`);
    assert(Math.max(...last) <= (rtt <= 250 ? 60 : 105), `RTT ${rtt} ms: last opening T+${Math.max(...last)}`);
  }
  // A relay six times slower than the one observed delivery still leaves every opening inside the window.
  const slow = await boundary({ rtt: 250, relay: 150, until: 230 });
  console.log(`# 250 ms RTT, 150 s relay: openings T+${slow.openings}`);
  assert(slow.openings.every(at => at > 0 && at <= 190)); assert.equal(slow.failed, 0);
});

test('D19: between boundaries the keeper is quiet, and identity is re-verified once a minute per chain, not per send', async () => {
  const r = await boundary({ rtt: 250, from: -260, until: -20 }); // four idle minutes: every round is trading
  const perMinute = chain => (r.s.requests[chain] / 4).toFixed(1);
  console.log(`# idle: ${perMinute('horizen')} Horizen and ${perMinute('base')} Base requests per minute`);
  assert(r.s.requests.horizen <= 16, `Horizen requests in four idle minutes: ${r.s.requests.horizen}`);
  // Base: the identity check once a minute and its head once per tick (every 30 s) for the status line.
  assert(r.s.requests.base <= 14, `Base requests in four idle minutes: ${r.s.requests.base}`);
  // In calls: the identity check (seven a minute on Horizen, three on Base) and one call per tick. It was 49 a minute on Horizen.
  const calls = chain => volume(r.s, chain, -260, -20).calls;
  console.log(`# idle: ${(calls('horizen') / 4).toFixed(1)} Horizen and ${(calls('base') / 4).toFixed(1)} Base JSON-RPC calls per minute`);
  assert(calls('horizen') <= 48 && calls('base') <= 28, `calls in four idle minutes: Horizen ${calls('horizen')}, Base ${calls('base')}`);
  assert.equal(r.s.sent.length, 0); assert.equal(r.failure, undefined);
  // One status line per tick, so a log alert on silence can be tight: idle, the lines are 30 s plus one tick's requests apart.
  const gaps = r.lines.slice(1).map((line, i) => line.at - r.lines[i].at);
  assert(r.lines.length >= 8 && Math.max(...gaps) <= 32, `status lines ${r.lines.length}, widest gap ${Math.max(...gaps)} s`);
  // Each line carries both chains' heads as read on that tick: never older than a block or two.
  assert(r.lines.every(line => line.status === 'idle' && line.remainingWei.base === '20000000000000000'
    && ['base', 'horizen'].every(chain => T + line.at - line.heads[chain].time >= 0 && T + line.at - line.heads[chain].time <= 4)));
});

test('harness self-check: the virtual clock adds nothing of its own (10 sequential reads take 10 round trips)', async () => {
  for (const rtt of [0, 250]) {
    const s = await simulate({ rtt }), clock = virtualClock(T * 1000); let elapsed, finished = false;
    try {
      (async () => { const start = Date.now(); for (let i = 0; i < 10; i++) await s.access.clients.horizen.getBlock(); elapsed = Date.now() - start; finished = true; })();
      await clock.run((T + 60) * 1000, () => finished);
    } finally { clock.restore(); }
    assert.equal(elapsed, 10 * rtt);
  }
});
