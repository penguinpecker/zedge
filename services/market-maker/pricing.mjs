// Pure rules of the house market maker (README.md): fair value, quotes, the guest's stake and what to send next.
// No I/O. Prices are integer cents, quantities share atoms (one share = 1,000,000; Lot = 1,000), cash collateral atoms.

export const SHARE = 1_000_000;
const YEAR = 31_536_000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Standard normal CDF (Abramowitz and Stegun 7.1.26; error below 1.5e-7). */
export function phi(x) {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Probability that the round closes Up, Φ(ln(S/S0) / (σ√τ)) with τ the chain time left in years, within [0.02, 0.98].
 * Ties resolve Up; void risk is not modelled. */
export function fairUp(spot, open, sigma, secondsLeft) {
  if (!(spot > 0 && open > 0 && sigma > 0 && Number.isFinite(secondsLeft))) throw new Error("fairUp: invalid input");
  if (secondsLeft <= 0) return spot >= open ? 0.98 : 0.02;
  return clamp(phi(Math.log(spot / open) / (sigma * Math.sqrt(secondsLeft / YEAR))), 0.02, 0.98);
}

/** Integer-cent quotes around p with half-spread h: bid = floor(100p) − h in [1, 97], ask = ceil(100p) + h in [3, 99];
 * Down the same with 1 − p. */
export function quotes(p, h) {
  const side = (q) => {
    const c = Math.round(q * 1e8) / 1e6; // 100q without binary noise (1 − 0.57 is 0.43000000000000005)
    return { bid: clamp(Math.floor(c) - h, 1, 97), ask: clamp(Math.ceil(c) + h, 3, 99) };
  };
  return { up: side(p), down: side(1 - p) };
}

/** Annualised volatility (×√525,600) of 1-minute closes, oldest first, within [0.30, 1.50]. */
export function realizedSigma(closes) {
  if (closes.length < 10 || !closes.every((c) => c > 0)) throw new Error("realizedSigma: need at least 10 positive closes");
  const r = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return clamp(Math.sqrt(variance * 525_600), 0.3, 1.5);
}

/** Coinbase's mid if both feeds are at most 10 s old and within 0.3 % of each other. Feeds are { mid, at } (ms). */
export function spotCheck(coinbase, kraken, nowMs) {
  if (!(coinbase?.mid > 0 && kraken?.mid > 0)) return { ok: false, reason: "spot missing" };
  if (nowMs - coinbase.at > 10_000 || nowMs - kraken.at > 10_000) return { ok: false, reason: "spot stale" };
  if (Math.abs(coinbase.mid - kraken.mid) / kraken.mid > 0.003) return { ok: false, reason: "spot disputed" };
  return { ok: true, spot: coinbase.mid };
}

/** The guest's worst stake (guest README §9), summed over every round the view holds, in atoms:
 * max(up + reservedUp + resting Up buys − down, down + reservedDown + resting Down buys − up). */
export function worstStake(view) {
  const rounds = new Map();
  const at = (id) => rounds.get(id) ?? rounds.set(id, { up: 0, down: 0, reservedUp: 0, reservedDown: 0, buyUp: 0, buyDown: 0 }).get(id);
  for (const h of view.holdings) Object.assign(at(h.roundId), { up: h.up, down: h.down, reservedUp: h.reservedUp, reservedDown: h.reservedDown });
  for (const o of view.orders) if (o.side === "buy") at(o.roundId)[o.outcome === "up" ? "buyUp" : "buyDown"] += o.remaining;
  let total = 0;
  for (const x of rounds.values()) total += Math.max(x.up + x.reservedUp + x.buyUp - x.down, x.down + x.reservedDown + x.buyDown - x.up);
  return total;
}

const reservedKey = (outcome) => (outcome === "up" ? "reservedUp" : "reservedDown");
function holding(view, roundId) {
  let h = view.holdings.find((x) => x.roundId === roundId);
  if (!h) view.holdings.push((h = { roundId, up: 0, down: 0, reservedUp: 0, reservedDown: 0 }));
  return h;
}
/** Returns orders matching `gone` to the account: a buy's reserved cash, a sell's offered shares. Mutates. */
function release(view, gone) {
  for (const o of view.orders.filter(gone)) {
    if (o.side === "buy") { view.cash += o.reservedCash; view.reservedCash -= o.reservedCash; }
    else { const h = holding(view, o.roundId); h[o.outcome] += o.remaining; h[reservedKey(o.outcome)] -= o.remaining; }
  }
  view.orders = view.orders.filter((o) => !gone(o));
  return view;
}

/** The view as if command c had been applied whole: a mint adds sets, a place_order rests unfilled, a cancel_all
 * releases the round's orders. The model for a staged command until its outcome comes back (and for --dry-run). */
export function apply(view, c) {
  const v = structuredClone(view);
  if (c.op === "mint") { v.cash -= c.quantity; const h = holding(v, c.roundId); h.up += c.quantity; h.down += c.quantity; return v; }
  if (c.op === "cancel_all") return release(v, (o) => o.roundId === c.roundId);
  if (c.op !== "place_order") return v;
  const o = { roundId: c.roundId, outcome: c.outcome, side: c.side, price: c.price, remaining: c.quantity, reservedCash: 0, expiry: c.expiry };
  if (c.side === "buy") { o.reservedCash = Math.floor(c.quantity / 100) * c.price; v.cash -= o.reservedCash; v.reservedCash += o.reservedCash; }
  else { const h = holding(v, c.roundId); h[c.outcome] -= c.quantity; h[reservedKey(c.outcome)] += c.quantity; }
  v.orders.push(o);
  return v;
}

/**
 * The next command for the open round, or null. `view` is the house's view (its latest receipt, staged commands
 * applied), `round` { id, cutoff }, `now` chain time, `p` the fair Up probability or null when pricing is refused.
 *   from cutoff − 120: no new orders; in [cutoff − 90, cutoff) a cancel_all if anything still rests;
 *   a cancel_all when a resting quote is `requoteDriftCents` or more from 100p;
 *   otherwise the first missing quote of askUp, askDown, bidUp, bidDown (minting sets first for an ask), each
 *   expiring at min(now + lifetime, cutoff − 60) and skipped if the total worst stake would pass maxStakeUsdc.
 */
export function plan(view, round, now, p, s) {
  const v = release(structuredClone(view), (o) => o.expiry <= now); // the next tick's checkpoint releases these first
  const mine = v.orders.filter((o) => o.roundId === round.id);
  if (now >= round.cutoff - 120) return mine.length && now >= round.cutoff - 90 && now < round.cutoff ? { op: "cancel_all", roundId: round.id } : null;
  if (p === null) return null;
  const h = s.halfSpreadCents, cents = Math.round(p * 1e8) / 1e6; // 100p as quotes() reads it
  const implied = (o) => { const x = o.side === "sell" ? o.price - h : o.price + h; return o.outcome === "up" ? x : 100 - x; };
  if (mine.some((o) => Math.abs(implied(o) - cents) >= s.requoteDriftCents)) return { op: "cancel_all", roundId: round.id };
  const q = quotes(p, h), Q = s.quoteShares * SHARE, expiry = Math.min(now + s.quoteLifetimeSeconds, round.cutoff - 60);
  const held = v.holdings.find((x) => x.roundId === round.id) ?? { up: 0, down: 0 };
  for (const [outcome, side] of [["up", "sell"], ["down", "sell"], ["up", "buy"], ["down", "buy"]]) {
    if (mine.some((o) => o.outcome === outcome && o.side === side)) continue;
    const order = { op: "place_order", roundId: round.id, outcome, side, price: q[outcome][side === "sell" ? "ask" : "bid"], quantity: Q, tif: "gtc", expiry };
    const mint = side === "sell" && held[outcome] < Q ? { op: "mint", roundId: round.id, quantity: s.mintSets * SHARE } : null;
    if (mint && v.cash < mint.quantity) continue;
    if (side === "buy" && v.cash < Math.floor(Q / 100) * order.price) continue;
    if (worstStake(apply(mint ? apply(v, mint) : v, order)) > s.maxStakeUsdc * SHARE) continue; // a mint itself changes no stake
    return mint ?? order;
  }
  return null;
}
