/** The signed-in user's private records: resting orders, positions and history, read from their own decrypted receipts.
 * Nothing here is fetched from ZEDGE; everything comes from the chain and this tab's key. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ChartLine, Check } from "@phosphor-icons/react";
import { formatUnits } from "viem";
import { transactionExplorerUrl } from "./networks.ts";
import { holdingKind } from "./market-view.ts";
import { engineRound, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import type { Snapshot } from "./private/client.ts";
import type { House } from "./read-api.ts";
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

/** `event`: the Politics market's round (events-manifest.ts), listed under its own name and left out of the opening sync. */
export function PrivatePortfolio({ priv, book, chainNow, onDeposit, event, onEvent }: { priv: PrivateState; book: Book; chainNow: number; onDeposit?: () => void; event?: { id: string; cutoff: number } | null; onEvent?: () => void }) {
  const view = priv.snapshot?.view, unlocked = Boolean(priv.snapshot?.unlocked), { run } = priv;
  // A cached view (shown while the unlock syncs) is read-only: nothing is signed from it.
  const ready = unlocked && !priv.busy;
  // The settlement sweep pays out in the account's own name, and makers fill, which only the next receipt shows: a sync on opening,
  // when something could have changed and none was read in the last minute (each sync is a public request).
  const eventId = event?.id ?? null;
  useEffect(() => { if (unlocked) void run((a) => a.refresh(eventId ? [eventId] : [])); }, [unlocked, run, eventId]);
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
  // Simplification: Redeem waits until the closing price can be recorded (end + observation window), when a round is normally settled;
  // gate it on the rounds the results check reports as settled once the client exposes them.
  const settleAfter = 900 + book.application.engine.oracle.observationWindow;
  return <div className="chain-private-list">
    <dl className="chain-account-values"><div><dt>Private balance</dt><dd>{usdc(view.cash)}</dd></div><div><dt>Reserved for orders</dt><dd>{usdc(view.reservedCash)}</dd></div></dl>
    <div className="chain-book-columns"><span>Round</span><span>Up / Down</span><span>Action</span></div>
    {view.holdings.length === 0 ? <div className="chain-empty chain-book-empty"><h3>No positions</h3></div> : view.holdings.map((h) => {
      const start = starts.get(h.roundId), sets = Math.min(h.up, h.down);
      if (event && holdingKind(h.roundId, starts, event.id) === "event") return <div className="chain-book-row" key={h.roundId}>
        <span>US House 2026 · Yes / No</span>
        <span>{shares(h.up + h.reservedUp)} / {shares(h.down + h.reservedDown)}{h.reservedUp + h.reservedDown ? ` · ${shares(h.reservedUp + h.reservedDown)} offered` : ""}</span>
        <span>{sets > 0 && <button className="chain-text-button" disabled={!ready} onClick={() => void priv.run((a) => a.merge(event, sets))}>Merge</button>}
          {onEvent && <button className="chain-text-button" onClick={onEvent}>View</button>}</span>
      </div>;
      return <div className="chain-book-row" key={h.roundId}>
        {start === undefined ? <span>Earlier round</span> : <span title={`${clock(start, "UTC")}–${clock(start + 900, "UTC")} UTC`}>{clock(start)}–{clock(start + 900)} {zone(start)}</span>}
        <span>{shares(h.up + h.reservedUp)} / {shares(h.down + h.reservedDown)}{h.reservedUp + h.reservedDown ? ` · ${shares(h.reservedUp + h.reservedDown)} offered` : ""}</span>
        <span>{start !== undefined && sets > 0 && <button className="chain-text-button" disabled={!ready} onClick={() => void priv.run((a) => a.merge(start, sets))}>Merge</button>}
          {start !== undefined && start + settleAfter <= chainNow && <button className="chain-text-button" disabled={!ready} onClick={() => void priv.run((a) => a.redeem(start))}>Redeem</button>}</span>
      </div>;
    })}
    <ActionLine snapshot={priv.snapshot} names={["Unlock", "Sync", "Merge", "Redeem"]} />
    {error}
  </div>;
}

export function PrivateHistory({ priv, fromBlock }: { priv: PrivateState; fromBlock: bigint }) {
  const unlocked = Boolean(priv.snapshot?.unlocked), { run } = priv;
  const [from] = useState(fromBlock);
  // This read's own outcome, not the shared busy flag and error line: either the failure with Retry or the empty state, never both.
  const [status, setStatus] = useState<"loading" | "done" | "failed">("loading");
  // The read in flight: a newer one, closing the page or a new account (this panel remounts) stops it between waves.
  const job = useRef<{ stopped: boolean; older: boolean } | null>(null);
  const load = useCallback((older = false) => {
    if (job.current) job.current.stopped = true;
    const mine = job.current = { stopped: false, older };
    setStatus("loading");
    void run((a) => a.loadHistory(from, older, () => mine.stopped), { quiet: true }).then((ok) => { if (!mine.stopped) setStatus(ok ? "done" : "failed"); });
  }, [run, from]);
  // Each time the page opens: the latest page the first time, then only the blocks since (client.ts loadHistory).
  useEffect(() => {
    if (unlocked) load();
    return () => { if (job.current) job.current.stopped = true; };
  }, [unlocked, load]);
  const entries = priv.snapshot?.history ?? [], more = Boolean(priv.snapshot?.historyMore), hours = priv.snapshot?.historyHours ?? 0;
  return <div className="chain-private-list">
    <div className="chain-book-columns"><span>Block</span><span>Record</span><span>Transaction</span></div>
    {entries.map((e) => <div className="chain-book-row" key={e.requestId}>
      <span>{e.block.toString()}</span><span>{e.text}</span>
      <span><a href={transactionExplorerUrl(26514, e.txHash)} target="_blank" rel="noreferrer">View <ArrowSquareOut size={12} /></a></span>
    </div>)}
    {status === "failed" ? <p className="chain-error" role="alert">Couldn’t load your history. <button className="chain-text-button" onClick={() => load(job.current?.older)}>Retry</button></p>
      : status === "loading" ? <p className="chain-copy" role="status">Reading your records…</p>
      : entries.length === 0 && <div className="chain-empty chain-book-empty"><h3>{more ? `No records in the last ${hours} hours` : "No records in the last seven days"}</h3></div>}
    {more && status === "done" && <button className="button" onClick={() => load(true)}>Load older</button>}
  </div>;
}

/** The house's public quotes for one market: on each side its lowest sell (ask) and highest buy (bid). Display only. The event's
 * quotes have the same shape (read-api.ts EventHouse) and Yes/No names. */
export function HouseQuotes({ house, names = { up: "Up", down: "Down" } }: { house: Pick<House, "up" | "down"> | null; names?: { up: string; down: string } }) {
  const rows = house ? (["up", "down"] as const).flatMap((side) => (["ask", "bid"] as const).flatMap((kind) => { const q = house[side][kind]; return q ? [{ side, kind, ...q }] : []; })) : [];
  if (!rows.length) return <div className="chain-empty chain-book-empty"><ChartLine size={24} /><h3>No quotes right now</h3></div>;
  return rows.map((r) => <div className="chain-book-row" key={r.side + r.kind}><span><b className={r.side}>{names[r.side]}</b> {r.kind === "ask" ? "Ask" : "Bid"} {r.cents}¢</span><span>{shares(r.shares)}</span><span>{usdc(Math.floor(r.shares / 100) * r.cents)}</span></div>);
}
