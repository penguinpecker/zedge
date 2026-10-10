/** The Politics page: the order book's one event (events-manifest.ts), traded like a BTC round with the one-click ticket (client.ts
 * buy and close, at exactly the price shown, waiting up to 20 s) but by its engine round ID, priced by the event house's quotes only,
 * and settled by the operator's signed result. Up is Yes, Down is No. */
import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsDownUp, Bank, CaretRight, Check, LockKey, Wallet, X } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import { countdown } from "../lib/market.ts";
import { eventOutcome, loadRules, type PoliticsEvent } from "./events-manifest.ts";
import { chainClient } from "./gateway.ts";
import { ORDER_MARGIN, sidePrice } from "./market-view.ts";
import { parseAtomicAmount, transactionExplorerUrl } from "./networks.ts";
import { LOT, type ConfiguredOrderbook, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { ActionLine, HouseQuotes, shares, usdc } from "./PrivatePanels.tsx";
import { sharesFor, waitingOrder } from "./private/client.ts";
import type { PrivateState } from "./private/use-private.ts";
import type { ChainWallet } from "./privy.tsx";
import { confirmSettle, readApi, type EventHouse } from "./read-api.ts";
import { stakeRoom } from "./fair.ts";

type Side = "up" | "down";
export const SIDE_NAME = { up: "Yes", down: "No" } as const;
export const EVENT_QUESTION = "Will Democrats win control of the US House in the 3 November 2026 midterms?";
const cents = (value: number | null) => value === null ? "—" : `${value}¢`;
// The house's quotes only, never an estimate: its ask is the buy's limit exactly, its bid the close's (market-view.ts sidePrice).
const ask = (quotes: EventHouse | null, side: Side) => sidePrice(quotes, null, side).buy;
const bid = (quotes: EventHouse | null, side: Side) => sidePrice(quotes, null, side).sell;
const utcDate = (s: number) => `${new Date(s * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
const localDate = (s: number) => new Date(s * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
const offUtc = new Date().getTimezoneOffset() !== 0;
/** Time left, at the scale that matters: days and hours, then hours and minutes, then the round clock's mm:ss. */
const left = (s: number) => s >= 86_400 ? `${Math.floor(s / 86_400)}d ${Math.floor(s % 86_400 / 3_600)}h` : s >= 3_600 ? `${Math.floor(s / 3_600)}h ${String(Math.floor(s % 3_600 / 60)).padStart(2, "0")}m` : countdown(s * 1000);

type Result = { outcome: 1 | 2 | 3; txHash: string };
/** The event's result: the read API names its settle record (/v1/event), and one receipt read on chain confirms it is exactly that
 * record of this application (confirmSettle) before it shows. Asked for from the event's end, every minute until it is there. */
function useResult(event: PoliticsEvent, book: ConfiguredOrderbook | null, now: number): Result | null {
  const [result, setResult] = useState<Result | null>(null);
  const ended = now >= event.terms.end;
  useEffect(() => {
    if (!ended || !book || result) return;
    let on = true;
    const look = async () => {
      const api = await readApi().event();
      const s = api && api.round === `0x${event.id}` && api.registryRoundId === event.registryRoundId ? api.settle : null, outcome = eventOutcome(s);
      if (!s || !outcome || !await confirmSettle(chainClient(26514), book, s, event.registryRoundId).catch(() => false)) return;
      if (on) setResult({ outcome, txHash: s.txHash });
    };
    void look();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void look(); }, 60_000);
    return () => { on = false; clearInterval(timer); };
  }, [ended, book, result, event.id, event.registryRoundId]);
  return result;
}

function Rules({ event }: { event: PoliticsEvent }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { let on = true; void loadRules(event).then((t) => { if (on) setText(t); }, () => { if (on) setFailed(true); }); return () => { on = false; }; }, [event]);
  return <section className="chain-panel event-rules" aria-labelledby="event-rules-title"><div className="chain-panel-heading"><h2 id="event-rules-title">Rules</h2><a className="chain-pill" href={event.rules} target="_blank" rel="noreferrer">Text file <ArrowSquareOut size={12} /></a></div>
    {text !== null ? <div className="event-rules-text">{text}</div> : <p className={failed ? "chain-error" : "chain-copy"}>{failed ? "The rules text could not be checked against this market. Open the text file above, or try again later." : "Loading the rules…"}</p>}
    {text !== null && <p className="chain-copy event-rules-note">This is the exact text the market was set up with: its Keccak-256 hash, <code>{event.terms.question}</code>, is the market’s question hash on chain.</p>}</section>;
}

type TicketProps = { event: PoliticsEvent; priv: PrivateState; orderbook: VerifiedOrderbook | null; wallet: ChainWallet; quotes: EventHouse | null; now: number; outcome: Side; onOutcome: (side: Side) => void; onAccount: () => void; onFunds: () => void };
/** The BTC ticket's flow for the event: one click to buy at the house's ask (the limit is exactly that price), one to close at its bid. */
function EventTicket({ event, priv, orderbook, wallet, quotes, now, outcome, onOutcome, onAccount, onFunds }: TicketProps) {
  const [stake, setStake] = useState("5");
  const book = orderbook?.manifest, view = priv.snapshot?.view ?? null, unlocked = Boolean(priv.snapshot?.unlocked), cash = view?.cash ?? 0;
  const round = { id: event.id, cutoff: event.terms.cutoff }, limit = ask(quotes, outcome), name = SIDE_NAME[outcome];
  let pay = 0;
  try { pay = stake ? Number(parseAtomicAmount(stake, 6)) : 0; } catch { pay = -1; }
  // Before a first deposit there is no view: the room is then the account's whole stake limit. Without a verified book it is unknown.
  const cap = book ? Number(book.application.stakeLimits.account) : 0, room = book ? view ? stakeRoom(view, event.id, outcome, cap) : cap : Infinity;
  // A buy at the house's ask can fill only the shares resting there.
  const offered = quotes?.[outcome].ask?.shares ?? Infinity;
  const wanted = limit && pay > 0 ? sharesFor(pay, limit) : 0, quantity = Math.min(wanted, room, offered);
  const open = now < event.terms.cutoff - ORDER_MARGIN, rest = waitingOrder(view, now);
  const frozen = Boolean(orderbook?.withdrawOnly), trading = Boolean(book && !frozen && unlocked && open && !priv.busy && !rest);
  const held = view?.holdings.find((h) => h.roundId === event.id);
  const total = (side: Side) => side === "up" ? (held?.up ?? 0) + (held?.reservedUp ?? 0) : (held?.down ?? 0) + (held?.reservedDown ?? 0);
  const free = (side: Side) => Math.floor((side === "up" ? held?.up ?? 0 : held?.down ?? 0) / LOT) * LOT;
  const sets = Math.min(free("up"), free("down"));
  const buy = () => { if (limit && quantity) void priv.run((a) => a.buy(round, outcome, limit, quantity, now)); };
  const close = (side: Side) => { const p = bid(quotes, side); if (p !== null) void priv.run((a) => a.close(round, side, p, now)); };
  const [label, action, enabled] = !wallet.session ? ["Sign in to trade", onAccount, wallet.configured && !wallet.pending]
    : !book ? ["Trading is not open yet", onAccount, false]
    : frozen ? ["Withdraw your balance", onFunds, true]
    : !unlocked ? [priv.busy ? "Unlocking your account…" : "Unlock your account", () => void priv.run((a) => a.unlock()), !priv.busy]
    : cash === 0 ? priv.snapshot?.behind ? ["Refresh balance", () => void priv.run((a) => a.sync()), !priv.busy] : ["Deposit to trade", onFunds, true]
    : !open ? ["Trading has closed", buy, false]
    : limit === null ? ["No seller right now", buy, false]
    : pay > cash ? ["Deposit to trade", onFunds, true]
    : [`Buy ${name} · ${limit}¢`, buy, trading && quantity > 0 && pay <= cash] as const;
  const short = unlocked && cash > 0 && pay > cash;
  const reason = rest ? `Your order at ${rest.price}¢ is still waiting` : pay < 0 ? "Enter an amount like 2.5" : short ? "Not enough balance" : wanted > 0 && room === 0 ? "Limit reached for this market"
    : quantity < wanted ? quantity === offered ? `Only ${shares(offered)} shares on offer at ${limit}¢` : "Capped at your limit for this market" : "";
  return <aside id="event-ticket" className="chain-panel chain-ticket" aria-label="Order ticket"><div className="chain-panel-heading"><h2>Make your call</h2><span className="chain-pill">Yes / No</span></div>
    <p className="chain-copy">One click to enter, one click to close.</p>
    <div className="chain-outcomes">{(["up", "down"] as const).map((side) => <button key={side} className={side} aria-pressed={outcome === side} onClick={() => onOutcome(side)}>{side === "up" ? <Check size={21} /> : <X size={21} />}<strong>{SIDE_NAME[side]}</strong><span>{cents(ask(quotes, side))}</span></button>)}</div>
    <label htmlFor="event-stake">Stake · USDC</label>
    <input id="event-stake" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-invalid={pay < 0 || short} aria-describedby={reason ? "event-stake-reason" : undefined} autoComplete="off" />
    <div className="chain-quick">{[1, 5, 10].map((n) => <button key={n} type="button" onClick={() => setStake(formatUnits(BigInt(Math.max(0, pay)) + BigInt(n) * 1_000_000n, 6))}>+${n}</button>)}
      <button type="button" disabled={!unlocked || cash <= 0} onClick={() => setStake(formatUnits(BigInt(cash), 6))}>Max</button></div>
    {reason && <p id="event-stake-reason" className="chain-reason">{reason}</p>}
    <dl className="chain-account-values">{wallet.session && <div><dt>Trading balance</dt><dd>{unlocked ? usdc(cash) : <><LockKey size={12} /> Locked</>}</dd></div>}
      <div><dt>Shares / pays if right</dt><dd>{quantity ? `${shares(quantity)} / ${usdc(quantity)}` : "—"}</dd></div></dl>
    {quantity > 0 && limit !== null && <p className="chain-copy chain-ticket-cost">Cost at most {usdc(quantity * limit / 100)}</p>}
    <button className="button primary chain-full" disabled={!enabled} onClick={action}>{label}</button>
    {(total("up") > 0 || total("down") > 0) && <div className="chain-position-block" role="group" aria-label="Your position"><h3>Your position</h3>
      {(["up", "down"] as const).filter((side) => total(side) > 0).map((side) => {
        const p = bid(quotes, side), worth = p === null ? null : Math.floor(total(side) / 100) * p;
        return <div className="chain-position" key={side}><span><b className={side}>{SIDE_NAME[side]}</b> {shares(total(side))} shares · pays {usdc(total(side))} if right{worth !== null && ` · worth ${usdc(worth)} now`}</span>
          <button className="button" disabled={!trading || p === null || free(side) === 0} onClick={() => close(side)}>{p === null ? open ? "No buyer right now" : "Closed" : `Close · ${p}¢`}</button></div>;
      })}
      {sets > 0 && <div className="chain-position"><span>{shares(sets)} Yes + No back into {usdc(sets)}</span><button className="button" disabled={!unlocked || priv.busy} onClick={() => void priv.run((a) => a.merge(round, sets))}>Merge</button></div>}</div>}
    <ActionLine snapshot={priv.snapshot} names={["Buy Yes", "Buy No", "Sell Yes", "Sell No", "Merge", "Order result"]} />
    {priv.error && <p className="chain-error" role="alert">{priv.error}</p>}
    <div className="chain-ticket-account"><button onClick={onAccount}><Wallet size={17} /> Account <CaretRight /></button><button onClick={onFunds}><ArrowsDownUp size={17} /> Deposit or withdraw <CaretRight /></button></div></aside>;
}

type Props = Omit<TicketProps, "event"> & { event: PoliticsEvent | null; state: "loading" | "none" | "failed"; book: ConfiguredOrderbook | null };
export default function EventMarket({ event, state, book, ...ticket }: Props) {
  if (!event) return <section className="chain-panel"><div className="chain-empty"><span className="chain-empty-icon"><Bank size={26} /></span><h3>{state === "loading" ? "Loading…" : state === "failed" ? "Politics market unavailable" : "No politics market yet"}</h3>
    <p>{state === "failed" ? "Its market information did not pass this site's checks. Try refreshing." : state === "loading" ? "" : "The US House 2026 market is not open yet."}</p></div></section>;
  return <Market event={event} book={book} {...ticket} />;
}

function Market({ event, book, ...ticket }: TicketProps & { book: ConfiguredOrderbook | null }) {
  const { now, quotes, priv } = ticket, t = event.terms;
  const result = useResult(event, book, now);
  const status = result ? result.outcome === 3 ? "Void" : `Result: ${SIDE_NAME[result.outcome === 1 ? "up" : "down"]}` : now < t.cutoff - ORDER_MARGIN ? "Open" : now < t.end ? "Trading closed" : "Awaiting result";
  // The result pays every holder at once, but the view shown is the last one read: one sync brings the payout in.
  const held = Boolean(priv.snapshot?.view?.holdings.some((h) => h.roundId === event.id && h.up + h.down + h.reservedUp + h.reservedDown > 0)), unlocked = Boolean(priv.snapshot?.unlocked);
  const synced = useRef(false), { run } = priv;
  useEffect(() => { if (result && unlocked && held && !synced.current) { synced.current = true; void run((a) => a.sync(), { quiet: true }); } }, [result, unlocked, held, run]);
  const closing = Math.max(0, t.cutoff - now);
  return <div className="chain-workspace">
    <div className="chain-left-column">
      <section className="chain-panel chain-market-detail" aria-label="Market"><div className="chain-panel-heading"><div><span className="eyebrow">US House · 2026 midterms</span><h2>{EVENT_QUESTION}</h2></div><span className="chain-pill">{status}</span></div>
        <div className="chain-strip">
          {(["up", "down"] as const).map((side) => <div key={side} className={side}><span>{SIDE_NAME[side]}</span><strong>{cents(ask(quotes, side))}</strong><small>{ask(quotes, side) === null ? "No seller right now" : `Buy price · bid ${cents(bid(quotes, side))}`}</small></div>)}
          {result ? <div className={`chain-countdown ${result.outcome === 1 ? "up" : result.outcome === 2 ? "down" : ""}`}><span>Result</span><strong>{result.outcome === 3 ? "Void" : SIDE_NAME[result.outcome === 1 ? "up" : "down"]}</strong></div>
            : <div className="chain-countdown" role="timer"><span>{closing > 0 ? "Trading closes in" : "Trading closed"}</span><strong>{closing > 0 ? left(closing) : "—"}</strong></div>}
        </div>
        <dl className="chain-account-values event-times">
          <div><dt>Trading closes</dt><dd>{utcDate(t.cutoff)}{offUtc && ` · ${localDate(t.cutoff)}`}</dd></div>
          <div><dt>Earliest result</dt><dd>At least 24 hours after the AP calls the House (rules 3 and 4)</dd></div>
          <div><dt>Void if no result by</dt><dd>{utcDate(t.voidableAfter)} · every share pays 0.50 USDC</dd></div>
        </dl>
        {result && <p className="chain-copy event-result">{result.outcome === 3 ? "No result was posted by the deadline, so the market is void: every Yes and every No share paid 0.50 USDC." : `Result posted: ${result.outcome === 1 ? "Yes. Democrats won control of the House." : "No. Democrats did not win control of the House."} Each ${SIDE_NAME[result.outcome === 1 ? "up" : "down"]} share paid 1 USDC.`} <a href={transactionExplorerUrl(26514, result.txHash)} target="_blank" rel="noreferrer">Settle record <ArrowSquareOut size={12} /></a></p>}
        <p className="chain-copy event-operator">ZEDGE, the operator, posts the result with a signature from its resolver wallet <code>{event.resolver}</code>. It also runs the house that quotes this market, so it may hold the other side of your trade.</p>
        <div className="chain-market-foot"><span>Money in this market is locked until the result or the void.</span><span>Winner 1 · Loser 0 · Void ½ USDC</span></div>
      </section>
      <section className="chain-panel chain-book" aria-label="Order book"><div className="chain-panel-heading"><h2>Order book</h2><span className="chain-pill">Public quotes</span></div><div className="chain-book-columns"><span>Price</span><span>Shares</span><span>Total</span></div><HouseQuotes house={quotes} names={SIDE_NAME} /></section>
      <Rules event={event} />
    </div>
    <EventTicket event={event} {...ticket} />
  </div>;
}
