import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowSquareOut, ArrowUpRight, ArrowsClockwise, CaretLeft, CaretRight, ChartLine, CurrencyBtc, CurrencyEth, Info, LockKey, ShieldCheck, Wallet } from "@phosphor-icons/react";
import AccountDrawer, { type DrawerView } from "./AccountDrawer";
import { DEFAULT_NETWORK, isNetworkId, NETWORKS, type NetworkId } from "./networks.ts";
import { useWallet } from "./wallet.ts";
import { checkDeployment, gasBalance, loadManifest, observationPrice, PHASES, readChain, readRound, type ChainSnapshot, type RoundRead } from "./gateway.ts";
import type { DeploymentManifest, VerifiedDeployment } from "./manifest.ts";
import "./chain.css";

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
  verified: VerifiedDeployment | null;
  rpcError: string;
  deploymentError: string;
};

const utc = (value: bigint) => new Date(Number(value) * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function PrivateEmpty({ title, onOpen }: { title: string; onOpen: () => void }) {
  return <div className="chain-empty"><span className="chain-empty-icon"><LockKey size={26} /></span><h3>{title} are locked</h3><p>Private account access is not connected. No balance, position or trading history has been loaded.</p><button className="button" onClick={onOpen}>View account setup <CaretRight /></button></div>;
}

export default function ChainApp() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK);
  const [refresh, setRefresh] = useState(0);
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
  const verified = active?.verified ?? null;
  const currentRoundKey = snapshot ? `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}` : "";
  const [loadedRoundKey, setLoadedRoundKey] = useState("");
  const round = loadedRoundKey === currentRoundKey ? roundRead : null;
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
      if (busy) return;
      busy = true;
      const results = await Promise.allSettled([readChain(network), loadManifest(network, controller.signal)]);
      const chainResult = results[0];
      const manifestResult = results[1];
      const next: Connection = { network, snapshot: null, manifest: null, verified: null, rpcError: "", deploymentError: "" };
      if (chainResult.status === "fulfilled") next.snapshot = chainResult.value;
      else next.rpcError = "The network could not be verified. Check your connection and retry.";
      if (manifestResult.status === "fulfilled") next.manifest = manifestResult.value;
      else next.deploymentError = "Deployment information is missing or invalid. Trading remains unavailable.";
      if (next.snapshot && next.manifest) {
        try { next.verified = await checkDeployment(next.manifest, next.snapshot); }
        catch { next.deploymentError = "Contract checks did not pass. This deployment cannot be used."; }
      }
      if (!cancelled) setConnection(next);
      busy = false;
    };
    void update();
    const interval = setInterval(() => void update(), 15_000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [network, refresh]);

  useEffect(() => {
    if (!verified || !snapshot) return;
    let cancelled = false;
    const key = `${network}:${market.id}:${roundOffset}:${snapshot.blockNumber}`;
    void readRound(verified, snapshot, market.assetId, market.duration, roundOffset).then((result) => {
      if (!cancelled) { setRoundRead(result); setLoadedRoundKey(key); setRoundError(""); }
    }).catch(() => { if (!cancelled) { setRoundRead(null); setLoadedRoundKey(key); setRoundError("This round could not be read from the verified registry."); } });
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
  const phase = round ? PHASES[round.phase] : verified ? "Reading registry…" : "Not connected";
  const openingPrice = round?.round?.openedAt ? observationPrice(round.round.opening.price, round.round.opening.exponent) : null;

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
      <div className="chain-mode-strip"><span><span className={`chain-signal ${snapshot ? "connected" : ""}`} />{snapshot ? `Connected · block ${snapshot.blockNumber.toLocaleString()}` : active?.rpcError ? "Network unavailable" : "Connecting to network…"}</span><a href="?mode=demo">Switch to paper-trading demo <ArrowSquareOut size={13} /></a></div>
      <div className="page-heading trading-heading"><div><div className="intro-eyebrow"><span className="eyebrow">The short-term prediction exchange</span><span className="demo-badge">{network === 2651420 ? "TESTNET" : "READ-ONLY"}</span></div><h1>{page === "markets" ? <>Find your edge<span>.</span></> : page === "portfolio" ? <>Your positions<span>.</span></> : <>Your history<span>.</span></>}</h1><p>{page === "markets" ? "Public markets. Private intent. Your next move." : "Your account data stays separate from public market information."}</p></div><button className="chain-security-link" onClick={() => setDrawer("security")}><LockKey size={18} />Private access not active <CaretRight size={14} /></button></div>
      <div className="chain-status-banner"><Info size={21} /><div><strong>{active?.deploymentError ? "Deployment checks need attention" : verified ? "Round registry connected · trading unavailable" : "Trading deployment not connected"}</strong><p>{active?.deploymentError || "You can inspect the network and connect a wallet. Private orders, funding and account data are unavailable until their services are verified."}</p></div><button className="icon-button" aria-label="Refresh network and deployment checks" onClick={() => setRefresh((value) => value + 1)}><ArrowsClockwise size={20} /></button></div>
      {active?.rpcError && <p className="chain-error" role="alert">{active.rpcError}</p>}
      {wallet.session && !sameNetwork && <div className="chain-network-warning" role="status">Your wallet uses a different network.<button onClick={openAccount}>Review connection <CaretRight /></button></div>}
      {page === "markets" ? <>
        <section className="chain-market-cards" aria-label="Choose a market">{MARKETS.map((item, index) => <button className={`chain-market-card ${marketIndex === index ? "selected" : ""}`} key={item.id} aria-pressed={marketIndex === index} onClick={() => chooseMarket(index)}><span className="chain-card-heading"><span className={`coin ${item.asset.toLowerCase()} small`}>{item.asset === "BTC" ? <CurrencyBtc weight="bold" /> : <CurrencyEth weight="fill" />}</span><strong>{item.name}</strong><span className="chain-duration">{item.duration / 60}m</span></span><span className="chain-card-question">Higher or lower?</span><span className="chain-card-prices"><span>Up <b>—</b></span><span>Down <b>—</b></span></span><span className="chain-card-foot">{verified ? "Select to read round" : "Market not connected"}<CaretRight /></span></button>)}</section>
        <div className="workspace-label"><div><span>CRYPTO</span><CaretRight size={11} /><span>{market.asset}</span><CaretRight size={11} /><strong>{market.duration / 60} MIN UP / DOWN</strong></div><span className="chain-label-muted">Real-chain interface</span></div>
        <div className="chain-workspace">
          <div className="chain-left-column">
            <section className="chain-panel chain-market-detail" aria-label="Market and price chart"><div className="chain-panel-heading"><div><span className="eyebrow">{market.name} · {market.duration / 60} minute round</span><h2>Will {market.name} finish higher?</h2></div><span className="chain-pill">{phase}</span></div>
              <div className="chain-round-nav"><button aria-label="Previous round" disabled={!verified || roundOffset <= -1} onClick={() => setRoundOffset((value) => value - 1)}><CaretLeft /></button><span>{round ? `${utc(round.start)} — ${utc(round.start + BigInt(market.duration))} UTC` : "Round schedule unavailable"}</span><button aria-label="Next round" disabled={!verified || roundOffset >= 1} onClick={() => setRoundOffset((value) => value + 1)}><CaretRight /></button></div>
              <div className="chain-price-grid"><div><span>Price to beat</span><strong>{openingPrice ?? "—"}</strong><small>{openingPrice ? "Verified registry observation" : "Awaiting verified opening price"}</small></div><div><span>Closing price</span><strong>{round?.round?.resolvedAt && round.round.outcome !== 3 ? observationPrice(round.round.closing.price, round.round.closing.exponent) : "—"}</strong><small>{round?.round?.outcome === 3 ? "Round voided" : "Final outcome comes from the registry"}</small></div></div>
              <div className="chain-chart-empty"><ChartLine size={30} /><strong>Price feed not connected</strong><p>A verified opening price and an independent live chart will appear here. No sample prices are used in chain mode.</p></div>
              {roundError && verified && <p className="chain-error" role="alert">{roundError}</p>}
              <div className="chain-market-foot"><span>{snapshot ? `Network observed at ${utc(snapshot.timestamp)} UTC` : "Waiting for a network response"}</span><span>Winner 1 · Loser 0 · Void ½ collateral unit</span></div>
            </section>
            <section className="chain-panel chain-book" aria-label="Order book"><div className="chain-panel-heading"><h2>Order book</h2><div className="chain-segment"><button aria-pressed={book === "quotes"} onClick={() => setBook("quotes")}>Public quotes</button><button aria-pressed={book === "orders"} onClick={() => setBook("orders")}><LockKey size={13} />My orders</button></div></div>{book === "quotes" ? <><div className="chain-book-columns"><span>Price</span><span>Shares</span><span>Total</span></div><div className="chain-empty chain-book-empty"><ChartLine size={24} /><h3>No verified quotes</h3><p>Public liquidity will appear when the quote service is connected. Personal orders and fills belong in your private account.</p></div></> : <PrivateEmpty title="Your orders" onOpen={openAccount} />}</section>
          </div>
          <aside className="chain-panel chain-ticket" aria-label="Order ticket"><div className="chain-panel-heading"><h2>Make your call</h2><span className="chain-pill">Up / Down</span></div><p className="chain-copy">Choose the outcome you believe in.</p><div className="chain-outcomes"><button aria-pressed={outcome === "Up"} onClick={() => setOutcome("Up")}><ArrowUpRight size={23} /><strong>Up</strong><span>—</span></button><button className="down" aria-pressed={outcome === "Down"} onClick={() => setOutcome("Down")}><ArrowDownRight size={23} /><strong>Down</strong><span>—</span></button></div><dl className="chain-account-values"><div><dt>Private balance</dt><dd><LockKey size={12} /> Locked</dd></div><div><dt>Execution price</dt><dd>Unavailable</dd></div><div><dt>Available liquidity</dt><dd>Unavailable</dd></div></dl><button className="button primary chain-full" onClick={() => setDrawer("order")}>Review {outcome} prediction <CaretRight /></button><p className="chain-ticket-note">Trading is unavailable. Review explains what must be connected before an order can be submitted.</p><div className="chain-ticket-account"><button onClick={openAccount}><Wallet size={17} /> Account setup <CaretRight /></button><button onClick={() => setDrawer("funds")}><LockKey size={17} /> Manage funds <CaretRight /></button></div><div className="chain-privacy-note"><ShieldCheck size={21} /><p>Private receipts require verified encryption. Connecting your wallet does not activate privacy.</p></div></aside>
        </div>
      </> : <section className="chain-panel chain-private-page"><div className="chain-panel-heading"><h2>{page === "portfolio" ? "Positions & balances" : "Fills & account history"}</h2><span className="chain-pill"><LockKey size={13} />Locked</span></div><PrivateEmpty title={page === "portfolio" ? "Your positions" : "Your records"} onOpen={openAccount} /></section>}
      <details className="chain-details chain-deployment-details"><summary>Network & deployment details</summary><div className="chain-technical-grid"><dl><dt>Network</dt><dd>{NETWORKS[network].name} · {network}</dd><dt>RPC connection</dt><dd>{snapshot ? `Verified network response · block ${snapshot.blockNumber}` : "Not verified"}</dd><dt>Trading mode</dt><dd>Read-only · transactions disabled</dd><dt>Confidential execution</dt><dd>Not connected or attested</dd></dl><dl><dt>Registry verification</dt><dd>{verified ? "Runtime code and immutable configuration match release" : active?.manifest?.status === "unavailable" ? "No deployment configured" : "Not verified"}</dd><dt>Roles and governance</dt><dd>{verified ? "Registry and oracle adapter: immutable, no admin roles. External provider governance is not verified." : "No deployment roles verified"}</dd><dt>Private account</dt><dd>Locked · no key signature requested</dd></dl></div>{verified && <><p>Release {verified.manifest.release}. Identity checks do not establish oracle compatibility, hardware privacy, financial safety or withdrawal recovery.</p><dl className="chain-address-list">{Object.entries(verified.manifest.contracts).map(([name, pin]) => <div key={name}><dt>{name}</dt><dd><a href={`${NETWORKS[network].blockExplorers.default.url}/address/${pin.address}`} target="_blank" rel="noreferrer">{pin.address}</a><code>{pin.runtimeCodeHash}</code></dd></div>)}</dl></>}</details>
      <footer className="app-footer"><span>ZEDGE · {network === 2651420 ? "Testnet" : "Mainnet read-only"}</span><span>Wallet reads use real network data. Trading services are not connected.</span><button onClick={() => setDrawer("security")}>Privacy & security</button></footer>
    </main>
    {drawer && <AccountDrawer view={drawer} onView={setDrawer} onClose={() => setDrawer(null)} network={network} wallet={wallet} gas={sameNetwork ? gas : null} deploymentReady={Boolean(verified)} market={`${market.asset} · ${market.duration / 60} minutes`} outcome={outcome} />}
  </div>;
}
