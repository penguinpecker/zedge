import { useEffect, useReducer, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowsClockwise,
  BookOpen,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Command,
  GearSix,
  Lightning,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  Question,
  ShieldCheck,
  Wallet,
} from "@phosphor-icons/react";
import {
  AccountPanel,
  ActivityFeed,
  History,
  Portfolio,
} from "./components/AccountPanels";
import { MarketCards, MarketDetail } from "./components/MarketBoard";
import { Coin, Direction, Modal, Toast } from "./components/Primitives";
import { DEFAULT_FORM, TradeTicket } from "./components/TradeTicket";
import type { TicketForm } from "./components/TradeTicket";
import {
  availableShares,
  cash,
  countdown,
  exchangeReducer,
  loadState,
  MARKETS,
  marketById,
  marketSnapshot,
  price,
  quoteOrder,
  roundAt,
  sharesText,
  STORAGE_KEY,
  timeText,
} from "./lib/market";
import type { MarketId, OrderInput, Position } from "./lib/market";

type Page = "trade" | "portfolio" | "history";
type Dialog =
  "search" | "funds" | "rules" | "help" | "settings" | "reset" | null;

function readRoute(): { page: Page; market: MarketId; start: number | null } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  const market = MARKETS.some((m) => m.id === parts[1])
    ? (parts[1] as MarketId)
    : "btc-5m";
  const requestedStart = Number(parts[2]);
  const duration = marketById(market).minutes * 60_000;
  return {
    page: ["portfolio", "history"].includes(parts[0])
      ? (parts[0] as Page)
      : "trade",
    market,
    start:
      Number.isSafeInteger(requestedStart) &&
      requestedStart > 0 &&
      requestedStart % duration === 0
        ? requestedStart
        : null,
  };
}

