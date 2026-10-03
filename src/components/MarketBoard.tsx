import {
  ArrowUpRight,
  CaretLeft,
  CaretRight,
  Check,
  Clock,
  SlidersHorizontal,
  Star,
} from "@phosphor-icons/react";
import type { Dispatch } from "react";
import { useState } from "react";
import {
  cash,
  clamp,
  countdown,
  executionPrice,
  MARKETS,
  marketById,
  marketSnapshot,
  price,
  roundAt,
  spotAt,
  timeText,
} from "../lib/market";
import type {
  ExchangeAction,
  ExchangeState,
  MarketId,
  Outcome,
} from "../lib/market";
import { Coin, Direction } from "./Primitives";
import { PriceChart, Sparkline } from "./PriceChart";

export function MarketCards({
  state,
  selected,
  onSelect,
  dispatch,
}: {
  state: ExchangeState;
  selected: MarketId;
  onSelect: (id: MarketId) => void;
  dispatch: Dispatch<ExchangeAction>;
}) {
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const visible =
    filter === "all"
      ? MARKETS
      : MARKETS.filter((market) => state.favorites.includes(market.id));
  return (
    <section className="market-discovery" aria-label="Available markets">
      <div className="section-heading">
        <div className="discovery-tabs">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            All markets <span>04</span>
          </button>
          <button
            className={filter === "favorites" ? "active" : ""}
            onClick={() => setFilter("favorites")}
          >
            <Star size={14} /> Watchlist
          </button>
        </div>
        <span className="muted small hide-phone">
          One direction. Two possible outcomes.
        </span>
      </div>
      <div className="market-cards">
        {visible.map((market) => {
          const snap = marketSnapshot(market.id, state.now);
          return (
            <article
              key={market.id}
              className={`market-card ${selected === market.id ? "selected" : ""}`}
            >
              <button
                className="card-select"
                aria-label={`Select ${market.name} ${market.minutes} minute market`}
                aria-pressed={selected === market.id}
                onClick={() => onSelect(market.id)}
              >
                <div className="market-card-title">
                  <Coin asset={market.asset} small />
                  <span>{market.name}</span>
                  <span className="interval-tag">{market.minutes}m</span>
                </div>
                <div className="market-card-body">
                  <div>
                    <span
                      className={`market-odds ${snap.up >= 50 ? "up" : "down"}`}
                    >
                      {snap.up}
                      <small>%</small>
                    </span>
                    <span className="odds-caption">chance of Up</span>
                  </div>
                  <Sparkline
                    marketId={market.id}
                    now={state.now}
                    positive={snap.delta >= 0}
                  />
                </div>
                <div className="market-card-footer">
                  <span>
                    <span className="status-dot" />
                    Live round
                  </span>
                  <span>
                    <Clock size={12} />
                    {countdown(snap.remaining)}
                  </span>
                </div>
              </button>
              <button
                className={`card-star ${state.favorites.includes(market.id) ? "saved" : ""}`}
                aria-label={`${state.favorites.includes(market.id) ? "Remove" : "Add"} ${market.asset} ${market.minutes}m ${state.favorites.includes(market.id) ? "from" : "to"} watchlist`}
                aria-pressed={state.favorites.includes(market.id)}
                onClick={() => dispatch({ type: "favorite", id: market.id })}
              >
                <Star
                  size={15}
                  weight={
                    state.favorites.includes(market.id) ? "fill" : "regular"
                  }
                />
              </button>
            </article>
          );
        })}
        {visible.length === 0 && (
          <div className="watchlist-empty">
            Your watchlist is ready for a first pick. Star a market to add it
            here.
          </div>
        )}
      </div>
    </section>
  );
}

