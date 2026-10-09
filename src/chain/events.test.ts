import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { keccak256 } from "viem";
import { eventRound } from "../../adapters/vela/crypto/guest.ts";
import { eventOutcome, loadEvent, loadRules, parseEventsManifest, US_HOUSE_2026 } from "./events-manifest.ts";
import { eventHouseFor, holdingKind, sidePrice } from "./market-view.ts";
import { parseOrderbookManifest, type ConfiguredOrderbook } from "./orderbook-manifest.ts";
import type { EventHouse } from "./read-api.ts";

const repoFile = (path: string) => readFile(new URL(`../../${path}`, import.meta.url));
const book = parseOrderbookManifest(JSON.parse(String(await repoFile("src/chain/testdata/orderbook-configured.json")))) as ConfiguredOrderbook;
const rules = await repoFile(`public${US_HOUSE_2026.rules}`);
const RESOLVER = "0x7777777777777777777777777777777777777777";
/** The events manifest as scripts/write-orderbook-manifest.mjs writes it for this book. */
const manifest = () => ({ schemaVersion: 1, kind: "zedge-events", chainId: 26514, release: book.release, application: book.application.id, deployTx: book.application.deployTx,
  resolver: RESOLVER, depositsFrom: 8, event: { rules: "/events/us-house-2026.txt", questionHash: US_HOUSE_2026.questionHash as string, start: 1_792_000_800, cutoff: 1_793_743_200, end: 1_793_743_201, voidableAfter: 1_801_439_999 } });
const serving = (files: Record<string, { status?: number; body: string }>) => (async (url: string) => {
  const f = files[url] ?? { status: 404, body: "" };
  return new Response(f.body, { status: f.status ?? 200 });
}) as typeof fetch;

test("the pinned question hash is the Keccak-256 of the committed rules text, which states the pinned times", () => {
  assert.equal(keccak256(rules), US_HOUSE_2026.questionHash);
  const text = rules.toString("utf8");
  for (const said of ["3 November 2026 22:00:00 UTC", "3 November 2026 22:00:01 UTC", "31 January 2027 23:59:59 UTC", "0.50 USDC", "50 USDC", "200 USDC"]) assert.ok(text.includes(said), said);
  assert.deepEqual([new Date(US_HOUSE_2026.cutoff * 1000).toISOString(), new Date(US_HOUSE_2026.end * 1000).toISOString(), new Date(US_HOUSE_2026.voidableAfter * 1000).toISOString()],
    ["2026-11-03T22:00:00.000Z", "2026-11-03T22:00:01.000Z", "2027-01-31T23:59:59.000Z"]);
  assert.ok(/^[\x20-\x7e\n]*$/.test(text), "plain ASCII, so its bytes are the same in every editor");
});

test("the events manifest parses only exactly: this book's release, application and deploy transaction, this event's rules and times", () => {
  assert.deepEqual(parseEventsManifest(manifest(), book), { release: book.release, application: book.application.id, resolver: RESOLVER, depositsFrom: 8, rules: US_HOUSE_2026.rules,
    terms: { question: US_HOUSE_2026.questionHash, start: 1_792_000_800, cutoff: 1_793_743_200, end: 1_793_743_201, voidableAfter: 1_801_439_999 } });
  const mutations: [string, (m: ReturnType<typeof manifest> & Record<string, unknown>) => void][] = [
    ["extra field", (m) => { m.extra = 1; }],
    ["missing field", (m) => { delete (m as Record<string, unknown>).depositsFrom; }],
    ["extra event field", (m) => { (m.event as Record<string, unknown>).outcome = 1; }],
    ["event is a list", (m) => { (m as Record<string, unknown>).event = [m.event]; }],
    ["schema version", (m) => { m.schemaVersion = 2; }],
    ["kind", (m) => { m.kind = "zedge-private-orderbook"; }],
    ["chain", (m) => { m.chainId = 2651420; }],
    ["another release", (m) => { m.release = "orderbook-mainnet-2026-10-07"; }],
    ["another application", (m) => { m.application = "7408397676477227659"; }],
    ["another deploy transaction", (m) => { m.deployTx = `0x${"1".repeat(64)}`; }],
    ["checksummed resolver", (m) => { m.resolver = "0xAbCdEf7777777777777777777777777777777777"; }],
    ["zero resolver", (m) => { m.resolver = `0x${"0".repeat(40)}`; }],
    ["resolver is the house", (m) => { m.resolver = book.application.house; }],
    ["resolver is the trigger", (m) => { m.resolver = book.trigger.address; }],
    ["resolver is the operator", (m) => { m.resolver = book.endpoint.operator; }],
    ["depositsFrom 0", (m) => { m.depositsFrom = 0; }],
    ["depositsFrom as text", (m) => { (m as Record<string, unknown>).depositsFrom = "8"; }],
    ["fractional depositsFrom", (m) => { m.depositsFrom = 8.5; }],
    ["another rules file", (m) => { m.event.rules = "/events/other.txt"; }],
    ["another question", (m) => { m.event.questionHash = `0x${"2".repeat(64)}`; }],
    ["a later cutoff", (m) => { m.event.cutoff += 3_600; }],
    ["an end on the grid", (m) => { m.event.end = 1_793_743_200; }],
    ["a later void", (m) => { m.event.voidableAfter += 1; }],
    ["start at the cutoff", (m) => { m.event.start = m.event.cutoff; }],
    ["start 0", (m) => { m.event.start = 0; }],
    ["start as text", (m) => { (m.event as Record<string, unknown>).start = "1792000800"; }],
  ];
  for (const [name, mutate] of mutations) {
    const m = manifest() as ReturnType<typeof manifest> & Record<string, unknown>;
    mutate(m);
    assert.throws(() => parseEventsManifest(m, book), /Invalid events manifest/, name);
  }
  for (const bad of [null, [], "x", 1]) assert.throws(() => parseEventsManifest(bad, book), /Invalid events manifest/);
});

