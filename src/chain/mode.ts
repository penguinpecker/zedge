export type AppMode = "demo" | "chain";

// Read before mounting either app: chain mode must never initialize the demo ledger.
// The live market is the default (owner decision 2026-10-07); the paper demo opens only at ?mode=demo.
// `?mode=chain` and `#/chain` links keep working because everything that is not the demo is chain.
export function appMode(search: string, _hash = ""): AppMode {
  return new URLSearchParams(search).get("mode") === "demo" ? "demo" : "chain";
}
