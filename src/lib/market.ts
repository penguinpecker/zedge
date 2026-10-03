export type Asset = "BTC" | "ETH";
export type MarketId = "btc-5m" | "btc-15m" | "eth-5m" | "eth-15m";
export type Outcome = "up" | "down";
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface Market {
  id: MarketId;
  asset: Asset;
  name: string;
  minutes: 5 | 15;
}

export const MARKETS: Market[] = [
  { id: "btc-5m", asset: "BTC", name: "Bitcoin", minutes: 5 },
  { id: "btc-15m", asset: "BTC", name: "Bitcoin", minutes: 15 },
  { id: "eth-5m", asset: "ETH", name: "Ethereum", minutes: 5 },
  { id: "eth-15m", asset: "ETH", name: "Ethereum", minutes: 15 },
];

export const FEE_RATE = 0.01;
export const CLOSE_BUFFER = 5_000;
export const RESOLUTION_DELAY = 3_000;
export const STORAGE_KEY = "edge-paper-exchange-v1";
const floorShares = (n: number) => Math.floor((n + 1e-9) * 1000) / 1000;
const principalFor = (quantity: number, priceCents: number, side: Side) =>
  Math[side === "buy" ? "ceil" : "floor"](
    (Math.round(quantity * 1000) * priceCents) / 1000,
  );
const payoutFor = (quantity: number) =>
  Math.floor(Math.round(quantity * 1000) / 10);
export const marketById = (id: MarketId) =>
  MARKETS.find((market) => market.id === id)!;
export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export const cash = (cents: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(cents / 100);
export const price = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
export const sharesText = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 3 });
export const timeText = (time: number) =>
  new Date(time).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
export const countdown = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export function roundAt(id: MarketId, now: number, offset = 0) {
  const duration = marketById(id).minutes * 60_000;
  const start = Math.floor(now / duration) * duration + offset * duration;
  return { start, end: start + duration, duration };
}

// One deterministic reference feed per asset. Every timeframe, chart, and
// settlement reads the same function; no external price feed is implied.
export function spotAt(asset: Asset, timestamp: number) {
  const t = (timestamp / 1000) % 86_400;
  const phase = asset === "BTC" ? 0 : 2.1;
  const wave =
    Math.sin(t / 190 + phase) * 41 +
    Math.sin(t / 37 + phase) * 15 +
    Math.sin(t / 8.7) * 4 +
    Math.sin(t / 2.3) * 1.7;
  return (
    Math.round(
      ((asset === "BTC" ? 67_428 : 3_524) +
        wave * (asset === "BTC" ? 1 : 0.074)) *
        100,
    ) / 100
  );
}

export function marketSnapshot(
  id: MarketId,
  now: number,
  start = roundAt(id, now).start,
) {
  const market = marketById(id);
  const end = start + market.minutes * 60_000;
  const reference = spotAt(market.asset, start);
  const current = spotAt(market.asset, clamp(now, start, end));
  const remaining = Math.max(0, end - now);
  const delta = current - reference;
  const volatility =
    (market.asset === "BTC" ? 62 : 4.6) *
    Math.sqrt(Math.max(0.025, remaining / 300_000));
  const probability =
    now >= end
      ? delta >= 0
        ? 1
        : 0
      : clamp(0.5 + Math.tanh(delta / volatility) * 0.43, 0.05, 0.95);
  const up = Math.round(probability * 100);
  return {
    ...market,
    start,
    end,
    reference,
    current,
    delta,
    remaining,
    up,
    down: 100 - up,
    tradable: now >= start && now < end - CLOSE_BUFFER,
    status:
      now < start
        ? "upcoming"
        : now < end
          ? "live"
          : now < end + RESOLUTION_DELAY
            ? "resolving"
            : "resolved",
  };
}

export function executionPrice(
  id: MarketId,
  outcome: Outcome,
  side: Side,
  now: number,
  start = roundAt(id, now).start,
) {
  const snapshot = marketSnapshot(id, now, start);
  return clamp(snapshot[outcome] + (side === "buy" ? 1 : -1), 1, 99);
}

