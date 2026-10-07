import { http } from "viem";
import { BASE_RPC, NETWORKS } from "./networks.ts";
import { STREAMS_RPCS } from "./streams-manifest.ts";

const endpoints = new Set<string>([
  ...Object.values(NETWORKS).flatMap((network) => network.rpcUrls.default.http),
  STREAMS_RPCS.base,
  BASE_RPC,
]);
const cooldowns = new Map<string, number>();
const DEFAULT_DELAY = 60_000;
const MIN_DELAY = 1_000;
const MAX_DELAY = 3_600_000;

function requireEndpoint(url: string) {
  if (!endpoints.has(url)) throw new Error("Unreviewed RPC endpoint.");
}

function retryDelay(value: string | null): number {
  const text = value?.trim() ?? "";
  let delay = DEFAULT_DELAY;
  if (/^\d+$/.test(text)) {
    // Very large positive integers are valid delays; cap them before conversion to milliseconds.
    delay = Math.min(Number(text), MAX_DELAY / 1_000) * 1_000;
  } else if (text) {
    const parsed = Date.parse(text);
    // Reject ambiguous numeric strings and permissive Date.parse rollovers. HTTP dates use GMT.
    if (Number.isFinite(parsed) && new Date(parsed).toUTCString() === text) delay = parsed - Date.now();
  }
  return Math.max(MIN_DELAY, Math.min(MAX_DELAY, delay));
}

/** In-memory, per-endpoint delay shared by every public reader in this page. */
export function rpcCooldownRemaining(url: string): number {
  requireEndpoint(url);
  const until = cooldowns.get(url);
  if (until === undefined) return 0;
  const remaining = Math.max(0, Math.ceil(until - performance.now()));
  if (remaining === 0) cooldowns.delete(url);
  return remaining;
}

function requireAvailable(url: string) {
  if (rpcCooldownRemaining(url) > 0) throw new Error("Network busy or unavailable. Retry after the cooldown.");
}

/** Only pinned public endpoints; no automatic retry, fallback, or cached security verification. */
export function rpcTransport(url: string) {
  requireEndpoint(url);
  return http(url, {
    timeout: 10_000,
    retryCount: 0,
    batch: { batchSize: 20, wait: 10 },
    onFetchRequest() {
      requireAvailable(url);
    },
    fetchFn(input, init) {
      // viem awaits its request hook. Recheck synchronously at fetch to close that microtask gap.
      requireAvailable(url);
      return fetch(input, init);
    },
    onFetchResponse(response) {
      if (response.status !== 429 && response.status !== 503) return;
      const until = performance.now() + retryDelay(response.headers.get("retry-after"));
      // Older in-flight success/error responses must not clear or shorten an active cooldown.
      cooldowns.set(url, Math.max(cooldowns.get(url) ?? 0, until));
    },
  });
}
