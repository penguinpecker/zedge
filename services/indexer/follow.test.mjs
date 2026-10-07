// follow.mjs against a fake chain (blocks with hashes and logs) and an in-memory store with the same compare-and-set cursor.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { step } from "./follow.mjs";

const q = (n) => `0x${n.toString(16)}`;
/** Blocks 0..head; every 7th block carries one log. `fork` (a tag) changes the hashes and logs from block `from` on. */
function chain(head, forks = []) {
  const tag = (n) => forks.filter((f) => n >= f.from).map((f) => f.tag).join("");
  const block = (n) => n > c.head ? null : { hash: `0x${tag(n)}h${n}`, timestamp: q(1_000 + n) };
  const logsIn = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((n) => n % 7 === 0 && n <= c.head)
    .map((n) => ({ blockNumber: q(n), blockHash: block(n).hash, logIndex: "0x0", data: `${tag(n)}log${n}`, removed: false }));
  const c = {
    head, reads: [], refuseAbove: Infinity, lie: null,
    rpc: async (calls) => calls.map(({ method, params }) => {
      if (method === "eth_blockNumber") return q(c.head);
      if (method === "eth_getBlockByNumber") return block(Number(params[0]));
      const from = Number(params[0].fromBlock), to = Number(params[0].toBlock);
      c.reads.push([from, to]);
      if (to - from + 1 > c.refuseAbove) throw Object.assign(new Error("RPC_-32005"), { rpcCode: -32005, rpcMessage: "query exceeds max results" });
      const logs = logsIn(from, to);
      return c.lie ? c.lie(logs) : logs;
    }),
  };
  return c;
}
function store(start) {
  const s = { cursor: { block: start, hash: null }, logs: new Map(), writes: 0 };
  const cas = (expect) => { if (expect.block !== s.cursor.block) throw Object.assign(new Error("INDEXER_CURSOR_MOVED"), { lost: true }); };
  Object.assign(s, {
    deps: (c) => ({ rpc: c.rpc, cursor: async () => ({ ...s.cursor }), rows: (logs) => logs,
      write: async (_name, expect, next, logs) => { cas(expect); s.writes++; s.cursor = { block: next.block, hash: next.hash }; for (const l of logs) s.logs.set(Number(l.blockNumber), l.data); },
      rewind: async (_name, expect, fork) => { cas(expect); s.cursor = { block: fork.block, hash: fork.hash }; for (const n of s.logs.keys()) if (n > fork.block) s.logs.delete(n); } }),
  });
  return s;
}
const settings = (span = 1_000) => ({ name: "horizen", start: 0, depth: 3, rewind: 600, filter: {}, span });
async function drain(deps, c) { const out = []; for (let r; !(r = await step(deps, c)).idle;) out.push(r); return out; }

test("backfill in ranges of at most 1,000 blocks up to the confirmation depth, then idle; a repeated step adds nothing", async () => {
  const ch = chain(2_503), s = store(0), c = settings();
  const steps = await drain(s.deps(ch), c);
  assert.deepEqual(steps.map((r) => [r.from, r.to]), [[1, 1000], [1001, 2000], [2001, 2500]]);
  assert.ok(ch.reads.every(([from, to]) => to - from < 1_000));
  assert.equal(s.cursor.block, 2_500);
  assert.equal(s.logs.size, Math.floor(2_500 / 7));
  const writes = s.writes;
  assert.deepEqual(await step(s.deps(ch), c), { idle: true });
  assert.equal(s.writes, writes);
});

test("a reorg at the cursor rewinds 600 blocks; the store then holds exactly the new fork's logs", async () => {
  const ch = chain(2_503), s = store(0), c = settings();
  await drain(s.deps(ch), c);
  const fork = chain(2_603, [{ from: 2_450, tag: "f" }]);
  assert.deepEqual(await step(s.deps(fork), c), { reorg: true, from: 2_500, to: 1_900 });
  assert.ok([...s.logs.keys()].every((n) => n <= 1_900));
  await drain(s.deps(fork), c);
  assert.equal(s.cursor.block, 2_600);
  const expected = new Map(Array.from({ length: 2_600 }, (_, i) => i + 1).filter((n) => n % 7 === 0).map((n) => [n, `${n >= 2_450 ? "f" : ""}log${n}`]));
  assert.deepEqual(s.logs, expected);
});

test("a reorg below the cursor landing between the head read and the range read rewinds; the old rows never join the new fork", async () => {
  const ch = chain(2_503), s = store(0), c = settings();
  await drain(s.deps(ch), c);
  ch.head = 2_603;
  const fork = chain(2_603, [{ from: 2_450, tag: "f" }]);
  let calls = 0;
  const racing = { rpc: async (batch) => (calls++ === 0 ? ch : fork).rpc(batch) }; // the first batch still sees the old chain
  assert.deepEqual(await step(s.deps(racing), c), { reorg: true, from: 2_500, to: 1_900 });
  await drain(s.deps(fork), c);
  const expected = new Map(Array.from({ length: 2_600 }, (_, i) => i + 1).filter((n) => n % 7 === 0).map((n) => [n, `${n >= 2_450 ? "f" : ""}log${n}`]));
  assert.deepEqual(s.logs, expected);
});

test("logs off the stored chain are refused unwritten; removed logs are skipped; a size refusal halves the range", async () => {
  const ch = chain(20), s = store(0), c = settings();
  // A backend that answers logs of another fork for block 7 (inside the rewind window) while its header says otherwise.
  ch.lie = (logs) => logs.map((l) => l.blockNumber === q(7) ? { ...l, blockHash: "0xother" } : l);
  await assert.rejects(step(s.deps(ch), c), { code: "INDEXER_LOG_HASH" });
  assert.equal(s.writes, 0);
  // A backend that reports a head it has no header for yet: refused, not indexed as an empty range.
  const ahead = { rpc: async (batch) => batch[0].method === "eth_blockNumber" ? [q(ch.head + 10), ...(await ch.rpc(batch.slice(1)))] : ch.rpc(batch) };
  await assert.rejects(step(s.deps(ahead), settings()), { code: "INDEXER_NODE_BEHIND" });
  assert.equal(s.writes, 0);
  ch.lie = (logs) => [...logs, { blockNumber: q(8), blockHash: "0xgone", logIndex: "0x1", data: "dropped", removed: true }];
  await drain(s.deps(ch), c);
  assert.deepEqual([...s.logs.values()], ["log7", "log14"]);

  const big = chain(3_003), t = store(0), d = settings();
  big.refuseAbove = 250;
  const steps = await drain(t.deps(big), d);
  assert.deepEqual(steps.slice(0, 3).map((r) => r.span), [500, 250, undefined]);
  assert.equal(t.cursor.block, 3_000);
  assert.equal(t.logs.size, Math.floor(3_000 / 7));
});
