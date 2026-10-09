// Pure rules of the event house and the event's result (README "Event house", "The event's result"): the price from
// Polymarket and Kalshi, what the house sends next, the event from the deployment's manifests, and the resolver's
// signed result. No I/O. ethers and guest.ts are passed in where needed, so this module loads neither.
import { LEAD, expire, plan } from "./pricing.mjs";

const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };

/** The two price feeds (owner decision 2026-10-09). Polymarket: the CLOB midpoint of the Yes token of "Will the Democratic
 * Party control the House after the 2026 Midterm elections?". Kalshi: the CONTROLH series, whose CONTROLH-2026-D is Yes. */
export const EVENT_FEEDS = {
  polymarket: "https://clob.polymarket.com/midpoint?token_id=83247781037352156539108067944461291821683755894607244160607042790356561625563",
  kalshi: "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=CONTROLH&status=open",
};

/** Polymarket's {"mid": "0.905"}: the Yes midpoint, or null. */
export function polymarketMid(body) {
  const mid = typeof body?.mid === "string" ? Number(body.mid) : NaN;
  return mid > 0 && mid < 1 ? mid : null;
}

/** Kalshi's Yes bid and ask in dollars for CONTROLH-2026-D while it trades with both sides, or null. */
export function kalshiYes(body) {
  const m = Array.isArray(body?.markets) ? body.markets.find((x) => x?.ticker === "CONTROLH-2026-D") : null;
  const bid = Number(m?.yes_bid_dollars), ask = Number(m?.yes_ask_dollars);
  return m?.status === "active" && bid > 0 && bid <= ask && ask < 1 ? { bid, ask } : null;
}

const micro = (dollars) => Math.round(dollars * 1e6); // so that 3 cents compares as exactly 3 cents
/** The Yes probability the house quotes around, or why there is none. `poly` { mid, at } and `kalshi` { bid, ask, at } are
 * the latest good reads (`at` in ms); each counts for 60 s. Polymarket's midpoint while Kalshi's mid is within 3 cents of
 * it; Kalshi's mid alone while Polymarket cannot be read. No price without Kalshi, the only feed that shows a spread, with
 * Kalshi's spread above 5 cents, or with the two more than 3 cents apart. */
export function eventPrice(poly, kalshi, nowMs) {
  const fresh = (f) => !!f && nowMs - f.at <= 60_000;
  if (!fresh(kalshi)) return { ok: false, reason: fresh(poly) ? "Kalshi unavailable, and Polymarket alone is not quoted" : "Polymarket and Kalshi unavailable" };
  if (micro(kalshi.ask) - micro(kalshi.bid) > 50_000) return { ok: false, reason: "Kalshi's spread is above 5 cents" };
  const k = (micro(kalshi.bid) + micro(kalshi.ask)) / 2e6;
  if (!fresh(poly)) return { ok: true, p: k, source: "kalshi" };
  if (Math.abs(micro(poly.mid) - micro(k)) > 30_000) return { ok: false, reason: "Polymarket and Kalshi differ by more than 3 cents" };
  return { ok: true, p: poly.mid, source: "polymarket" };
}

/** The event house's next command for the event round { id, start, cutoff }: plan() around the price once the event has
 * started; with no price, a cancel_all while its quotes rest, since a quote lives for hours and must not stay up at a price
 * no feed backs. (None outlives cutoff − 60, so none rests after the cutoff.) */
export function eventPlan(view, round, now, price, s, opts) {
  if (price.ok && now >= round.start) return plan(view, round, now, price.p, s, opts);
  return expire(view, now + LEAD).orders.some((o) => o.roundId === round.id) ? { op: "cancel_all", roundId: round.id } : null;
}

/** The deployment's event, from its engine configuration JSON (an order-book manifest's engineConfigJson) and its events
 * manifest (scripts/write-orderbook-manifest.mjs): the engine domain, the engine round { id, spec } (codec = guest.ts
 * eventRound, which also checks the terms), the terms and the pinned resolver. */
export function deploymentEvent(engineConfigJson, events, codec) {
  const domain = JSON.parse(engineConfigJson).domain;
  if (events?.kind !== "zedge-events" || events.chainId !== domain.chainId) refuse("not this chain's events manifest (public/deployments/26514-events.json)");
  if (events.application !== domain.applicationId) refuse(`the events manifest is application ${events.application}'s, not ${domain.applicationId}'s`);
  if (!/^0x[0-9a-f]{40}$/.test(events.resolver ?? "")) refuse("the events manifest's resolver is not a lowercase address");
  const e = events.event ?? {}, terms = { question: e.questionHash, start: e.start, cutoff: e.cutoff, end: e.end, voidableAfter: e.voidableAfter };
  return { domain, ...codec.eventRound(engineConfigJson, terms), terms, resolver: events.resolver };
}

/** The signed result as scripts/sign-event-result.mjs writes it, for outcome 1 (Yes) or 2 (No) of `event` (deploymentEvent). */
export function resultBody(event, outcome, signature) {
  return { kind: "zedge-event-result", chainId: event.domain.chainId, endpoint: event.domain.endpoint, applicationId: event.domain.applicationId,
    round: `0x${event.id}`, registryRoundId: event.spec.registryRoundId, outcome, answer: outcome === 1 ? "Yes" : "No", resolver: event.resolver, signature };
}

/** The EIP-712 typed data the resolver signs, as ethers takes it: [domain, types, message]. */
export function resultTypedData(event, outcome, codec) {
  const t = codec.eventResultTypedData(event.domain, event.id, outcome);
  return [t.domain, { EventResult: [...codec.EVENT_RESULT_TYPES.EventResult] }, t.message];
}

/** The outcome of `result` once it is exactly a result of this event (resultBody) in the guest's signature format, signed by
 * the pinned resolver, and, given the chain time `now`, the event has ended. Anything else is refused before it can cost a
 * request. */
export function checkResult(result, event, { ethers, codec }, now) {
  if (now < event.terms.end) refuse(`the result is taken from the event's end, ${event.terms.end}; the chain is at ${now}`);
  const outcome = result?.outcome;
  if ((outcome !== 1 && outcome !== 2) || !/^0x[0-9a-f]{128}(1b|1c)$/.test(result.signature ?? "") ||
      JSON.stringify(result) !== JSON.stringify(resultBody(event, outcome, result.signature))) {
    refuse(`not a signed result of this deployment's event 0x${event.id}`);
  }
  const signer = ethers.verifyTypedData(...resultTypedData(event, outcome, codec), result.signature).toLowerCase();
  if (signer !== event.resolver) refuse(`the result is signed by ${signer}, not by the resolver ${event.resolver} the deployment pinned`);
  return outcome;
}
