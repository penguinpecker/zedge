import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowSquareOut, ArrowsClockwise, ArrowsDownUp, ArrowUpRight, CaretLeft, CaretRight, ChartLine, Clock, CurrencyBtc, Info, LockKey, LockKeyOpen, Trophy, Wallet, Warning } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import AccountDrawer, { type DrawerView } from "./AccountDrawer";
import type { MarketFeed } from "./LiveChart.tsx";
import SiteFooter from "../components/SiteFooter";
import { price } from "../lib/market";
import { BASE_RPC, DEFAULT_NETWORK, isNetworkId, NETWORKS, parseAtomicAmount, type NetworkId } from "./networks.ts";
import { useChainWallet, WalletBoundary, type ChainWallet } from "./privy.tsx";
import { fairUp, realizedSigma, stakeRoom } from "./fair.ts";
import { chainClient, checkDeployment, checkOrderbook, loadManifest, loadOrderbook, observationPrice, exactObservationPrice, PHASES, priceCaptions, readChain, readRound, type ChainSnapshot, type RoundRead, type RoundState } from "./gateway.ts";
import { clockPhase, countdownLine, eventHouseFor, houseFor, ORDER_MARGIN, roundResults, sidePrice, tradable, versus, type RoundResult, type RoundTimes, roundNumber } from "./market-view.ts";
import { confirmSettle, liveNow, readApi, type ApiRound, type House, type Live } from "./read-api.ts";
import { createPriceFeed } from "./price-feed.ts";
import { engineRound, LOT, OPERATOR_KEYS_CHANGED, type OrderbookManifest, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { usePrivate, type PrivateState } from "./private/use-private.ts";
import { ActionLine, HouseQuotes, PrivateHistory, PrivateOrders, PrivatePortfolio, shares, usdc } from "./PrivatePanels.tsx";
import { sharesFor, waitingOrder } from "./private/client.ts";
import type { DeploymentManifest, VerifiedDeployment } from "./manifest.ts";
import { STREAMS_MISMATCH_REASON, STREAMS_PLANNED_REASON, StreamsMismatchError } from "./streams-manifest.ts";
import { rpcCooldownRemaining } from "./rpc.ts";
import { createVerificationCache, verificationIsFresh, type ReadOnlyVerification } from "./verification-cache.ts";
import { loadEvent, type PoliticsEvent } from "./events-manifest.ts";
import EventMarket, { SIDE_NAME } from "./EventMarket.tsx";
import "./chain.css";

const LiveChart = lazy(() => import("./LiveChart.tsx"));

const ORDERBOOK_MISMATCH = "Private order book checks did not pass, so private features are paused.";
const verificationCache = createVerificationCache<VerifiedDeployment | null>();
const orderbookCache = createVerificationCache<VerifiedOrderbook | null>();
const verificationTime = (value: number) => new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
function cooldownRemaining(network: NetworkId) {
  return Math.max(rpcCooldownRemaining(NETWORKS[network].rpcUrls.default.http[0]), network === 26514 ? rpcCooldownRemaining(BASE_RPC) : 0);
}
function networkError(network: NetworkId) {
  const remaining = cooldownRemaining(network);
  return remaining > 0 ? `Network busy. Retrying after ${verificationTime(Date.now() + remaining)} UTC.` : "The public network is busy or unavailable. Please try again shortly.";
}
/** A check kept from an earlier poll, while it is still within its own expiry. */
function stillFresh<T>(entry: ReadOnlyVerification<T> | null | undefined) {
  return entry && verificationIsFresh(entry) ? entry : null;
}

// The contracts support BTC and ETH rounds of 5 and 15 minutes; only BTC 15-minute rounds are offered for now.
const MARKETS = [
  { id: "btc-15m", asset: "BTC", name: "Bitcoin", duration: 900, assetId: 0 },
] as const;
/** The earliest round the arrows reach: /api/btc keeps two hours of prices for its chart (gateway.ts readRound accepts the offset). */
const MIN_OFFSET = -6;
type Connection = {
  network: NetworkId;
  snapshot: ChainSnapshot | null;
  manifest: DeploymentManifest | null;
  verification: ReadOnlyVerification<VerifiedDeployment | null> | null;
  rpcError: string;
  deploymentError: string;
  /** The private order book, checked after the public markets; a failure locks private features only. */
  orderbook: ReadOnlyVerification<VerifiedOrderbook | null> | null;
  orderbookError: string;
  /** Polls in a row that failed; errors are shown from the third. */
  failures: number;
};
type Side = "up" | "down";

const utc = (value: bigint | number) => new Date(Number(value) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
// The closing price timeout can be up to 21 days after the round, so it shows its date.
const utcDate = (value: bigint) => new Date(Number(value) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
/** The viewer's own clock, shown beside UTC. */
const viewer = (value: bigint | number, options: Intl.DateTimeFormatOptions = {}) => new Date(Number(value) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...options });
const offUtc = new Date().getTimezoneOffset() !== 0;
const alsoLocal = (value: bigint) => offUtc ? ` · ${viewer(value, { second: "2-digit", timeZoneName: "short" })}` : "";
const cents = (value: number | null) => value === null ? "—" : `${value}¢`;
const later = (a: bigint, b: bigint) => a > b ? a : b;
const timesOf = (r: RoundState): RoundTimes => ({ start: Number(r.start), cutoff: Number(r.cutoff), end: Number(r.end) });
/** The start of the round `offset` rounds from the one the block is in (gateway.ts readRound picks rounds the same way). */
const roundStart = (snapshot: ChainSnapshot, duration: number, offset: number) => snapshot.timestamp / BigInt(duration) * BigInt(duration) + BigInt(offset * duration);
const smooth = (): ScrollBehavior => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

function PrivateEmpty({ title, onOpen, open }: { title: string; onOpen: () => void; open: boolean }) {
  return <div className="chain-empty"><span className="chain-empty-icon"><LockKey size={26} /></span><h3>{title} are locked</h3><p>{open ? "Sign in and unlock your private account to see this." : "Private accounts are not available yet."}</p><button className="button" onClick={onOpen}>View account <CaretRight /></button></div>;
}

/** Every round that ended in the last 24 hours, oldest first: one mark each, Up lime, Down coral; the time and prices on hover. */
function RoundResults({ results }: { results: RoundResult[] }) {
  if (!results.length) return null;
  const count = (outcome: RoundResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  const usd = (value: bigint | null) => value === null ? "—" : `$${price(Number(formatUnits(value, 18)))}`;
  const name = { up: "Up", down: "Down", void: "Voided" } as const;
  return <div className="chain-results"><span>Last 24 h <b className="up">Up {count("up")}</b> <b className="down">Down {count("down")}</b></span>
    <ol role="img" aria-label={`Results of the last ${results.length} rounds, oldest first: ${count("up")} Up, ${count("down")} Down`}>{results.map((r) => <li key={r.start} className={r.outcome ?? ""}
      title={`${utc(r.start).slice(0, 5)}–${utc(r.start + 900).slice(0, 5)} UTC · ${r.outcome ? name[r.outcome] : "No result yet"} · ${usd(r.open)} → ${usd(r.close)}`} />)}</ol></div>;
}

type TicketRound = { start: number; cutoff: number; end: number; opening: string | null };
/** One click to enter (a buy), one click to close (a sell of the whole side), each a GTC that waits up to 20 s for its price
 * (client.ts buy), one at a time; the engine decides every fill, at the resting order's price. With the house's quotes for this
 * round the Up and Down buttons show its ask, the buy's limit exactly, and Close its bid. Without them, the house's ask for its
 * fair value (the display feed and the Chainlink opening price), marked as an estimate, with the one-click slack on the limits
 * (market-view.ts sidePrice). `slot`: the current round, whose position shows until it ends. */
function Ticket({ priv, orderbook, wallet, round, slot, now, up, house, outcome, onOutcome, loading, onAccount, onFunds }: { priv: PrivateState; orderbook: VerifiedOrderbook | null; wallet: ChainWallet; round: TicketRound | null; slot: number; now: number; up: number | null; house: House | null; outcome: Side; onOutcome: (side: Side) => void; loading: boolean; onAccount: () => void; onFunds: () => void }) {
  const [stake, setStake] = useState("5");
  const book = orderbook?.manifest, view = priv.snapshot?.view ?? null, unlocked = Boolean(priv.snapshot?.unlocked), cash = view?.cash ?? 0, onBase = priv.snapshot?.wallet ?? null;
  const quote = (side: Side) => sidePrice(house, up, side), chosen = quote(outcome), limit = chosen.buy;
  let pay = 0;
  try { pay = stake ? Number(parseAtomicAmount(stake, 6)) : 0; } catch { pay = -1; }
  const roundId = book && round ? engineRound(book, round.start).id : null;
  // Before a first deposit there is no view: the room is then the account's whole stake limit.
  const cap = book ? Number(book.application.stakeLimits.account) : 0;
  const room = book && roundId ? view ? stakeRoom(view, roundId, outcome, cap) : cap : 0;
  // A buy at the house's ask can fill only the shares resting there; any more would not fill.
  const offered = house?.[outcome].ask?.shares ?? Infinity;
  const wanted = limit && pay > 0 ? sharesFor(pay, limit) : 0, quantity = Math.min(wanted, room, offered);
  const toCutoff = round ? round.cutoff - now : null;
  const rest = waitingOrder(view, now);
  // A book frozen for its replacement (orderbook-manifest.ts withdrawOnly) takes no deposit and no order: only withdrawals.
  const frozen = Boolean(orderbook?.withdrawOnly);
  const trading = Boolean(book && !frozen && unlocked && round && toCutoff !== null && toCutoff > ORDER_MARGIN && !priv.busy && !rest);
  const held = view && book ? view.holdings.find((h) => h.roundId === engineRound(book, round?.start ?? slot).id) : undefined;
  const free = (side: Side) => Math.floor((side === "up" ? held?.up ?? 0 : held?.down ?? 0) / LOT) * LOT;
  const total = (side: Side) => side === "up" ? (held?.up ?? 0) + (held?.reservedUp ?? 0) : (held?.down ?? 0) + (held?.reservedDown ?? 0);
  const name = outcome === "up" ? "Up" : "Down";
  const buy = () => { if (round && limit && quantity) void priv.run((a) => a.buy(round.start, outcome, limit, quantity, now)); };
  const close = (side: Side) => { const p = quote(side).sell; if (round && p !== null) void priv.run((a) => a.close(round.start, side, p, now)); };
  // The latest deposit while it is on its way (this page may have stopped waiting): no second stake until it lands.
  const dep = priv.snapshot?.actions.find((a) => a.action === "Deposit"), moving = Boolean(dep && !dep.final);
  const [label, action, enabled] = !wallet.session ? ["Sign in to trade", onAccount, wallet.configured && !wallet.pending]
    : !book ? [loading ? "Loading…" : "Trading is not open yet", onAccount, false]
    : frozen ? ["Withdraw your balance", onFunds, true]
    : !unlocked ? [priv.busy ? "Unlocking your account…" : "Unlock your account", () => void priv.run((a) => a.unlock()), !priv.busy]
    // Low on trading balance: the Deposit window (AccountDrawer) takes the deposit and follows it to Horizen.
    : cash === 0 ? moving ? ["Deposit on its way…", onFunds, false]
      // Credited, but the sync after it failed: the balance is short, so read it again rather than offer another deposit.
      : priv.snapshot?.behind ? ["Refresh balance", () => void priv.run((a) => a.sync()), !priv.busy]
      : ["Deposit to trade", onFunds, true]
    : !round ? ["Waiting for the next round", buy, false]
    : toCutoff !== null && toCutoff <= ORDER_MARGIN ? ["This round no longer takes orders", buy, false]
    : limit === null ? [house ? "No seller right now" : "Price unavailable", buy, false]
    : pay > cash ? ["Deposit to trade", onFunds, true]
    : [chosen.est ? `Buy ${name} · up to ${limit}¢` : `Buy ${name} · ${limit}¢`, buy, trading && quantity > 0 && pay <= cash] as const;
  const short = unlocked && cash > 0 && pay > cash;
  const reason = rest ? `Your order at ${rest.price}¢ is still waiting` : pay < 0 ? "Enter an amount like 2.5" : short ? "Not enough balance" : wanted > 0 && room === 0 ? "Round limit reached"
    : quantity < wanted ? quantity === offered ? `Only ${shares(offered)} shares on offer at ${limit}¢` : "Capped at this round's limit" : "";
  const last = priv.snapshot?.lastResult ?? null;
  return <aside id="chain-ticket" className="chain-panel chain-ticket" aria-label="Order ticket"><div className="chain-panel-heading"><h2>Make your call</h2><span className="chain-pill">Up / Down</span></div>
    <p className="chain-copy">One click to enter, one click to close.</p>
    <div className="chain-outcomes">{(["up", "down"] as const).map((side) => { const q = quote(side); return <button key={side} className={side} aria-pressed={outcome === side} onClick={() => onOutcome(side)}>{side === "up" ? <ArrowUpRight size={23} /> : <ArrowDownRight size={23} />}<strong>{side === "up" ? "Up" : "Down"}</strong><span>{cents(q.ask)}{q.ask !== null && q.est && <small>est.</small>}</span></button>; })}</div>
    <label htmlFor="chain-stake">Stake · USDC</label>
    <input id="chain-stake" inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} aria-invalid={pay < 0 || short} aria-describedby={reason ? "chain-stake-reason" : undefined} autoComplete="off" />
    <div className="chain-quick">{[1, 5, 10].map((n) => <button key={n} type="button" onClick={() => setStake(formatUnits(BigInt(Math.max(0, pay)) + BigInt(n) * 1_000_000n, 6))}>+${n}</button>)}
      <button type="button" disabled={!unlocked || cash <= 0} onClick={() => setStake(formatUnits(BigInt(cash), 6))}>Max</button></div>
    {reason && <p id="chain-stake-reason" className="chain-reason">{reason}</p>}
    <dl className="chain-account-values">{wallet.session && <><div><dt>On Base</dt><dd>{onBase === null ? "—" : usdc(onBase)}</dd></div><div><dt>Trading balance</dt><dd>{unlocked ? usdc(cash) : <><LockKey size={12} /> Locked</>}</dd></div></>}
      <div><dt>Shares / pays if right</dt><dd>{quantity ? `${shares(quantity)} / ${usdc(quantity)}` : "—"}</dd></div></dl>
    {quantity > 0 && limit !== null && <p className="chain-copy chain-ticket-cost">{chosen.est ? `Est. cost ${usdc(quantity * (chosen.ask ?? limit) / 100)} · at most ${usdc(quantity * limit / 100)}` : `Cost at most ${usdc(quantity * limit / 100)}`}</p>}
    <button className="button primary chain-full" disabled={!enabled} onClick={action}>{label}</button>
    {(total("up") > 0 || total("down") > 0) && <div className="chain-position-block" role="group" aria-label="Your position"><h3>Your position</h3>
      {(["up", "down"] as const).filter((side) => total(side) > 0).map((side) => {
        const q = quote(side), worth = q.est || q.sell === null ? null : Math.floor(total(side) / 100) * q.sell;
        return <div className="chain-position" key={side}><span><b className={side}>{side === "up" ? "Up" : "Down"}</b> {shares(total(side))} shares · pays {usdc(total(side))} if right{worth !== null && ` · worth ${usdc(worth)} now`}</span>
          <button className="button" disabled={!trading || q.sell === null || free(side) === 0} onClick={() => close(side)}>{q.sell === null ? house ? "No buyer right now" : "Close · —" : q.est ? `Close · at least ${q.sell}¢` : `Close · ${q.sell}¢`}</button></div>;
      })}</div>}
    {last && <p className="chain-copy chain-last-result">Last round {viewer(last.start)}–{viewer(last.start + 900)} · <b className={last.outcome === 3 ? "" : last.paid > 0 ? "up" : "down"}>{last.outcome === 3 ? `Voided · ${usdc(last.paid)} back` : last.paid > 0 ? `You won ${usdc(last.paid)}` : "You lost"}</b></p>}
    <ActionLine snapshot={priv.snapshot} names={["Buy Up", "Buy Down", "Sell Up", "Sell Down", "Order result", "Round result"]} />
    {priv.error && <p className="chain-error" role="alert">{priv.error}</p>}
    <div className="chain-ticket-account"><button onClick={onAccount}><Wallet size={17} /> Account <CaretRight /></button><button onClick={onFunds}><ArrowsDownUp size={17} /> Deposit or withdraw <CaretRight /></button></div></aside>;
}

/** Whether this tab's session already opened the Deposit window for `account`; marks it so. Storage blocked: it may open again. */
function onboarded(account: string): boolean {
  try {
    const key = `zedge:onboarded:${account}`;
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
  } catch { /* storage blocked */ }
  return false;
}

export default function ChainApp() {
  return <WalletBoundary><ChainMarkets /></WalletBoundary>;
}

function ChainMarkets() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [marketIndex, setMarketIndex] = useState(0);
  const [page, setPage] = useState<"markets" | "portfolio" | "history">("markets");
  // Crypto (the BTC rounds) or Politics (the event): `?market=politics` opens the second.
  const [category, setCategory] = useState<"crypto" | "politics">(() => new URLSearchParams(window.location.search).get("market") === "politics" ? "politics" : "crypto");
  const [eventSide, setEventSide] = useState<Side>("up");
  const [drawer, setDrawer] = useState<DrawerView | null>(null);
  const [book, setBook] = useState<"quotes" | "orders">("quotes");
  const [roundOffset, setRoundOffset] = useState(0);
  const [roundRead, setRoundRead] = useState<RoundRead | null>(null);
  const [roundError, setRoundError] = useState("");
  const [roundAttempt, setRoundAttempt] = useState(0);
  // The last read of the current round (offset 0): the ticket and Portfolio trade it while another round is browsed.
  const [liveRead, setLiveRead] = useState<{ key: string; read: RoundRead } | null>(null);
  const [outcome, setOutcome] = useState<Side>("up");
  const wallet = useChainWallet();
  const [feed, setFeed] = useState<(MarketFeed & { status?: string }) | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const active = connection?.network === network ? connection : null;
  const market = MARKETS[marketIndex];
  const snapshot = active?.snapshot ?? null;
  // Chain time, each second: the last block's time carried forward by this browser's clock, or the browser's own before the first
  // block. A failed poll keeps the last block, so the countdown never stops.
  const skew = snapshot ? Number(snapshot.timestamp) * 1000 - snapshot.checkedAt : 0;
  const now = (clock + skew) / 1000, chainNow = Math.floor(now);
  const verification = active?.verification;
  const verified = verification && verificationIsFresh(verification) ? verification.value : null;
  const keyOf = (s: ChainSnapshot, offset: number) => `${network}:${market.id}:${offset}:${roundStart(s, market.duration, offset)}`;
  const currentRoundKey = snapshot ? keyOf(snapshot, roundOffset) : "";
  const [loadedRoundKey, setLoadedRoundKey] = useState("");
  // Keyed on the round, not the block: the re-read at each new block keeps showing the last read until a different round loads.
  const round = verified && loadedRoundKey === currentRoundKey ? roundRead : null;
  // Signing in goes straight to Privy: its modal cannot be used under an open popup. The wallet popup opens once the session exists.
  const signingIn = useRef(false);
  const signIn = () => { signingIn.current = true; setDrawer(null); wallet.connect(); };
  const openAccount = (view: DrawerView = "account") => wallet.session || !wallet.configured || wallet.pending ? setDrawer(view) : signIn();
  useEffect(() => { if (wallet.session && signingIn.current) { signingIn.current = false; setDrawer("account"); } }, [wallet.session]);
  const orderbookCheck = active?.orderbook;
  const orderbook = verified && orderbookCheck && verificationIsFresh(orderbookCheck) ? orderbookCheck.value : null;
  // The private account (its key, in memory) outlives a check that only lapsed until the next poll re-verifies it, as
  // every check does each two minutes; a check that found a difference drops it. Actions stay gated on `orderbook`.
  const [privateBook, setPrivateBook] = useState<VerifiedOrderbook | null>(null);
  const checksExpire = useRef(Infinity);
  const mismatch = active?.deploymentError === STREAMS_MISMATCH_REASON || active?.orderbookError === OPERATOR_KEYS_CHANGED || active?.orderbookError === ORDERBOOK_MISMATCH;
  useEffect(() => { if (orderbook) setPrivateBook(orderbook); else if (mismatch) setPrivateBook(null); }, [orderbook, mismatch]);
  // While Horizen cannot be read, funding still opens from the published manifest (read by the poll): deposits and withdrawals happen on Base.
  const [committedBook, setCommittedBook] = useState<VerifiedOrderbook | null>(null);
  const fundingBook = orderbook ?? (mismatch ? null : privateBook ?? committedBook);
  // The Politics market: the events manifest of the published order book (events-manifest.ts), read once. Trading it still needs
  // the verified book.
  const [politics, setPolitics] = useState<{ event: PoliticsEvent | null; state: "loading" | "none" | "failed" }>({ event: null, state: "loading" });
  const publishedBook = committedBook?.manifest ?? null;
  useEffect(() => {
    if (!publishedBook) return;
    let on = true;
    void loadEvent(publishedBook).then((event) => { if (on) setPolitics({ event, state: event ? "loading" : "none" }); }, () => { if (on) setPolitics({ event: null, state: "failed" }); });
    return () => { on = false; };
  }, [publishedBook]);
  const priv = usePrivate(wallet, fundingBook);
  const unlocked = Boolean(priv.snapshot?.unlocked), cash = priv.snapshot?.view?.cash ?? 0, onBase = priv.snapshot?.wallet ?? null;
  // The Deposit window: right after sign-up, and once a session for a signed-in account with nothing in it (no trading balance,
  // nothing on Base, no positions or orders, no deposit this session). Never over a popup already open.
  const account = wallet.session?.address ?? "", empty = unlocked && !cash && !priv.snapshot?.view?.reservedCash && !priv.snapshot?.view?.holdings.length && onBase === 0n && !priv.snapshot?.actions.some((a) => a.action === "Deposit");
  useEffect(() => { if (account && wallet.newUser) { onboarded(account); setDrawer("deposit"); } }, [account, wallet.newUser]);
  useEffect(() => { if (account && empty && !onboarded(account)) setDrawer((open) => open ?? "deposit"); }, [account, empty]);

  useEffect(() => {
    // Canonicalize the hash entry so in-page anchors cannot change app mode on reload.
    const url = new URL(window.location.href);
    if (url.searchParams.get("mode") !== "chain") {
      url.searchParams.set("mode", "chain");
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  // The poll, also run by the re-reads at each round end.
  const pollNow = useRef(() => {});
  useEffect(() => {
    let cancelled = false, busy = false, fails = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const update = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      clearTimeout(retry);
      setRefreshing(true);
      const next: Connection = { network, snapshot: null, manifest: null, verification: null, rpcError: "", deploymentError: "", orderbook: null, orderbookError: "", failures: 0 };
      if (cooldownRemaining(network) > 0) next.rpcError = networkError(network);
      else {
        // Re-verify while the shown checks are still valid: a check left to lapse showed markets and trading unavailable
        // until the next 30 s poll, about a quarter of the time.
        if (checksExpire.current - performance.now() < 40_000) { verificationCache.invalidate(network); orderbookCache.invalidate(network); }
        const results = await Promise.allSettled([readChain(network), loadManifest(network, controller.signal), network === 26514 ? loadOrderbook(controller.signal) : Promise.resolve(null)]);
        const chainResult = results[0];
        const manifestResult = results[1];
        const orderbookResult = results[2];
        if (chainResult.status === "fulfilled") next.snapshot = chainResult.value;
        else next.rpcError = networkError(network);
        if (manifestResult.status === "fulfilled") next.manifest = manifestResult.value;
        else next.deploymentError = "Market information is unavailable. Try refreshing.";
        if (orderbookResult.status === "fulfilled" && orderbookResult.value?.status === "configured") { const published = orderbookResult.value; setCommittedBook((current) => current ?? { manifest: published, verified: true }); }
        if (next.snapshot && next.manifest) {
          const manifest = next.manifest, snapshot = next.snapshot;
          try { next.verification = await verificationCache.read(network, JSON.stringify(manifest), () => checkDeployment(manifest, snapshot)); }
          catch (error) { next.deploymentError = error instanceof StreamsMismatchError ? STREAMS_MISMATCH_REASON : cooldownRemaining(network) > 0 ? networkError(network) : "Market checks could not complete. Please try again shortly."; }
        }
        const streamsRelease = next.verification?.value?.manifest.schemaVersion === 3 ? next.verification.value.manifest : null;
        if (streamsRelease && next.snapshot && orderbookResult.status === "fulfilled" && orderbookResult.value) {
          const book: OrderbookManifest = orderbookResult.value, snapshot = next.snapshot;
          try { next.orderbook = await orderbookCache.read(network, JSON.stringify(book), () => checkOrderbook(book, streamsRelease, snapshot)); }
          catch (error) { next.orderbookError = error instanceof StreamsMismatchError ? error.message === OPERATOR_KEYS_CHANGED ? OPERATOR_KEYS_CHANGED : ORDERBOOK_MISMATCH : "Private order book checks could not complete. Please try again shortly."; }
        } else if (orderbookResult.status === "rejected") next.orderbookError = "Private order book information is unavailable.";
      }
      busy = false;
      if (cancelled) return;
      // A failed read keeps the last good block and checks, each until its own expiry (a mismatch drops them at once), retries after
      // 3 s, 6 s, 12 s… and is reported only from the third failure in a row.
      const keysChanged = next.orderbookError === OPERATOR_KEYS_CHANGED || next.orderbookError === ORDERBOOK_MISMATCH;
      const failed = Boolean(next.rpcError || (next.deploymentError && next.deploymentError !== STREAMS_MISMATCH_REASON) || (next.orderbookError && !keysChanged));
      fails = failed ? fails + 1 : 0;
      next.failures = fails;
      setConnection((previous) => {
        const keep = previous?.network === network ? previous : null;
        return { ...next, snapshot: next.snapshot ?? keep?.snapshot ?? null, manifest: next.manifest ?? keep?.manifest ?? null,
          verification: next.verification ?? (next.deploymentError === STREAMS_MISMATCH_REASON ? null : stillFresh(keep?.verification)),
          orderbook: next.orderbook ?? (keysChanged ? null : stillFresh(keep?.orderbook)) };
      });
      setRefreshing(false);
      // Plus up to 2 s of this tab's own, so tabs that failed together do not retry together.
      if (failed) retry = setTimeout(() => void update(), Math.max(cooldownRemaining(network), Math.min(30_000, 3_000 * 2 ** (fails - 1))) + Math.random() * 2_000);
    };
    pollNow.current = () => void update();
    void update();
    const interval = setInterval(() => void update(), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void update(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; controller.abort(); clearTimeout(retry); clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [network, refresh]);
  useEffect(() => { checksExpire.current = Math.min(active?.verification?.expiresAt ?? Infinity, active?.orderbook?.expiresAt ?? Infinity); }, [active]);

  // Re-read at each round end +1 s, +12 s and +35 s (the registry records the opening about 32 s in): with the 30 s poll alone the
  // old round stayed up to 20 s past its end and the new price to beat came up to a minute late. Each tab adds its own 0-3 s, so
  // open tabs do not all read at the same chain second.
  const slotStart = Math.floor(now / market.duration) * market.duration;
  const [jitter] = useState(() => Math.random() * 3_000);
  useEffect(() => {
    const timers = [1, 12, 35].map((d) => (slotStart + d) * 1000 - (Date.now() + skew)).filter((ms) => ms > 0).map((ms) => setTimeout(() => pollNow.current(), ms + jitter));
    return () => timers.forEach(clearTimeout);
    // Scheduled once per round; `skew` only refines when.
  }, [slotStart]);

  // The page's one /v1/live read every 2 s while the tab is visible (the price feeds and round results share it: read-api.ts liveNow).
  // A failed read keeps the last answer, and so does a late one older than it (the shared read can have two in flight).
  const [indexed, setIndexed] = useState<Live | null>(null);
  useEffect(() => {
    let on = true;
    const read = () => { if (document.visibilityState !== "hidden") void liveNow().then((x) => { if (on && x) setIndexed((held) => held && held.head.block > x.head.block ? held : x); }); };
    read();
    const timer = setInterval(read, 2_000);
    return () => { on = false; clearInterval(timer); };
  }, []);
  // The engine's own opening for the current slot opens the ticket before the registry records it, but only once one receipt read
  // shows that exact record on chain, because it feeds the buy limit. Once per round; a failed read is tried again at the next live read.
  const [engineOpen, setEngineOpen] = useState<{ start: number; opening: string } | null>(null);
  const confirming = useRef("");
  useEffect(() => {
    const book = orderbook?.manifest, entry = indexed?.rounds.find((r) => r.start === slotStart), ref = entry?.open;
    if (!book || !entry || !ref || ref.kind !== 1 || engineOpen?.start === slotStart) return;
    const id = engineRound(book, slotStart).spec.registryRoundId, key = `${slotStart}:${ref.txHash}:${ref.logIndex}`;
    if (entry.registryRoundId !== id || confirming.current === key) return;
    confirming.current = key;
    void confirmSettle(chainClient(26514), book, ref, id).then((ok) => { if (ok) setEngineOpen({ start: slotStart, opening: formatUnits(ref.price, 18) }); }, () => { confirming.current = ""; });
  }, [indexed, orderbook, slotStart, engineOpen]);
  // The results strip: the read API's last 24 hours, read again each round; the live read's newer records go over it.
  const [listed, setListed] = useState<ApiRound[]>([]);
  useEffect(() => {
    if (page !== "markets") return;
    let on = true;
    void readApi().rounds().then((r) => { if (on && r) setListed(r.rounds); });
    return () => { on = false; };
  }, [page, slotStart]);
  // The last round's result from the account's receipts (client.ts loadLastResult), on unlocking and each time a round settles: after
  // a reload, or a round whose result the page did not see, the settlement has already emptied the holding the result is read from.
  const knownRounds = [...listed, ...(indexed?.rounds ?? [])];
  const lastSettled = Math.max(0, ...knownRounds.filter((r) => r.settle).map((r) => r.start));
  const { run } = priv;
  useEffect(() => {
    if (unlocked && lastSettled) void run((a) => a.loadLastResult(knownRounds), { quiet: true });
    // Once per settled round: `knownRounds` is read when `lastSettled` moves.
  }, [unlocked, lastSettled, run]);

  useEffect(() => {
    if (!verification) return;
    // Expire the displayed check even when the next poll is slow or this tab was hidden.
    const expire = () => setConnection((current) => current?.verification === verification ? { ...current, verification: null } : current);
    const timer = setTimeout(expire, Math.max(0, verification.expiresAt - performance.now()));
    const onVisible = () => { if (!verificationIsFresh(verification)) expire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [verification]);

  useEffect(() => {
    if (!orderbookCheck) return;
    // The private check expires on its own clock too: a stale check never keeps private features open.
    const expire = () => setConnection((current) => current?.orderbook === orderbookCheck ? { ...current, orderbook: null } : current);
    const timer = setTimeout(expire, Math.max(0, orderbookCheck.expiresAt - performance.now()));
    return () => clearTimeout(timer);
  }, [orderbookCheck]);

  const roundFails = useRef({ key: "", count: 0 });
  useEffect(() => {
    if (!verified || !snapshot) return;
    let cancelled = false, retry: ReturnType<typeof setTimeout> | undefined;
    const key = keyOf(snapshot, roundOffset);
    if (roundFails.current.key !== key) { roundFails.current = { key, count: 0 }; setRoundError(""); }
    void readRound(verified, snapshot, market.assetId, market.duration, roundOffset).then((result) => {
      if (cancelled) return;
      roundFails.current.count = 0;
      setRoundRead(result); setLoadedRoundKey(key); setRoundError("");
      if (roundOffset === 0) setLiveRead({ key, read: result });
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof StreamsMismatchError) {
        // The registry's code or owner changed after the cached check. Drop that check now, not at its expiry; the next poll checks everything again.
        verificationCache.invalidate(network);
        setConnection((current) => current?.verification?.value === verified ? { ...current, verification: null, deploymentError: STREAMS_MISMATCH_REASON } : current);
        return;
      }
      // A failed re-read keeps the last read of this same round. Retry after 3 s, 6 s, 12 s…; say so from the third failure in a row.
      const count = ++roundFails.current.count;
      if (count >= 3) setRoundError("Unable to load this round. Try refreshing.");
      retry = setTimeout(() => setRoundAttempt((n) => n + 1), Math.min(30_000, 3_000 * 2 ** (count - 1)) + Math.random() * 2_000);
    });
    // While another round is shown, the current one is read too, at each block: the ticket, the market card and Portfolio trade it.
    // A failed read is left to the next block.
    if (roundOffset !== 0) void readRound(verified, snapshot, market.assetId, market.duration, 0).then((read) => { if (!cancelled) setLiveRead({ key: keyOf(snapshot, 0), read }); }, () => undefined);
    return () => { cancelled = true; clearTimeout(retry); };
    // `keyOf` reads only network and market, listed here.
  }, [verified, snapshot, network, market.assetId, market.duration, market.id, roundOffset, roundAttempt]);

  const chooseMarket = (index: number) => {
    setMarketIndex(index); setRoundOffset(0);
    const detail = document.getElementById("chain-round");
    detail?.scrollIntoView({ behavior: smooth(), block: "start" });
    detail?.focus({ preventScroll: true });
  };
  const pick = (side: Side) => { setOutcome(side); document.getElementById("chain-ticket")?.scrollIntoView({ behavior: smooth(), block: "start" }); };
  const pickEvent = (side: Side) => { setEventSide(side); document.getElementById("event-ticket")?.scrollIntoView({ behavior: smooth(), block: "start" }); };
  const chooseCategory = (next: "crypto" | "politics") => {
    setCategory(next);
    const url = new URL(window.location.href);
    if (next === "politics") url.searchParams.set("market", "politics"); else url.searchParams.delete("market");
    window.history.replaceState(window.history.state, "", url);
  };
  const refreshMarkets = () => {
    if (refreshing || cooldownRemaining(network) > 0) return;
    verificationCache.invalidate(network);
    orderbookCache.invalidate(network);
    setRefreshing(true);
    setRefresh((value) => value + 1);
  };
  // A mismatch shows at once; a network failure only from the third poll in a row (the last good data stays on screen meanwhile).
  const connectionError = active?.deploymentError === STREAMS_MISMATCH_REASON ? active.deploymentError : active && active.failures >= 3 ? active.deploymentError || active.rpcError : "";
  const streams = verified?.manifest.schemaVersion === 3 ? verified.manifest : null;
  // A planned release fails closed exactly like an unavailable network: nothing is verified and no round is read.
  const planned = active?.manifest?.status === "planned";
  const offline = active?.manifest?.status === "unavailable" ? active.manifest.reason : planned ? STREAMS_PLANNED_REASON : "";
  // Nothing verified yet and nothing has failed for good: the first load, not an outage.
  const loading = !verified && !connectionError && !offline;
  // The shown round's times: from its read, else from the clock (the 30 s cutoff mirrors the live registry's rounds).
  const slotAt = (offset: number): RoundTimes => { const start = slotStart + offset * market.duration; return { start, cutoff: start + market.duration - 30, end: start + market.duration }; };
  const times = round?.round ? timesOf(round.round) : slotAt(roundOffset);
  const shownPhase = round ? clockPhase(round.phase, times, now) : null;
  const phase = round ? round.phase === 0 && now < times.start ? "Upcoming" : PHASES[shownPhase ?? 0]
    : roundError && verified ? "Read unavailable" : verified ? "Loading round…" : loading ? "Loading…" : "Unavailable";
  const line = countdownLine(times, now);
  // A slot the keeper has not scheduled yet is a round to come, not a missing one; once its start has passed it can never be
  // scheduled (the registry refuses a start in the past), so it reads Not scheduled.
  const captions = loading ? { opening: "Loading…", closing: "Loading…" } : round?.phase === 0 && now < times.start ? { opening: "Awaiting opening observation", closing: "Awaiting resolution" } : priceCaptions(round, Boolean(verified), Boolean(roundError));
  const openingExact = round?.round?.openedAt ? exactObservationPrice(round.round.opening.price, round.round.opening.decimals) : null;
  const openingPrice = round?.round?.openedAt ? observationPrice(round.round.opening.price, -round.round.opening.decimals) : null;
  const closing = round?.round?.resolvedAt && round.round.outcome !== 3 ? round.round.closing : null;
  const result = round?.round?.outcome === 1 ? "Up wins" : round?.round?.outcome === 2 ? "Down wins" : round?.round?.outcome === 3 ? "Round voided" : null;
  // Signed by the exact difference (market-view.ts versus), as settlement is: a tie reads Up, a Down lead under a cent reads Down.
  const tone = (difference: number | null) => difference === null ? "" : difference >= 0 ? "up" : "down";
  const signed = (difference: number) => `${difference >= 0 ? "▲" : "▼"} $${price(Math.abs(difference))}`;
  const closingDelta = closing ? versus(Number(exactObservationPrice(closing.price, closing.decimals)), openingExact) : null;

  // The live chart keeps the last read of this same offset while the next round loads, so it never remounts mid-round.
  const chartRound = verified && streams && loadedRoundKey.startsWith(`${network}:${market.id}:${roundOffset}:`) && roundRead?.round ? roundRead.round : null;
  // With no readable round (Horizen halted or busy, or not scheduled yet) the current slot still shows its prices, without a price to beat.
  const chartTimes = chartRound ? timesOf(chartRound) : roundOffset === 0 ? times : null;

  // The round being traded: the read of the current round (the block's, never an earlier round's), open by the clock.
  const live = verified && snapshot && liveRead?.key === keyOf(snapshot, 0) ? liveRead.read : null;
  const liveTimes = live?.round ? timesOf(live.round) : slotAt(0);
  const spec = orderbook && engineOpen?.start === slotStart ? engineRound(orderbook.manifest, slotStart).spec : null;
  const ticketRound: TicketRound | null = tradable(live ? { phase: live.phase, times: liveTimes, opening: live.round?.openedAt ? exactObservationPrice(live.round.opening.price, live.round.opening.decimals) : null } : null,
    spec && engineOpen ? { times: { start: spec.start, cutoff: spec.cutoff, end: spec.end }, opening: engineOpen.opening } : null, now);
  // The display feed's latest Chainlink report (from the current or next round's chart, which both reach now), used for prices only
  // while current (a report lands each minute).
  const spot = feed?.spot ?? null;
  const spotLive = spot !== null && (feed?.status === undefined || feed.status === "live") && clock - spot.t < 120_000;
  let up: number | null = null;
  try { if (spot && spotLive && feed && ticketRound?.opening) up = fairUp(spot.p, Number(ticketRound.opening), realizedSigma(feed.closes), ticketRound.end - chainNow); } catch { up = null; }
  // The house's own quotes for the round being traded (the live read), when fresh: its real prices instead of the estimate.
  const house = houseFor(indexed?.house, ticketRound?.start ?? null, clock + skew);
  const askOf = (side: Side) => sidePrice(house, up, side).ask;
  const eventQuotes = eventHouseFor(indexed?.event, politics.event?.id ?? null, clock + skew);
  const nowDelta = versus(spot?.p ?? null, openingExact);
  const liveLine = countdownLine(liveTimes, now);
  const onMarket = (next: MarketFeed) => setFeed((last) => last?.spot?.t === next.spot?.t && last?.closes.length === next.closes.length && last?.status === (next as { status?: string }).status ? last : next);
  // The chart reports the price only when it reaches the present (the current or next round). Otherwise (an earlier round shown,
  // or a next round with no chart) a feed of the current round keeps the ticket's and the market card's prices live.
  const chartLive = chartTimes !== null && roundOffset >= 0;
  useEffect(() => {
    if (chartLive || page !== "markets") return;
    const feed = createPriceFeed((liveTimes.start - 300) * 1000, liveTimes.end * 1000);
    let seen = -1;
    const timer = setInterval(() => { if (feed.version !== seen) { seen = feed.version; onMarket({ spot: feed.last(), closes: feed.closes(), status: feed.status }); } }, 500);
    const visibility = () => document.visibilityState === "hidden" ? feed.pause() : feed.resume();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { feed.pause(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
    // onMarket only sets state.
  }, [chartLive, page, liveTimes.start, liveTimes.end]);

  const pins = verified ? Object.entries(verified.manifest.contracts).map(([name, pin]) => ({ name, ...pin, chainId: "chainId" in pin ? pin.chainId : network })) : [];
  if (streams) {
    const registry = streams.contracts.registry;
    pins.splice(1, 0, { name: "registryImplementation", chainId: 26514, address: registry.implementation, runtimeCodeHash: registry.implementationCodeHash });
    for (const name of ["collateral", "verifier", "sourceMessenger", "destinationMessenger"] as const) {
      pins.push({ name, ...streams.dependencies[name] });
    }
  }
  const balance = `${unlocked ? `${usdc(cash)} to trade` : ""}${unlocked && onBase !== null ? ", " : ""}${onBase === null ? "" : `${usdc(onBase)} on Base`}`;
  return <div className="chain-app">
    <a className="skip-link" href="#chain-main">Skip to content</a>
    <header className="app-header"><div className="header-inner">
      <button className="brand" aria-label="ZEDGE home" onClick={() => setPage("markets")}><svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2h20v5L9 17h13v5H2v-5L15 7H2z" fill="currentColor" /></svg><span>edge<span className="brand-period">.</span></span></button>
      <nav className="main-nav" aria-label="Main navigation">{(["markets", "portfolio", "history"] as const).map((item) => <button key={item} className={page === item ? "active" : ""} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="header-actions">
        <label className="chain-network-select"><span className="sr-only">Market network</span><select id="chain-network" name="network" value={network} onChange={(event) => { const next = Number(event.target.value); if (isNetworkId(next)) { setNetwork(next); setRoundOffset(0); } }}><option value={26514}>Horizen mainnet</option></select></label>
        {wallet.session && <button className="chain-balance" onClick={() => openAccount()} aria-label={`Wallet balance${balance ? `: ${balance}` : ""}`}>{unlocked && <strong>{usdc(cash)}</strong>}<small>{onBase === null ? "…" : `${usdc(onBase)} on Base`}</small></button>}
        <button className="button primary chain-connect" onClick={() => openAccount()}><Wallet size={18} /><span>{wallet.session ? `${wallet.session.address.slice(0, 6)}…${wallet.session.address.slice(-4)}` : "Sign in"}</span></button>
      </div>
    </div></header>
    <main id="chain-main" className="app-main" tabIndex={-1}>
      {page !== "markets" && <div className="page-heading trading-heading"><div><h1>{page === "portfolio" ? <>Your positions<span>.</span></> : <>Your history<span>.</span></>}</h1></div></div>}
      {/* Privy's sign-in errors: every sign-in path closes the account popup first, so they show here, under the header's Sign in. */}
      {!wallet.session && wallet.error && <div className="chain-status-banner warn" role="alert"><Warning size={21} /><div><strong>{wallet.error}</strong></div></div>}
      {(connectionError || (!verified && (planned || offline))) && <div className={`chain-status-banner ${connectionError ? "warn" : ""}`}>{connectionError ? <Warning size={21} /> : <Info size={21} />}<div><strong>{connectionError ? "Market checks unavailable" : planned ? "Public markets not available yet" : "Public markets unavailable"}</strong><p>{connectionError || offline}</p></div><button className="icon-button" aria-label="Refresh markets" disabled={refreshing || cooldownRemaining(network) > 0} onClick={refreshMarkets}><ArrowsClockwise size={20} /></button></div>}
      {orderbook?.withdrawOnly && <div className="chain-status-banner warn" role="status"><Warning size={21} /><div><strong>This order book is closing</strong><p>Deposits and trading are off. You can still withdraw your balance to Base.</p></div></div>}
      {page === "markets" ? <>
        <div className="chain-categories"><div className="chain-segment" role="group" aria-label="Market category">{(["crypto", "politics"] as const).map((c) => <button key={c} aria-pressed={category === c} onClick={() => chooseCategory(c)}>{c === "crypto" ? "Crypto" : "Politics"}</button>)}</div></div>
        {category === "politics" ? <>
          <div className="workspace-label"><div><span>POLITICS</span><CaretRight size={11} /><span>US HOUSE</span><CaretRight size={11} /><strong>2026 MIDTERMS</strong></div></div>
          <EventMarket event={politics.event} state={politics.state} book={publishedBook} priv={priv} orderbook={orderbook} wallet={wallet} quotes={eventQuotes} now={now} outcome={eventSide} onOutcome={setEventSide} onAccount={() => openAccount()} onFunds={() => openAccount("funds")} />
        </> : <>
        <section className="chain-market-cards" aria-label="Choose a market">{MARKETS.map((item, index) => <button className={`chain-market-card ${marketIndex === index ? "selected" : ""}`} key={item.id} aria-pressed={marketIndex === index} onClick={() => chooseMarket(index)}><span className="chain-card-heading"><span className={`coin ${item.asset.toLowerCase()} small`}><CurrencyBtc weight="bold" /></span><strong>{item.name}</strong><span className="chain-duration">{item.duration / 60}m</span></span><span className="chain-card-question">Higher or lower?</span>
          <span className="chain-card-prices"><span>Up <b title={house ? undefined : "Estimated price"}>{index === marketIndex ? cents(askOf("up")) : "—"}</b></span><span>Down <b title={house ? undefined : "Estimated price"}>{index === marketIndex ? cents(askOf("down")) : "—"}</b></span></span>
          <span className="chain-card-foot">{index === marketIndex && <span className={`chain-card-time ${liveLine.urgent ? "urgent" : ""}`}><Clock size={13} />{liveLine.time}</span>}<span>{loading ? "Loading…" : verified ? "View round" : "Unavailable"}<CaretRight /></span></span></button>)}</section>
        <div className="workspace-label"><div><span>CRYPTO</span><CaretRight size={11} /><span>{market.asset}</span><CaretRight size={11} /><strong>{market.duration / 60} MIN UP / DOWN</strong></div></div>
        <div className="chain-workspace">
          <div className="chain-left-column">
            <section id="chain-round" tabIndex={-1} className="chain-panel chain-market-detail" aria-label="Market and price chart"><div className="chain-panel-heading"><div><span className="eyebrow">{market.name} · {market.duration / 60} minute round{roundNumber(times.start, market.duration) !== null && ` · #${roundNumber(times.start, market.duration)}`}</span><h2>Will {market.name} finish higher?</h2></div><span className="chain-pill">{phase}</span></div>
              <div className="chain-round-nav"><button aria-label="Previous round" disabled={!verified || roundOffset <= MIN_OFFSET} onClick={() => setRoundOffset((value) => value - 1)}><CaretLeft /></button><span>{utc(times.start).slice(0, 5)} — {utc(times.end).slice(0, 5)} UTC{offUtc && <small>{viewer(times.start)} — {viewer(times.end, { timeZoneName: "short" })}</small>}</span><button aria-label="Next round" disabled={!verified || roundOffset >= 1} onClick={() => setRoundOffset((value) => value + 1)}><CaretRight /></button></div>
              <div className="chain-strip">
                <div><span>Price to beat</span><strong title={openingExact ? `$${openingExact}` : undefined}>{openingPrice ?? "—"}</strong><small>{captions.opening}</small></div>
                {roundOffset < 0 || result ? <div className={tone(closingDelta)}><span>Closing price</span><strong title={closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : undefined}>{closing ? observationPrice(closing.price, -closing.decimals) : "—"}</strong><small>{closingDelta !== null ? <b>{signed(closingDelta)}</b> : captions.closing}</small></div>
                  : <div className={tone(nowDelta)}><span>Current price</span><strong>{spot ? `$${price(spot.p)}` : "—"}</strong><small title={spot ? `${utc(spot.t / 1000)} UTC` : undefined}>{nowDelta !== null && <b>{signed(nowDelta)} </b>}{spot ? `Chainlink · ${viewer(spot.t / 1000)}` : "Chainlink BTC/USD"}</small></div>}
                {result ? <div className={`chain-countdown ${round?.round?.outcome === 1 ? "up" : round?.round?.outcome === 2 ? "down" : ""}`}><span>Result</span><strong>{result}</strong></div>
                  : <div className={`chain-countdown ${line.urgent ? "urgent" : ""}`} role="timer"><span>{line.label}</span><strong>{line.time}</strong><div className="chain-track"><i style={{ transform: `scaleX(${1 - line.progress})` }} /></div></div>}
              </div>
              {chartTimes ? <Suspense fallback={<div className="chain-chart-empty" />}><LiveChart start={chartTimes.start} cutoff={chartTimes.cutoff} end={chartTimes.end} priceToBeat={chartRound?.openedAt ? exactObservationPrice(chartRound.opening.price, chartRound.opening.decimals) : null}
                offset={roundOffset} onMarket={roundOffset >= 0 ? onMarket : undefined} /></Suspense> : <div className="chain-chart-empty">{result && round?.round?.outcome !== 3 ? <Trophy size={30} /> : <ChartLine size={30} />}<strong>{round?.phase === 0 ? "No round scheduled for this time" : result ?? "Settlement observations"}</strong><p className="chain-copy">{round?.phase === 0 ? "The registry has no market in this time slot. Check the adjacent rounds or refresh." : "Opening and closing observations determine the outcome."}</p>{streams && <small>Chainlink Data Streams · Base → Horizen</small>}</div>}
              <RoundResults results={roundResults(listed, indexed?.rounds ?? [], chainNow)} />
              {round?.round && <details className="chain-details"><summary>Round rules & exact observations</summary><dl className="chain-account-values"><div><dt>Trading cutoff</dt><dd>{utc(round.round.cutoff)} UTC{alsoLocal(round.round.cutoff)}</dd></div><div><dt>Opening deadline</dt><dd>{utc(round.round.openingDeadline)} UTC{alsoLocal(round.round.openingDeadline)}</dd></div>{round.round.voidableAfter !== null ? <div><dt>Closing price timeout</dt><dd>{utcDate(round.round.voidableAfter)} UTC</dd></div> : round.round.resolutionDeadline !== null && <div><dt>Resolution deadline</dt><dd>{utc(round.round.resolutionDeadline)} UTC{alsoLocal(round.round.resolutionDeadline)}</dd></div>}<div><dt>Exact opening</dt><dd>{round.round.openedAt ? `$${exactObservationPrice(round.round.opening.price, round.round.opening.decimals)}` : "Not recorded"}</dd></div><div><dt>Exact closing</dt><dd>{closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : "Not recorded"}</dd></div></dl><p className="chain-copy">A tie resolves Up. {round.round.voidableAfter !== null ? "After the round ends it can be resolved whenever its closing price has been delivered; there is no deadline. It can be voided only if no opening price was recorded by the opening deadline, or after the closing price timeout while no closing price has been delivered. Anyone can block price delivery until that timeout at a small cost in network fees, so a trader holding the losing side can force a void." : "If its opening or closing price is not recorded by the deadline, the round can be voided."} Prices shown above are rounded to cents for display; settlement compares the exact values.</p></details>}
              {round && <details className="chain-details"><summary>Round identity</summary><code>{round.roundId}</code><p className="chain-copy">{round.phase === 0 ? "Canonical ID for this unscheduled time slot." : "Read from the verified registry at the displayed block."}</p></details>}
              {roundError && verified && <p className="chain-error" role="alert">{roundError} <button className="chain-text-button" onClick={() => setRoundAttempt((n) => n + 1)}>Retry</button></p>}
              <div className="chain-market-foot"><span>{snapshot ? `Updated ${utc(snapshot.timestamp)} UTC` : "Waiting for a network response"}</span><span>Winner 1 · Loser 0 · Void ½ collateral unit</span></div>
            </section>
            <section className="chain-panel chain-book" aria-label="Order book"><div className="chain-panel-heading"><h2>Order book</h2><div className="chain-segment"><button aria-pressed={book === "quotes"} onClick={() => setBook("quotes")}>Public quotes</button><button aria-pressed={book === "orders"} onClick={() => setBook("orders")}>{unlocked ? <LockKeyOpen size={13} /> : <LockKey size={13} />}My orders</button></div></div>{book === "quotes" ? <><div className="chain-book-columns"><span>Price</span><span>Shares</span><span>Total</span></div><HouseQuotes house={house} /></> : orderbook && unlocked ? <PrivateOrders priv={priv} book={orderbook.manifest} roundStart={live?.round ? Number(live.start) : null} /> : <PrivateEmpty title="Your orders" onOpen={() => openAccount()} open={Boolean(orderbook)} />}</section>
          </div>
          <Ticket priv={priv} orderbook={orderbook} wallet={wallet} round={ticketRound} slot={liveTimes.start} now={now} up={up} house={house} outcome={outcome} onOutcome={setOutcome} loading={loading} onAccount={() => openAccount()} onFunds={() => openAccount("funds")} />
        </div>
        </>}
      </> : <section className="chain-panel chain-private-page"><div className="chain-panel-heading"><h2>{page === "portfolio" ? "Positions & balances" : "Fills & account history"}</h2><span className="chain-pill">{unlocked ? <LockKeyOpen size={13} /> : <LockKey size={13} />}{unlocked ? "Unlocked" : "Locked"}</span></div>{orderbook && snapshot && (unlocked || (page === "portfolio" && priv.snapshot?.cached)) ? page === "portfolio" ? <PrivatePortfolio {...{ onDeposit: () => openAccount("funds") }} priv={priv} book={orderbook.manifest} chainNow={chainNow}
        event={politics.event && { id: politics.event.id, cutoff: politics.event.terms.cutoff }} onEvent={() => { setPage("markets"); chooseCategory("politics"); }} /> : <PrivateHistory priv={priv} fromBlock={later(snapshot.blockNumber > 604_800n ? snapshot.blockNumber - 604_800n : 0n, BigInt(orderbook.manifest.application.deployBlock))} /> : <PrivateEmpty title={page === "portfolio" ? "Your positions" : "Your records"} onOpen={() => openAccount()} open={Boolean(orderbook)} />}</section>}
      <details className="chain-details chain-deployment-details"><summary>Market details</summary><div className="chain-technical-grid"><dl><dt>Network</dt><dd>{NETWORKS[network].name} · {network}</dd><dt>Connection</dt><dd>{snapshot ? `Connected · block ${snapshot.blockNumber}` : "Not verified"}</dd><dt>Trading</dt><dd>{orderbook ? "Open (private order book)" : "Unavailable"}</dd><dt>Private access</dt><dd>{orderbook ? "Sign in to use" : active?.orderbookError || "Unavailable"}</dd></dl><dl><dt>Contract checks</dt><dd>{verified && verification ? `Matched release · checked ${verificationTime(verification.checkedAt)} UTC` : planned ? "Not available yet" : offline ? "Not available" : "Not verified"}</dd><dt>Roles and governance</dt><dd>{verified ? streams ? <>The round registry is upgradeable: its owner address <code>{streams.contracts.registry.owner}</code> can replace its code, including the round rules. The three price-route contracts are fixed. The registry’s code and owner and the upstream implementations and governance matched this release at the checked blocks, with no ownership transfer pending.</> : "Registry fixed; external provider governance requires separate review." : "Not verified"}</dd><dt>Private account</dt><dd>{unlocked ? "Unlocked" : "Locked"}</dd></dl></div>{verified && <><p>Release {verified.manifest.release}. Matching code and configuration does not verify private execution or imply a security audit.</p>{streams && <p><a href="https://github.com/penguinpecker/zedge/blob/feat/production-core/contracts/deployment/MAINNET.md" target="_blank" rel="noreferrer">Deployment record and source-verification details <ArrowSquareOut size={13} /></a></p>}<dl className="chain-address-list">{pins.map((pin) => <div key={pin.name}><dt>{pin.name.replace(/([A-Z])/g, " $1")} · {pin.chainId === 8453 ? "Base" : NETWORKS[network].name}</dt><dd><a href={`${pin.chainId === 8453 ? "https://basescan.org" : NETWORKS[network].blockExplorers.default.url}/address/${pin.address}`} target="_blank" rel="noreferrer">{pin.address}</a><code>{pin.runtimeCodeHash}</code></dd></div>)}</dl></>}</details>
      <SiteFooter mode="chain" status={<span>ZEDGE · {network === 2651420 ? "Testnet" : "Mainnet"}</span>} action={<button onClick={() => openAccount("security")}>Account security</button>} />
    </main>
    {page === "markets" && category === "crypto" && <div className="chain-mobile-bar">{(["up", "down"] as const).map((side) => <button key={side} className={side} onClick={() => pick(side)}>{side === "up" ? "Up" : "Down"} <b>{cents(askOf(side))}</b></button>)}</div>}
    {page === "markets" && category === "politics" && politics.event && <div className="chain-mobile-bar">{(["up", "down"] as const).map((side) => <button key={side} className={side} onClick={() => pickEvent(side)}>{SIDE_NAME[side]} <b>{cents(eventQuotes?.[side].ask?.cents ?? null)}</b></button>)}</div>}
    {drawer && <AccountDrawer view={drawer} onView={setDrawer} onClose={() => setDrawer(null)} network={network} wallet={wallet} orderbook={fundingBook} orderbookReason={active?.orderbookError ?? ""} priv={priv} onSignIn={signIn} />}
  </div>;
}