export function MarketDetail({
  marketId,
  state,
  offset,
  onOffset,
  onRules,
  onTimeframe,
}: {
  marketId: MarketId;
  state: ExchangeState;
  offset: number;
  onOffset: (value: number) => void;
  onRules: () => void;
  onTimeframe: (id: MarketId) => void;
}) {
  const [mode, setMode] = useState<"price" | "odds">("price");
  const [showBook, setShowBook] = useState(false);
  const round = roundAt(marketId, state.now, offset);
  const snapshot = marketSnapshot(marketId, state.now, round.start);
  const duration = snapshot.minutes * 60_000;
  const base = roundAt(marketId, state.now);
  const progress = clamp((state.now - round.start) / duration, 0, 1);
  return (
    <section
      className="market-detail panel"
      aria-label={`${snapshot.name} market details`}
    >
      <div className="detail-header">
        <div className="detail-identity">
          <Coin asset={snapshot.asset} />
          <div>
            <div className="detail-title-line">
              <h2>{snapshot.name}</h2>
              <span className="tiny-tag">{snapshot.minutes} MIN</span>
            </div>
            <span className="muted">
              Up or down <span className="dot-separator">·</span>{" "}
              {timeText(round.start)}–{timeText(round.end)} UTC
            </span>
          </div>
        </div>
        <button className="text-button rules-link" onClick={onRules}>
          Market rules <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="round-timeline">
        <button
          className="round-arrow"
          aria-label="Previous round"
          onClick={() => onOffset(Math.max(-12, offset - 1))}
          disabled={offset <= -12}
        >
          <CaretLeft size={16} />
        </button>
        {[-2, -1, 0, 1, 2].map((i) => {
          const start = base.start + i * duration;
          const live = i === 0;
          const winner: Outcome =
            spotAt(snapshot.asset, start + duration) >=
            spotAt(snapshot.asset, start)
              ? "up"
              : "down";
          return (
            <button
              key={i}
              disabled={i > 0}
              className={`round-option ${i === offset ? "selected" : ""} ${live ? "live" : ""}`}
              onClick={() => onOffset(i)}
              aria-label={`${live ? "Live" : i > 0 ? "Upcoming" : "Previous"} round ${timeText(start)}`}
              aria-pressed={i === offset}
            >
              <span>
                {i < 0 ? (
                  <Direction outcome={winner}>
                    <Check size={10} />
                  </Direction>
                ) : live ? (
                  <span className="status-dot" />
                ) : (
                  <Clock size={11} />
                )}
                {live ? "LIVE" : i > 0 ? "NEXT" : "SETTLED"}
              </span>
              <strong>{timeText(start)}</strong>
            </button>
          );
        })}
        <button
          className="round-arrow"
          aria-label="Back to current round"
          onClick={() => onOffset(0)}
          disabled={offset === 0}
        >
          <CaretRight size={16} />
        </button>
      </div>
      <div className="price-header">
        <div className="current-price-block">
          <span className="eyebrow">
            {snapshot.status === "resolved" ? "Closing price" : "Current price"}
          </span>
          <div className="main-price">
            <span className="dollar">$</span>
            {price(snapshot.current)}
          </div>
          <span
            className={`price-delta ${snapshot.delta >= 0 ? "up" : "down"}`}
          >
            <Direction outcome={snapshot.delta >= 0 ? "up" : "down"}>
              {snapshot.delta >= 0 ? "+" : "−"}$
              {price(Math.abs(snapshot.delta))}
            </Direction>
            <span>vs. price to beat</span>
          </span>
        </div>
        <div className="beat-block">
          <span className="eyebrow">Price to beat</span>
          <strong>${price(snapshot.reference)}</strong>
          <span>At {timeText(round.start)} UTC</span>
        </div>
        <div
          className={`countdown-block ${snapshot.remaining < 30_000 && snapshot.remaining > 0 ? "closing" : ""}`}
        >
          <span className="eyebrow">
            {snapshot.status === "resolved"
              ? "Round result"
              : snapshot.status === "resolving"
                ? "Finalizing"
                : "Round ends in"}
          </span>
          {snapshot.status === "resolved" ? (
            <Direction outcome={snapshot.delta >= 0 ? "up" : "down"} />
          ) : (
            <strong>{countdown(snapshot.remaining)}</strong>
          )}
          <div className="countdown-track">
            <i style={{ transform: `scaleX(${1 - progress})` }} />
          </div>
        </div>
      </div>
      <div className="chart-topline">
        <div className="chart-mode">
          {(["price", "odds"] as const).map((value) => (
            <button
              key={value}
              className={mode === value ? "active" : ""}
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
            >
              {value === "price" ? "Price" : "Probability"}
            </button>
          ))}
        </div>
        <span className="chart-source">
          <span className="status-dot" />
          Simulated feed <span className="hide-phone">· USD</span>
        </span>
      </div>
      <PriceChart
        marketId={marketId}
        now={state.now}
        start={round.start}
        mode={mode}
      />
      <div className="chart-bottom">
        <div className="timeframe-buttons">
          {([5, 15] as const).map((minutes) => (
            <button
              key={minutes}
              className={snapshot.minutes === minutes ? "active" : ""}
              aria-pressed={snapshot.minutes === minutes}
              onClick={() =>
                onTimeframe(
                  `${snapshot.asset.toLowerCase()}-${minutes}m` as MarketId,
                )
              }
            >
              {minutes}m
            </button>
          ))}
        </div>
        <span className="small muted hide-phone">
          Up wins at or above the price to beat.
        </span>
        <button
          className={`text-button ${showBook ? "lime-text" : ""}`}
          onClick={() => setShowBook(!showBook)}
          aria-expanded={showBook}
        >
          <SlidersHorizontal size={15} /> Order book
        </button>
      </div>
      {showBook && (
        <OrderBook marketId={marketId} now={state.now} start={round.start} />
      )}
    </section>
  );
}

function OrderBook({
  marketId,
  now,
  start,
}: {
  marketId: MarketId;
  now: number;
  start: number;
}) {
  const [outcome, setOutcome] = useState<Outcome>("up");
  const asset = marketById(marketId).asset;
  const bid = executionPrice(marketId, outcome, "sell", now, start);
  const ask = executionPrice(marketId, outcome, "buy", now, start);
  return (
    <div className="order-book">
      <div className="section-heading">
        <strong>
          Order book <span className="muted small">/ {asset}</span>
        </strong>
        <div className="mini-tabs">
          {(["up", "down"] as Outcome[]).map((o) => (
            <button
              key={o}
              className={o === outcome ? "active" : ""}
              onClick={() => setOutcome(o)}
            >
              {o === "up" ? "Up" : "Down"}
            </button>
          ))}
        </div>
      </div>
      <div className="depth-columns">
        {(["bid", "ask"] as const).map((side) => (
          <div key={side}>
            <div className="depth-header">
              <span>{side === "bid" ? "Bid" : "Ask"} price</span>
              <span>Shares</span>
              <span>Total</span>
            </div>
            {[0, 1, 2, 3].map((i) => {
              const p = clamp(side === "bid" ? bid - i : ask + i, 1, 99);
              const size = 310 + (i + 1) * (side === "bid" ? 147 : 193);
              return (
                <div className={`depth-row ${side}`} key={i}>
                  <i style={{ width: `${25 + i * 22}%` }} />
                  <span>{p}¢</span>
                  <span>{size.toLocaleString()}</span>
                  <span>{cash(size * p)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="small muted">
        Illustrative liquidity · {ask - bid}¢ spread · Up and Down are separate
        order books.
      </p>
    </div>
  );
}
