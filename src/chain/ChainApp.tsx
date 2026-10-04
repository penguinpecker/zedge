import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowSquareOut, ArrowUpRight, ArrowsClockwise, CaretLeft, CaretRight, ChartLine, CurrencyBtc, CurrencyEth, Info, LockKey, Wallet } from "@phosphor-icons/react";
import AccountDrawer, { type DrawerView } from "./AccountDrawer";
import SiteFooter from "../components/SiteFooter";
import { DEFAULT_NETWORK, isNetworkId, NETWORKS, type NetworkId } from "./networks.ts";
import { useWallet } from "./wallet.ts";
import { checkDeployment, gasBalance, loadManifest, observationPrice, exactObservationPrice, PHASES, readChain, readRound, type ChainSnapshot, type RoundRead } from "./gateway.ts";
import type { DeploymentManifest, VerifiedDeployment } from "./manifest.ts";
import { STREAMS_RPCS } from "./streams-manifest.ts";
import { rpcCooldownRemaining } from "./rpc.ts";
import { createVerificationCache, verificationIsFresh, type ReadOnlyVerification } from "./verification-cache.ts";
import "./chain.css";

const verificationCache = createVerificationCache<VerifiedDeployment | null>();
const verificationTime = (value: number) => new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
function cooldownRemaining(network: NetworkId) {
  return Math.max(rpcCooldownRemaining(NETWORKS[network].rpcUrls.default.http[0]), network === 26514 ? rpcCooldownRemaining(STREAMS_RPCS.base) : 0);
}
function networkError(network: NetworkId) {
  const remaining = cooldownRemaining(network);
  return remaining > 0 ? `Network busy. Retrying after ${verificationTime(Date.now() + remaining)} UTC.` : "The public network is busy or unavailable. Please try again shortly.";
}

const MARKETS = [
  { id: "btc-5m", asset: "BTC", name: "Bitcoin", duration: 300, assetId: 0 },
  { id: "btc-15m", asset: "BTC", name: "Bitcoin", duration: 900, assetId: 0 },
  { id: "eth-5m", asset: "ETH", name: "Ethereum", duration: 300, assetId: 1 },
  { id: "eth-15m", asset: "ETH", name: "Ethereum", duration: 900, assetId: 1 },
] as const;
type Connection = {
  network: NetworkId;
  snapshot: ChainSnapshot | null;
  manifest: DeploymentManifest | null;
  verification: ReadOnlyVerification<VerifiedDeployment | null> | null;
  rpcError: string;
  deploymentError: string;
};

