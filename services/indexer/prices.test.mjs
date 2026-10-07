// prices.mjs against a stand-in Solana endpoint serving the two real round-program transactions server/btc.test.ts uses (14:18 UTC's
// report observed a second after the minute; 15:38 UTC's landing 33 s into it), with a page of failed transactions between them.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pricesStep } from "./prices.mjs";

const { transactions } = JSON.parse(readFileSync(new URL("../../server/btc-fixtures.json", import.meta.url), "utf8"));
const [early, late] = transactions;
const feed = JSON.parse(readFileSync(new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8")).application.chainlink.feedId;
const minute = (t) => t - t % 60;
// Newest first, as getSignaturesForAddress lists them.
const failed = Array.from({ length: 1000 }, (_, i) => ({ signature: `failed${i}`, blockTime: late.blockTime - 60 - i, err: { InstructionError: [0, "Custom"] } }));
const listing = [{ ...late, err: null }, ...failed, { ...early, err: null }].map(({ signature, blockTime, err }) => ({ signature, blockTime, err }));

function stand() {
  const s = { cursor: { sig: null, time: null }, minutes: new Map(), lists: 0, served: false };
  s.deps = {
    program: "program", feed,
    rpc: async (method, [key, options]) => {
      if (method === "getSignaturesForAddress") {
        s.lists++;
        const until = options.until ? listing.findIndex((e) => e.signature === options.until) : -1, all = until < 0 ? listing : listing.slice(0, until);
        const from = options.before ? all.findIndex((e) => e.signature === options.before) + 1 : 0;
        return all.slice(from, from + options.limit);
      }
      if (key === early.signature && !s.served) { s.served = true; return null; } // a node behind the one that listed it
      return transactions.find((t) => t.signature === key)?.transaction ?? null;
    },
    cursor: async () => ({ ...s.cursor }),
    held: async (from) => new Set([...s.minutes.keys()].filter((m) => m >= from)),
    write: async (expect, next, rows) => {
      assert.equal(expect.sig, s.cursor.sig); // the store's compare-and-set
      s.cursor = next;
      for (const r of rows) if (!(s.minutes.get(r.minute)?.observed_at <= r.observed_at)) s.minutes.set(r.minute, r);
    },
  };
  return s;
}
const usd = (s) => [...s.minutes.values()].sort((a, b) => a.minute - b.minute).map((r) => [r.minute, Number(r.price) / 1e18]);

test("every transaction is read once, oldest first; one not served yet holds the cursor before it", async () => {
  const s = stand();
  assert.equal((await pricesStep(s.deps)).more, false);
  assert.deepEqual(s.cursor, { sig: null, time: null }); // the oldest was not served: nothing passed it
  assert.equal(s.lists, 2); // the whole listing, past its first page
  const r = await pricesStep(s.deps);
  // The prices /api/btc serves for these minutes (server/btc.test.ts).
  assert.deepEqual(usd(s), [[minute(early.blockTime), 83102.82698224793], [minute(late.blockTime), 83254.69222516466]]);
  assert.deepEqual(s.cursor, { sig: late.signature, time: late.blockTime });
  assert.equal(r.latest, minute(late.blockTime));
  s.lists = 0;
  await pricesStep(s.deps); // nothing newer than the cursor: one listing, no write
  assert.equal(s.lists, 1);
  assert.deepEqual(s.cursor, { sig: late.signature, time: late.blockTime });
});

test("a cursor transaction that was dropped stops the listing 300 s before its block time instead of paging back forever", async () => {
  const s = stand();
  s.cursor = { sig: "dropped", time: late.blockTime };
  await pricesStep(s.deps);
  assert.equal(s.lists, 1); // the first page reaches blocks older than the cursor's time - 300
  assert.deepEqual(usd(s), [[minute(late.blockTime), 83254.69222516466]]);
});
