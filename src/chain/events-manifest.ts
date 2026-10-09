/** The Politics market: the order book's one operator-resolved event (public/deployments/26514-events.json, written with the order
 * book's manifest by scripts/write-orderbook-manifest.mjs). Served by this site and parsed as strictly as the order book's manifest:
 * anything else and the Politics page stays closed. Its engine round is derived as the guest derives it (guest.ts eventRound). */
import { keccak256, type Address, type Hex } from "viem";
import type { ConfiguredOrderbook } from "./orderbook-manifest.ts";
import type { SettleRef } from "./read-api.ts";

/** The event this release offers: its rules file, the Keccak-256 of its exact bytes (the question hash the guest is deployed with;
 * events.test.ts checks it against the file) and the times those rules state. Changing the rules means changing all of these. */
export const US_HOUSE_2026 = {
  rules: "/events/us-house-2026.txt", questionHash: "0xf5c89309c52b38360804a828320f782a4b755170db7791f0933fd8024bb32a69",
  cutoff: 1_793_743_200, end: 1_793_743_201, voidableAfter: 1_801_439_999,
} as const;

export type EventTerms = { question: Hex; start: number; cutoff: number; end: number; voidableAfter: number };
/** The parsed manifest. `id`: the engine round ID (64 hex) that commands and holdings name; `registryRoundId`: the ID its public settle
 * records carry. Up is Yes, Down is No. */
export type PoliticsEvent = { release: string; application: string; resolver: Address; depositsFrom: number; rules: string; terms: EventTerms; id: string; registryRoundId: Hex };
type Book = Pick<ConfiguredOrderbook, "release" | "application" | "trigger" | "endpoint" | "custody">;

const fail = (): never => { throw new Error("Invalid events manifest."); };
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.toSorted().join(",")) fail();
  return value as Record<string, unknown>;
}
const time = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : fail();

/** The manifest's own fields, bound to the verified order book's release, application and deploy transaction, naming exactly this
 * release's event; a resolver that is one of the book's roles is refused. The round ID is filled in by loadEvent. */
export function parseEventsManifest(value: unknown, book: Book): Omit<PoliticsEvent, "id" | "registryRoundId"> {
  const r = object(value, ["schemaVersion", "kind", "chainId", "release", "application", "deployTx", "resolver", "depositsFrom", "event"]);
  const e = object(r.event, ["rules", "questionHash", "start", "cutoff", "end", "voidableAfter"]);
  if (r.schemaVersion !== 1 || r.kind !== "zedge-events" || r.chainId !== 26514 || r.release !== book.release || r.application !== book.application.id || r.deployTx !== book.application.deployTx) fail();
  const resolver = typeof r.resolver === "string" && /^0x[0-9a-f]{40}$/.test(r.resolver) && !/^0x0{40}$/.test(r.resolver) ? r.resolver as Address : fail();
  if ([book.application.house, book.trigger.address, book.endpoint.address, book.endpoint.operator, book.custody.vault.address, book.custody.inbox.address].includes(resolver)) fail();
  const start = time(e.start), u = US_HOUSE_2026;
  if (e.rules !== u.rules || e.questionHash !== u.questionHash || e.cutoff !== u.cutoff || e.end !== u.end || e.voidableAfter !== u.voidableAfter || start >= u.cutoff) fail();
  return { release: book.release, application: book.application.id, resolver, depositsFrom: time(r.depositsFrom), rules: u.rules,
    terms: { question: u.questionHash, start, cutoff: u.cutoff, end: u.end, voidableAfter: u.voidableAfter } };
}

/** The event of this order book, or null when it has none (no events manifest is served). A malformed or mismatched one throws. */
export async function loadEvent(book: Book & Pick<ConfiguredOrderbook, "application">, fetcher: typeof fetch = fetch): Promise<PoliticsEvent | null> {
  const response = await fetcher("/deployments/26514-events.json", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 404) return null;
  const body = response.ok ? await response.text() : fail();
  if (body.length > 4_096) fail();
  const parsed = parseEventsManifest(JSON.parse(body) as unknown, book);
  // Loaded only here: guest.ts brings in ethers' ABI coder, which the first chain-mode load does not need.
  const { eventRound } = await import("../../adapters/vela/crypto/guest.ts");
  const round = eventRound(book.application.engineConfigJson, parsed.terms);
  return { ...parsed, id: round.id, registryRoundId: round.spec.registryRoundId.toLowerCase() as Hex };
}

/** The rules text, only if its bytes hash to the event's question hash: the exact text the market was deployed with. */
export async function loadRules(event: Pick<PoliticsEvent, "rules" | "terms">, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(event.rules, { cache: "no-store", credentials: "same-origin" });
  const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : fail();
  if (bytes.length > 16_384 || keccak256(bytes) !== event.terms.question) throw new Error("The rules text does not match this market.");
  return new TextDecoder().decode(bytes);
}

/** What a settle record of the event says: 1 Yes or 2 No (kind 2, posted by the resolver, source 4), 3 void (kind 3, the timeout void,
 * source 3); null for anything else, which the event can never have. */
export function eventOutcome(s: Pick<SettleRef, "kind" | "outcome" | "source"> | null): 1 | 2 | 3 | null {
  if (s?.kind === 2 && s.source === 4 && (s.outcome === 1 || s.outcome === 2)) return s.outcome;
  return s?.kind === 3 && s.source === 3 && s.outcome === 3 ? 3 : null;
}
