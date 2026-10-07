// Idempotent-send guard between the Vela manager and the chain RPC. Original code, no dependencies.
//
// The manager (v0.2.x) rolls its database back whenever eth_sendRawTransaction does not answer cleanly, even
// when the node accepted the transaction and it mines; from then on it stops with "unrecoverable disalignment"
// and processes nothing again. This guard answers for the node: every call is forwarded with a timeout, and a
// send whose answer is not a clean JSON-RPC result (HTTP error, timeout, reset, JSON-RPC error) is looked up by
// its hash, keccak256 of the raw bytes. If the node holds the transaction the manager gets the hash, as from a
// clean send; if not, the same bytes are sent again, at most 3 times in all, and then the last answer is passed on.
// Resending signed bytes is idempotent: the same transaction, the same nonce.
//
// A rate-limited upstream (HTTP 429, or Caldera's -31002 "Bandwidth limit exceeded") rests for its Retry-After (60 s
// when none) and the call goes to the next one; the first is used again once it has rested. Caldera cut this host off
// for about 12 minutes in every 15 and the manager processed nothing meanwhile. With Caldera as UPSTREAM the fallback
// defaults to thirdweb's public Horizen gateway; UPSTREAM_FALLBACK overrides it. Any other UPSTREAM (rehearsals) gets
// no fallback unless one is named.
//
//   UPSTREAM=https://horizen.calderachain.xyz/http node rpcguard.mjs     (listens on :8545)
import http from "node:http";

const M = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // by x + 5y
const rol = (v, n) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M : v);

/** Keccak-256 (Ethereum's, not SHA3-256). Run only when a send did not answer cleanly. */
export function keccak256(data) {
  const p = Buffer.alloc(data.length - (data.length % 136) + 136);
  data.copy(p); p[data.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let o = 0; o < p.length; o += 136) {
    for (let i = 0; i < 17; i++) s[i] ^= p.readBigUInt64LE(o + 8 * i);
    for (const rc of RC) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
      const b = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rol(s[x + 5 * y], ROT[x + 5 * y]);
      for (let i = 0; i < 25; i++) s[i] = b[i] ^ (~b[(i % 5 + 1) % 5 + i - (i % 5)] & M & b[(i % 5 + 2) % 5 + i - (i % 5)]);
      s[0] ^= rc;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], 8 * i);
  return out;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Starts the guard; returns the server. */
export function start({ upstream, fallback, port = 8545, host = "0.0.0.0", timeoutMs = 10_000, retryMs = 1_000, attempts = 3, statsMs = 60_000 }) {
  const ups = [upstream, fallback].filter(Boolean).map((url) => ({ url, name: new URL(url).host, until: 0, calls: 0, limited: 0 }));
  const once = async (u, body) => {
    u.calls++;
    try {
      const r = await fetch(u.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
      return { status: r.status, text: await r.text(), retryAfter: Number(r.headers.get("retry-after")) };
    } catch (e) {
      return { status: 502, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `rpcguard: upstream ${e.name}` } }) };
    }
  };
  const limited = (r) => r.status === 429 || /"code":\s*-31002\b/.test(r.text);
  const forward = async (body) => {
    const now = Date.now();
    let r;
    for (const u of [...ups].sort((a, b) => (a.until > now) - (b.until > now))) { // rested ones first, in order; all resting: try anyway
      r = await once(u, body);
      if (!limited(r)) return r;
      u.limited++;
      const rest = Math.min(r.retryAfter > 0 ? r.retryAfter : 60, 3600);
      if (u.until <= now) log(`${u.name} rate-limited (${r.status}); resting it ${rest} s`);
      u.until = Date.now() + rest * 1000;
    }
    return r;
  };
  if (statsMs) setInterval(() => {
    if (ups.some((u) => u.calls)) log(`calls in the last ${statsMs / 1000} s: ${ups.map((u) => `${u.name} ${u.calls} (${u.limited} limited)`).join(", ")}`);
    for (const u of ups) u.calls = u.limited = 0;
  }, statsMs).unref();
  const clean = (r) => { try { return r.status === 200 && "result" in JSON.parse(r.text); } catch { return false; } };

  async function send(msg, body) {
    let hash;
    for (let attempt = 1; ; attempt++) {
      const r = await forward(body);
      if (clean(r)) return r;
      hash ??= "0x" + keccak256(Buffer.from(String(msg.params?.[0] ?? "").replace(/^0x/, ""), "hex")).toString("hex");
      // "already known" names this exact transaction, the same proof as a lookup hit. A pending transaction is visible
      // only on the gateway that took it, so the lookup asks every upstream, resting or not.
      const looks = await Promise.all(ups.map((u) => once(u, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }))));
      let known = /already known|known transaction/i.test(r.text);
      for (const look of looks) try { known ||= !!JSON.parse(look.text).result; } catch {}
      log(`send ${hash} attempt ${attempt}: answered ${r.status} ${r.text.slice(0, 120)}; node holds it: ${known}`);
      if (known) return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: hash }) };
      if (attempt >= attempts) return r;
      await new Promise((s) => setTimeout(s, retryMs));
    }
  }

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    let msg = null;
    try { msg = JSON.parse(body); } catch {}
    const r = msg && !Array.isArray(msg) && msg.method === "eth_sendRawTransaction" ? await send(msg, body) : await forward(body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.text);
  });
  server.listen(port, host, () => log(`rpcguard listening on ${host}:${server.address().port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.UPSTREAM) { console.error("rpcguard: UPSTREAM is required"); process.exit(1); }
  const upstream = process.env.UPSTREAM;
  const fallback = process.env.UPSTREAM_FALLBACK ?? (new URL(upstream).host === "horizen.calderachain.xyz" ? "https://26514.rpc.thirdweb.com" : undefined);
  start({ upstream, fallback, timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10_000) });
}
