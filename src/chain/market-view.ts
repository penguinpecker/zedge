/** Display rules of the live market page (ChainApp.tsx), free of React so they can be tested: the round's phase and countdown by
 * the 1 s clock, and the ticket's prices, the house's quotes or an estimate. */
import { countdown } from "../lib/market.ts";
import { buyLimit, sellLimit } from "./fair.ts";
import type { ApiRound, EventHouse, House } from "./read-api.ts";

/** A round's start, order cutoff and end, in unix seconds. */
export type RoundTimes = { start: number; cutoff: number; end: number };

/** The registry phase read at the last block, carried forward by the clock: Scheduled becomes Awaiting opening price at the start,
 * Trading window becomes Closed when the ticket stops taking orders (ORDER_MARGIN before the cutoff, so the badge and the ticket agree)
 * and Closed becomes Awaiting resolution at the end. A read can be 30 s old; a result (Resolved, Voided) only ever comes from the chain. */
export function clockPhase(phase: number, times: RoundTimes, now: number): number {
  if (phase === 1 && now >= times.start) phase = 2;
  if (phase === 3 && now >= times.cutoff - ORDER_MARGIN) phase = 4;
  if (phase === 4 && now >= times.end) phase = 5;
  return phase;
}

/** Seconds before the registry's cutoff when the ticket stops taking orders (an order needs that long to reach the book). */
export const ORDER_MARGIN = 15;
/** Round #1 is the first 15-minute slot after the round registry went live on Horizen (block 27958006, 2026-10-07 06:41:29 UTC),
 * so a round's number is the same on every application that followed it. Rounds before that have no number. */
export const ROUND_ONE = 1_791_355_500;
export const roundNumber = (start: number, duration: number): number | null => start >= ROUND_ONE && Number.isInteger((start - ROUND_ONE) / duration) ? (start - ROUND_ONE) / duration + 1 : null;

/** The countdown cell: the time to the start of a round not begun, else the time to its end, with the close of orders (the cutoff
 * less ORDER_MARGIN, when the ticket stops) called out in the 30 s before it and after it. `progress` runs from 0 to 1 across the round. */
export function countdownLine(t: RoundTimes, now: number): { label: string; time: string; urgent: boolean; progress: number } {
  const progress = Math.min(1, Math.max(0, (now - t.start) / (t.end - t.start)));
  const left = (to: number) => countdown((to - now) * 1000), close = t.cutoff - ORDER_MARGIN;
  if (now < t.start) return { label: "Starts in", time: left(t.start), urgent: false, progress };
  if (now >= t.end) return { label: "Ended", time: "00:00", urgent: false, progress };
  if (now >= close) return { label: "Orders closed · ends in", time: left(t.end), urgent: true, progress };
  if (now >= close - 30) return { label: `Orders close in ${left(close)}`, time: left(t.end), urgent: true, progress };
  return { label: "Ends in", time: left(t.end), urgent: false, progress };
}

/** A price less the round's exact opening, unrounded: settlement is Up at or above the opening, so the sign is taken before any
 * rounding (a Down lead under half a cent reads ▼ $0.00, not ▲). Null without both. */
export const versus = (value: number | null, opening: string | null) => value === null || opening === null ? null : value - Number(opening);

/** The house's ask for a side it values at `p` (services/market-maker/pricing.mjs quotes at its default 3¢ half-spread): what a
 * one-click buy most likely pays. Shown as an estimate while the house's own quotes are unavailable. */
export const askCents = (p: number) => Math.min(99, Math.max(3, Math.ceil(Math.round(p * 1e8) / 1e6) + 3));

/** How old the house's quotes may be by chain time: the indexer's own 20 s, the page's 2 s read and a margin. A read API that stops
 * answering leaves its last answer on the page; this retires its quotes. */
export const HOUSE_STALE_MS = 30_000;
/** The house's quotes when they are for the round starting at `start` and fresh at `nowMs` (chain time), else null. */
export const houseFor = (house: House | null | undefined, start: number | null, nowMs: number): House | null =>
  house && house.start === start && nowMs - house.at <= HOUSE_STALE_MS ? house : null;
