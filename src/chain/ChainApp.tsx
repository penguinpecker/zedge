import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowSquareOut, ArrowUpRight, ArrowsClockwise, CaretLeft, CaretRight, ChartLine, CurrencyBtc, Info, LockKey, Wallet } from "@phosphor-icons/react";
import AccountDrawer, { type DrawerView } from "./AccountDrawer";
import type { MarketFeed } from "./LiveChart.tsx";
import SiteFooter from "../components/SiteFooter";
import { DEFAULT_NETWORK, isNetworkId, NETWORKS, parseAtomicAmount, type NetworkId } from "./networks.ts";
import { useChainWallet, WalletBoundary, type ChainWallet } from "./privy.tsx";
import { buyLimit, fairUp, realizedSigma, sellLimit, stakeRoom } from "./fair.ts";
import { checkDeployment, checkOrderbook, loadManifest, loadOrderbook, observationPrice, exactObservationPrice, PHASES, priceCaptions, readChain, readRound, type ChainSnapshot, type RoundRead } from "./gateway.ts";
import { engineRound, LOT, OPERATOR_KEYS_CHANGED, type OrderbookManifest, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { usePrivate, type PrivateState } from "./private/use-private.ts";
import { ActionLine, PrivateHistory, PrivateOrders, PrivatePortfolio, shares, usdc } from "./PrivatePanels.tsx";
import { sharesFor } from "./private/client.ts";
import type { DeploymentManifest, VerifiedDeployment } from "./manifest.ts";
import { STREAMS_MISMATCH_REASON, STREAMS_PLANNED_REASON, STREAMS_RPCS, StreamsMismatchError } from "./streams-manifest.ts";
import { rpcCooldownRemaining } from "./rpc.ts";
import { createVerificationCache, verificationIsFresh, type ReadOnlyVerification } from "./verification-cache.ts";
import "./chain.css";

const LiveChart = lazy(() => import("./LiveChart.tsx"));

const ORDERBOOK_MISMATCH = "Private order book checks did not pass, so private features are paused.";
const verificationCache = createVerificationCache<VerifiedDeployment | null>();
const orderbookCache = createVerificationCache<VerifiedOrderbook | null>();
const verificationTime = (value: number) => new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
function cooldownRemaining(network: NetworkId) {
  return Math.max(rpcCooldownRemaining(NETWORKS[network].rpcUrls.default.http[0]), network === 26514 ? rpcCooldownRemaining(STREAMS_RPCS.base) : 0);
}
function networkError(network: NetworkId) {
  const remaining = cooldownRemaining(network);
  return remaining > 0 ? `Network busy. Retrying after ${verificationTime(Date.now() + remaining)} UTC.` : "The public network is busy or unavailable. Please try again shortly.";
}

// The contracts support BTC and ETH rounds of 5 and 15 minutes; only BTC 15-minute rounds are offered for now.
const MARKETS = [
  { id: "btc-15m", asset: "BTC", name: "Bitcoin", duration: 900, assetId: 0 },
] as const;
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
};

