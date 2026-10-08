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

/** The view once orders with expiry ≤ t are gone: a tick's checkpoint at t releases them before it activates anything. */
export function expire(view, t) {
  return release(structuredClone(view), (o) => o.expiry <= t);
}

/** The view as if command c had been applied whole: a mint adds sets, a place_order rests unfilled under its command ID
 * `c.id`, a cancel_order releases that order, a cancel_all the round's orders. The model for a staged command until its
 * outcome comes back (and for --dry-run). */
export function apply(view, c) {
  const v = structuredClone(view);
  if (c.op === "mint") { v.cash -= c.quantity; const h = holding(v, c.roundId); h.up += c.quantity; h.down += c.quantity; return v; }
  if (c.op === "cancel_all") return release(v, (o) => o.roundId === c.roundId);
  if (c.op === "cancel_order") return release(v, (o) => o.id === c.orderId);
  if (c.op !== "place_order") return v;
  const o = { id: c.id, roundId: c.roundId, outcome: c.outcome, side: c.side, price: c.price, remaining: c.quantity, reservedCash: 0, expiry: c.expiry };
  if (c.side === "buy") { o.reservedCash = Math.floor(c.quantity / 100) * c.price; v.cash -= o.reservedCash; v.reservedCash += o.reservedCash; }
  else { const h = holding(v, c.roundId); h[c.outcome] -= c.quantity; h[reservedKey(c.outcome)] += c.quantity; }
  v.orders.push(o);
  return v;
}

// Simplification: Horizen stamps blocks +1 s, so a request sent at head h is committed, and its tick runs, at T ≥ h + 2.
// Must be 0 on a chain that can repeat a timestamp.
const LEAD = 2;
const SIDES = [["up", "sell"], ["down", "sell"], ["up", "buy"], ["down", "buy"]];

/**
 * The next command for the open round, or null. `view` is the house's view (its latest receipt, staged commands
 * applied), `round` { id, cutoff }, `now` chain time, `p` the fair Up probability or null when pricing is refused,
 * `cycle` the measured seconds from sending a request to its receipt, `optional` whether a requote that only helps
 * users may go out now. An order expiring by now + LEAD counts as gone: its replacement is sent before it expires and
 * activates after the checkpoint released it, so no fifth order and no cancel. In order:
 *   from cutoff − 120: no new orders; in [cutoff − 90, cutoff) a cancel_all if anything still rests;
 *   a cancel_order of the quote furthest in the trader's favour, by requoteDriftCents or more (an ask below the fresh
 *   ask, a bid above the fresh bid);
 *   the first missing quote of askUp, askDown, bidUp, bidDown (minting sets first for an ask), skipped if the total worst
 *   stake would pass maxStakeUsdc; or a cancel_order of the house's own quote that the new one would cross;
 *   only if optional, no side is missing and no rotation falls due within one cycle: a cancel_order of the quote
 *   drifted furthest the house's way (it fails users' one-click orders).
 * A cancel never targets an order expiring within SOON = max(12, 2 cycles): it would land after the order is gone and be
 * refused, and since a refusal uses no nonce, the next command would be refused too. That order rotates instead.
 */
export function plan(view, round, now, p, s, { cycle = 6, optional = true } = {}) {
  const v = expire(view, now + LEAD); // gone before anything sent now activates
  const mine = v.orders.filter((o) => o.roundId === round.id);
  if (now >= round.cutoff - 120) return mine.length && now >= round.cutoff - 90 && now < round.cutoff ? { op: "cancel_all", roundId: round.id } : null;
  if (p === null) return null;
  const q = quotes(p, s.halfSpreadCents), Q = s.quoteShares * SHARE, L = s.quoteLifetimeSeconds, soon = now + Math.max(12, 2 * cycle);
  const fresh = (outcome, side) => q[outcome][side === "sell" ? "ask" : "bid"];
  const against = (o) => (o.side === "sell" ? fresh(o.outcome, o.side) - o.price : o.price - fresh(o.outcome, o.side)); // > 0: the trader's favour
  const pull = (sign) => {
    const o = mine.filter((x) => sign * against(x) >= s.requoteDriftCents && x.expiry > soon).sort((a, b) => sign * (against(b) - against(a)))[0];
    return o ? { op: "cancel_order", orderId: o.id } : null;
  };
  const adverse = pull(1);
  if (adverse) return adverse;
  const held = v.holdings.find((x) => x.roundId === round.id) ?? { up: 0, down: 0 };
  const missing = SIDES.filter(([outcome, side]) => !mine.some((o) => o.outcome === outcome && o.side === side));
  for (const entry of missing) {
    const [outcome, side] = entry, price = fresh(outcome, side);
    const own = mine.find((o) => o.outcome === outcome && o.side !== side && (side === "buy" ? price >= o.price : price <= o.price));
    if (own) { if (own.expiry > soon) return { op: "cancel_order", orderId: own.id }; continue; } // self-trade prevention would cancel the new one
    // Side k expires on its own grid, k quarter-lifetimes apart and 0.5 to 1.5 lifetimes ahead, so rotations never fall due together.
    // Never sooner than SOON: a deep endpoint queue can commit a request 30 s or more after it is sent, and an order already
    // expired at its commit is refused ("invalid order", counted toward the round's refusals).
    const x = Math.max(now + Math.ceil(L / 2), soon), phase = SIDES.indexOf(entry) * Math.floor(L / 4);
    const order = { op: "place_order", roundId: round.id, outcome, side, price, quantity: Q, tif: "gtc", expiry: Math.min(x + (((phase - x) % L) + L) % L, round.cutoff - 60) };
    // mintSets sets, or only the shares this ask lacks when cash is short, so a small house still rests asks
    const lack = side === "sell" && held[outcome] < Q ? (v.cash >= s.mintSets * SHARE ? s.mintSets * SHARE : Q - held[outcome]) : 0;
    const mint = lack ? { op: "mint", roundId: round.id, quantity: lack } : null;
    if (mint && v.cash < mint.quantity) continue;
    if (side === "buy" && v.cash < Math.floor(Q / 100) * order.price) continue;
    if (worstStake(apply(mint ? apply(v, mint) : v, order)) > s.maxStakeUsdc * SHARE) continue; // a mint itself changes no stake
    return mint ?? order;
  }
  if (!optional || missing.length || mine.some((o) => o.expiry - LEAD <= now + cycle)) return null;
  return pull(-1);
}