/** How old the event house's quotes may be: the indexer's own 60 s, the page's 2 s read and a margin. */
export const EVENT_STALE_MS = 90_000;
/** The event house's quotes when they are for engine round `id` (64 hex) and fresh at `nowMs` (chain time), else null. */
export const eventHouseFor = (event: EventHouse | null | undefined, id: string | null, nowMs: number): EventHouse | null =>
  event && id && event.round === `0x${id}` && nowMs - event.at <= EVENT_STALE_MS ? event : null;

/** One side on the ticket: the price shown, the buy's and the close's limits, and whether they are estimates. */
export type SidePrice = { ask: number | null; buy: number | null; sell: number | null; est: boolean };
/** With the house's quotes (houseFor): its ask, which is the buy's limit exactly, and its bid, the close's; null where it has none.
 * A fill executes at the resting order's price (engine/matching.go), so a buy at the house's ask pays that ask or less, and a
 * close at its bid gets that bid or more. Without them: the ask for the house's fair value `up` (askCents), marked est., and the
 * one-click limits with their slack (fair.ts). */
export function sidePrice(house: Pick<House, "up" | "down"> | null, up: number | null, side: "up" | "down"): SidePrice {
  if (house) { const q = house[side]; return { ask: q.ask?.cents ?? null, buy: q.ask?.cents ?? null, sell: q.bid?.cents ?? null, est: false }; }
  const p = up === null ? null : side === "up" ? up : 1 - up;
  return p === null ? { ask: null, buy: null, sell: null, est: true } : { ask: askCents(p), buy: buyLimit(p), sell: sellLimit(p), est: true };
}

/** The round the ticket trades and its opening price. The registry's while its trading window is open (by the clock, as the badge).
 * Before the registry records the opening (Not scheduled, Scheduled, Awaiting opening price), the engine's own opening for that slot,
 * which the caller has confirmed on chain because it feeds the buy limit, until ORDER_MARGIN before the engine's cutoff. The engine
 * refuses an early order itself; this only opens the ticket about 25 s sooner each round. */
export function tradable(registry: { phase: number; times: RoundTimes; opening: string | null } | null, engine: { times: RoundTimes; opening: string } | null, now: number): (RoundTimes & { opening: string | null }) | null {
  const phase = registry ? clockPhase(registry.phase, registry.times, now) : 0;
  if (registry && phase === 3) return { ...registry.times, opening: registry.opening };
  if (engine && phase <= 2 && now >= engine.times.start && now < engine.times.cutoff - ORDER_MARGIN) return { ...engine.times, opening: engine.opening };
  return null;
}

/** The Portfolio's name for a holding: the event's round (by name), a BTC round of the last day (by its start, in `starts`), or an
 * earlier BTC round. */
export const holdingKind = (roundId: string, starts: ReadonlyMap<string, number>, eventId: string | null): "event" | "round" | "earlier" =>
  roundId === eventId ? "event" : starts.has(roundId) ? "round" : "earlier";

export type RoundResult = { start: number; outcome: "up" | "down" | "void" | null; open: bigint | null; close: bigint | null };
/** The results strip: every round that ended in the last 24 hours, oldest first, from the read API's rounds with the shared live
 * read's newer records over them. Display only. `outcome` null: no result recorded yet. */
export function roundResults(listed: ApiRound[], live: ApiRound[], now: number): RoundResult[] {
  const byStart = new Map([...listed, ...live].map((r) => [r.start, r]));
  return [...byStart.values()].filter((r) => r.start + 900 <= now && r.start + 900 > now - 86_400).sort((a, b) => a.start - b.start).map((r) => {
    const s = r.settle;
    return { start: r.start, outcome: !s ? null : s.kind === 3 || s.outcome === 3 ? "void" : s.outcome === 1 ? "up" : s.outcome === 2 ? "down" : null, open: r.open?.price ?? null, close: s && s.kind === 2 ? s.price : null };
  });
}
