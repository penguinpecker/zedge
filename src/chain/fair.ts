/** The house's own fair value (services/market-maker/pricing.mjs, copied; fair.test.ts compares the two) and the price limits
 * and stake room of the one-click orders. Display data only: the engine decides every fill. */
import type { View } from "./private/client.ts";

const YEAR = 31_536_000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Standard normal CDF (Abramowitz and Stegun 7.1.26; error below 1.5e-7). */
export function phi(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/** Probability that the round closes Up, Φ(ln(S/S0) / (σ√τ)) with τ the chain time left in years, within [0.02, 0.98]. */
export function fairUp(spot: number, open: number, sigma: number, secondsLeft: number): number {
  if (!(spot > 0 && open > 0 && sigma > 0 && Number.isFinite(secondsLeft))) throw new Error("fairUp: invalid input");
  if (secondsLeft <= 0) return spot >= open ? 0.98 : 0.02;
  return clamp(phi(Math.log(spot / open) / (sigma * Math.sqrt(secondsLeft / YEAR))), 0.02, 0.98);
}
/** Annualised volatility (×√525,600) of 1-minute closes, oldest first, within [0.30, 1.50]. */
export function realizedSigma(closes: number[]): number {
  if (closes.length < 10 || !closes.every((c) => c > 0)) throw new Error("realizedSigma: need at least 10 positive closes");
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return clamp(Math.sqrt(variance * 525_600), 0.3, 1.5);
}

// The house quotes 3¢ either side of 100p; one click accepts 5¢ more than that.
const SPREAD = 3, SLACK = 5;
const cents = (p: number) => Math.round(p * 1e8) / 1e6; // 100p without binary noise, as the house reads it
/** Highest price a one-click buy accepts for a side the house values at `p`: its ask plus the slack. */
export const buyLimit = (p: number) => Math.min(99, Math.ceil(cents(p)) + SPREAD + SLACK);
/** Lowest price a one-click sell accepts: the house's bid less the slack. */
export const sellLimit = (p: number) => Math.max(1, Math.floor(cents(p)) - SPREAD - SLACK);

/** Shares (atoms, whole lots) one more buy of `outcome` can add in this round before the account's worst stake (guest README §9,
 * as pricing.mjs worstStake: a share pays one atom, resting buys count as bought, offered shares as sold) passes `limit` atoms. */
export function stakeRoom(view: Pick<View, "holdings" | "orders">, roundId: string, outcome: "up" | "down", limit: number): number {
  const h = view.holdings.find((x) => x.roundId === roundId) ?? { up: 0, down: 0, reservedUp: 0, reservedDown: 0 };
  const buys = (side: "up" | "down") => view.orders.filter((o) => o.roundId === roundId && o.side === "buy" && o.outcome === side).reduce((n, o) => n + o.remaining, 0);
  // A buy widens its own side's gap by its size and narrows the other's, so only its own side can pass the limit.
  const gap = outcome === "up" ? h.up + h.reservedUp + buys("up") - h.down : h.down + h.reservedDown + buys("down") - h.up;
  return Math.max(0, Math.floor((limit - gap) / 1000) * 1000);
}
