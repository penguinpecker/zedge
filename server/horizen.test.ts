import assert from "node:assert/strict";
import test from "node:test";
import { handleRpc, refusal, type RpcDeps } from "./horizen.ts";

const ORIGIN = "https://zedge-markets.vercel.app";
const req = (body: unknown, origin: string | null = ORIGIN) => ({ method: "POST", origin, visitor: "1.2.3.4", body: JSON.stringify(body) });
function deps(answers: Record<string, (body: string) => { status: number; text: string }>, extra: Partial<RpcDeps> = {}): RpcDeps & { seen: string[] } {
  const seen: string[] = [];
  return { upstreams: Object.keys(answers), allowedOrigin: ORIGIN, limiter: null, seen, ...extra,
    fetch: (async (url: string, init: RequestInit) => { seen.push(url); const a = answers[url](String(init.body)); return new Response(a.text, { status: a.status }); }) as unknown as typeof fetch };
}
const ok = (result: unknown) => () => ({ status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });

test("only read methods, only our origin, batches of at most 20", async () => {
  const d = deps({ "https://a": ok("0x1") });
  assert.equal((await handleRpc(req({ id: 1, method: "eth_sendRawTransaction", params: ["0x00"] }), d)).status, 400);
  assert.equal((await handleRpc(req({ id: 1, method: "eth_blockNumber" }, "https://evil.example"), d)).status, 403);
  assert.equal((await handleRpc(req(Array.from({ length: 21 }, (_, i) => ({ id: i, method: "eth_chainId" }))), d)).status, 400);
  assert.equal(d.seen.length, 0, "nothing refused reaches an upstream");
  assert.equal((await handleRpc(req({ id: 1, method: "eth_blockNumber" }), d)).status, 200);
});

test("log reads span at most 1,000 blocks, including an open 'latest' upper bound", async () => {
  assert.match(String(refusal({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x3e8" }] })), /1,000/);
  assert.equal(refusal({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "0x3e7" }] }), null);
  assert.match(String(refusal({ method: "eth_getLogs", params: [{ toBlock: "latest" }] })), /fromBlock/);
  const d = deps({ "https://a": (body) => body.includes("eth_blockNumber") ? { status: 200, text: '{"jsonrpc":"2.0","id":1,"result":"0x1000"}' } : ok([])() });
  assert.equal((await handleRpc(req({ id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "latest" }] }), d)).status, 400);
  assert.equal((await handleRpc(req({ id: 1, method: "eth_getLogs", params: [{ fromBlock: "0xf00", toBlock: "latest" }] }), d)).status, 200);
});

test("a rate-limited or failing upstream hands over to the next one", async () => {
  const d = deps({ "https://primary": () => ({ status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-31002,"message":"Bandwidth limit exceeded"}}' }), "https://fallback": ok("0x2") });
  const r = await handleRpc(req({ id: 1, method: "eth_blockNumber" }), d);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).result, "0x2");
  assert.deepEqual(d.seen, ["https://primary", "https://fallback"]);
});

test("a visitor over budget is refused before any upstream call; a limiter failure does not take the site down", async () => {
  const over = deps({ "https://a": ok("0x1") }, { limiter: async () => false });
  assert.equal((await handleRpc(req({ id: 1, method: "eth_chainId" }), over)).status, 429);
  assert.equal(over.seen.length, 0);
  const broken = deps({ "https://a": ok("0x1") }, { limiter: async () => { throw new Error("redis down"); } });
  assert.equal((await handleRpc(req({ id: 1, method: "eth_chainId" }), broken)).status, 200);
});
