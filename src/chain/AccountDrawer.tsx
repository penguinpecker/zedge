import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowSquareOut, Copy, Wallet, X } from "@phosphor-icons/react";
import { isHash } from "viem";
import { NETWORKS, parseAtomicAmount, transactionExplorerUrl, type NetworkId } from "./networks.ts";
import { readTransaction, type TransactionRead } from "./gateway.ts";
import { SIGN_IN_NOT_SET_UP, type ChainWallet } from "./privy.tsx";
import type { VerifiedOrderbook } from "./orderbook-manifest.ts";
import type { PrivateState } from "./private/use-private.ts";
import { ActionLine, DepositSteps, usdc } from "./PrivatePanels.tsx";

export type DrawerView = "account" | "funds" | "security";
type Props = {
  view: DrawerView;
  onView: (view: DrawerView) => void;
  onClose: () => void;
  network: NetworkId;
  wallet: ChainWallet;
  orderbook: VerifiedOrderbook | null;
  /** Why private features are locked, when a check failed (not when they are simply not open yet). */
  orderbookReason: string;
  priv: PrivateState;
};

/** The user's Base deposit address as a QR code (drawn in this tab; the address never leaves it). */
function AddressQr({ address }: { address: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    void import("qrcode").then((q) => q.toDataURL(address, { margin: 1, width: 168, color: { dark: "#111410", light: "#ffffff" } })).then((url) => { if (live) setSrc(url); }, () => undefined);
    return () => { live = false; };
  }, [address]);
  return src ? <img className="chain-qr" src={src} width={168} height={168} alt="QR code of your deposit address" /> : null;
}

