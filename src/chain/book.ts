/** One outcome's order book, from the house's best resting level per side (read-api.ts House). Pure, so the rows can be tested
 * without React. Asks come best (lowest) first and bids best (highest) first; the display reverses the asks so the two bests meet
 * at the spread row. Totals are cumulative USDC atoms from the best level outward (shares are atoms, so shares × cents / 100). */
import type { House, Quote } from "./read-api.ts";

export type Level = { cents: number; shares: number; total: number };
export type BookLevels = { asks: Level[]; bids: Level[]; spread: number | null; mid: number | null; max: number };

const cumulative = (quotes: (Quote | null)[]): Level[] => {
  let total = 0;
  return quotes.flatMap((q) => q ? [{ cents: q.cents, shares: q.shares, total: total += Math.floor(q.shares / 100) * q.cents }] : []);
};

export function bookLevels(house: Pick<House, "up" | "down"> | null, outcome: "up" | "down"): BookLevels {
  const side = house?.[outcome], asks = cumulative([side?.ask ?? null]), bids = cumulative([side?.bid ?? null]);
  const ask = asks[0]?.cents ?? null, bid = bids[0]?.cents ?? null, both = ask !== null && bid !== null;
  // The depth bars share one scale, so a thin side reads as thin next to a deep one; 1 keeps an empty book from dividing by zero.
  const max = Math.max(1, ...asks.map((l) => l.total), ...bids.map((l) => l.total));
  return { asks, bids, spread: both ? ask - bid : null, mid: both ? (ask + bid) / 2 : null, max };
}
