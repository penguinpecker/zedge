/** Display rules of the live market page (ChainApp.tsx), free of React so they can be tested: the round's phase and countdown by
 * the 1 s clock, and the house's ask as a price estimate. */
import { countdown } from "../lib/market.ts";
import type { ApiRound } from "./read-api.ts";

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
 * one-click buy most likely pays. Shown as an estimate until the house publishes its own quotes. */
export const askCents = (p: number) => Math.min(99, Math.max(3, Math.ceil(Math.round(p * 1e8) / 1e6) + 3));

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
