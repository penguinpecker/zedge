/** Vercel function: /api/horizen, the site's Horizen reads (logic in server/horizen.ts). HORIZEN_RPC_URL (a private endpoint,
 * server-side only) first, HORIZEN_RPC_FALLBACK_URL next; the budget per visitor lives in the relay's Upstash Redis. */
import { Redis } from "@upstash/redis";
import { handleRpc, type Limiter } from "../server/horizen.ts";

const BUDGET = 300; // calls per visitor per 10 s: a cold page load bursts to about 100
function limiter(url: string | undefined, token: string | undefined): Limiter | null {
  if (!url || !token) return null;
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return async (visitor, calls) => {
    const key = `rpc:${visitor}:${Math.floor(Date.now() / 10_000)}`;
    const used = await redis.incrby(key, calls);
    if (used === calls) await redis.expire(key, 20);
    return used <= BUDGET;
  };
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const upstreams = [env.HORIZEN_RPC_URL, env.HORIZEN_RPC_FALLBACK_URL].filter((u): u is string => !!u && u.startsWith("https://"));
  const visitor = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const answer = await handleRpc({ method: request.method, origin: request.headers.get("origin"), visitor, body: await request.text() }, {
    upstreams: upstreams.length ? upstreams : ["https://26514.rpc.thirdweb.com"],
    allowedOrigin: env.RELAY_ALLOWED_ORIGIN ?? "https://zedge-markets.vercel.app",
    limiter: limiter(env.KV_REST_API_URL, env.KV_REST_API_TOKEN),
    fetch,
  });
  return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
