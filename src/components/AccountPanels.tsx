import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  DownloadSimple,
  ListChecks,
  TrendUp,
  Wallet,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { Dispatch } from "react";
import {
  accountTotals,
  cash,
  countdown,
  executionPrice,
  marketById,
  positionValue,
  price,
  roundAt,
  sharesText,
  spotAt,
  timeText,
} from "../lib/market";
import type {
  ExchangeAction,
  ExchangeState,
  MarketId,
  Order,
  Position,
} from "../lib/market";
import { Coin, Direction, EmptyState } from "./Primitives";

export function PositionsTable({
  state,
  positions,
  dispatch,
  onSell,
  onSelect,
}: {
  state: ExchangeState;
  positions: Position[];
  dispatch: Dispatch<ExchangeAction>;
  onSell: (position: Position) => void;
  onSelect: (id: MarketId, start?: number) => void;
}) {
  if (!positions.length)
    return (
      <EmptyState
        icon={<Wallet size={24} />}
        title="Your next move starts here."
      >
        Buy an outcome to see your position, value, and potential payout.
      </EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="positions-table">
        <thead>
          <tr>
            <th>Market / outcome</th>
            <th>Shares</th>
            <th>Avg. cost</th>
            <th>Value</th>
            <th>Return</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const market = marketById(position.marketId);
            const value =
              position.status === "open"
                ? positionValue(position, state.now)
                : position.payoutCents;
            const pnl = value - position.costCents;
            const canSell =
              state.now < position.roundEnd - 5000 &&
              position.status === "open";
            return (
              <tr key={position.id}>
                <td>
                  <button
                    className="position-market"
                    onClick={() =>
                      onSelect(position.marketId, position.roundStart)
                    }
                  >
                    <Coin asset={market.asset} small />
                    <span>
                      <strong>
                        {market.name}{" "}
                        <span className="muted">{market.minutes}m</span>
                      </strong>
                      <span className="position-sub">
                        <Direction outcome={position.outcome} />{" "}
                        <span>
                          {timeText(position.roundStart)}–
                          {timeText(position.roundEnd)}
                        </span>
                      </span>
                    </span>
                  </button>
                </td>
                <td className="mono">{sharesText(position.quantity)}</td>
                <td className="mono">
                  {position.quantity
                    ? (position.costCents / position.quantity).toFixed(1)
                    : "0"}
                  ¢
                </td>
                <td className="mono">{cash(value)}</td>
                <td>
                  <span className={`mono ${pnl >= 0 ? "up" : "down"}`}>
                    {pnl >= 0 ? "+" : "−"}
                    {cash(Math.abs(pnl))}
                  </span>
                </td>
                <td className="text-right">
                  {canSell ? (
                    <button
                      className="table-action"
                      onClick={() => onSell(position)}
                    >
                      Sell <ArrowUpRight size={13} />
                    </button>
                  ) : position.status === "won" && !position.claimed ? (
                    <button
                      className="table-action claim"
                      onClick={() =>
                        dispatch({ type: "claim", id: position.id })
                      }
                    >
                      Claim {cash(position.payoutCents)}
                    </button>
                  ) : (
                    <span
                      className={`settlement-tag ${position.status === "won" ? "up" : "muted"}`}
                    >
                      {position.claimed ? (
                        <>
                          <CheckCircle size={13} /> Claimed
                        </>
                      ) : position.status === "won" ? (
                        "Won"
                      ) : position.status === "lost" ? (
                        "Lost"
                      ) : (
                        "Resolving"
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OrdersTable({
  state,
  orders,
  dispatch,
}: {
  state: ExchangeState;
  orders: Order[];
  dispatch: Dispatch<ExchangeAction>;
}) {
  if (!orders.length)
    return (
      <EmptyState
        icon={<ListChecks size={24} />}
        title="Nothing waiting in the wings."
      >
        Your limit orders will appear here. Set a price and let the market come
        to you.
      </EmptyState>
    );
  return (
    <div className="table-scroll">
      <table className="positions-table orders-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Order</th>
            <th>Shares</th>
            <th>Price</th>
            <th>Total / fees included</th>
            <th className="text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const market = marketById(order.marketId);
            return (
              <tr key={order.id}>
                <td>
                  <div className="position-market">
                    <Coin asset={market.asset} small />
                    <span>
                      <strong>
                        {market.asset} {market.minutes}m
                      </strong>
                      <span className="position-sub">
                        {timeText(order.createdAt)} UTC
                      </span>
                    </span>
                  </div>
                </td>
                <td>
                  <span className="order-side">
                    {order.side} <Direction outcome={order.outcome} />
                  </span>
                  <span className="table-secondary">
                    {order.type === "limit" ? "Limit" : "Market"}
                  </span>
                </td>
                <td className="mono">{sharesText(order.quantity)}</td>
                <td className="mono">{order.priceCents}¢</td>
                <td className="mono">
                  {cash(order.totalCents)}
                  {order.status === "open" && (
                    <span className="table-secondary">
                      {order.side === "buy" ? "Reserved" : "Estimated proceeds"}{" "}
                      · {countdown(order.roundEnd - 5000 - state.now)}
                    </span>
                  )}
                </td>
                <td className="text-right">
                  {order.status === "open" ? (
                    <button
                      className="table-action"
                      onClick={() => dispatch({ type: "cancel", id: order.id })}
                    >
                      Cancel order
                    </button>
                  ) : (
                    <span
                      className={`settlement-tag ${order.status === "filled" ? "filled" : "muted"}`}
                    >
                      {order.status === "filled" && <CheckCircle size={13} />}
                      {order.status}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RoundResults({
  marketId,
  now,
}: {
  marketId: MarketId;
  now: number;
}) {
  const market = marketById(marketId);
  return (
    <div className="round-results">
      {[-1, -2, -3, -4, -5, -6].map((offset) => {
        const round = roundAt(marketId, now, offset);
        const start = spotAt(market.asset, round.start);
        const end = spotAt(market.asset, round.end);
        const up = end >= start;
        return (
          <div className="result-tile" key={offset}>
            <span>
              {timeText(round.start)}–{timeText(round.end)}
            </span>
            <Direction outcome={up ? "up" : "down"} />
            <strong>${price(end)}</strong>
            <small className="muted">
              {up ? "+" : "−"}${price(Math.abs(end - start))}
            </small>
          </div>
        );
      })}
      <p className="result-note">
        <CheckCircle size={14} />
        Settled from the simulated reference feed. Winning shares pay $1.
      </p>
    </div>
  );
}

export function AccountPanel({
  state,
  marketId,
  dispatch,
  onSell,
  onSelect,
  selectedTab,
  onTab,
}: {
  state: ExchangeState;
  marketId: MarketId;
  dispatch: Dispatch<ExchangeAction>;
  onSell: (position: Position) => void;
  onSelect: (id: MarketId, start?: number) => void;
  selectedTab: string;
  onTab: (tab: string) => void;
}) {
  const positions = state.positions.filter(
    (p) => p.status === "open" || (p.status === "won" && !p.claimed),
  );
  const orders = state.orders.filter((o) => o.status === "open");
  return (
    <section className="account-panel panel" aria-label="Positions and orders">
      <div className="account-panel-tabs">
        <div>
          {[
            {
              key: "positions",
              label: "Your positions",
              count: positions.length,
            },
            { key: "orders", label: "Open orders", count: orders.length },
            { key: "results", label: "Round results" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={selectedTab === tab.key ? "active" : ""}
              aria-pressed={selectedTab === tab.key}
              onClick={() => onTab(tab.key)}
            >
              {tab.label}
              {tab.count !== undefined && <span>{tab.count}</span>}
            </button>
          ))}
        </div>
        <span className="tiny-tag hide-phone">DEMO ACCOUNT</span>
      </div>
      {selectedTab === "positions" ? (
        <PositionsTable
          state={state}
          positions={positions}
          dispatch={dispatch}
          onSell={onSell}
          onSelect={onSelect}
        />
      ) : selectedTab === "orders" ? (
        <OrdersTable state={state} orders={orders} dispatch={dispatch} />
      ) : (
        <RoundResults marketId={marketId} now={state.now} />
      )}
    </section>
  );
}

export function ActivityFeed({
  marketId,
  state,
}: {
  marketId: MarketId;
  state: ExchangeState;
}) {
  const [filter, setFilter] = useState<"all" | "yours">("all");
  const round = roundAt(marketId, state.now);
  const own = state.orders
    .filter((o) => o.marketId === marketId && o.status === "filled")
    .slice(0, 5);
  const rows =
    filter === "yours"
      ? own.map((o) => ({
          id: o.id,
          outcome: o.outcome,
          price: o.priceCents,
          total: o.totalCents,
          label: "You",
          time: o.updatedAt,
        }))
      : Array.from({ length: 5 }, (_, i) => {
          const time = Math.max(
            round.start,
            Math.floor(state.now / 9000) * 9000 - i * 17000,
          );
          const outcome =
            (Math.floor(time / 9000) + i * 7) % 3 === 0
              ? ("down" as const)
              : ("up" as const);
          return {
            id: String(i),
            outcome,
            price: executionPrice(marketId, outcome, "buy", time, round.start),
            total: [4125, 17800, 6300, 2520, 9800][i],
            label: [
              "0x8c…42f1",
              "0xa1…09e3",
              "0x7f…bb20",
              "0x32…e671",
              "0xf9…4ca8",
            ][i],
            time,
          };
        });
  return (
    <section className="activity-feed panel">
      <div className="section-heading">
        <h3>
          Market activity <span className="status-dot" />
        </h3>
        <div className="mini-tabs">
          <button
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            className={filter === "yours" ? "active" : ""}
            onClick={() => setFilter("yours")}
          >
            Yours
          </button>
        </div>
      </div>
      <div className="activity-heading">
        <span>Trader / outcome</span>
        <span>Amount</span>
      </div>
      {rows.length ? (
        rows.map((row) => (
          <div className="activity-row" key={row.id}>
            <div className={`activity-avatar ${row.outcome}`}>
              {row.outcome === "up" ? (
                <ArrowUpRight size={15} />
              ) : (
                <ArrowDownRight size={15} />
              )}
            </div>
            <div>
              <strong>{row.label}</strong>
              <span>
                <Direction outcome={row.outcome} />{" "}
                <span className="muted">at {row.price}¢</span>
              </span>
            </div>
            <div className="activity-amount">
              <strong>{cash(row.total)}</strong>
              <span>{countdown(state.now - row.time)} ago</span>
            </div>
          </div>
        ))
      ) : (
        <p className="activity-empty">
          Your filled trades in this market will appear here.
        </p>
      )}
      <span className="activity-note">
        {filter === "all"
          ? "Simulated traders and activity"
          : "Your paper-trading activity"}
      </span>
    </section>
  );
}

export function Portfolio({
  state,
  dispatch,
  onSell,
  onSelect,
  onFunds,
}: {
  state: ExchangeState;
  dispatch: Dispatch<ExchangeAction>;
  onSell: (position: Position) => void;
  onSelect: (id: MarketId, start?: number) => void;
  onFunds: () => void;
}) {
  const [tab, setTab] = useState<"open" | "settled" | "orders">("open");
  const totals = accountTotals(state);
  const visible = state.positions.filter((p) =>
    tab === "open"
      ? p.status === "open"
      : p.status === "won" || p.status === "lost",
  );
  return (
    <div className="portfolio-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Your paper account</span>
          <h1>
            Every move, accounted for<span>.</span>
          </h1>
          <p>A clear view of your positions, returns, and available funds.</p>
        </div>
        <button className="button primary" onClick={onFunds}>
          Add demo funds <ArrowUpRight size={18} />
        </button>
      </div>
      <div className="portfolio-overview">
        <div className="portfolio-total">
          <span className="eyebrow">Portfolio value</span>
          <strong>{cash(totals.total)}</strong>
          <span className={totals.pnl >= 0 ? "up" : "down"}>
            {totals.pnl >= 0 ? "+" : "−"}
            {cash(Math.abs(totals.pnl))}{" "}
            <span className="muted">vs. total demo deposits</span>
          </span>
          <div className="portfolio-allocation">
            <i
              style={{
                width: `${totals.total ? (state.cashCents / totals.total) * 100 : 0}%`,
              }}
            />
            <i style={{ flex: 1 }} />
          </div>
          <div className="allocation-labels">
            <span>
              <i />
              Available balance
            </span>
            <span>
              <i />
              Positions & reserves
            </span>
          </div>
        </div>
        <div className="portfolio-stats">
          <div>
            <Wallet size={20} />
            <span>
              Available balance<strong>{cash(state.cashCents)}</strong>
            </span>
          </div>
          <div>
            <TrendUp size={20} />
            <span>
              Open position value<strong>{cash(totals.openValue)}</strong>
            </span>
          </div>
          <div>
            <Clock size={20} />
            <span>
              Reserved for orders<strong>{cash(totals.reserved)}</strong>
            </span>
          </div>
          <div>
            <CheckCircle size={20} />
            <span>
              Ready to claim
              <strong className="lime-text">{cash(totals.claimable)}</strong>
            </span>
          </div>
        </div>
      </div>
      {totals.claimable > 0 && (
        <div className="claim-banner">
          <span>
            <CheckCircle size={22} />
            Your winning rounds are settled. {cash(totals.claimable)} is ready.
          </span>
          <button
            className="button primary"
            onClick={() =>
              state.positions
                .filter((p) => p.status === "won" && !p.claimed)
                .forEach((p) => dispatch({ type: "claim", id: p.id }))
            }
          >
            Claim all <ArrowRight size={16} />
          </button>
        </div>
      )}
      <section className="panel portfolio-table">
        <div className="account-panel-tabs">
          <div>
            {(["open", "settled", "orders"] as const).map((value) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
              >
                {value === "open"
                  ? "Open positions"
                  : value === "settled"
                    ? "Settled positions"
                    : "Open orders"}
              </button>
            ))}
          </div>
          <span className="tiny-tag">USD</span>
        </div>
        {tab === "orders" ? (
          <OrdersTable
            state={state}
            orders={state.orders.filter((o) => o.status === "open")}
            dispatch={dispatch}
          />
        ) : (
          <PositionsTable
            state={state}
            positions={visible}
            dispatch={dispatch}
            onSell={onSell}
            onSelect={onSelect}
          />
        )}
      </section>
      <div className="portfolio-note">
        <InfoNote />
        Values use simulated executable bid prices before exit fees. Portfolio
        value includes unclaimed winnings. Two sample positions are included in
        a fresh account.
      </div>
    </div>
  );
}

function InfoNote() {
  return <span className="tiny-tag">FYI</span>;
}

export function History({
  state,
  dispatch,
}: {
  state: ExchangeState;
  dispatch: Dispatch<ExchangeAction>;
}) {
  const [filter, setFilter] = useState<"all" | "buy" | "sell" | "limit">("all");
  const orders = state.orders.filter(
    (o) => filter === "all" || o.side === filter || o.type === filter,
  );
  const exportCsv = () => {
    const header =
      "id,market,round_start_utc,side,outcome,type,shares,price_cents,fee_cents,total_cents,status";
    const lines = state.orders.map((o) =>
      [
        o.id,
        o.marketId,
        new Date(o.roundStart).toISOString(),
        o.side,
        o.outcome,
        o.type,
        o.quantity,
        o.priceCents,
        o.feeCents,
        o.totalCents,
        o.status,
      ].join(","),
    );
    const url = URL.createObjectURL(
      new Blob([[header, ...lines].join("\n")], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "zedge-paper-trades.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="history-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Your paper account</span>
          <h1>
            The full picture<span>.</span>
          </h1>
          <p>
            Every filled, open, cancelled, and expired order. All in one place.
          </p>
        </div>
        <button className="button secondary" onClick={exportCsv}>
          <DownloadSimple size={18} /> Export CSV
        </button>
      </div>
      <div className="history-stats">
        <span>
          <strong>{state.orders.length}</strong> total orders
        </span>
        <span>
          <strong>
            {state.orders.filter((o) => o.status === "filled").length}
          </strong>{" "}
          filled
        </span>
        <span>
          <strong>{cash(state.realizedCents)}</strong> realized return
        </span>
      </div>
      <section className="panel">
        <div className="account-panel-tabs">
          <div>
            {(["all", "buy", "sell", "limit"] as const).map((value) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "All orders"
                  : value === "buy"
                    ? "Buys"
                    : value === "sell"
                      ? "Sells"
                      : "Limit orders"}
              </button>
            ))}
          </div>
        </div>
        <OrdersTable state={state} orders={orders} dispatch={dispatch} />
      </section>
    </div>
  );
}
