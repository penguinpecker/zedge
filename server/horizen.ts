/** The site's Horizen reads, through our own function: the browser never holds a private endpoint, and the free thirdweb key
 * (10 requests a second) stops being the site's limit. Read-only methods, our origin only, small batches, short log ranges,
 * a per-visitor budget. Upstreams are tried in order; the next one is used when one is rate-limited or unreachable. */
const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount", "eth_getBalance", "eth_getCode", "eth_getStorageAt"]);
export const MAX_BATCH = 20;
export const MAX_LOG_BLOCKS = 1_000n;
export const MAX_BODY = 64 * 1024;

export type Limiter = (visitor: string, calls: number) => Promise<boolean>;
export type RpcDeps = { upstreams: string[]; allowedOrigin: string; limiter: Limiter | null; fetch: typeof fetch; timeoutMs?: number };
type Call = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
type Answer = { status: number; body: string };

const fail = (status: number, message: string): Answer => ({ status, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }) });
const block = (tag: unknown, head: bigint | null): bigint | null => {
  if (typeof tag === "string" && /^0x[0-9a-f]{1,16}$/i.test(tag)) return BigInt(tag);
  return tag === undefined || tag === "latest" ? head : null; // "earliest", "pending", hashes: not a bounded range
};

/** Why a call is refused, or null. eth_getLogs needs explicit hex bounds (or "latest" as the upper one) at most 1,000 blocks apart. */
export function refusal(call: Call): string | null {
  if (!call || typeof call !== "object" || typeof call.method !== "string") return "Malformed request.";
  if (!READ_METHODS.has(call.method)) return `Method ${call.method.slice(0, 40)} is not allowed.`;
  if (call.method !== "eth_getLogs") return null;
  const filter = Array.isArray(call.params) ? call.params[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined : undefined;
  if (!filter || typeof filter !== "object") return "Malformed log filter.";
  if (filter.blockHash !== undefined) return null; // one block
  const from = block(filter.fromBlock, null), to = filter.toBlock === undefined || filter.toBlock === "latest" ? null : block(filter.toBlock, null);
  if (from === null) return "Log reads need a hex fromBlock.";
  if (to !== null && (to < from || to - from >= MAX_LOG_BLOCKS)) return "Log reads span at most 1,000 blocks.";
  return null;
}

export async function handleRpc(request: { method: string; origin: string | null; visitor: string; body: string }, deps: RpcDeps): Promise<Answer> {
  if (request.method !== "POST" || request.origin !== deps.allowedOrigin) return fail(403, "Origin not allowed.");
  if (request.body.length > MAX_BODY) return fail(413, "Request too large.");
  let parsed: unknown;
  try { parsed = JSON.parse(request.body); } catch { return fail(400, "Malformed request."); }
  const calls: Call[] = Array.isArray(parsed) ? parsed : [parsed as Call];
  if (calls.length === 0 || calls.length > MAX_BATCH) return fail(400, `Batches hold 1 to ${MAX_BATCH} calls.`);
  // An open-ended "latest" upper bound is checked against the head below, so a far-back fromBlock cannot read the whole chain.
  for (const call of calls) { const why = refusal(call); if (why) return fail(400, why); }
  if (deps.limiter && !(await deps.limiter(request.visitor, calls.length).catch(() => true))) return fail(429, "Too many requests; slow down.");
  const open = calls.filter((c) => c.method === "eth_getLogs" && block((c.params as { fromBlock?: unknown }[])[0].fromBlock, null) !== null
    && ((c.params as { toBlock?: unknown }[])[0].toBlock ?? "latest") === "latest");
  let last: Answer = fail(502, "No Horizen endpoint answered.");
  for (const url of deps.upstreams) {
    try {
      if (open.length) {
        const head = await post(deps, url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }));
        if (head.status === 429 || head.status >= 500) { last = { status: head.status, body: head.text }; continue; }
        const now = BigInt(JSON.parse(head.text).result);
        for (const c of open) if (now - BigInt((c.params as { fromBlock: string }[])[0].fromBlock) >= MAX_LOG_BLOCKS) return fail(400, "Log reads span at most 1,000 blocks.");
      }
      const r = await post(deps, url, request.body);
      if (r.status === 429 || r.status >= 500 || /"code":\s*-31002\b/.test(r.text)) { last = { status: r.status === 200 ? 429 : r.status, body: r.text }; continue; }
      return { status: r.status, body: r.text };
    } catch { last = fail(502, "Horizen endpoint unreachable."); }
  }
  return last;
}

async function post(deps: RpcDeps, url: string, body: string) {
  const r = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
  return { status: r.status, text: await r.text() };
}
