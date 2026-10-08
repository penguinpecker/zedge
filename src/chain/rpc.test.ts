import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { createPublicClient } from "viem";
import { chainClient } from "./gateway.ts";
import { NETWORKS } from "./networks.ts";
import { rpcCooldownRemaining, rpcTransport } from "./rpc.ts";
import { STREAMS_RPCS } from "./streams-manifest.ts";

const horizen = STREAMS_RPCS.horizen;
const base = STREAMS_RPCS.base;
let fixtureOrdinal = 0;
function clock(t: TestContext) {
  // Every fixture starts after all previous fixture deadlines, without a production reset hook.
  let monotonic = ++fixtureOrdinal * 1_000_000_000;
  let wall = Date.UTC(2026, 9, 4, 12);
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  return {
    advance(milliseconds: number) { monotonic += milliseconds; wall += milliseconds; },
    shiftWall(milliseconds: number) { wall += milliseconds; },
    dateAfter(milliseconds: number) { return new Date(wall + milliseconds).toUTCString(); },
  };
}
function success(init?: RequestInit) {
  const body = JSON.parse(String(init?.body)) as { id: number } | { id: number }[];
  const reply = (item: { id: number }) => ({ jsonrpc: "2.0", id: item.id, result: "0x6792" });
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), {
    headers: { "Content-Type": "application/json" },
  });
}
function unavailable(status: number, after?: string) {
  return new Response("provider response stays outside the cooldown state", {
    status, headers: after === undefined ? {} : { "Retry-After": after },
  });
}
const client = (url: string = horizen) => createPublicClient({ transport: rpcTransport(url) });
const request = (url: string = horizen) => client(url).getChainId();

// These tests intercept fetch; none contacts a public endpoint.
test("Retry-After 900 blocks every new reader until the shared cooldown expires", async (t) => {
  const time = clock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    return calls === 1 ? unavailable(429, "900") : success(init);
  });
  await assert.rejects(request());
  assert.equal(calls, 1, "the initial 429 is not retried automatically");
  assert.equal(rpcCooldownRemaining(horizen), 900_000);
  for (let i = 0; i < 3; i += 1) await assert.rejects(chainClient(26514).getChainId());
  assert.equal(calls, 1, "new gateway clients share the same endpoint cooldown");
  time.advance(899_999);
  await assert.rejects(request());
  assert.equal(calls, 1);
  assert.equal(rpcCooldownRemaining(horizen), 1);
  time.advance(1);
  assert.equal(rpcCooldownRemaining(horizen), 0);
  assert.equal(await request(), 26514);
  assert.equal(calls, 2);
});

test("one provider cooldown does not block another pinned endpoint", async (t) => {
  clock(t);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    return String(input) === horizen ? unavailable(503, "120") : success(init);
  });
  await assert.rejects(request());
  assert.equal(await request(base), 26514);
  assert.equal(await request(NETWORKS[2651420].rpcUrls.default.http[0]), 26514);
  assert.equal(rpcCooldownRemaining(base), 0);
  assert.equal(rpcCooldownRemaining(horizen), 120_000);
  await assert.rejects(request());
  assert.equal(calls.length, 3);
});

test("HTTP-date Retry-After is honored and elapsed cooldown uses monotonic time", async (t) => {
  const time = clock(t);
  let calls = 0;
  const after = time.dateAfter(180_000);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    return calls === 1 ? unavailable(503, after) : success(init);
  });
  await assert.rejects(request());
  assert.equal(rpcCooldownRemaining(horizen), 180_000);
  time.shiftWall(86_400_000);
  await assert.rejects(request());
  assert.equal(rpcCooldownRemaining(horizen), 180_000, "a wall-clock change cannot bypass backoff");
  time.advance(180_000);
  await request();
  assert.equal(calls, 2);
});