export interface OrderInput {
  marketId: MarketId;
  roundStart: number;
  outcome: Outcome;
  side: Side;
  type: OrderType;
  value: number; // buy: USD budget including fees; sell: share quantity
  limitPrice: number; // cents per share
}

export interface Quote {
  quantity: number;
  priceCents: number;
  principalCents: number;
  feeCents: number;
  totalCents: number;
  payoutCents: number;
  error?: string;
}

export function quoteOrder(input: OrderInput, now: number): Quote {
  const priceCents =
    input.type === "limit"
      ? input.limitPrice
      : executionPrice(
          input.marketId,
          input.outcome,
          input.side,
          now,
          input.roundStart,
        );
  const invalid =
    !Number.isFinite(input.value) ||
    input.value <= 0 ||
    !Number.isFinite(priceCents) ||
    priceCents < 1 ||
    priceCents > 99 ||
    !Number.isInteger(priceCents);
  if (invalid)
    return {
      quantity: 0,
      priceCents,
      principalCents: 0,
      feeCents: 0,
      totalCents: 0,
      payoutCents: 0,
      error: "Enter a valid amount and a price from 1¢ to 99¢.",
    };
  let quantity =
    input.side === "buy"
      ? floorShares(
          Math.floor(input.value * 100) / (priceCents * (1 + FEE_RATE)),
        )
      : floorShares(input.value);
  let principalCents = principalFor(quantity, priceCents, input.side);
  let feeCents = Math.ceil(principalCents / 100);
  // Account for cent-level fee rounding without ever exceeding a buy budget.
  if (
    input.side === "buy" &&
    principalCents + feeCents > Math.floor(input.value * 100)
  ) {
    quantity = floorShares(
      (Math.floor(input.value * 100) - feeCents) / priceCents,
    );
    principalCents = principalFor(quantity, priceCents, input.side);
    feeCents = Math.ceil(principalCents / 100);
  }
  const totalCents =
    input.side === "buy"
      ? principalCents + feeCents
      : principalCents - feeCents;
  return {
    quantity,
    priceCents,
    principalCents,
    feeCents,
    totalCents,
    payoutCents: payoutFor(quantity),
    ...(quantity < 0.001 || totalCents < 1
      ? { error: "Amount is too small. Increase it to continue." }
      : {}),
  };
}

export interface Order {
  id: string;
  marketId: MarketId;
  roundStart: number;
  roundEnd: number;
  outcome: Outcome;
  side: Side;
  type: OrderType;
  quantity: number;
  priceCents: number;
  feeCents: number;
  totalCents: number;
  reservedCents: number;
  createdAt: number;
  updatedAt: number;
  status: "open" | "filled" | "cancelled" | "expired";
}

export interface Position {
  id: string;
  marketId: MarketId;
  roundStart: number;
  roundEnd: number;
  outcome: Outcome;
  quantity: number;
  costCents: number;
  status: "open" | "won" | "lost" | "sold";
  claimed: boolean;
  finalPrice?: number;
  payoutCents: number;
}

export interface ExchangeState {
  version: 1;
  now: number;
  cashCents: number;
  depositedCents: number;
  realizedCents: number;
  orders: Order[];
  positions: Position[];
  favorites: MarketId[];
  speed: 1 | 5 | 15;
  paused: boolean;
  notice: {
    id: string;
    message: string;
    kind: "success" | "error" | "info";
  } | null;
}

export function emptyState(now = Date.now()): ExchangeState {
  return {
    version: 1,
    now,
    cashCents: 100_000,
    depositedCents: 100_000,
    realizedCents: 0,
    orders: [],
    positions: [],
    favorites: ["btc-5m"],
    speed: 1,
    paused: false,
    notice: null,
  };
}

export function heldShares(
  state: ExchangeState,
  marketId: MarketId,
  start: number,
  outcome: Outcome,
) {
  return state.positions
    .filter(
      (p) =>
        p.marketId === marketId &&
        p.roundStart === start &&
        p.outcome === outcome &&
        p.status === "open",
    )
    .reduce((sum, p) => sum + p.quantity, 0);
}

