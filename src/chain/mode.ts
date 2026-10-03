export type AppMode = "demo" | "chain";

// Read before mounting either app: chain mode must never initialize the demo ledger.
export function appMode(search: string, hash = ""): AppMode {
  if (new URLSearchParams(search).get("mode") === "demo") return "demo";
  return new URLSearchParams(search).get("mode") === "chain" || /^#\/?chain(?:\/|$)/.test(hash)
    ? "chain"
    : "demo";
}