test("missing or malformed Retry-After defaults to 5 seconds on 429 and 503", async (t) => {
  const time = clock(t);
  let header: string | undefined;
  let status = 429;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return unavailable(status, header); });
  for (const value of [undefined, "", "nonsense", "-1", "1.5", "1e3", "NaN", "Infinity", "Sun, 31 Feb 2026 00:00:00 GMT"]) {
    header = value;
    status = status === 429 ? 503 : 429;
    await assert.rejects(request());
    assert.equal(rpcCooldownRemaining(horizen), 5_000, String(value));
    const before = calls;
    await assert.rejects(request());
    assert.equal(calls, before);
    time.advance(5_000);
  }
});

test("valid delays have a one-second floor and one-hour maximum", async (t) => {
  const time = clock(t);
  let after = "0";
  t.mock.method(globalThis, "fetch", async () => unavailable(429, after));
  for (const [header, expected] of [
    ["0", 1_000], ["1", 1_000], [" 2 ", 2_000], ["3601", 3_600_000],
    ["9".repeat(400), 3_600_000], [time.dateAfter(-1_000), 1_000],
  ] as const) {
    after = header;
    await assert.rejects(request());
    assert.equal(rpcCooldownRemaining(horizen), expected);
    time.advance(expected);
  }
  after = time.dateAfter(86_400_000);
  await assert.rejects(request());
  assert.equal(rpcCooldownRemaining(horizen), 3_600_000);
});

test("other HTTP errors do not install a cooldown or retry automatically", async (t) => {
  clock(t);
  let calls = 0;
  let status = 500;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return unavailable(status, "900"); });
  for (const code of [500, 401, 400]) {
    status = code;
    await assert.rejects(request());
    assert.equal(rpcCooldownRemaining(horizen), 0);
  }
  assert.equal(calls, 3);
});

test("older in-flight success and shorter errors cannot erase a provider cooldown", async (t) => {
  clock(t);
  const pending: { finish: (response: Response) => void; init?: RequestInit }[] = [];
  let notify: (() => void) | undefined;
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => new Promise<Response>((finish) => {
    pending.push({ finish, init });
    notify?.();
  }));
  async function start() {
    const sent = new Promise<void>((resolve) => { notify = resolve; });
    // Attach rejection handling immediately while this request is held in flight.
    const result = request().then(() => true, () => false);
    await sent;
    return { result };
  }
  const first = await start();
  const second = await start();
  const third = await start();
  pending[1].finish(unavailable(429, "900"));
  assert.equal(await second.result, false);
  assert.equal(rpcCooldownRemaining(horizen), 900_000);
  pending[0].finish(success(pending[0].init));
  assert.equal(await first.result, true);
  assert.equal(rpcCooldownRemaining(horizen), 900_000);
  pending[2].finish(unavailable(503, "1"));
  assert.equal(await third.result, false);
  assert.equal(rpcCooldownRemaining(horizen), 900_000);
  await assert.rejects(request());
  assert.equal(pending.length, 3);
});

test("RPC transports refuse altered or unreviewed endpoint strings", (t) => {
  clock(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("unexpected fetch"); });
  for (const url of [
    "https://attacker.example", `${horizen}?key=secret`, `${horizen}/`,
    "https://user:password@horizen.calderachain.xyz/http", "http://horizen.calderachain.xyz/http",
    "https://base.llamarpc.com", "javascript:alert(1)", "",
  ]) {
    assert.throws(() => rpcTransport(url), /Unreviewed RPC endpoint/);
    assert.throws(() => rpcCooldownRemaining(url), /Unreviewed RPC endpoint/);
  }
  assert.equal(calls, 0);
});

test("batch: false sends each request alone, as Alchemy's transfer index needs; the default sends a batch", async (t) => {
  clock(t);
  const bodies: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return success(init); });
  await createPublicClient({ transport: rpcTransport(base, { batch: false }) }).getChainId();
  await client(base).getChainId();
  assert.deepEqual(bodies.map((body) => Array.isArray(body)), [false, true]);
});