export function availableShares(
  state: ExchangeState,
  marketId: MarketId,
  start: number,
  outcome: Outcome,
) {
  const reserved = state.orders
    .filter(
      (order) =>
        order.status === "open" &&
        order.side === "sell" &&
        order.marketId === marketId &&
        order.roundStart === start &&
        order.outcome === outcome,
    )
    .reduce((sum, order) => sum + order.quantity, 0);
  return floorShares(
    Math.max(0, heldShares(state, marketId, start, outcome) - reserved),
  );
}

function notify(
  state: ExchangeState,
  message: string,
  kind: "success" | "error" | "info" = "success",
): ExchangeState {
  return {
    ...state,
    notice: {
      id: `${state.now}-${state.orders.length}-${message}`,
      message,
      kind,
    },
  };
}

function fillOrder(
  state: ExchangeState,
  order: Order,
  priceCents: number,
): ExchangeState {
  const principal = principalFor(order.quantity, priceCents, order.side);
  const fee = Math.ceil(principal / 100);
  const total = order.side === "buy" ? principal + fee : principal - fee;
  let next: ExchangeState = {
    ...state,
    positions: state.positions.map((p) => ({ ...p })),
    orders: state.orders.map((o) =>
      o.id === order.id
        ? {
            ...o,
            priceCents,
            feeCents: fee,
            totalCents: total,
            reservedCents: 0,
            status: "filled",
            updatedAt: state.now,
          }
        : o,
    ),
  };
  if (order.side === "buy") {
    next.cashCents += order.reservedCents - total;
    const existing = next.positions.find(
      (p) =>
        p.marketId === order.marketId &&
        p.roundStart === order.roundStart &&
        p.outcome === order.outcome &&
        p.status === "open",
    );
    if (existing) {
      existing.quantity =
        Math.round((existing.quantity + order.quantity) * 1000) / 1000;
      existing.costCents += total;
    } else {
      next.positions.push({
        id: `position-${order.id}`,
        marketId: order.marketId,
        roundStart: order.roundStart,
        roundEnd: order.roundEnd,
        outcome: order.outcome,
        quantity: order.quantity,
        costCents: total,
        status: "open",
        claimed: false,
        payoutCents: 0,
      });
    }
  } else {
    next.cashCents += total;
    let remaining = order.quantity;
    let costBasis = 0;
    for (const p of next.positions) {
      if (
        p.marketId !== order.marketId ||
        p.roundStart !== order.roundStart ||
        p.outcome !== order.outcome ||
        p.status !== "open"
      )
        continue;
      const sold = Math.min(remaining, p.quantity);
      const cost = Math.round((p.costCents * sold) / p.quantity);
      costBasis += cost;
      p.quantity = Math.round((p.quantity - sold) * 1000) / 1000;
      p.costCents -= cost;
      remaining = Math.round((remaining - sold) * 1000) / 1000;
      if (p.quantity <= 0) p.status = "sold";
      if (remaining <= 0) break;
    }
    next.realizedCents += total - costBasis;
  }
  return next;
}

export function submitOrder(
  state: ExchangeState,
  input: OrderInput,
  id: string,
): ExchangeState {
  const snapshot = marketSnapshot(input.marketId, state.now, input.roundStart);
  if (!snapshot.tradable)
    return notify(
      state,
      "This round is closed. Choose the live round to trade.",
      "error",
    );
  const quote = quoteOrder(input, state.now);
  if (quote.error) return notify(state, quote.error, "error");
  if (input.side === "buy" && quote.totalCents > state.cashCents)
    return notify(
      state,
      "Not enough demo funds. Add funds or reduce your amount.",
      "error",
    );
  if (
    input.side === "sell" &&
    quote.quantity >
      availableShares(state, input.marketId, input.roundStart, input.outcome)
  )
    return notify(
      state,
      "Not enough available shares. Check your open sell orders.",
      "error",
    );
  if (state.orders.some((o) => o.id === id)) return state;
  const order: Order = {
    id,
    marketId: input.marketId,
    roundStart: input.roundStart,
    roundEnd: snapshot.end,
    outcome: input.outcome,
    side: input.side,
    type: input.type,
    quantity: quote.quantity,
    priceCents: quote.priceCents,
    feeCents: quote.feeCents,
    totalCents: quote.totalCents,
    reservedCents: input.side === "buy" ? quote.totalCents : 0,
    createdAt: state.now,
    updatedAt: state.now,
    status: "open",
  };
  let next: ExchangeState = {
    ...state,
    cashCents: state.cashCents - order.reservedCents,
    orders: [order, ...state.orders],
  };
  const currentPrice = executionPrice(
    input.marketId,
    input.outcome,
    input.side,
    state.now,
    input.roundStart,
  );
  const matches =
    input.type === "market" ||
    (input.side === "buy"
      ? input.limitPrice >= currentPrice
      : input.limitPrice <= currentPrice);
  if (matches) {
    next = fillOrder(next, order, currentPrice);
    return notify(
      next,
      `${input.side === "buy" ? "Bought" : "Sold"} ${sharesText(quote.quantity)} ${input.outcome.toUpperCase()} shares. Paper trade filled.`,
    );
  }
  return notify(
    next,
    `Limit order placed at ${quote.priceCents}¢. ${input.side === "buy" ? cash(order.reservedCents) + " reserved" : sharesText(order.quantity) + " shares reserved"}.`,
  );
}

