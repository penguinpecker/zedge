/** The signed-in user's private records: resting orders, positions and history, read from their own decrypted receipts.
 * Nothing here is fetched from ZEDGE; everything comes from the chain and this tab's key. */
import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, Check } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import { parseAtomicAmount, transactionExplorerUrl } from "./networks.ts";
import { engineRound, LOT, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import type { Snapshot } from "./private/client.ts";
import type { PrivateState } from "./private/use-private.ts";

type Book = VerifiedOrderbook["manifest"];
export const usdc = (atoms: number | bigint) => `${formatUnits(BigInt(atoms), 6)} USDC`;
export const shares = (atoms: number) => formatUnits(BigInt(atoms), 6);
const clock = (seconds: number, timeZone?: string) => new Date(seconds * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
/** The viewer's zone, e.g. "GMT+5:30". */
const zone = (seconds: number) => new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(seconds * 1000).find((p) => p.type === "timeZoneName")?.value ?? "";

/** One status line for the latest of these actions: Signing, Sending, Submitted · tx, Waiting for the operator, then its result. */
export function ActionLine({ snapshot, names }: { snapshot: Snapshot | null; names: string[] }) {
  const a = snapshot?.actions.find((x) => names.includes(x.action));
  if (!a) return null;
  return <p className={a.phase === "failed" || a.phase === "refused" ? "chain-error" : "chain-copy"} role="status">{a.action}: {a.text}{a.tx && <> · <a href={transactionExplorerUrl(a.chain ?? 26514, a.tx)} target="_blank" rel="noreferrer">View transaction <ArrowSquareOut size={12} /></a></>}</p>;
}

const DEPOSIT_STAGES = ["Sent on Base", "Reached Horizen", "Credited"] as const;
/** The latest deposit in three stages, each set from its own chain signal (client.ts depositFromBase). `idle`: the stages show,
 * greyed out, before any deposit. The status text shows for as long as the deposit is not done, including after the page stops watching. */
export function DepositSteps({ snapshot, idle = false }: { snapshot: Snapshot | null; idle?: boolean }) {
  const a = snapshot?.actions.find((x) => x.action === "Deposit");
  if (!a && !idle) return null;
  const done = a?.stage ?? 0, broken = a?.phase === "failed" || a?.phase === "refused";
  return <div className="chain-deposit-steps" role="status">
    <ol>{DEPOSIT_STAGES.map((label, i) => <li key={label} className={i < done ? "done" : a && i === done && !a.final ? "now" : ""}>
      <span>{i < done ? <Check size={12} weight="bold" /> : i + 1}</span>{label}
      {i === 0 && a?.tx && a.chain === 8453 && <a href={transactionExplorerUrl(8453, a.tx)} target="_blank" rel="noreferrer" aria-label="View on Base"><ArrowSquareOut size={12} /></a>}</li>)}</ol>
    {a && (broken || !a.final) && <p className={broken ? "chain-error" : "chain-copy"}>{a.text}</p>}
  </div>;
}

export function PrivateOrders({ priv, book, roundStart }: { priv: PrivateState; book: Book; roundStart: number | null }) {
  const orders = priv.snapshot?.view?.orders ?? [];
  const roundId = roundStart === null ? null : engineRound(book, roundStart).id;
  return <div className="chain-private-list">
    <div className="chain-book-columns"><span>Order</span><span>Remaining</span><span>Action</span></div>
    {orders.length === 0 ? <div className="chain-empty chain-book-empty"><h3>No resting orders</h3></div> : orders.map((o) => <div className="chain-book-row" key={o.id}>
      <span>{o.side === "buy" ? "Buy" : "Sell"} {o.outcome === "up" ? "Up" : "Down"} · {o.price}¢</span>
      <span>{shares(o.remaining)} of {shares(o.original)}</span>
      <span><button className="chain-text-button" disabled={priv.busy} onClick={() => void priv.run((a) => a.cancelOrder(o.id))}>Cancel</button></span>
    </div>)}
    {roundStart !== null && orders.some((o) => o.roundId === roundId) && <button className="button" disabled={priv.busy} onClick={() => void priv.run((a) => a.cancelAll(roundStart))}>Cancel all</button>}
    <ActionLine snapshot={priv.snapshot} names={["Cancel order", "Cancel all", "Order result"]} />
    {priv.error && <p className="chain-error" role="alert">{priv.error}</p>}
  </div>;
}

export function PrivatePortfolio({ priv, book, chainNow, openRound, onDeposit }: { priv: PrivateState; book: Book; chainNow: number; openRound: number | null; onDeposit?: () => void }) {
  const [amount, setAmount] = useState("");
  const view = priv.snapshot?.view, unlocked = Boolean(priv.snapshot?.unlocked), { run } = priv;
  // The settlement sweep pays out in the account's own name, and makers fill, which only the next receipt shows: a sync on opening,
  // when something could have changed and none was read in the last minute (each sync is a public request).
  useEffect(() => { if (unlocked) void run((a) => a.refresh()); }, [unlocked, run]);
  const error = priv.error && <p className="chain-error" role="alert">{priv.error}</p>;
  // Unlocked with no view: the exchange opens the account on its first deposit.
  if (!view) return unlocked ? <div className="chain-private-list">
    <dl className="chain-account-values"><div><dt>Private balance</dt><dd>{usdc(0)}</dd></div><div><dt>Reserved for orders</dt><dd>{usdc(0)}</dd></div></dl>
    <div className="chain-empty chain-book-empty"><h3>No positions</h3>{onDeposit && <button className="button primary" onClick={onDeposit}>Deposit</button>}</div>
    {error}
  </div> : error || null;
  // Engine rounds are named by hashes; recompute them for the last day to show times.
  const starts = new Map<string, number>();
  for (let k = -96, base = Math.floor(chainNow / 900) * 900; k <= 2; k++) starts.set(engineRound(book, base + k * 900).id, base + k * 900);
  let quantity = 0;
  try { quantity = amount ? Number(parseAtomicAmount(amount, 6)) : 0; } catch { quantity = -1; }
  const mintable = quantity > 0 && quantity % LOT === 0 && quantity <= view.cash;
  // ponytail: Redeem waits until the closing price can be recorded (end + observation window), when a round is normally settled;
  // gate it on the rounds the results check reports as settled once the client exposes them.
  const settleAfter = 900 + book.application.engine.oracle.observationWindow;
  return <div className="chain-private-list">
    <dl className="chain-account-values"><div><dt>Private balance</dt><dd>{usdc(view.cash)}</dd></div><div><dt>Reserved for orders</dt><dd>{usdc(view.reservedCash)}</dd></div></dl>
    <div className="chain-book-columns"><span>Round</span><span>Up / Down</span><span>Action</span></div>
    {view.holdings.length === 0 ? <div className="chain-empty chain-book-empty"><h3>No positions</h3></div> : view.holdings.map((h) => {
      const start = starts.get(h.roundId), sets = Math.min(h.up, h.down);
      return <div className="chain-book-row" key={h.roundId}>
        {start === undefined ? <span>Earlier round</span> : <span title={`${clock(start, "UTC")}–${clock(start + 900, "UTC")} UTC`}>{clock(start)}–{clock(start + 900)} {zone(start)}</span>}
        <span>{shares(h.up + h.reservedUp)} / {shares(h.down + h.reservedDown)}{h.reservedUp + h.reservedDown ? ` · ${shares(h.reservedUp + h.reservedDown)} offered` : ""}</span>
        <span>{start !== undefined && sets > 0 && <button className="chain-text-button" disabled={priv.busy} onClick={() => void priv.run((a) => a.merge(start, sets))}>Merge</button>}
          {start !== undefined && start + settleAfter <= chainNow && <button className="chain-text-button" disabled={priv.busy} onClick={() => void priv.run((a) => a.redeem(start))}>Redeem</button>}</span>
      </div>;
    })}
    {openRound !== null && <form onSubmit={(event) => { event.preventDefault(); if (mintable) void priv.run((a) => a.mint(openRound, quantity)).then((ok) => ok && setAmount("")); }}>
      <label htmlFor="chain-mint-amount">Mint Up + Down sets for the open round · USDC</label>
      <input id="chain-mint-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" autoComplete="off" aria-invalid={quantity < 0 || (quantity > 0 && !mintable)} />
      <button className="button" type="submit" disabled={!mintable || priv.busy}>Mint</button>
    </form>}
    <ActionLine snapshot={priv.snapshot} names={["Sync", "Mint", "Merge", "Redeem"]} />
    {error}
  </div>;
}

export function PrivateHistory({ priv, fromBlock }: { priv: PrivateState; fromBlock: bigint }) {
  const unlocked = Boolean(priv.snapshot?.unlocked), { run } = priv;
  const [from] = useState(fromBlock);
  // This read's own outcome, not the shared busy flag and error line: either the failure with Retry or the empty state, never both.
  const [status, setStatus] = useState<"loading" | "done" | "failed">("loading");
  const load = useCallback(() => { setStatus("loading"); void run((a) => a.loadHistory(from)).then((ok) => setStatus(ok ? "done" : "failed")); }, [run, from]);
  // A rescan of the last seven days each time the page opens, not on every refresh.
  useEffect(() => { if (unlocked) load(); }, [unlocked, load]);
  const entries = priv.snapshot?.history ?? [];
  return <div className="chain-private-list">
    <div className="chain-book-columns"><span>Block</span><span>Record</span><span>Transaction</span></div>
    {entries.map((e) => <div className="chain-book-row" key={e.requestId}>
      <span>{e.block.toString()}</span><span>{e.text}</span>
      <span><a href={transactionExplorerUrl(26514, e.txHash)} target="_blank" rel="noreferrer">View <ArrowSquareOut size={12} /></a></span>
    </div>)}
    {status === "failed" ? <p className="chain-error" role="alert">Couldn’t load your history. <button className="chain-text-button" onClick={load}>Retry</button></p>
      : entries.length === 0 && (status === "loading" ? <p className="chain-copy" role="status">Reading your records…</p> : <div className="chain-empty chain-book-empty"><h3>No records in the last seven days</h3></div>)}
  </div>;
}
