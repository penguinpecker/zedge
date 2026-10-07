// /api/btc (api/btc.ts) against a stand-in Solana endpoint serving two real transactions of the round program, read on
// 2026-10-07 when the live /api/btc lacked both minutes: 14:18 UTC's BTC report is observed a second after the minute,
// and 15:38 UTC's lands 33 s into it. Here the 14:18 one also sits past a full page of the listing and is not served
// on the first ask.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { GET } from "../api/btc.ts";

type Fixture = { signature: string; blockTime: number; transaction: unknown };
const { transactions } = JSON.parse(readFileSync(new URL("./btc-fixtures.json", import.meta.url), "utf8")) as { transactions: Fixture[] };
const [early, late] = transactions; // 14:18:02 and 15:38:33 UTC
const minute = (t: number) => t - t % 60;
// Newest first, as getSignaturesForAddress lists: a page of failed transactions between the two (passed over unread).
const failed = Array.from({ length: 1000 }, (_, i) => ({ signature: `failed${i}`, blockTime: late.blockTime - 60 - i, err: { InstructionError: [0, "Custom"] } as unknown }));
const listing = [{ ...late, err: null as unknown }, ...failed, { ...early, err: null }].map(({ signature, blockTime, err }) => ({ signature, blockTime, err }));

let clock = Date.UTC(2026, 9, 7, 15, 40, 10), served = false;
const limits: number[] = [];
mock.method(Date, "now", () => clock);
mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
  const { method, params } = JSON.parse(String(init?.body));
  if (method === "getSignaturesForAddress") {
    const { limit, before } = params[1] as { limit: number; before?: string };
    limits.push(limit);
    const from = before ? listing.findIndex((e) => e.signature === before) + 1 : 0;
    return Response.json({ result: listing.slice(from, from + limit) });
  }
  const tx = transactions.find((t) => t.signature === params[0]);
  if (tx === early && !served) { served = true; return Response.json({ result: null }); } // a node behind the one that listed it
  return Response.json({ result: tx?.transaction ?? null });
});

test("every minute of the window is read: observed at :01, landing late, past a page, not served at first", async () => {
  const read = async () => ((await (await GET()).json()) as { prices: [number, number][] }).prices;
  assert.deepEqual(await read(), [[minute(late.blockTime), 83254.69222516466]]);
  assert.deepEqual(limits.splice(0), [1000, 1000]); // the whole window, past its first page
  clock += 70_000; // a minute on, the window is listed again for the minute still missing
  assert.deepEqual(await read(), [[minute(early.blockTime), 83102.82698224793], [minute(late.blockTime), 83254.69222516466]]);
  assert.deepEqual(limits.splice(0), [1000, 1000]);
  clock += 5_000; // the rest of this window has no reports: it is listed in full at most once a minute
  await read();
  assert.deepEqual(limits.splice(0), [50]);
});