const utc = (value: bigint) => new Date(Number(value) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
// The closing price timeout can be up to 21 days after the round, so it shows its date.
const utcDate = (value: bigint) => new Date(Number(value) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function PrivateEmpty({ title, onOpen, open }: { title: string; onOpen: () => void; open: boolean }) {
  return <div className="chain-empty"><span className="chain-empty-icon"><LockKey size={26} /></span><h3>{title} are locked</h3><p>{open ? "Sign in and unlock your private account to see this." : "Private accounts are not available yet."}</p><button className="button" onClick={onOpen}>View account <CaretRight /></button></div>;
}

type TicketRound = { start: number; cutoff: number; opening: string | null };
/** One click to enter (an IOC buy at the house's fair price plus slack), one click to close (an IOC sell of the whole side). Prices are
 * the house's own fair value from the display feed and the Chainlink opening price; the engine decides every fill. */
function Ticket({ priv, orderbook, wallet, round, chainNow, feed, onAccount, onFunds }: { priv: PrivateState; orderbook: VerifiedOrderbook | null; wallet: ChainWallet; round: TicketRound | null; chainNow: number | null; feed: MarketFeed | null; onAccount: () => void; onFunds: () => void }) {
  const [outcome, setOutcome] = useState<"up" | "down">("up");
  const [stake, setStake] = useState("5");
  const book = orderbook?.manifest, view = priv.snapshot?.view ?? null, unlocked = Boolean(priv.snapshot?.unlocked), cash = view?.cash ?? 0;
  let up: number | null = null;
  try { if (feed?.spot && round?.opening && chainNow !== null) up = fairUp(feed.spot.p, Number(round.opening), realizedSigma(feed.closes), round.start + 900 - chainNow); } catch { up = null; }
  const fair = (side: "up" | "down") => up === null ? null : side === "up" ? up : 1 - up;
  const value = fair(outcome), limit = value === null ? null : buyLimit(value);
  let pay = 0;
  try { pay = stake ? Number(parseAtomicAmount(stake, 6)) : 0; } catch { pay = -1; }
  const roundId = book && round ? engineRound(book, round.start).id : null;
  const room = book && view && roundId ? stakeRoom(view, roundId, outcome, Number(book.application.stakeLimits.account)) : 0;
  const quantity = limit && pay > 0 ? Math.min(sharesFor(pay, limit), room) : 0;
  const toCutoff = round && chainNow !== null ? round.cutoff - chainNow : null;
  const trading = Boolean(book && unlocked && round && toCutoff !== null && toCutoff > 15 && !priv.busy);
  const held = view && roundId ? view.holdings.find((h) => h.roundId === roundId) : undefined;
  const free = (side: "up" | "down") => Math.floor((side === "up" ? held?.up ?? 0 : held?.down ?? 0) / LOT) * LOT;
  const name = outcome === "up" ? "Up" : "Down", cents = (p: number | null) => p === null ? "—" : `${Math.round(p * 100)}¢`;
  const buy = () => { if (round && limit && quantity) void priv.run((a) => a.placeOrder({ roundStart: round.start, outcome, side: "buy", price: limit, quantity, tif: "ioc", expiry: round.cutoff })); };
  const close = (side: "up" | "down") => { const p = fair(side); if (round && p !== null) void priv.run((a) => a.close(round.start, side, sellLimit(p), round.cutoff)); };
  const [label, action, enabled] = !wallet.session ? ["Sign in to trade", onAccount, wallet.configured]
    : !book ? ["Trading is not open yet", onAccount, false]
    : !unlocked ? [priv.busy ? "Unlocking your account…" : "Unlock your account", onAccount, true]
    : cash === 0 ? ["Deposit to trade", onFunds, true]
    : !round ? ["Waiting for the next round", buy, false]
    : toCutoff !== null && toCutoff <= 15 ? ["This round no longer takes orders", buy, false]
    : limit === null ? ["Price unavailable", buy, false]
    : [`Buy ${name} · up to ${limit}¢`, buy, trading && quantity > 0 && pay <= cash] as const;
  return <aside className="chain-panel chain-ticket" aria-label="Order ticket"><div className="chain-panel-heading"><h2>Make your call</h2><span className="chain-pill">Up / Down</span></div>
    <p className="chain-copy">One click to enter, one click to close.</p>
    <div className="chain-outcomes"><button aria-pressed={outcome === "up"} onClick={() => setOutcome("up")}><ArrowUpRight size={23} /><strong>Up</strong><span>{cents(fair("up"))}</span></button><button className="down" aria-pressed={outcome === "down"} onClick={() => setOutcome("down")}><ArrowDownRight size={23} /><strong>Down</strong><span>{cents(fair("down"))}</span></button></div>
    <label htmlFor="chain-stake">Stake · USDC</label>
    <input id="chain-stake" inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} aria-invalid={pay < 0 || pay > cash} autoComplete="off" />
    <dl className="chain-account-values"><div><dt>Trading balance</dt><dd>{unlocked && view ? usdc(cash) : <><LockKey size={12} /> Locked</>}</dd></div>
      <div><dt>Shares / pays if right</dt><dd>{quantity ? `${shares(quantity)} / ${usdc(quantity)}` : "—"}</dd></div></dl>
    <button className="button primary chain-full" disabled={!enabled} onClick={action}>{label}</button>
    {(["up", "down"] as const).filter((side) => free(side) > 0).map((side) => <div className="chain-position" key={side}><span>You hold {shares(free(side))} {side === "up" ? "Up" : "Down"}</span>
      <button className="button" disabled={!trading || fair(side) === null} onClick={() => close(side)}>Close · at least {fair(side) === null ? "—" : `${sellLimit(fair(side)!)}¢`}</button></div>)}
    <ActionLine snapshot={priv.snapshot} names={["Buy Up", "Buy Down", "Sell Up", "Sell Down", "Order result", "Round result"]} />
    {priv.error && <p className="chain-error" role="alert">{priv.error}</p>}
    <div className="chain-ticket-account"><button onClick={onAccount}><Wallet size={17} /> Account <CaretRight /></button><button onClick={onFunds}><LockKey size={17} /> Deposit or withdraw <CaretRight /></button></div></aside>;
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
  const [drawer, setDrawer] = useState<DrawerView | null>(null);
  const [book, setBook] = useState<"quotes" | "orders">("quotes");
  const [roundOffset, setRoundOffset] = useState(0);
  const [roundRead, setRoundRead] = useState<RoundRead | null>(null);
  const [roundError, setRoundError] = useState("");
  const wallet = useChainWallet();
  const [feed, setFeed] = useState<MarketFeed | null>(null);
  const active = connection?.network === network ? connection : null;
  const market = MARKETS[marketIndex];
  const snapshot = active?.snapshot ?? null;
  const verification = active?.verification;
  const verified = verification && verificationIsFresh(verification) ? verification.value : null;
  const currentRoundKey = snapshot ? `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}` : "";
  const [loadedRoundKey, setLoadedRoundKey] = useState("");
  const round = verified && loadedRoundKey === currentRoundKey ? roundRead : null;
  const openAccount = () => setDrawer("account");
  const orderbookCheck = active?.orderbook;
  const orderbook = verified && orderbookCheck && verificationIsFresh(orderbookCheck) ? orderbookCheck.value : null;
  // The private account (its key, in memory) outlives a check that only lapsed until the next poll re-verifies it, as
  // every check does each two minutes; a check that found a difference drops it. Actions stay gated on `orderbook`.
  const [privateBook, setPrivateBook] = useState<VerifiedOrderbook | null>(null);
  const checksExpire = useRef(Infinity);
  const mismatch = active?.deploymentError === STREAMS_MISMATCH_REASON || active?.orderbookError === OPERATOR_KEYS_CHANGED || active?.orderbookError === ORDERBOOK_MISMATCH;
  useEffect(() => { if (orderbook) setPrivateBook(orderbook); else if (mismatch) setPrivateBook(null); }, [orderbook, mismatch]);
  const priv = usePrivate(wallet, orderbook ?? (mismatch ? null : privateBook));
  const unlocked = Boolean(priv.snapshot?.unlocked);

  useEffect(() => {
    // Canonicalize the hash entry so in-page anchors cannot change app mode on reload.
    const url = new URL(window.location.href);
    if (url.searchParams.get("mode") !== "chain") {
      url.searchParams.set("mode", "chain");
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const controller = new AbortController();
    const update = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      setRefreshing(true);
      if (cooldownRemaining(network) > 0) {
        if (!cancelled) { setConnection({ network, snapshot: null, manifest: null, verification: null, rpcError: networkError(network), deploymentError: "", orderbook: null, orderbookError: "" }); setRefreshing(false); }
        busy = false;
        return;
      }
      // Re-verify while the shown checks are still valid: a check left to lapse showed markets and trading unavailable
      // until the next 30 s poll, about a quarter of the time.
      if (checksExpire.current - performance.now() < 40_000) { verificationCache.invalidate(network); orderbookCache.invalidate(network); }
      const results = await Promise.allSettled([readChain(network), loadManifest(network, controller.signal), network === 26514 ? loadOrderbook(controller.signal) : Promise.resolve(null)]);
      const chainResult = results[0];
      const manifestResult = results[1];
      const orderbookResult = results[2];
      const next: Connection = { network, snapshot: null, manifest: null, verification: null, rpcError: "", deploymentError: "", orderbook: null, orderbookError: "" };
      if (chainResult.status === "fulfilled") next.snapshot = chainResult.value;
      else next.rpcError = networkError(network);
      if (manifestResult.status === "fulfilled") next.manifest = manifestResult.value;
      else next.deploymentError = "Market information is unavailable. Try refreshing.";
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
      checksExpire.current = Math.min(next.verification?.expiresAt ?? Infinity, next.orderbook?.expiresAt ?? Infinity);
      if (!cancelled) { setConnection(next); setRefreshing(false); }
      busy = false;
    };
    void update();
    const interval = setInterval(() => void update(), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void update(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [network, refresh]);

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

  useEffect(() => {
    if (!verified || !snapshot) return;
    let cancelled = false;
    const key = `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}`;
    void readRound(verified, snapshot, market.assetId, market.duration, roundOffset).then((result) => {
      if (!cancelled) { setRoundRead(result); setLoadedRoundKey(key); setRoundError(""); }
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof StreamsMismatchError) {
        // The registry's code or owner changed after the cached check. Drop that check now, not at its expiry; the next poll checks everything again.
        verificationCache.invalidate(network);
        setConnection((current) => current?.verification?.value === verified ? { ...current, verification: null, deploymentError: STREAMS_MISMATCH_REASON } : current);
        return;
      }
      setRoundRead(null); setLoadedRoundKey(key); setRoundError("Unable to load this round. Try refreshing.");
    });
    return () => { cancelled = true; };
  }, [verified, snapshot, network, market.assetId, market.duration, market.id, roundOffset]);

  const chooseMarket = (index: number) => { setMarketIndex(index); setRoundOffset(0); };
  const refreshMarkets = () => {
    if (refreshing || cooldownRemaining(network) > 0) return;
    verificationCache.invalidate(network);
    orderbookCache.invalidate(network);
    setConnection(null);
    setRefreshing(true);
    setRefresh((value) => value + 1);
  };
  const connectionError = active?.deploymentError || active?.rpcError;
  const phase = round ? PHASES[round.phase] : roundError && verified ? "Read unavailable" : verified ? "Loading round…" : "Unavailable";
  const streams = verified?.manifest.schemaVersion === 3 ? verified.manifest : null;
  // A planned release fails closed exactly like an unavailable network: nothing is verified and no round is read.
  const planned = active?.manifest?.status === "planned";
  const offline = active?.manifest?.status === "unavailable" ? active.manifest.reason : planned ? STREAMS_PLANNED_REASON : "";
  const captions = priceCaptions(round, Boolean(verified), Boolean(roundError));
  const openingPrice = round?.round?.openedAt ? observationPrice(round.round.opening.price, -round.round.opening.decimals) : null;
  // The live chart keeps the last read of this same round while it is re-read at each new block, so it never remounts mid-round.
  const chartRound = verified && streams && loadedRoundKey.startsWith(`${network}:${market.id}:${roundOffset}:`) && roundRead?.round && roundRead.phase >= 1 && roundRead.phase <= 5 ? roundRead.round : null;

  const closing = round?.round?.resolvedAt && round.round.outcome !== 3 ? round.round.closing : null;
  const chainNow = snapshot ? Number(snapshot.timestamp) + Math.floor((Date.now() - snapshot.checkedAt) / 1000) : null;
  const openRound = round?.round && round.phase === 3 ? { start: Number(round.start), cutoff: Number(round.round.cutoff) } : null;
  const ticketRound = openRound && round?.round ? { ...openRound, opening: round.round.openedAt ? exactObservationPrice(round.round.opening.price, round.round.opening.decimals) : null } : null;
  const pins = verified ? Object.entries(verified.manifest.contracts).map(([name, pin]) => ({ name, ...pin, chainId: "chainId" in pin ? pin.chainId : network })) : [];
  if (streams) {
    const registry = streams.contracts.registry;
    pins.splice(1, 0, { name: "registryImplementation", chainId: 26514, address: registry.implementation, runtimeCodeHash: registry.implementationCodeHash });
    for (const name of ["collateral", "verifier", "sourceMessenger", "destinationMessenger"] as const) {
      pins.push({ name, ...streams.dependencies[name] });
    }
  }
  return <div className="chain-app">
    <a className="skip-link" href="#chain-main">Skip to content</a>
    <header className="app-header"><div className="header-inner">
      <button className="brand" aria-label="ZEDGE home" onClick={() => setPage("markets")}><svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2h20v5L9 17h13v5H2v-5L15 7H2z" fill="currentColor" /></svg><span>edge<span className="brand-period">.</span></span></button>
      <nav className="main-nav" aria-label="Main navigation">{(["markets", "portfolio", "history"] as const).map((item) => <button key={item} className={page === item ? "active" : ""} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="header-actions">
        <label className="chain-network-select"><span className="sr-only">Market network</span><select id="chain-network" name="network" value={network} onChange={(event) => { const next = Number(event.target.value); if (isNetworkId(next)) { setNetwork(next); setRoundOffset(0); } }}><option value={26514}>Horizen mainnet</option></select></label>
        <button className="button primary chain-connect" onClick={wallet.configured && !wallet.session ? () => wallet.connect() : openAccount}><Wallet size={18} /><span>{wallet.session ? `${wallet.session.address.slice(0, 6)}…${wallet.session.address.slice(-4)}` : "Sign in"}</span></button>
      </div>
    </div></header>
    <main id="chain-main" className="app-main" tabIndex={-1}>
      <div className="page-heading trading-heading"><div><div className="intro-eyebrow"><span className="eyebrow">The short-term prediction exchange</span></div><h1>{page === "markets" ? <>Find your edge<span>.</span></> : page === "portfolio" ? <>Your positions<span>.</span></> : <>Your history<span>.</span></>}</h1><p>{page === "markets" ? "Big conviction. Short rounds. What’s your next move?" : page === "portfolio" ? "Your positions and balance." : "Your orders, fills and settled predictions."}</p></div><button className="chain-security-link" onClick={() => setDrawer("security")}><LockKey size={18} />{unlocked ? "Account unlocked" : "Account locked"} <CaretRight size={14} /></button></div>
      {(connectionError || (!verified && (planned || offline))) && <div className="chain-status-banner"><Info size={21} /><div><strong>{connectionError ? "Market checks unavailable" : planned ? "Public markets not available yet" : "Public markets unavailable"}</strong><p>{connectionError || offline}</p></div><button className="icon-button" aria-label="Refresh markets" disabled={refreshing || cooldownRemaining(network) > 0} onClick={refreshMarkets}><ArrowsClockwise size={20} /></button></div>}
      {active?.rpcError && !connectionError && <p className="chain-error" role="alert">{active.rpcError}</p>}
      {page === "markets" ? <>
        <section className="chain-market-cards" aria-label="Choose a market">{MARKETS.map((item, index) => <button className={`chain-market-card ${marketIndex === index ? "selected" : ""}`} key={item.id} aria-pressed={marketIndex === index} onClick={() => chooseMarket(index)}><span className="chain-card-heading"><span className={`coin ${item.asset.toLowerCase()} small`}><CurrencyBtc weight="bold" /></span><strong>{item.name}</strong><span className="chain-duration">{item.duration / 60}m</span></span><span className="chain-card-question">Higher or lower?</span><span className="chain-card-prices"><span>Up <b>—</b></span><span>Down <b>—</b></span></span><span className="chain-card-foot">{verified ? "View round" : "Unavailable"}<CaretRight /></span></button>)}</section>
        <div className="workspace-label"><div><span>CRYPTO</span><CaretRight size={11} /><span>{market.asset}</span><CaretRight size={11} /><strong>{market.duration / 60} MIN UP / DOWN</strong></div></div>
        <div className="chain-workspace">
          <div className="chain-left-column">
            <section className="chain-panel chain-market-detail" aria-label="Market and price chart"><div className="chain-panel-heading"><div><span className="eyebrow">{market.name} · {market.duration / 60} minute round</span><h2>Will {market.name} finish higher?</h2></div><span className="chain-pill">{phase}</span></div>
              <div className="chain-round-nav"><button aria-label="Previous round" disabled={!verified || roundOffset <= -1} onClick={() => setRoundOffset((value) => value - 1)}><CaretLeft /></button><span>{round ? `${utc(round.start)} — ${utc(round.start + BigInt(market.duration))} UTC` : "Round unavailable"}</span><button aria-label="Next round" disabled={!verified || roundOffset >= 1} onClick={() => setRoundOffset((value) => value + 1)}><CaretRight /></button></div>
              <div className="chain-price-grid"><div><span>Price to beat</span><strong title={round?.round?.openedAt ? `$${exactObservationPrice(round.round.opening.price, round.round.opening.decimals)}` : undefined}>{openingPrice ?? "—"}</strong><small>{captions.opening}</small></div><div><span>Closing price</span><strong title={closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : undefined}>{closing ? observationPrice(closing.price, -closing.decimals) : "—"}</strong><small>{captions.closing}</small></div></div>
              {chartRound ? <Suspense fallback={<div className="chain-chart-empty" />}><LiveChart start={Number(chartRound.start)} cutoff={Number(chartRound.cutoff)} end={Number(chartRound.end)} priceToBeat={chartRound.openedAt ? exactObservationPrice(chartRound.opening.price, chartRound.opening.decimals) : null}
                onMarket={(next) => setFeed((last) => last?.spot?.t === next.spot?.t && last?.closes.length === next.closes.length ? last : next)} /></Suspense> : <div className="chain-chart-empty"><ChartLine size={30} /><strong>{round?.phase === 0 ? "No round scheduled for this time" : round?.round?.outcome === 1 ? "Up wins" : round?.round?.outcome === 2 ? "Down wins" : round?.round?.outcome === 3 ? "Round voided" : "Settlement observations"}</strong><p className="chain-copy">{round?.phase === 0 ? "The registry has no market in this time slot. Check the adjacent rounds or refresh." : "Opening and closing observations determine the outcome."}</p>{streams && <small>Chainlink Data Streams · Base → Horizen</small>}</div>}
              {round?.round && <details className="chain-details"><summary>Round rules & exact observations</summary><dl className="chain-account-values"><div><dt>Trading cutoff</dt><dd>{utc(round.round.cutoff)} UTC</dd></div><div><dt>Opening deadline</dt><dd>{utc(round.round.openingDeadline)} UTC</dd></div>{round.round.voidableAfter !== null ? <div><dt>Closing price timeout</dt><dd>{utcDate(round.round.voidableAfter)} UTC</dd></div> : round.round.resolutionDeadline !== null && <div><dt>Resolution deadline</dt><dd>{utc(round.round.resolutionDeadline)} UTC</dd></div>}<div><dt>Exact opening</dt><dd>{round.round.openedAt ? `$${exactObservationPrice(round.round.opening.price, round.round.opening.decimals)}` : "Not recorded"}</dd></div><div><dt>Exact closing</dt><dd>{closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : "Not recorded"}</dd></div></dl><p className="chain-copy">A tie resolves Up. {round.round.voidableAfter !== null ? "After the round ends it can be resolved whenever its closing price has been delivered; there is no deadline. It can be voided only if no opening price was recorded by the opening deadline, or after the closing price timeout while no closing price has been delivered. Anyone can block price delivery until that timeout at a small cost in network fees, so a trader holding the losing side can force a void." : "If its opening or closing price is not recorded by the deadline, the round can be voided."} Prices shown above are shortened to cents for display; settlement compares the exact values.</p></details>}
              {round && <details className="chain-details"><summary>Round identity</summary><code>{round.roundId}</code><p className="chain-copy">{round.phase === 0 ? "Canonical ID for this unscheduled time slot." : "Read from the verified registry at the displayed block."}</p></details>}
              {roundError && verified && <p className="chain-error" role="alert">{roundError}</p>}
              <div className="chain-market-foot"><span>{snapshot ? `Updated ${utc(snapshot.timestamp)} UTC` : "Waiting for a network response"}</span><span>Winner 1 · Loser 0 · Void ½ collateral unit</span></div>
            </section>
            <section className="chain-panel chain-book" aria-label="Order book"><div className="chain-panel-heading"><h2>Order book</h2><div className="chain-segment"><button aria-pressed={book === "quotes"} onClick={() => setBook("quotes")}>Public quotes</button><button aria-pressed={book === "orders"} onClick={() => setBook("orders")}><LockKey size={13} />My orders</button></div></div>{book === "quotes" ? <><div className="chain-book-columns"><span>Price</span><span>Shares</span><span>Total</span></div><div className="chain-empty chain-book-empty"><ChartLine size={24} /><h3>Quotes unavailable</h3></div></> : orderbook && unlocked ? <PrivateOrders priv={priv} book={orderbook.manifest} roundStart={round?.round ? Number(round.start) : null} /> : <PrivateEmpty title="Your orders" onOpen={openAccount} open={Boolean(orderbook)} />}</section>
          </div>
          <Ticket priv={priv} orderbook={orderbook} wallet={wallet} round={ticketRound} chainNow={chainNow} feed={chartRound ? feed : null} onAccount={openAccount} onFunds={() => setDrawer("funds")} />
        </div>
      </> : <section className="chain-panel chain-private-page"><div className="chain-panel-heading"><h2>{page === "portfolio" ? "Positions & balances" : "Fills & account history"}</h2><span className="chain-pill"><LockKey size={13} />{unlocked ? "Unlocked" : "Locked"}</span></div>{orderbook && unlocked && snapshot ? page === "portfolio" ? <PrivatePortfolio priv={priv} book={orderbook.manifest} chainNow={chainNow ?? Number(snapshot.timestamp)} openRound={openRound?.start ?? null} /> : <PrivateHistory priv={priv} fromBlock={snapshot.blockNumber > 604_800n ? snapshot.blockNumber - 604_800n : 0n} /> : <PrivateEmpty title={page === "portfolio" ? "Your positions" : "Your records"} onOpen={openAccount} open={Boolean(orderbook)} />}</section>}
      <details className="chain-details chain-deployment-details"><summary>Market details</summary><div className="chain-technical-grid"><dl><dt>Network</dt><dd>{NETWORKS[network].name} · {network}</dd><dt>Connection</dt><dd>{snapshot ? `Connected · block ${snapshot.blockNumber}` : "Not verified"}</dd><dt>Trading</dt><dd>{orderbook ? "Open (private order book)" : "Unavailable"}</dd><dt>Private access</dt><dd>{orderbook ? "Sign in to use" : active?.orderbookError || "Unavailable"}</dd></dl><dl><dt>Contract checks</dt><dd>{verified && verification ? `Matched release · checked ${verificationTime(verification.checkedAt)} UTC` : planned ? "Not available yet" : offline ? "Not available" : "Not verified"}</dd><dt>Roles and governance</dt><dd>{verified ? streams ? <>The round registry is upgradeable: its owner address <code>{streams.contracts.registry.owner}</code> can replace its code, including the round rules. The three price-route contracts are fixed. The registry’s code and owner and the upstream implementations and governance matched this release at the checked blocks, with no ownership transfer pending.</> : "Registry fixed; external provider governance requires separate review." : "Not verified"}</dd><dt>Private account</dt><dd>{unlocked ? "Unlocked" : "Locked"}</dd></dl></div>{verified && <><p>Release {verified.manifest.release}. Matching code and configuration does not verify private execution or imply a security audit.</p>{streams && <p><a href="https://github.com/penguinpecker/zedge/blob/feat/production-core/contracts/deployment/MAINNET.md" target="_blank" rel="noreferrer">Deployment record and source-verification details <ArrowSquareOut size={13} /></a></p>}<dl className="chain-address-list">{pins.map((pin) => <div key={pin.name}><dt>{pin.name.replace(/([A-Z])/g, " $1")} · {pin.chainId === 8453 ? "Base" : NETWORKS[network].name}</dt><dd><a href={`${pin.chainId === 8453 ? "https://basescan.org" : NETWORKS[network].blockExplorers.default.url}/address/${pin.address}`} target="_blank" rel="noreferrer">{pin.address}</a><code>{pin.runtimeCodeHash}</code></dd></div>)}</dl></>}</details>
      <SiteFooter mode="chain" status={<span>ZEDGE · {network === 2651420 ? "Testnet" : orderbook ? "Mainnet" : "Mainnet read-only"}</span>} action={<button onClick={() => setDrawer("security")}>Account security</button>} />
    </main>
    {drawer && <AccountDrawer view={drawer} onView={setDrawer} onClose={() => setDrawer(null)} network={network} wallet={wallet} orderbook={orderbook} orderbookReason={active?.orderbookError ?? ""} priv={priv} />}
  </div>;
}
