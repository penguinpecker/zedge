import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check, Copy, LockKey, Wallet, X } from "@phosphor-icons/react";
import { isHash } from "viem";
import { NETWORKS, parseAtomicAmount, transactionExplorerUrl, type NetworkId } from "./networks.ts";
import { readTransaction, type TransactionRead } from "./gateway.ts";
import { SIGN_IN_NOT_SET_UP, type ChainWallet } from "./privy.tsx";
import type { VerifiedOrderbook } from "./orderbook-manifest.ts";
import type { PrivateState } from "./private/use-private.ts";
import { ActionLine, usdc } from "./PrivatePanels.tsx";

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

export default function AccountDrawer({ view, onView, onClose, network, wallet, orderbook, orderbookReason, priv }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [funds, setFunds] = useState("");
  const [copied, setCopied] = useState(false);
  const snap = priv.snapshot, unlocked = Boolean(snap?.unlocked), cash = snap?.view?.cash ?? 0, live = Boolean(orderbook);
  const book = orderbook?.manifest, limits = book?.custody.vault.limits;
  const address = wallet.session?.address;
  // One click: the default deposit is all of the wallet's USDC up to the largest deposit; a typed amount replaces it.
  const fallback = limits && snap?.wallet ? (snap.wallet < BigInt(limits.maxDeposit) ? snap.wallet : BigInt(limits.maxDeposit)) : 0n;
  let depositAtoms = fallback, fundsError = "";
  if (funds) {
    try { depositAtoms = parseAtomicAmount(funds, 6); } catch { depositAtoms = 0n; fundsError = "Use a positive decimal amount without separators."; }
  }
  const outOfRange = limits && depositAtoms > 0n && (depositAtoms < BigInt(limits.minDeposit) || depositAtoms > BigInt(limits.maxDeposit) || (snap?.wallet !== null && snap?.wallet !== undefined && depositAtoms > snap.wallet));
  const withdrawAtoms = limits ? Math.min(cash, Number(limits.maxPayout)) : 0;
  const { refreshFunds } = priv;
  // The wallet balance changes when the user sends USDC from elsewhere: re-read it while Funds is open.
  useEffect(() => {
    if (view !== "funds" || !live) return;
    refreshFunds();
    const timer = setInterval(refreshFunds, 10_000);
    return () => clearInterval(timer);
  }, [view, live, refreshFunds]);
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
  const title = view === "account" ? "Your account" : view === "funds" ? "Deposit & withdraw" : "Security & recovery";
  const copy = () => { if (address) void navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); };
  return (
    <dialog ref={dialog} className="chain-drawer" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="chain-drawer-heading">
        <div><span className="eyebrow">ZEDGE · {network === 2651420 ? "TESTNET" : live ? "MAINNET" : "MAINNET READ-ONLY"}</span><h2 id={titleId}>{title}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close account drawer"><X size={22} /></button>
      </div>
      <nav className="chain-drawer-nav" aria-label="Account sections">
        {(["account", "funds", "security"] as const).map((item) => <button key={item} aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>{item === "account" ? "Account" : item === "funds" ? "Funds" : "Security"}</button>)}
      </nav>
      <div className="chain-drawer-content">
        {view === "account" && <ol className="chain-steps">
          <li><span className="chain-step-number">{wallet.session ? <Check /> : "1"}</span><div><h3>Sign in</h3>
            {wallet.session ? <><code>{wallet.session.address}</code><button className="chain-text-button" onClick={wallet.disconnect}>Sign out</button></>
              : <><p>Email, Google, X or Apple. A wallet is created for you: nothing to install, no network to pick, no gas to pay.</p><button className="button primary" disabled={!wallet.configured || wallet.pending} onClick={() => wallet.connect()}><Wallet />{wallet.pending ? "Loading…" : "Sign in"}</button>{!wallet.configured && <p>{SIGN_IN_NOT_SET_UP}</p>}</>}
          </div></li>
          <li><span className="chain-step-number">{unlocked ? <Check /> : "2"}</span><div><h3>Private account</h3>
            {!live ? <p>{orderbookReason || "Private accounts are not available yet."}</p>
              : unlocked ? <p>Unlocked in this tab. Key fingerprint <code>{snap?.fingerprint}</code></p>
              : <><p>Your private key is made in this browser when you sign in, and registered once.</p><button className="button" disabled={!wallet.session || !snap || priv.busy} onClick={() => void priv.run((a) => a.unlock())}><LockKey />{priv.busy ? "Unlocking…" : priv.hasKeyHint ? "Unlock" : "Set up private account"}</button></>}
            <ActionLine snapshot={snap} names={["Unlock", "Register key"]} />
            {live && !unlocked && priv.error && !snap?.actions.some((a) => a.text === priv.error) && <p className="chain-error" role="alert">{priv.error}</p>}
          </div></li>
          <li><span className="chain-step-number">{cash > 0 ? <Check /> : "3"}</span><div><h3>Add funds</h3><p>Deposit USDC on Base once; trade from your private balance; withdraw once.</p><button className="button" onClick={() => onView("funds")}>Deposit</button></div></li>
        </ol>}
        {view === "funds" && <>
          {live ? <div className="chain-callout"><LockKey size={22} /><div><strong>Network fees are paid by ZEDGE.</strong><p>Deposits and withdrawals, with their amounts and your address, are public on Base. Trades are not.</p></div></div>
            : <div className="chain-callout"><LockKey size={22} /><div><strong>Funding unavailable</strong><p>Deposits and withdrawals are closed.</p></div></div>}
          {address && live && <div className="chain-deposit-address"><div><h3>Your deposit address · Base</h3><code>{address}</code>
            <button className="chain-text-button" onClick={copy}><Copy size={13} /> {copied ? "Copied" : "Copy address"}</button>
            <p className="chain-copy">Send only USDC on Base to this address. Then deposit it below in one click.</p></div><AddressQr address={address} /></div>}
          <dl className="chain-account-values"><div><dt>In your wallet on Base</dt><dd>{!live || !snap || snap.wallet === null ? "Unavailable" : usdc(snap.wallet)}</dd></div><div><dt>Trading balance</dt><dd>{unlocked ? usdc(cash) : "Locked"}</dd></div></dl>
          {live && limits && <>
            <label htmlFor="chain-funds-amount">Deposit amount · USDC</label>
            <input id="chain-funds-amount" inputMode="decimal" value={funds} onChange={(event) => setFunds(event.target.value)} aria-invalid={Boolean(fundsError || outOfRange)} placeholder={fallback ? usdc(fallback).replace(" USDC", "") : "Enter amount"} autoComplete="off" />
            {fundsError && <p className="chain-error">{fundsError}</p>}
            <button className="button primary chain-full" disabled={!unlocked || priv.busy || depositAtoms === 0n || Boolean(outOfRange)}
              onClick={() => void priv.run((a) => a.depositFromBase(depositAtoms)).then((ok) => ok && setFunds(""))}>Deposit {depositAtoms ? usdc(depositAtoms) : ""}</button>
            <p className="chain-copy">From {usdc(BigInt(limits.minDeposit))} to {usdc(BigInt(limits.maxDeposit))} per deposit. Credited in about a minute.</p>
            <button className="button chain-full" disabled={!unlocked || priv.busy || withdrawAtoms <= 0} onClick={() => void priv.run((a) => a.withdraw())}>Withdraw {withdrawAtoms > 0 ? usdc(withdrawAtoms) : ""} to your wallet on Base</button>
            {cash > withdrawAtoms && <p className="chain-copy">At most {usdc(withdrawAtoms)} per withdrawal; withdraw again for the rest.</p>}
          </>}
          {!live && <button className="button primary chain-full" disabled>Deposits unavailable</button>}
          <ActionLine snapshot={snap} names={["Deposit", "Withdraw", "Payout"]} />
          {priv.error && <p className="chain-error" role="alert">{priv.error}</p>}
          <TransactionLookup key={network} network={network} />
        </>}
        {view === "security" && <>
          <div className="chain-callout"><LockKey size={23} /><div><strong>{unlocked ? "Private account unlocked" : live ? "Private account locked" : "Private account unavailable"}</strong></div></div>
          {book ? <>
            <h3>What is private</h3><p className="chain-copy">Your orders, balance, positions and fills are encrypted on chain and hidden from the public.</p>
            <h3>What stays public</h3><p className="chain-copy">Deposits and withdrawals on Base, with their amounts and your address, and the time of each request. Others can tell when you place or cancel an order, but not what it is. ZEDGE’s relayer (<code>{book.relayer.facilitator}</code>) appears on chain as the sender of your requests and deposits and pays their network fees.</p>
            <h3>What ZEDGE sees</h3><p className="chain-copy">ZEDGE runs the exchange’s operator (<code>{book.endpoint.operator}</code>), which processes requests in clear: ZEDGE can see everything, including your orders and balances. There is no hardware attestation. ZEDGE also quotes prices as the house.</p>
            <h3>Where your USDC is</h3><p className="chain-copy">Deposits are held by ZEDGE’s vault on Base (<code>{book.custody.vault.address}</code>). Its owner can replace its code, and withdrawals are paid when ZEDGE’s payout key (<code>{book.custody.vault.signer}</code>) approves them, so you rely on ZEDGE to pay out.</p>
            <h3>Keys and account access</h3><p className="chain-copy">Your private-data key is derived from a signature by your wallet each time you unlock. It stays in this tab’s memory and is never sent to ZEDGE. Privy’s servers can compute that signature and your other signatures, so Privy could re-create your private-data key and read your private records. Privy also knows which sign-in account owns your wallet and when you sign.</p>
            {unlocked && <><p className="chain-copy">Key fingerprint <code>{snap?.fingerprint}</code></p><button className="button" onClick={priv.lock}>Lock</button></>}
            <button className="button" disabled>Key rotation unavailable</button>
            <h3>Recovery and withdrawals</h3><p className="chain-copy">If ZEDGE’s operator or payout service stops, private balances cannot be withdrawn until it runs again.</p>
          </> : <>
            <h3>What stays public</h3><p className="chain-copy">On-chain transactions, including deposits and withdrawals, are public.</p>
            <h3>Keys and account access</h3><p className="chain-copy">Key setup and recovery are not available yet.</p>
            <button className="button" disabled>Key rotation unavailable</button>
            <h3>Recovery and withdrawals</h3><p className="chain-copy">No custody contract is connected. The public market contracts cannot hold or release your trading funds.</p>
          </>}
          <button className="button" disabled>Recovery unavailable</button>
          <h3>Your session</h3><p className="chain-copy">Sign out of ZEDGE here.</p>
          {wallet.session && <button className="button" onClick={wallet.disconnect}>Sign out</button>}
          <a className="chain-source-link" href="https://github.com/penguinpecker/zedge/tree/main/research" target="_blank" rel="noreferrer">Privacy details <ArrowSquareOut /></a>
        </>}
        {wallet.error && <p className="chain-error" role="alert">{wallet.error}</p>}
      </div>
    </dialog>
  );
}
