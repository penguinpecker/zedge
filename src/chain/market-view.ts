/** Display rules of the live market page (ChainApp.tsx), free of React so they can be tested: the round's phase and countdown by
 * the 1 s clock, and the house's ask as a price estimate. */
import { countdown } from "../lib/market.ts";

/** A round's start, order cutoff and end, in unix seconds. */
export type RoundTimes = { start: number; cutoff: number; end: number };

/** The registry phase read at the last block, carried forward by the clock: Scheduled becomes Awaiting opening price at the start,
 * Trading window becomes Closed at the cutoff and Closed becomes Awaiting resolution at the end. A read can be 30 s old; a result
 * (Resolved, Voided) only ever comes from the chain. */
export function clockPhase(phase: number, times: RoundTimes, now: number): number {
  if (phase === 1 && now >= times.start) phase = 2;
  if (phase === 3 && now >= times.cutoff) phase = 4;
  if (phase === 4 && now >= times.end) phase = 5;
  return phase;
}

/** The countdown cell: the time to the start of a round not begun, else the time to its end, with the order cutoff called out in
 * the 30 s before it and after it. `progress` runs from 0 to 1 across the round. */
export function countdownLine(t: RoundTimes, now: number): { label: string; time: string; urgent: boolean; progress: number } {
  const progress = Math.min(1, Math.max(0, (now - t.start) / (t.end - t.start)));
  const left = (to: number) => countdown((to - now) * 1000);
  if (now < t.start) return { label: "Starts in", time: left(t.start), urgent: false, progress };
  if (now >= t.end) return { label: "Ended", time: "00:00", urgent: false, progress };
  if (now >= t.cutoff) return { label: "Orders closed · ends in", time: left(t.end), urgent: true, progress };
  if (now >= t.cutoff - 30) return { label: `Orders close in ${left(t.cutoff)}`, time: left(t.end), urgent: true, progress };
  return { label: "Ends in", time: left(t.end), urgent: false, progress };
}

/** The house's ask for a side it values at `p` (services/market-maker/pricing.mjs quotes at its default 3¢ half-spread): what a
 * one-click buy most likely pays. Shown as an estimate until the house publishes its own quotes. */
export const askCents = (p: number) => Math.min(99, Math.max(3, Math.ceil(Math.round(p * 1e8) / 1e6) + 3));
