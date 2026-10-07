import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchedule } from './vela.mjs';

const B = 1_791_320_400, FEED = '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';

function lane({ reports = {}, completions = {} } = {}) {
  const w = { t: B * 1000, sent: [], asked: [], highest: 4n };
  const tick = createSchedule({
    now: () => w.t, feedId: FEED,
    report: async (feed, boundary, window) => {
      w.asked.push([feed, boundary, window]);
      const copy = reports[boundary];
      if (!copy || w.t / 1000 < copy.at) throw new Error('STREAMS_NO_COVERING_REPORT');
      return { payload: copy.payload, observation: { observationsTimestamp: copy.observed } };
    },
    send: async (kind, copy) => { w.sent.push({ kind, payload: copy?.payload, at: w.t / 1000 - B }); return { hash: `0x${w.sent.length}`, requestId: `r${w.sent.length}`, block: 1 }; },
    completion: async (o) => completions[o.requestId] ?? null,
    highest: async () => w.highest,
  });
  const run = async (until) => { const out = []; for (; w.t / 1000 <= B + until; w.t += 1000) out.push(...await tick()); return out; };
  return { w, tick, run };
}

test('the exact boundary report goes out as soon as a copy appears, once; then the confirming sync at B + 45 s', async () => {
  const { w, run } = lane({ reports: { [B]: { payload: '0xabc', observed: B, at: B + 4 } } });
  await run(3);
  assert.equal(w.sent.length, 0, 'nothing before the copy is posted');
  assert.ok(w.asked.every(([feed, boundary, window]) => feed === FEED && boundary === B && window === 0), 'only the exact-second report is asked for');
  const lines = await run(50);
  assert.deepEqual(w.sent.map((s) => [s.kind, s.payload ?? null, Math.round(s.at)]), [['report', '0xabc', 4], ['sync', null, 45]]);
  assert.equal(lines[0].vela, 'report');
  assert.equal(lines[0].seenAfter, 4);
  assert.equal(lines[0].tx, '0x1');
});

test('a report for another second is never sent; past B + 60 s the registry path is left to cover the boundary', async () => {
  const { w, run } = lane({ reports: { [B]: { payload: '0xlate', observed: B + 1, at: B + 2 } } });
  await run(70);
  assert.deepEqual(w.sent.map((s) => s.kind), ['sync']);
  const asks = w.asked.length;
  await run(120);
  assert.equal(w.asked.length, asks, 'no asks after B + 60 s');
});

test('a refused report is tried once more inside its window; "already applied" is final', async () => {
  const refused = lane({ reports: { [B]: { payload: '0xabc', observed: B, at: B + 2 } }, completions: { r1: { status: 0, receipt: { status: 'rejected', reason: 'not a boundary report' }, settles: 0 } } });
  await refused.run(20);
  assert.deepEqual(refused.w.sent.map((s) => s.kind), ['report', 'report'], 'one retry');
  const applied = lane({ reports: { [B]: { payload: '0xabc', observed: B, at: B + 2 } }, completions: { r1: { status: 0, receipt: { status: 'rejected', reason: 'already applied' }, settles: 0 } } });
  await applied.run(20);
  assert.deepEqual(applied.w.sent.map((s) => s.kind), ['report']);
  const ok = lane({ reports: { [B]: { payload: '0xabc', observed: B, at: B + 2 } }, completions: { r1: { status: 0, receipt: { status: 'applied' }, settles: 2 } } });
  const lines = await ok.run(20);
  assert.deepEqual(ok.w.sent.map((s) => s.kind), ['report']);
  assert.ok(lines.some((l) => l.vela === 'report completed' && l.receipt === 'applied' && l.settles === 2));
});

test('a new deposit in the Horizen inbox brings a sync about five seconds later, one per burst', async () => {
  const { w, run } = lane();
  await run(10);
  assert.equal(w.sent.length, 0, 'the first read only sets the mark');
  w.highest = 5n;
  await run(12);
  w.highest = 6n; // a second deposit inside the debounce
  await run(30);
  assert.deepEqual(w.sent.map((s) => [s.kind, Math.round(s.at)]), [['sync', 19]]);
});