export function cancelOrder(
  state: ExchangeState,
  id: string,
  expired = false,
): ExchangeState {
  const order = state.orders.find((o) => o.id === id && o.status === "open");
  if (!order) return state;
  const next: ExchangeState = {
    ...state,
    cashCents: state.cashCents + order.reservedCents,
    orders: state.orders.map((o) =>
      o.id === id
        ? {
            ...o,
            reservedCents: 0,
            status: expired ? "expired" : "cancelled",
            updatedAt: state.now,
          }
        : o,
    ),
  };
  return expired
    ? next
    : notify(
        next,
        "Order cancelled. Reserved funds or shares are available again.",
      );
}

export function advanceState(state: ExchangeState, now: number): ExchangeState {
  if (!Number.isFinite(now) || now < state.now) return state;
  let next = { ...state, now };
  for (const order of next.orders.filter((o) => o.status === "open")) {
    if (now >= order.roundEnd - CLOSE_BUFFER) {
      next = cancelOrder(next, order.id, true);
      continue;
    }
    const current = executionPrice(
      order.marketId,
      order.outcome,
      order.side,
      now,
      order.roundStart,
    );
    if (
      order.side === "buy"
        ? current <= order.priceCents
        : current >= order.priceCents
    ) {
      next = notify(
        fillOrder(next, order, current),
        `Your ${marketById(order.marketId).asset} limit order filled at ${current}¢.`,
      );
    }
  }
  next.positions = next.positions.map((p) => {
    if (p.status !== "open" || now < p.roundEnd + RESOLUTION_DELAY) return p;
    const asset = marketById(p.marketId).asset;
    const opening = spotAt(asset, p.roundStart);
    const closing = spotAt(asset, p.roundEnd);
    const winner: Outcome = closing >= opening ? "up" : "down";
    const won = p.outcome === winner;
    const payoutCents = won ? payoutFor(p.quantity) : 0;
    next.realizedCents += payoutCents - p.costCents;
    return {
      ...p,
      status: won ? "won" : "lost",
      payoutCents,
      finalPrice: closing,
    };
  });
  return next;
}

export function claimPosition(state: ExchangeState, id: string): ExchangeState {
  const position = state.positions.find(
    (p) => p.id === id && p.status === "won" && !p.claimed,
  );
  if (!position) return state;
  return notify(
    {
      ...state,
      cashCents: state.cashCents + position.payoutCents,
      positions: state.positions.map((p) =>
        p.id === id ? { ...p, claimed: true } : p,
      ),
    },
    `${cash(position.payoutCents)} added to your demo balance.`,
  );
}

export function accountTotals(state: ExchangeState) {
  const reserved = state.orders
    .filter((o) => o.status === "open")
    .reduce((sum, o) => sum + o.reservedCents, 0);
  const openValue = state.positions
    .filter((p) => p.status === "open")
    .reduce((sum, p) => sum + positionValue(p, state.now), 0);
  const claimable = state.positions
    .filter((p) => p.status === "won" && !p.claimed)
    .reduce((sum, p) => sum + p.payoutCents, 0);
  const total = state.cashCents + reserved + openValue + claimable;
  return {
    reserved,
    openValue,
    claimable,
    total,
    pnl: total - state.depositedCents,
  };
}

