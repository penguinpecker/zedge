import {
  ArrowRight,
  CaretDown,
  Info,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { Dispatch, SetStateAction } from "react";
import {
  availableShares,
  cash,
  executionPrice,
  marketSnapshot,
  quoteOrder,
  sharesText,
} from "../lib/market";
import type {
  ExchangeState,
  MarketId,
  OrderInput,
  OrderType,
  Outcome,
  Side,
} from "../lib/market";
import { Direction } from "./Primitives";

export interface TicketForm {
  outcome: Outcome;
  side: Side;
  type: OrderType;
  amount: string;
  limit: string;
}
export const DEFAULT_FORM: TicketForm = {
  outcome: "up",
  side: "buy",
  type: "market",
  amount: "25",
  limit: "50",
};

export function TradeTicket({
  state,
  marketId,
  roundStart,
  form,
  setForm,
  onReview,
  onFunds,
  onLive,
}: {
  state: ExchangeState;
  marketId: MarketId;
  roundStart: number;
  form: TicketForm;
  setForm: Dispatch<SetStateAction<TicketForm>>;
  onReview: (input: OrderInput) => void;
  onFunds: () => void;
  onLive: () => void;
}) {
  const snapshot = marketSnapshot(marketId, state.now, roundStart);
  const input: OrderInput = {
    marketId,
    roundStart,
    outcome: form.outcome,
    side: form.side,
    type: form.type,
    value: Number(form.amount),
    limitPrice: Number(form.limit),
  };
  const quote = quoteOrder(input, state.now);
  const owned = availableShares(state, marketId, roundStart, form.outcome);
  const insufficient =
    form.side === "buy"
      ? quote.totalCents > state.cashCents
      : quote.quantity > owned;
  const error =
    quote.error ||
    (insufficient
      ? form.side === "buy"
        ? "Insufficient demo balance."
        : `You have ${sharesText(owned)} available ${form.outcome} shares.`
      : "");
  const profit = quote.payoutCents - quote.totalCents;
  const patch = (change: Partial<TicketForm>) =>
    setForm((previous) => ({ ...previous, ...change }));
  const switchSide = (side: Side) =>
    patch({
      side,
      amount: side === "buy" ? "25" : String(Math.min(10, owned)),
    });

  return (
    <aside
      id="trade-ticket"
      className="trade-ticket panel"
      aria-label="Trade ticket"
    >
      <div className="ticket-top">
        <span className="eyebrow">Make your move</span>
        <span className="tiny-tag">
          {snapshot.asset} · {snapshot.minutes}m
        </span>
      </div>
      <div className="ticket-controls">
        <div className="buy-sell" aria-label="Trade direction">
          {(["buy", "sell"] as Side[]).map((side) => (
            <button
              key={side}
              className={form.side === side ? "active" : ""}
              aria-pressed={form.side === side}
              onClick={() => switchSide(side)}
            >
              {side === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <div className="select-wrap">
          <select
            name="order-type"
            aria-label="Order type"
            value={form.type}
            onChange={(event) =>
              patch({ type: event.target.value as OrderType })
            }
          >
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
          <CaretDown size={13} />
        </div>
      </div>
      <div className="outcome-picker" aria-label="Choose an outcome">
        {(["up", "down"] as Outcome[]).map((outcome) => (
          <button
            key={outcome}
            className={`outcome-button ${outcome} ${form.outcome === outcome ? "selected" : ""}`}
            aria-pressed={form.outcome === outcome}
            onClick={() => patch({ outcome })}
          >
            <Direction outcome={outcome} />
            <strong>
              {executionPrice(
                marketId,
                outcome,
                form.side,
                state.now,
                roundStart,
              )}
              <span>¢</span>
            </strong>
          </button>
        ))}
      </div>
      {!snapshot.tradable ? (
        <div className="round-closed">
          <Info size={24} />
          <h3>
            {snapshot.status === "resolved"
              ? "This round is settled."
              : snapshot.status === "upcoming"
                ? "A new round is on its way."
                : "This round is closing."}
          </h3>
          <p>
            {snapshot.status === "resolved"
              ? `${snapshot.delta >= 0 ? "Up" : "Down"} wins. Winning shares pay $1 each.`
              : "Orders close 5 seconds before the end. The next round opens automatically."}
          </p>
          <button className="button secondary" onClick={onLive}>
            Go to live round <ArrowRight />
          </button>
        </div>
      ) : (
        <>
          {form.type === "limit" && (
            <div className="limit-price">
              <label htmlFor="limit-price">
                Limit price <span className="muted">per share</span>
              </label>
              <div>
                <input
                  id="limit-price"
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={form.limit}
                  onChange={(event) => patch({ limit: event.target.value })}
                />
                <span>¢</span>
              </div>
            </div>
          )}
          <div className="amount-top">
            <label htmlFor="trade-amount">
              {form.side === "buy" ? "You pay" : "Shares to sell"}
            </label>
            {form.side === "buy" ? (
              <button className="balance-label" onClick={onFunds}>
                {cash(state.cashCents)} available <Plus size={12} />
              </button>
            ) : (
              <span className="balance-label">
                {sharesText(owned)} available
              </span>
            )}
          </div>
          <div
            className={`amount-input ${error && form.amount !== "" ? "invalid" : ""}`}
          >
            <span className="amount-symbol">
              {form.side === "buy" ? "$" : ""}
            </span>
            <input
              id="trade-amount"
              type="number"
              min="0"
              step={form.side === "buy" ? "0.01" : "0.001"}
              inputMode="decimal"
              value={form.amount}
              onChange={(event) => patch({ amount: event.target.value })}
              aria-describedby={error ? "amount-error" : "amount-hint"}
              aria-invalid={!!error}
            />
            <span className="amount-unit">
              {form.side === "buy" ? "USD" : "SHARES"}
            </span>
          </div>
          <div className="amount-presets">
            {form.side === "buy"
              ? [10, 25, 50, 100].map((amount) => (
                  <button
                    key={amount}
                    className={Number(form.amount) === amount ? "selected" : ""}
                    onClick={() => patch({ amount: String(amount) })}
                  >
                    ${amount}
                  </button>
                ))
              : [25, 50, 75].map((percentage) => (
                  <button
                    key={percentage}
                    onClick={() =>
                      patch({
                        amount: String(
                          Math.floor(((owned * percentage) / 100) * 1000) /
                            1000,
                        ),
                      })
                    }
                  >
                    {percentage}%
                  </button>
                ))}
            <button
              onClick={() =>
                patch({
                  amount: String(
                    form.side === "buy" ? state.cashCents / 100 : owned,
                  ),
                })
              }
            >
              Max
            </button>
          </div>
          {error && (
            <p className="input-error" id="amount-error">
              {error}
            </p>
          )}
          <div className="ticket-breakdown">
            <div>
              <span>
                {form.side === "buy" ? "Estimated shares" : "Sale price"}
              </span>
              <strong>
                {form.side === "buy"
                  ? sharesText(quote.quantity)
                  : quote.priceCents + "¢"}
              </strong>
            </div>
            <div>
              <span>
                Trading fee{" "}
                <span title="A flat 1% simulated fee, rounded up to the nearest cent.">
                  <Info size={12} />
                </span>
              </span>
              <strong>
                {cash(quote.feeCents)} <span className="muted">(1%)</span>
              </strong>
            </div>
            {form.type === "limit" && (
              <div>
                <span>Good until</span>
                <strong>Round closes</strong>
              </div>
            )}
          </div>
          <div className={`payout-preview ${form.outcome}`}>
            <div>
              <span>
                {form.side === "buy"
                  ? `If ${form.outcome === "up" ? "Up" : "Down"} wins`
                  : "You receive after fee"}
              </span>
              <strong>
                {cash(
                  form.side === "buy" ? quote.payoutCents : quote.totalCents,
                )}
              </strong>
            </div>
            {form.side === "buy" && (
              <span className="return-tag">
                {profit >= 0 ? "+" : ""}
                {cash(profit)}
                <small>potential profit</small>
              </span>
            )}
          </div>
          <button
            id="review-order"
            className={`button primary review-button ${form.outcome === "down" ? "coral" : ""}`}
            disabled={!!error || !snapshot.tradable}
            onClick={(event) => {
              event.currentTarget.focus();
              onReview(input);
            }}
          >
            {form.type === "limit"
              ? "Place limit order"
              : `${form.side === "buy" ? "Buy" : "Sell"} ${form.outcome === "up" ? "Up" : "Down"}`}
            <ArrowRight size={19} />
          </button>
          <p className="ticket-disclaimer" id="amount-hint">
            {form.side === "buy"
              ? `If ${form.outcome === "up" ? "Down" : "Up"} wins, this position pays $0.`
              : "Selling closes this portion of your position."}
            <br />
            {form.type === "limit"
              ? "Funds or shares are reserved until filled or cancelled."
              : "Review your order before confirming."}
          </p>
        </>
      )}
      <div className="ticket-footnote">
        <ShieldCheck size={15} /> Paper trading. No real funds.
      </div>
    </aside>
  );
}
