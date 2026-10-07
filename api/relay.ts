/** Vercel function: the relayer behind /api/relay. All logic is in server/relay.ts; this file only reads the environment
 * (the relayer key at runtime, never from the repo) and wires Upstash Redis and one RPC per chain. Missing settings leave it closed. */
import { Redis } from "@upstash/redis";
import manifest from "../public/deployments/26514-orderbook.json" with { type: "json" };
import { configFromEnv, handle, signerFromEnv, viemWire, type Store } from "../server/relay.ts";

function redisStore(url: string | undefined, token: string | undefined): Store | null {
  if (!url || !token) return null;
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return {
    set: (key, value, options) => redis.set(key, value, options as Parameters<typeof redis.set>[2]),
    get: (key) => redis.get<string>(key),
    del: (key) => redis.del(key),
    incrby: (key, by) => redis.incrby(key, by),
    decrby: (key, by) => redis.decrby(key, by),
    expire: (key, seconds) => redis.expire(key, seconds),
    ttl: (key) => redis.ttl(key),
    sismember: (key, member) => redis.sismember(key, member),
  };
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const config = configFromEnv(env, manifest);
  const answer = await handle({ method: request.method, headers: request.headers, body: await request.text() }, {
    config, store: redisStore(env.KV_REST_API_URL, env.KV_REST_API_TOKEN), signer: signerFromEnv(env.RELAYER_PRIVATE_KEY),
    // The thirdweb gateway by default: the operator keeps Caldera to itself.
    wire: config ? viemWire(env.HORIZEN_RPC_URL ?? "https://26514.rpc.thirdweb.com", config.book) : null,
    // Base carries the vault deposits; a private endpoint is advised over the public default.
    base: config ? viemWire(env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com", config.book) : null,
    log: (line) => console.log(line),
  });
  return Response.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store" } });
}