export function positionValue(position: Position, now: number) {
  if (now >= position.roundEnd) {
    const asset = marketById(position.marketId).asset;
    const winner =
      spotAt(asset, position.roundEnd) >= spotAt(asset, position.roundStart)
        ? "up"
        : "down";
    return winner === position.outcome ? payoutFor(position.quantity) : 0;
  }
  return principalFor(
    position.quantity,
    executionPrice(
      position.marketId,
      position.outcome,
      "sell",
      now,
      position.roundStart,
    ),
    "sell",
  );
}

export function seededState() {
  // Start within a round so the initial screen has useful chart history.
  const now = Math.floor(Date.now() / 900_000) * 900_000 + 438_000;
  let state = emptyState(now);
  state = submitOrder(
    state,
    {
      marketId: "btc-5m",
      roundStart: roundAt("btc-5m", now).start,
      outcome: "up",
      side: "buy",
      type: "market",
      value: 35,
      limitPrice: 50,
    },
    "sample-btc",
  );
  state = submitOrder(
    state,
    {
      marketId: "eth-15m",
      roundStart: roundAt("eth-15m", now).start,
      outcome: "down",
      side: "buy",
      type: "market",
      value: 25,
      limitPrice: 50,
    },
    "sample-eth",
  );
  return { ...state, notice: null };
}

export type ExchangeAction =
  | { type: "tick"; elapsed: number }
  | { type: "submit"; input: OrderInput; id: string }
  | { type: "cancel"; id: string }
  | { type: "claim"; id: string }
  | { type: "deposit"; cents: number }
  | { type: "favorite"; id: MarketId }
  | { type: "speed"; speed: 1 | 5 | 15 }
  | { type: "pause" }
  | { type: "advance"; marketId: MarketId }
  | { type: "reset" };

export function exchangeReducer(
  state: ExchangeState,
  action: ExchangeAction,
): ExchangeState {
  switch (action.type) {
    case "tick":
      return state.paused
        ? state
        : advanceState(state, state.now + action.elapsed * state.speed);
    case "submit":
      return submitOrder(state, action.input, action.id);
    case "cancel":
      return cancelOrder(state, action.id);
    case "claim":
      return claimPosition(state, action.id);
    case "deposit":
      return Number.isSafeInteger(action.cents) &&
        action.cents >= 100 &&
        action.cents <= 1_000_000
        ? notify(
            {
              ...state,
              cashCents: state.cashCents + action.cents,
              depositedCents: state.depositedCents + action.cents,
            },
            `${cash(action.cents)} in demo funds added. You're ready.`,
          )
        : notify(state, "Choose an amount between $1 and $10,000.", "error");
    case "favorite":
      return {
        ...state,
        favorites: state.favorites.includes(action.id)
          ? state.favorites.filter((id) => id !== action.id)
          : [...state.favorites, action.id],
      };
    case "speed":
      return { ...state, speed: action.speed };
    case "pause":
      return { ...state, paused: !state.paused };
    case "advance":
      return advanceState(
        state,
        roundAt(action.marketId, state.now).end + RESOLUTION_DELAY,
      );
    case "reset":
      return notify(
        seededState(),
        "Demo account reset. A fresh $1,000 starting balance, including two sample positions.",
      );
  }
}

export function loadState(): ExchangeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const state = JSON.parse(raw) as ExchangeState;
      if (
        state.version === 1 &&
        Number.isFinite(state.now) &&
        Number.isSafeInteger(state.cashCents) &&
        state.cashCents >= 0 &&
        Number.isSafeInteger(state.depositedCents) &&
        Number.isSafeInteger(state.realizedCents) &&
        Array.isArray(state.orders) &&
        Array.isArray(state.positions) &&
        Array.isArray(state.favorites) &&
        [1, 5, 15].includes(state.speed)
      )
        return { ...state, notice: null };
    }
  } catch {
    /* Private browsing or an older save: start a fresh paper account. */
  }
  return seededState();
}