test("loading: no manifest is no event; a broken or oversized one throws; the round is the guest's own, and the rules only with their hash", async () => {
  const event = await loadEvent(book, serving({ "/deployments/26514-events.json": { body: JSON.stringify(manifest()) } }));
  const guest = eventRound(book.application.engineConfigJson, { question: US_HOUSE_2026.questionHash, start: 1_792_000_800, cutoff: 1_793_743_200, end: 1_793_743_201, voidableAfter: 1_801_439_999 });
  assert.deepEqual([event?.id, event?.registryRoundId], [guest.id, guest.spec.registryRoundId.toLowerCase()]);
  assert.match(event?.id ?? "", /^[0-9a-f]{64}$/);
  assert.equal(await loadEvent(book, serving({})), null, "not served yet");
  await assert.rejects(loadEvent(book, serving({ "/deployments/26514-events.json": { status: 500, body: "" } })));
  await assert.rejects(loadEvent(book, serving({ "/deployments/26514-events.json": { body: `${JSON.stringify(manifest())}${" ".repeat(4_096)}` } })));
  await assert.rejects(loadEvent(book, serving({ "/deployments/26514-events.json": { body: "{" } })));
  assert.equal(await loadRules(event!, serving({ [US_HOUSE_2026.rules]: { body: rules.toString("utf8") } })), rules.toString("utf8"));
  const edited = rules.toString("utf8").replace("218 of the 435", "217 of the 435");
  await assert.rejects(loadRules(event!, serving({ [US_HOUSE_2026.rules]: { body: edited } })), /does not match/);
  await assert.rejects(loadRules(event!, serving({})));
});

test("the event's result is the resolver's (kind 2, source 4) or the timeout void (kind 3, source 3); a price-style record is none", () => {
  assert.deepEqual([eventOutcome({ kind: 2, outcome: 1, source: 4 }), eventOutcome({ kind: 2, outcome: 2, source: 4 }), eventOutcome({ kind: 3, outcome: 3, source: 3 })], [1, 2, 3]);
  for (const s of [{ kind: 2, outcome: 1, source: 1 }, { kind: 2, outcome: 1, source: 2 }, { kind: 2, outcome: 3, source: 4 }, { kind: 3, outcome: 3, source: 4 }, { kind: 3, outcome: 3, source: 2 }, { kind: 3, outcome: 1, source: 3 }, { kind: 1, outcome: 0, source: 4 }, null]) {
    assert.equal(eventOutcome(s), null, JSON.stringify(s));
  }
});

test("the event's prices are the event house's quotes for this round only, fresh; its buy limit is exactly the ask shown, never an estimate", () => {
  const id = "ab".repeat(32), at = 1_000_000;
  const quotes: EventHouse = { at, round: `0x${id}`, up: { ask: { cents: 93, shares: 5_000_000 }, bid: { cents: 88, shares: 5_000_000 } }, down: { ask: { cents: 12, shares: 5_000_000 }, bid: null } };
  assert.equal(eventHouseFor(quotes, id, at + 90_000), quotes);
  assert.equal(eventHouseFor(quotes, id, at + 90_001), null, "stale");
  assert.equal(eventHouseFor(quotes, "cd".repeat(32), at), null, "another round");
  assert.equal(eventHouseFor(quotes, null, at), null, "no event");
  assert.deepEqual(sidePrice(quotes, null, "up"), { ask: 93, buy: 93, sell: 88, est: false });
  assert.deepEqual(sidePrice(quotes, null, "down"), { ask: 12, buy: 12, sell: null, est: false });
  assert.deepEqual(sidePrice(null, null, "up"), { ask: null, buy: null, sell: null, est: true }, "no quotes: no price at all");
});

test("Portfolio names the event's holding by the event, never as an earlier BTC round", () => {
  const starts = new Map([["aa".repeat(32), 1_791_301_500]]), event = "ee".repeat(32);
  assert.equal(holdingKind(event, starts, event), "event");
  assert.equal(holdingKind("aa".repeat(32), starts, event), "round");
  assert.equal(holdingKind("bb".repeat(32), starts, event), "earlier");
  assert.equal(holdingKind(event, starts, null), "earlier", "before the events manifest loads");
});