export default function App() {
  const [state, dispatch] = useReducer(exchangeReducer, undefined, loadState);
  const [page, setPage] = useState<Page>(() => readRoute().page);
  const [marketId, setMarketId] = useState<MarketId>(() => readRoute().market);
  const [historicalStart, setHistoricalStart] = useState<number | null>(
    () => readRoute().start,
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState<TicketForm>(DEFAULT_FORM);
  const [review, setReview] = useState<OrderInput | null>(null);
  const [accountTab, setAccountTab] = useState("positions");
  const [search, setSearch] = useState("");
  const [deposit, setDeposit] = useState("500");
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastTick = useRef(Date.now());
  const market = marketById(marketId);
  const currentRound = roundAt(marketId, state.now);
  const start = historicalStart ?? currentRound.start;
  const offset = Math.round(
    (start - currentRound.start) / currentRound.duration,
  );
  const snapshot = marketSnapshot(marketId, state.now, start);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      dispatch({ type: "tick", elapsed: Math.max(0, now - lastTick.current) });
      lastTick.current = now;
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...state, notice: null }),
      );
    } catch {
      setStorageUnavailable(true);
    }
  }, [state]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((previous) => (previous === "search" ? null : "search"));
        setSearch("");
      }
    };
    const routeListener = () => {
      const next = readRoute();
      setPage(next.page);
      setMarketId(next.market);
      setHistoricalStart(next.start);
    };
    window.addEventListener("keydown", listener);
    window.addEventListener("hashchange", routeListener);
    return () => {
      window.removeEventListener("keydown", listener);
      window.removeEventListener("hashchange", routeListener);
    };
  }, []);

  const navigate = (next: Page) => {
    setPage(next);
    window.location.hash = next === "trade" ? `/trade/${marketId}` : `/${next}`;
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const selectMarket = (id: MarketId, roundStart?: number) => {
    const selectedStart =
      roundStart && roundStart !== roundAt(id, state.now).start
        ? roundStart
        : null;
    setMarketId(id);
    setHistoricalStart(selectedStart);
    setPage("trade");
    setForm(DEFAULT_FORM);
    window.location.hash = `/trade/${id}${selectedStart ? "/" + selectedStart : ""}`;
  };
  const scrollToTicket = () => {
    document.getElementById("trade-ticket")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "center",
    });
    setTimeout(
      () =>
        document.getElementById("trade-amount")?.focus({ preventScroll: true }),
      200,
    );
  };
  const sellPosition = (position: Position) => {
    selectMarket(position.marketId);
    setHistoricalStart(
      position.roundStart === roundAt(position.marketId, state.now).start
        ? null
        : position.roundStart,
    );
    setForm({
      ...DEFAULT_FORM,
      side: "sell",
      outcome: position.outcome,
      amount: String(
        availableShares(
          state,
          position.marketId,
          position.roundStart,
          position.outcome,
        ),
      ),
    });
    setTimeout(scrollToTicket, 50);
  };
  const selectedQuote = review ? quoteOrder(review, state.now) : null;
  const reviewSnapshot = review
    ? marketSnapshot(review.marketId, state.now, review.roundStart)
    : null;
  const searchResults = MARKETS.filter((m) =>
    `${m.name} ${m.asset} ${m.minutes}m ${m.minutes} min`
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );

  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <button
            className="brand"
            aria-label="ZEDGE home"
            onClick={() => navigate("trade")}
          >
            <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 2h20v5L9 17h13v5H2v-5L15 7H2z" fill="currentColor" />
            </svg>
            <span>
              edge<span className="brand-period">.</span>
            </span>
          </button>
          <nav className="main-nav" aria-label="Main navigation">
            {(["trade", "portfolio", "history"] as const).map((value) => (
              <button
                key={value}
                className={page === value ? "active" : ""}
                aria-current={page === value ? "page" : undefined}
                onClick={() => navigate(value)}
              >
                {value === "trade"
                  ? "Markets"
                  : value === "portfolio"
                    ? "Portfolio"
                    : "History"}
              </button>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className="search-trigger"
              aria-label="Search markets"
              onClick={() => {
                setDialog("search");
                setSearch("");
              }}
            >
              <MagnifyingGlass size={17} />
              <span>Search markets</span>
              <kbd>
                <Command size={10} /> K
              </kbd>
            </button>
            <button
              className="icon-button help-trigger"
              aria-label="How ZEDGE works"
              onClick={() => setDialog("help")}
            >
              <Question size={21} />
            </button>
            <div className="header-balance">
              <span>Demo balance</span>
              <strong>{cash(state.cashCents)}</strong>
            </div>
            <button
              className="button deposit-button"
              onClick={() => setDialog("funds")}
            >
              <Plus size={17} />
              <span>Add funds</span>
            </button>
            <button
              className="avatar-button"
              aria-label="Demo account settings"
              onClick={() => setDialog("settings")}
            >
              <span>D</span>
            </button>
          </div>
        </div>
      </header>
      <main id="main-content" className="app-main" tabIndex={-1}>
        {page === "trade" ? (
          <>
            <div className="page-heading trading-heading">
              <div>
                <div className="intro-eyebrow">
                  <span className="eyebrow">
                    The short-term prediction exchange
                  </span>
                  <span className="demo-badge">DEMO</span>
                </div>
                <h1>
                  Find your edge<span>.</span>
                </h1>
                <p>Big conviction. Short rounds. What’s your next move?</p>
              </div>
              <div className="heading-right">
                <div className="live-market-counter">
                  <span className="status-dot" />
                  <strong>04</strong>
                  <span>
                    markets
                    <br />
                    live now
                  </span>
                </div>
                <span className="heading-divider" />
                <button
                  className="how-it-works"
                  onClick={() => setDialog("help")}
                >
                  <span className="play-icon">
                    <Play size={12} weight="fill" />
                  </span>
                  How it works
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </div>
            <MarketCards
              state={state}
              selected={marketId}
              onSelect={selectMarket}
              dispatch={dispatch}
            />
            <div className="workspace-label">
              <div>
                <span>CRYPTO</span>
                <CaretRight size={11} />
                <span>{market.asset}</span>
                <CaretRight size={11} />
                <strong>{market.minutes} MIN UP / DOWN</strong>
              </div>
              <button
                className="text-button"
                onClick={() => setDialog("settings")}
              >
                <GearSix size={14} /> Customize demo
              </button>
            </div>
            <div className="trading-workspace">
              <div className="workspace-main">
                <MarketDetail
                  marketId={marketId}
                  state={state}
                  offset={offset}
                  onOffset={(value) =>
                    setHistoricalStart(
                      value === 0
                        ? null
                        : currentRound.start + value * currentRound.duration,
                    )
                  }
                  onRules={() => setDialog("rules")}
                  onTimeframe={selectMarket}
                />
                <AccountPanel
                  state={state}
                  marketId={marketId}
                  dispatch={dispatch}
                  onSell={sellPosition}
                  onSelect={selectMarket}
                  selectedTab={accountTab}
                  onTab={setAccountTab}
                />
                <div className="bottom-notes">
                  <span>
                    <ShieldCheck size={15} />
                    Clear rules. Defined outcomes.
                  </span>
                  <span>
                    <Clock size={14} />A fresh round every {market.minutes}{" "}
                    minutes.
                  </span>
                  <button
                    className="text-button"
                    onClick={() => setDialog("rules")}
                  >
                    Understand settlement <ArrowUpRight size={13} />
                  </button>
                </div>
              </div>
              <div className="workspace-side">
                <TradeTicket
                  state={state}
                  marketId={marketId}
                  roundStart={start}
                  form={form}
                  setForm={setForm}
                  onReview={setReview}
                  onFunds={() => setDialog("funds")}
                  onLive={() => selectMarket(marketId)}
                />
                <ActivityFeed marketId={marketId} state={state} />
              </div>
            </div>
          </>
        ) : page === "portfolio" ? (
          <Portfolio
            state={state}
            dispatch={dispatch}
            onSell={sellPosition}
            onSelect={selectMarket}
            onFunds={() => setDialog("funds")}
          />
        ) : (
          <History state={state} dispatch={dispatch} />
        )}
        <footer className="app-footer">
          <div>
            <span className={`status-dot ${state.paused ? "paused" : ""}`} />
            <span>{state.paused ? "Demo paused" : "Demo feed running"}</span>
            <span className="footer-divider">/</span>
            <span>{state.speed}× playback</span>
            <span className="footer-divider">/</span>
            <time className="mono">{timeText(state.now)} UTC</time>
          </div>
          <div>
            <span>Made for the next move.</span>
            <button onClick={() => setDialog("help")}>
              About ZEDGE <ArrowUpRight size={12} />
            </button>
          </div>
        </footer>
        {storageUnavailable && (
          <p className="storage-warning" role="status">
            Browser storage is unavailable. This demo session will reset when
            you reload.
          </p>
        )}
      </main>
      {page === "trade" && (
        <div className="mobile-trade-bar">
          <div>
            <span>
              {market.asset} · {market.minutes}m{" "}
              <span className="muted">{countdown(snapshot.remaining)}</span>
            </span>
            <strong>
              {cash(state.cashCents)} <small>available</small>
            </strong>
          </div>
          <button className="button primary" onClick={scrollToTicket}>
            Trade {market.asset} <ArrowRight size={17} />
          </button>
        </div>
      )}
      <Toast notice={state.notice} />

      {dialog === "search" && (
        <Modal
          title="Find your market."
          eyebrow="Make your next move"
          onClose={() => setDialog(null)}
        >
          <div className="search-input">
            <MagnifyingGlass size={21} />
            <input
              name="market-search"
              autoFocus
              aria-label="Search Bitcoin or Ethereum markets"
              placeholder="Bitcoin, Ethereum, 5m, 15m…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="search-results">
            {searchResults.length ? (
              searchResults.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    selectMarket(m.id);
                    setDialog(null);
                  }}
                >
                  <Coin asset={m.asset} />
                  <span>
                    <strong>
                      {m.name} <span className="muted">{m.minutes}m</span>
                    </strong>
                    <small>Up or down · live round</small>
                  </span>
                  <span className="search-odds">
                    {marketSnapshot(m.id, state.now).up}% <small>Up</small>
                  </span>
                  <ArrowUpRight size={17} />
                </button>
              ))
            ) : (
              <p className="empty-search">
                No matching markets. Try BTC, ETH, 5m, or 15m.
              </p>
            )}
          </div>
          <p className="modal-note">
            All four launch markets are available to explore.
          </p>
        </Modal>
      )}

      {dialog === "funds" && (
        <Modal
          title="A little more room to move."
          eyebrow="Your demo wallet"
          onClose={() => setDialog(null)}
        >
          <div className="wallet-summary">
            <span className="wallet-icon">
              <Wallet size={24} />
            </span>
            <div>
              <span>Available demo balance</span>
              <strong>{cash(state.cashCents)}</strong>
            </div>
            <span className="demo-badge">PAPER USD</span>
          </div>
          <p className="modal-description">
            Top up your practice balance and try a new prediction. Demo funds
            have no monetary value.
          </p>
          <label className="field-label" htmlFor="deposit-amount">
            Amount to add
          </label>
          <div className="deposit-input">
            <span>$</span>
            <input
              id="deposit-amount"
              autoFocus
              inputMode="decimal"
              type="number"
              min="1"
              max="10000"
              step="1"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value)}
            />
            <span>USD</span>
          </div>
          <div className="deposit-presets">
            {[100, 500, 1000].map((value) => (
              <button
                key={value}
                className={Number(deposit) === value ? "selected" : ""}
                onClick={() => setDeposit(String(value))}
              >
                ${value.toLocaleString()}
              </button>
            ))}
          </div>
          <button
            id="confirm-deposit"
            className="button primary full-width"
            disabled={
              !Number.isFinite(Number(deposit)) ||
              Number(deposit) < 1 ||
              Number(deposit) > 10000
            }
            onClick={() => {
              dispatch({
                type: "deposit",
                cents: Math.round(Number(deposit) * 100),
              });
              setDialog(null);
            }}
          >
            Add {cash(Number(deposit) * 100 || 0)} demo funds <Plus size={18} />
          </button>
          <p className="modal-note">
            <ShieldCheck size={14} />
            No wallet connection or payment required.
          </p>
        </Modal>
      )}

      {dialog === "rules" && (
        <Modal
          title={`${market.name}, ${market.minutes} minutes.`}
          eyebrow="The rules of this round"
          onClose={() => setDialog(null)}
        >
          <div className="rule-summary">
            <Coin asset={market.asset} />
            <div>
              <strong>Up or down</strong>
              <span>
                {new Date(start).toLocaleDateString("en-US", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  timeZone: "UTC",
                })}{" "}
                · {timeText(start)}–{timeText(snapshot.end)} UTC
              </span>
            </div>
          </div>
          <div className="rules-outcomes">
            <div>
              <Direction outcome="up" />
              <p>
                Closing price is <strong>at or above</strong> $
                {price(snapshot.reference)}.
              </p>
            </div>
            <div>
              <Direction outcome="down" />
              <p>
                Closing price is <strong>below</strong> $
                {price(snapshot.reference)}.
              </p>
            </div>
          </div>
          <dl className="rules-details">
            <div>
              <dt>Price to beat</dt>
              <dd>${price(snapshot.reference)}</dd>
            </div>
            <div>
              <dt>Orders close</dt>
              <dd>5 seconds before round end</dd>
            </div>
            <div>
              <dt>Resolution</dt>
              <dd>3 seconds after round end</dd>
            </div>
            <div>
              <dt>Winning share payout</dt>
              <dd>$1 per share</dd>
            </div>
            <div>
              <dt>Losing share payout</dt>
              <dd>$0</dd>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>1% per fill</dd>
            </div>
            <div>
              <dt>Price source</dt>
              <dd>ZEDGE simulated reference feed</dd>
            </div>
          </dl>
          <p className="rules-footnote">
            An exact tie resolves Up. The opening and closing observations use
            the same deterministic demo feed. Payouts are rounded down to whole
            cents. Unfilled orders expire at the trading cutoff and reserved
            funds or shares are released. Demo prices are not live BTC or ETH
            quotes.
          </p>
          <button
            className="button secondary full-width"
            onClick={() => {
              const text = `${market.name} ${market.minutes}m, ${timeText(start)}–${timeText(snapshot.end)} UTC. Up if closing price >= $${price(snapshot.reference)}; Down otherwise. Demo feed; $1 per winning share; 1% fee.`;
              navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? (
              <>
                <Check size={17} />
                Rules copied
              </>
            ) : (
              <>
                Copy round details <ArrowUpRight size={16} />
              </>
            )}
          </button>
        </Modal>
      )}

      {dialog === "help" && (
        <Modal
          title="Your view. Your move."
          eyebrow="Welcome to ZEDGE"
          onClose={() => setDialog(null)}
          wide
        >
          <p className="modal-description">
            A focused prediction exchange for Bitcoin and Ethereum. Pick a
            window, take a side, and follow the outcome.
          </p>
          <div className="help-steps">
            <div>
              <span>01</span>
              <Clock size={22} />
              <h3>Pick your window.</h3>
              <p>
                Trade the next 5 or 15 minutes. Each round has its own opening
                price and deadline.
              </p>
            </div>
            <div>
              <span>02</span>
              <Lightning size={22} />
              <h3>Choose a direction.</h3>
              <p>
                Buy Up if you expect a finish at or above the price to beat. Buy
                Down for a lower close.
              </p>
            </div>
            <div>
              <span>03</span>
              <CheckCircle size={22} />
              <h3>Know the outcome.</h3>
              <p>
                Winning shares pay $1. Losing shares pay $0. Sell early while
                trading is open, or hold to resolution.
              </p>
            </div>
          </div>
          <div className="help-example">
            <span className="eyebrow">A simple example</span>
            <p>
              Buy <strong>50 Up shares at 60¢</strong>. Your cost is{" "}
              <strong>$30 + $0.30 fee</strong>. If Up wins, you receive{" "}
              <strong>$50</strong> — a <strong>$19.70 profit</strong>. If Down
              wins, you lose the $30.30 paid.
            </p>
          </div>
          <details className="faq">
            <summary>How are market and limit orders different?</summary>
            <p>
              Market orders fill immediately at the simulated ask when buying,
              or bid when selling. Limit orders wait for your price or better;
              funds or shares remain reserved. They can be cancelled and expire
              five seconds before the round ends. The demo fills entire orders
              and does not model slippage or partial fills.
            </p>
          </details>
          <details className="faq">
            <summary>Are these real markets or funds?</summary>
            <p>
              This is an interactive paper-trading preview. Prices, liquidity,
              other traders, and fills are simulated. Your $1,000 starting
              account includes two sample positions. The account is saved in
              this browser. Use Customize demo to speed up time, see a round
              settle, or start fresh.
            </p>
          </details>
          <button
            className="button primary full-width"
            onClick={() => setDialog(null)}
          >
            Find my edge <ArrowRight size={18} />
          </button>
        </Modal>
      )}

      {dialog === "settings" && (
        <Modal
          title="Make it your session."
          eyebrow="Demo controls"
          onClose={() => setDialog(null)}
        >
          <div className="settings-row">
            <div>
              <strong>Reference feed</strong>
              <p>Pause or resume the demo clock.</p>
            </div>
            <button
              className="button secondary"
              onClick={() => dispatch({ type: "pause" })}
            >
              {state.paused ? <Play size={16} /> : <Pause size={16} />}
              {state.paused ? "Resume" : "Pause"}
            </button>
          </div>
          <div className="settings-row">
            <div>
              <strong>Playback speed</strong>
              <p>Watch shorter rounds unfold faster.</p>
            </div>
            <div className="speed-picker">
              {([1, 5, 15] as const).map((speed) => (
                <button
                  key={speed}
                  className={state.speed === speed ? "selected" : ""}
                  onClick={() => dispatch({ type: "speed", speed })}
                >
                  {speed}×
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>See a round settle</strong>
              <p>
                Advance {market.asset} {market.minutes}m to its final outcome.
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() => {
                dispatch({ type: "advance", marketId });
                setDialog(null);
                setAccountTab("positions");
                setHistoricalStart(null);
              }}
            >
              Finish round <ArrowRight size={16} />
            </button>
          </div>
          <div className="settings-row">
            <div>
              <strong>A fresh start</strong>
              <p>Reset demo trades, funds, and positions.</p>
            </div>
            <button
              className="text-button danger"
              onClick={() => setDialog("reset")}
            >
              <ArrowsClockwise size={16} /> Reset
            </button>
          </div>
          <p className="modal-note">
            All changes apply only to this browser’s paper account.
          </p>
        </Modal>
      )}

      {dialog === "reset" && (
        <Modal
          title="Start with a clean slate?"
          eyebrow="Reset demo account"
          onClose={() => setDialog(null)}
        >
          <p className="modal-description">
            This removes your local paper-trading history and restores a $1,000
            starting portfolio, including two sample positions. Your current
            demo trades cannot be restored.
          </p>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setDialog("settings")}
            >
              Keep my session
            </button>
            <button
              className="button primary"
              onClick={() => {
                dispatch({ type: "reset" });
                setHistoricalStart(null);
                setDialog(null);
              }}
            >
              Reset demo account
            </button>
          </div>
        </Modal>
      )}

      {review && selectedQuote && reviewSnapshot && (
        <Modal
          title="One last look."
          eyebrow="Review your paper trade"
          onClose={() => setReview(null)}
        >
          <div className="review-market">
            <Coin asset={reviewSnapshot.asset} />
            <div>
              <strong>
                {reviewSnapshot.name} {reviewSnapshot.minutes}m
              </strong>
              <span>
                {timeText(reviewSnapshot.start)}–{timeText(reviewSnapshot.end)}{" "}
                UTC
              </span>
            </div>
            <Direction outcome={review.outcome} />
          </div>
          <dl className="review-details">
            <div>
              <dt>Order</dt>
              <dd>
                {review.side === "buy" ? "Buy" : "Sell"} ·{" "}
                {review.type === "limit" ? "Limit" : "Market"}
              </dd>
            </div>
            <div>
              <dt>Price per share</dt>
              <dd>{selectedQuote.priceCents}¢</dd>
            </div>
            <div>
              <dt>Shares</dt>
              <dd>{sharesText(selectedQuote.quantity)}</dd>
            </div>
            <div>
              <dt>Trading fee (1%)</dt>
              <dd>{cash(selectedQuote.feeCents)}</dd>
            </div>
            <div className="review-total">
              <dt>{review.side === "buy" ? "Total cost" : "You receive"}</dt>
              <dd>{cash(selectedQuote.totalCents)}</dd>
            </div>
            {review.side === "buy" && (
              <div>
                <dt>
                  Payout if {review.outcome === "up" ? "Up" : "Down"} wins
                </dt>
                <dd className="lime-text">{cash(selectedQuote.payoutCents)}</dd>
              </div>
            )}
          </dl>
          <p className="review-risk">
            {review.side === "buy"
              ? `Maximum loss: ${cash(selectedQuote.totalCents)}, including fees. A winning share pays $1; a losing share pays $0.`
              : "These shares will no longer be eligible for a round payout after the sale."}
          </p>
          {!reviewSnapshot.tradable && (
            <p className="input-error">
              This round has closed. Choose the next round to trade.
            </p>
          )}
          <button
            id="confirm-order"
            className="button primary full-width"
            disabled={
              !reviewSnapshot.tradable ||
              !!selectedQuote.error ||
              (review.side === "buy"
                ? selectedQuote.totalCents > state.cashCents
                : selectedQuote.quantity >
                  availableShares(
                    state,
                    review.marketId,
                    review.roundStart,
                    review.outcome,
                  ))
            }
            onClick={() => {
              dispatch({
                type: "submit",
                input: review,
                id: crypto.randomUUID(),
              });
              setReview(null);
              setAccountTab(review.type === "limit" ? "orders" : "positions");
            }}
          >
            Confirm {review.type === "limit" ? "limit order" : "paper trade"}{" "}
            <ArrowRight size={18} />
          </button>
          <p className="modal-note">
            {review.type === "market"
              ? "Quote updates with the demo feed until confirmation."
              : "Your order will execute only at your limit or better."}
          </p>
        </Modal>
      )}
      <button
        className="floating-help"
        aria-label="Open getting started guide"
        onClick={() => setDialog("help")}
      >
        <BookOpen size={19} />
      </button>
    </>
  );
}