const utc = (value: bigint) => new Date(Number(value) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function PrivateEmpty({ title, onOpen }: { title: string; onOpen: () => void }) {
  return <div className="chain-empty"><span className="chain-empty-icon"><LockKey size={26} /></span><h3>{title} are locked</h3><p>Private accounts are not available yet.</p><button className="button" onClick={onOpen}>View account <CaretRight /></button></div>;
}

export default function ChainApp() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [marketIndex, setMarketIndex] = useState(1);
  const [page, setPage] = useState<"markets" | "portfolio" | "history">("markets");
  const [drawer, setDrawer] = useState<DrawerView | null>(null);
  const [outcome, setOutcome] = useState<"Up" | "Down">("Up");
  const [book, setBook] = useState<"quotes" | "orders">("quotes");
  const [roundOffset, setRoundOffset] = useState(0);
  const [roundRead, setRoundRead] = useState<RoundRead | null>(null);
  const [roundError, setRoundError] = useState("");
  const [gas, setGas] = useState<bigint | null>(null);
  const wallet = useWallet();
  const active = connection?.network === network ? connection : null;
  const market = MARKETS[marketIndex];
  const snapshot = active?.snapshot ?? null;
  const verification = active?.verification;
  const verified = verification && verificationIsFresh(verification) ? verification.value : null;
  const currentRoundKey = snapshot ? `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}` : "";
  const [loadedRoundKey, setLoadedRoundKey] = useState("");
  const round = verified && loadedRoundKey === currentRoundKey ? roundRead : null;
  const sameNetwork = wallet.session?.chainId === network;
  const openAccount = () => setDrawer("account");

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
        if (!cancelled) { setConnection({ network, snapshot: null, manifest: null, verification: null, rpcError: networkError(network), deploymentError: "" }); setRefreshing(false); }
        busy = false;
        return;
      }
      const results = await Promise.allSettled([readChain(network), loadManifest(network, controller.signal)]);
      const chainResult = results[0];
      const manifestResult = results[1];
      const next: Connection = { network, snapshot: null, manifest: null, verification: null, rpcError: "", deploymentError: "" };
      if (chainResult.status === "fulfilled") next.snapshot = chainResult.value;
      else next.rpcError = networkError(network);
      if (manifestResult.status === "fulfilled") next.manifest = manifestResult.value;
      else next.deploymentError = "Market information is unavailable. Try refreshing.";
      if (next.snapshot && next.manifest) {
        const manifest = next.manifest, snapshot = next.snapshot;
        try { next.verification = await verificationCache.read(network, JSON.stringify(manifest), () => checkDeployment(manifest, snapshot)); }
        catch { next.deploymentError = cooldownRemaining(network) > 0 ? networkError(network) : "Market checks could not complete. Please try again shortly."; }
      }
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
    if (!verified || !snapshot) return;
    let cancelled = false;
    const key = `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}`;
    void readRound(verified, snapshot, market.assetId, market.duration, roundOffset).then((result) => {
      if (!cancelled) { setRoundRead(result); setLoadedRoundKey(key); setRoundError(""); }
    }).catch(() => { if (!cancelled) { setRoundRead(null); setLoadedRoundKey(key); setRoundError("Unable to load this round. Try refreshing."); } });
    return () => { cancelled = true; };
  }, [verified, snapshot, network, market.assetId, market.duration, market.id, roundOffset]);

  const walletAddress = wallet.session?.address;
  const walletChain = wallet.session?.chainId;
  const walletGeneration = wallet.session?.generation;
  useEffect(() => {
    setGas(null);
    if (!walletAddress || walletChain !== network) return;
    let cancelled = false;
    void gasBalance(network, walletAddress).then((amount) => { if (!cancelled) setGas(amount); }).catch(() => { if (!cancelled) setGas(null); });
    return () => { cancelled = true; };
  }, [network, walletAddress, walletChain, walletGeneration, refresh]);

  const chooseMarket = (index: number) => { setMarketIndex(index); setRoundOffset(0); };
  const refreshMarkets = () => {
    if (refreshing || cooldownRemaining(network) > 0) return;
    verificationCache.invalidate(network);
    setConnection(null);
    setRefreshing(true);
    setRefresh((value) => value + 1);
  };
  const connectionError = active?.deploymentError || active?.rpcError;
  const phase = round ? PHASES[round.phase] : roundError && verified ? "Read unavailable" : verified ? "Loading round…" : "Unavailable";
  const streams = verified?.manifest.schemaVersion === 2;
  const openingPrice = round?.round?.openedAt ? observationPrice(round.round.opening.price, -round.round.opening.decimals) : null;

  const closing = round?.round?.resolvedAt && round.round.outcome !== 3 ? round.round.closing : null;
  const pins = verified ? Object.entries(verified.manifest.contracts).map(([name, pin]) => ({ name, ...pin, chainId: "chainId" in pin ? pin.chainId : network })) : [];
  if (verified?.manifest.schemaVersion === 2) {
    for (const name of ["collateral", "verifier", "sourceMessenger", "destinationMessenger"] as const) {
      pins.push({ name, ...verified.manifest.dependencies[name] });
    }
  }
  return <div className="chain-app">
    <a className="skip-link" href="#chain-main">Skip to content</a>
    <header className="app-header"><div className="header-inner">
      <button className="brand" aria-label="ZEDGE home" onClick={() => setPage("markets")}><svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 2h20v5L9 17h13v5H2v-5L15 7H2z" fill="currentColor" /></svg><span>edge<span className="brand-period">.</span></span></button>
      <nav className="main-nav" aria-label="Main navigation">{(["markets", "portfolio", "history"] as const).map((item) => <button key={item} className={page === item ? "active" : ""} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      <div className="header-actions">
        <label className="chain-network-select"><span className="sr-only">Market network</span><select id="chain-network" name="network" value={network} onChange={(event) => { const next = Number(event.target.value); if (isNetworkId(next)) { setNetwork(next); setRoundOffset(0); } }}><option value={2651420}>Horizen testnet</option><option value={26514}>Horizen mainnet · read-only</option></select></label>
        <button className="button primary chain-connect" onClick={openAccount}><Wallet size={18} /><span>{wallet.session ? `${wallet.session.address.slice(0, 6)}…${wallet.session.address.slice(-4)}` : "Connect wallet"}</span></button>
      </div>
    </div></header>
    <main id="chain-main" className="app-main" tabIndex={-1}>
      <div className="chain-mode-strip"><span><span className={`chain-signal ${snapshot ? "connected" : ""}`} />{snapshot ? `${NETWORKS[network].name} connected` : active?.rpcError ? "Network unavailable" : "Connecting to network…"}</span><a href="?mode=demo">Try the demo <ArrowSquareOut size={13} /></a></div>
      <div className="page-heading trading-heading"><div><div className="intro-eyebrow"><span className="eyebrow">The short-term prediction exchange</span><span className="demo-badge">{network === 2651420 ? "TESTNET" : "READ-ONLY"}</span></div><h1>{page === "markets" ? <>Find your edge<span>.</span></> : page === "portfolio" ? <>Your positions<span>.</span></> : <>Your history<span>.</span></>}</h1><p>{page === "markets" ? "Big conviction. Short rounds. What’s your next move?" : page === "portfolio" ? "Your positions and balance." : "Your orders, fills and settled predictions."}</p></div><button className="chain-security-link" onClick={() => setDrawer("security")}><LockKey size={18} />Account locked <CaretRight size={14} /></button></div>
      <div className="chain-status-banner"><Info size={21} /><div><strong>{connectionError ? "Market checks unavailable" : verified ? "Public markets connected" : active?.manifest?.status === "unavailable" ? "Public markets unavailable" : "Connecting public markets"}</strong><p>{connectionError || (verified ? `Live contract reads. Checks completed ${verificationTime(verification!.checkedAt)} UTC. Trading, deposits and withdrawals are not open.` : active?.manifest?.status === "unavailable" ? active.manifest.reason : "Checking the market contracts and settlement source.")}</p></div><button className="icon-button" aria-label="Refresh markets" disabled={refreshing || cooldownRemaining(network) > 0} onClick={refreshMarkets}><ArrowsClockwise size={20} /></button></div>
      {active?.rpcError && <p className="chain-error" role="alert">{active.rpcError}</p>}
      {wallet.session && !sameNetwork && <div className="chain-network-warning" role="status">Your wallet uses a different network.<button onClick={openAccount}>Review connection <CaretRight /></button></div>}
      {page === "markets" ? <>
        <section className="chain-market-cards" aria-label="Choose a market">{MARKETS.map((item, index) => <button className={`chain-market-card ${marketIndex === index ? "selected" : ""}`} key={item.id} aria-pressed={marketIndex === index} onClick={() => chooseMarket(index)}><span className="chain-card-heading"><span className={`coin ${item.asset.toLowerCase()} small`}>{item.asset === "BTC" ? <CurrencyBtc weight="bold" /> : <CurrencyEth weight="fill" />}</span><strong>{item.name}</strong><span className="chain-duration">{item.duration / 60}m</span></span><span className="chain-card-question">Higher or lower?</span><span className="chain-card-prices"><span>Up <b>—</b></span><span>Down <b>—</b></span></span><span className="chain-card-foot">{verified ? "View round" : "Unavailable"}<CaretRight /></span></button>)}</section>
        <div className="workspace-label"><div><span>CRYPTO</span><CaretRight size={11} /><span>{market.asset}</span><CaretRight size={11} /><strong>{market.duration / 60} MIN UP / DOWN</strong></div></div>
        <div className="chain-workspace">
          <div className="chain-left-column">
            <section className="chain-panel chain-market-detail" aria-label="Market and price chart"><div className="chain-panel-heading"><div><span className="eyebrow">{market.name} · {market.duration / 60} minute round</span><h2>Will {market.name} finish higher?</h2></div><span className="chain-pill">{phase}</span></div>
              <div className="chain-round-nav"><button aria-label="Previous round" disabled={!verified || roundOffset <= -1} onClick={() => setRoundOffset((value) => value - 1)}><CaretLeft /></button><span>{round ? `${utc(round.start)} — ${utc(round.start + BigInt(market.duration))} UTC` : "Round unavailable"}</span><button aria-label="Next round" disabled={!verified || roundOffset >= 1} onClick={() => setRoundOffset((value) => value + 1)}><CaretRight /></button></div>
              <div className="chain-price-grid"><div><span>Price to beat</span><strong title={round?.round?.openedAt ? `$${exactObservationPrice(round.round.opening.price, round.round.opening.decimals)}` : undefined}>{openingPrice ?? "—"}</strong><small>{openingPrice ? "Verified opening observation" : !verified ? "Unavailable" : round?.phase === 0 ? "No scheduled round" : "Awaiting opening observation"}</small></div><div><span>Closing price</span><strong title={closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : undefined}>{closing ? observationPrice(closing.price, -closing.decimals) : "—"}</strong><small>{round?.round?.outcome === 3 ? "Round voided" : closing ? "Verified closing observation" : !verified ? "Unavailable" : round?.phase === 0 ? "No scheduled round" : "Awaiting resolution"}</small></div></div>
              <div className="chain-chart-empty"><ChartLine size={30} /><strong>{round?.phase === 0 ? "No round scheduled for this time" : round?.round?.outcome === 1 ? "Up wins" : round?.round?.outcome === 2 ? "Down wins" : round?.round?.outcome === 3 ? "Round voided" : "Settlement observations"}</strong><p className="chain-copy">{round?.phase === 0 ? "The registry has no market in this time slot. Check the adjacent rounds or refresh." : "Opening and closing observations determine the outcome. A live display chart is not connected."}</p>{streams && <small>Chainlink Data Streams · Base → Horizen</small>}</div>
              {round?.round && <details className="chain-details"><summary>Round rules & exact observations</summary><dl className="chain-account-values"><div><dt>Trading cutoff</dt><dd>{utc(round.round.cutoff)} UTC</dd></div><div><dt>Opening deadline</dt><dd>{utc(round.round.openingDeadline)} UTC</dd></div><div><dt>Resolution deadline</dt><dd>{utc(round.round.resolutionDeadline)} UTC</dd></div><div><dt>Exact opening</dt><dd>{round.round.openedAt ? `$${exactObservationPrice(round.round.opening.price, round.round.opening.decimals)}` : "Not recorded"}</dd></div><div><dt>Exact closing</dt><dd>{closing ? `$${exactObservationPrice(closing.price, closing.decimals)}` : "Not recorded"}</dd></div></dl><p className="chain-copy">A tie resolves Up. Missing evidence can void the round after its deadline. Prices shown above are shortened to cents for display; settlement compares the exact values.</p></details>}
              {round && <details className="chain-details"><summary>Round identity</summary><code>{round.roundId}</code><p className="chain-copy">{round.phase === 0 ? "Canonical ID for this unscheduled time slot." : "Read from the verified registry at the displayed block."}</p></details>}
              {roundError && verified && <p className="chain-error" role="alert">{roundError}</p>}
              <div className="chain-market-foot"><span>{snapshot ? `Updated ${utc(snapshot.timestamp)} UTC` : "Waiting for a network response"}</span><span>Winner 1 · Loser 0 · Void ½ collateral unit</span></div>
            </section>
            <section className="chain-panel chain-book" aria-label="Order book"><div className="chain-panel-heading"><h2>Order book</h2><div className="chain-segment"><button aria-pressed={book === "quotes"} onClick={() => setBook("quotes")}>Public quotes</button><button aria-pressed={book === "orders"} onClick={() => setBook("orders")}><LockKey size={13} />My orders</button></div></div>{book === "quotes" ? <><div className="chain-book-columns"><span>Price</span><span>Shares</span><span>Total</span></div><div className="chain-empty chain-book-empty"><ChartLine size={24} /><h3>Quotes unavailable</h3></div></> : <PrivateEmpty title="Your orders" onOpen={openAccount} />}</section>
          </div>
          <aside className="chain-panel chain-ticket" aria-label="Order ticket"><div className="chain-panel-heading"><h2>Make your call</h2><span className="chain-pill">Up / Down</span></div><p className="chain-copy">Choose the outcome you believe in.</p><div className="chain-outcomes"><button aria-pressed={outcome === "Up"} onClick={() => setOutcome("Up")}><ArrowUpRight size={23} /><strong>Up</strong><span>—</span></button><button className="down" aria-pressed={outcome === "Down"} onClick={() => setOutcome("Down")}><ArrowDownRight size={23} /><strong>Down</strong><span>—</span></button></div><dl className="chain-account-values"><div><dt>Private balance</dt><dd><LockKey size={12} /> Locked</dd></div><div><dt>Execution price</dt><dd>Unavailable</dd></div><div><dt>Available liquidity</dt><dd>Unavailable</dd></div></dl><button className="button primary chain-full" onClick={() => setDrawer("order")}>Review {outcome} prediction <CaretRight /></button><div className="chain-ticket-account"><button onClick={openAccount}><Wallet size={17} /> Account setup <CaretRight /></button><button onClick={() => setDrawer("funds")}><LockKey size={17} /> Manage funds <CaretRight /></button></div></aside>
        </div>
      </> : <section className="chain-panel chain-private-page"><div className="chain-panel-heading"><h2>{page === "portfolio" ? "Positions & balances" : "Fills & account history"}</h2><span className="chain-pill"><LockKey size={13} />Locked</span></div><PrivateEmpty title={page === "portfolio" ? "Your positions" : "Your records"} onOpen={openAccount} /></section>}
      <details className="chain-details chain-deployment-details"><summary>Market details</summary><div className="chain-technical-grid"><dl><dt>Network</dt><dd>{NETWORKS[network].name} · {network}</dd><dt>Connection</dt><dd>{snapshot ? `Connected · block ${snapshot.blockNumber}` : "Not verified"}</dd><dt>Trading</dt><dd>Unavailable</dd><dt>Private access</dt><dd>Unavailable</dd></dl><dl><dt>Contract checks</dt><dd>{verified && verification ? `Matched release · checked ${verificationTime(verification.checkedAt)} UTC` : active?.manifest?.status === "unavailable" ? "Not available" : "Not verified"}</dd><dt>Roles and governance</dt><dd>{verified ? streams ? "ZEDGE rules fixed; upstream implementations and governance matched at the checked blocks." : "Registry fixed; external provider governance requires separate review." : "Not verified"}</dd><dt>Private account</dt><dd>Locked</dd></dl></div>{verified && <><p>Release {verified.manifest.release}. Matching code and configuration does not verify private execution or imply a security audit.</p>{streams && <p><a href="https://github.com/penguinpecker/zedge/blob/e4bf2ccdc87995b386400a3999bcce0dd6610902/contracts/deployment/MAINNET.md" target="_blank" rel="noreferrer">Deployment record and source-verification details <ArrowSquareOut size={13} /></a></p>}<dl className="chain-address-list">{pins.map((pin) => <div key={pin.name}><dt>{pin.name.replace(/([A-Z])/g, " $1")} · {pin.chainId === 8453 ? "Base" : NETWORKS[network].name}</dt><dd><a href={`${pin.chainId === 8453 ? "https://basescan.org" : NETWORKS[network].blockExplorers.default.url}/address/${pin.address}`} target="_blank" rel="noreferrer">{pin.address}</a><code>{pin.runtimeCodeHash}</code></dd></div>)}</dl></>}</details>
      <SiteFooter mode="chain" status={<span>ZEDGE · {network === 2651420 ? "Testnet" : "Mainnet read-only"}</span>} action={<button onClick={() => setDrawer("security")}>Account security</button>} />
    </main>
    {drawer && <AccountDrawer view={drawer} onView={setDrawer} onClose={() => setDrawer(null)} network={network} wallet={wallet} gas={sameNetwork ? gas : null} market={`${market.asset} · ${market.duration / 60} minutes`} outcome={outcome} />}
  </div>;
}