function TransactionLookup({ network }: { network: NetworkId }) {
  const [hash, setHash] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<TransactionRead | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setLoading(true);
      try {
        const next = await readTransaction(network, query);
        if (cancelled) return;
        setResult(next);
        setError("");
        if (next.status === "pending" || next.confirmations < 12n) timer = setTimeout(() => void read(), 8000);
      } catch {
        if (!cancelled) setError("Transaction not available on this network. Check the hash and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [network, query, attempt]);
  return (
    <details className="chain-details">
      <summary>Check a transaction</summary>
      <p>Track a transaction on {NETWORKS[network].name}.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        if (!isHash(hash)) { setError("Enter the full transaction hash, starting with 0x."); return; }
        setError(""); setQuery(hash); setAttempt((value) => value + 1);
      }}>
        <label htmlFor="chain-transaction">Transaction hash</label>
        <input id="chain-transaction" value={hash} onChange={(event) => setHash(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
        <button className="button" type="submit" disabled={loading || !hash}>Check transaction</button>
      </form>
      {loading && <p role="status">Checking the network…</p>}
      {error && <p className="chain-error" role="alert">{error}</p>}
      {result && <div className="chain-receipt" role="status">
        <strong>{result.status === "pending" ? "Pending on network" : result.status === "reverted" ? "Transaction reverted" : "Transaction included"}</strong>
        <span>{result.confirmations.toString()} confirmations · {NETWORKS[network].name}</span>
        <small>Transaction status only. Confirmations may change.</small>
        <a href={transactionExplorerUrl(network, result.hash)} target="_blank" rel="noreferrer">View on explorer <ArrowSquareOut /></a>
      </div>}
    </details>
  );
}

export default function AccountDrawer({ onClose, network, wallet, orderbook, orderbookReason, priv }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [funds, setFunds] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const snap = priv.snapshot, unlocked = Boolean(snap?.unlocked), cash = snap?.view?.cash ?? 0, live = Boolean(orderbook);
  const limits = orderbook?.manifest.custody.vault.limits;
  const address = wallet.session?.address;
  // One click: the default deposit is all of the wallet's USDC up to the largest deposit; a typed amount replaces it.
  const fallback = limits && snap?.wallet ? (snap.wallet < BigInt(limits.maxDeposit) ? snap.wallet : BigInt(limits.maxDeposit)) : 0n;
  let depositAtoms = fallback, fundsError = "";
  if (funds) {
    try { depositAtoms = parseAtomicAmount(funds, 6); } catch { depositAtoms = 0n; fundsError = "Enter an amount like 2.5"; }
  }
  const outOfRange = limits && depositAtoms > 0n && (depositAtoms < BigInt(limits.minDeposit) || depositAtoms > BigInt(limits.maxDeposit) || (snap?.wallet !== null && snap?.wallet !== undefined && depositAtoms > snap.wallet));
  const withdrawAtoms = limits ? Math.min(cash, Number(limits.maxPayout)) : 0;
  useLayoutEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !document.querySelector("dialog[open]")) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  const copy = () => { if (address) void navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  const setup = snap?.actions.find((a) => a.action === "Unlock" || a.action === "Register key");
  return (
    <dialog ref={dialog} className="chain-drawer chain-popup" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
      <div className="chain-drawer-heading">
        <h2 id={titleId}>{wallet.session ? "Wallet" : "Sign in"}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
      </div>
      <div className="chain-drawer-content">
        {!wallet.session ? <>
          <button className="button primary chain-full" disabled={!wallet.configured || wallet.pending} onClick={() => wallet.connect()}><Wallet />{wallet.pending ? "Loading…" : "Sign in with email or socials"}</button>
          {!wallet.configured && <p className="chain-copy">{SIGN_IN_NOT_SET_UP}</p>}
        </> : !live ? <p className="chain-copy">{orderbookReason || "Deposits open shortly."}</p> : <>
          <dl className="chain-account-values"><div><dt>On Base</dt><dd>{snap?.wallet == null ? "Checking…" : usdc(snap.wallet)}</dd></div><div><dt>Trading</dt><dd>{unlocked ? usdc(cash) : setup?.phase === "failed" ? "—" : "Setting up…"}</dd></div></dl>
          {address && <div className="chain-deposit-address"><div><h3>Send USDC on Base to</h3><code>{address}</code>
            <button className="chain-text-button" onClick={copy}><Copy size={13} /> {copied ? "Copied" : "Copy"}</button></div><AddressQr address={address} /></div>}
          {limits && <>
            <div className="chain-deposit-row">
              <input id="chain-funds-amount" aria-label="Deposit amount in USDC" inputMode="decimal" value={funds} onChange={(event) => setFunds(event.target.value)} aria-invalid={Boolean(fundsError || outOfRange)} placeholder={fallback ? usdc(fallback).replace(" USDC", "") : "Amount"} autoComplete="off" />
              <button className="button primary" disabled={!snap || sending || depositAtoms === 0n || Boolean(outOfRange)}
                onClick={() => { setSending(true); void priv.run((a) => a.depositFromBase(depositAtoms)).then((ok) => ok && setFunds("")).finally(() => setSending(false)); }}>{sending ? "Depositing…" : "Deposit"}</button>
            </div>
            {(fundsError || outOfRange) && <p className="chain-error">{fundsError || `${usdc(BigInt(limits.minDeposit))} to ${usdc(BigInt(limits.maxDeposit))}, up to your balance`}</p>}
            <DepositSteps snapshot={snap} />
            <button className="button chain-full" disabled={!unlocked || priv.busy || withdrawAtoms <= 0} onClick={() => void priv.run((a) => a.withdraw())}>Withdraw {withdrawAtoms > 0 ? usdc(withdrawAtoms) : ""}</button>
            <ActionLine snapshot={snap} names={["Withdraw", "Payout"]} />
          </>}
          {!unlocked && setup?.phase === "failed" && <p className="chain-error" role="alert">{setup.text} <button className="chain-text-button" disabled={priv.busy} onClick={() => void priv.run((a) => a.unlock())}>Retry</button></p>}
          {priv.error && !snap?.actions.some((a) => a.text === priv.error) && <p className="chain-error" role="alert">{priv.error}</p>}
          <div className="chain-popup-links">
            {unlocked && <button className="chain-text-button" onClick={priv.lock}>Lock</button>}
            <button className="chain-text-button" onClick={wallet.disconnect}>Sign out</button>
            <a className="chain-text-button" href="https://github.com/penguinpecker/zedge/tree/main/research" target="_blank" rel="noreferrer">How privacy works <ArrowSquareOut size={12} /></a>
          </div>
          <TransactionLookup key={network} network={network} />
        </>}
        {wallet.error && <p className="chain-error" role="alert">{wallet.error}</p>}
      </div>
    </dialog>
  );
}
