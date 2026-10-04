import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check, LockKey, Wallet, X } from "@phosphor-icons/react";
import { formatEther, isHash } from "viem";
import { NETWORKS, parseAtomicAmount, transactionExplorerUrl, type NetworkId } from "./networks.ts";
import { readTransaction, type TransactionRead } from "./gateway.ts";
import type { WalletState } from "./wallet.ts";

export type DrawerView = "account" | "funds" | "order" | "security";
type Props = {
  view: DrawerView;
  onView: (view: DrawerView) => void;
  onClose: () => void;
  network: NetworkId;
  wallet: WalletState;
  gas: bigint | null;
  market: string;
  outcome: "Up" | "Down";
};

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

export default function AccountDrawer({ view, onView, onClose, network, wallet, gas, market, outcome }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [fundingTab, setFundingTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const sameNetwork = wallet.session?.chainId === network;
  let amountError = "";
  if (amount) {
    try { parseAtomicAmount(amount, 6); } catch { amountError = "Use a positive decimal amount without separators."; }
  }
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
  const title = view === "account" ? "Your account" : view === "funds" ? "Manage funds" : view === "order" ? "Review your prediction" : "Security & recovery";
  return (
    <dialog ref={dialog} className="chain-drawer" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="chain-drawer-heading">
        <div><span className="eyebrow">ZEDGE · {network === 2651420 ? "TESTNET" : "MAINNET READ-ONLY"}</span><h2 id={titleId}>{title}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close account drawer"><X size={22} /></button>
      </div>
      <nav className="chain-drawer-nav" aria-label="Account sections">
        {(["account", "funds", "security"] as const).map((item) => <button key={item} aria-current={view === item ? "page" : undefined} onClick={() => onView(item)}>{item === "account" ? "Setup" : item === "funds" ? "Funds" : "Security"}</button>)}
      </nav>
      <div className="chain-drawer-content">
        {view === "account" && <>
          <p className="chain-copy">Connect your wallet to get started.</p>
          <ol className="chain-steps">
            <li><span className="chain-step-number">{wallet.session ? <Check /> : "1"}</span><div><h3>Connect your wallet</h3>
              {wallet.session ? <><code>{wallet.session.address}</code><button className="chain-text-button" onClick={wallet.disconnect}>Disconnect from app</button></> : <><p>Choose an account in your wallet.</p><button className="button primary" disabled={!wallet.provider || wallet.pending} onClick={() => void wallet.connect()}><Wallet />{wallet.pending ? "Open your wallet…" : "Connect wallet"}</button>{!wallet.provider && <p>No wallet found. Open ZEDGE in a browser with a wallet.</p>}</>}
            </div></li>
            <li><span className="chain-step-number">{sameNetwork ? <Check /> : "2"}</span><div><h3>Select {NETWORKS[network].name}</h3>
              <p>{sameNetwork ? "You’re on the right network." : "Switch your wallet to this network."}</p>
              {wallet.session && !sameNetwork && <button className="button" disabled={wallet.pending} onClick={() => void wallet.switchNetwork(network)}>Switch network in wallet</button>}
              {wallet.session && <details className="chain-details"><summary>Add network to wallet</summary><p>Review these settings in your wallet.</p><button className="button" disabled={wallet.pending} onClick={() => void wallet.switchNetwork(network, true)}>Review network settings</button></details>}
              {sameNetwork && <p className="mono">Gas balance: {gas === null ? "Unavailable" : `${formatEther(gas)} ETH`}{network === 2651420 ? " · test funds" : ""}</p>}
            </div></li>
            <li><span className="chain-step-number">3</span><div><h3>Private account</h3><p>Private accounts are not available yet.</p><button className="button" disabled><LockKey />Unavailable</button></div></li>
          </ol>
        </>}
        {view === "funds" && <>
          <div className="chain-segment" aria-label="Funding action">{(["deposit", "withdraw"] as const).map((item) => <button key={item} aria-pressed={fundingTab === item} onClick={() => setFundingTab(item)}>{item === "deposit" ? "Deposit" : "Withdraw"}</button>)}</div>
          <div className="chain-callout"><LockKey size={22} /><div><strong>Funding unavailable</strong><p>Deposits and withdrawals are closed.</p></div></div>
          <dl className="chain-account-values"><div><dt>Private balance</dt><dd>Locked</dd></div><div><dt>Available to {fundingTab}</dt><dd>Unavailable</dd></div><div><dt>Network</dt><dd>{NETWORKS[network].name}</dd></div></dl>

          <button className="button primary chain-full" disabled>{fundingTab === "deposit" ? "Deposits unavailable" : "Withdrawals unavailable"}</button>
          <TransactionLookup key={network} network={network} />
        </>}
        {view === "order" && <>
          <div className="chain-order-review"><span>{market}</span><strong>Buy {outcome}</strong><p>Payout per share: 1 collateral unit if correct, 0 if incorrect, ½ if voided.</p></div>
          <label htmlFor="chain-order-amount">Amount · collateral</label>
          <input id="chain-order-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(amountError)} aria-describedby={amountError ? "chain-amount-help" : undefined} placeholder="Enter amount" autoComplete="off" />
          {amountError && <p id="chain-amount-help" className="chain-error">{amountError}</p>}
          <dl className="chain-account-values"><div><dt>Execution price</dt><dd>Unavailable</dd></div><div><dt>Shares / possible payout</dt><dd>Unavailable</dd></div><div><dt>Trading fees</dt><dd>Unavailable</dd></div><div><dt>Private balance</dt><dd>Locked</dd></div></dl>

          <button className="button primary chain-full" disabled>Trading unavailable</button>
          <button className="chain-text-button" onClick={() => onView("account")}>View account</button>
        </>}
        {view === "security" && <>
          <div className="chain-callout"><LockKey size={23} /><div><strong>Private account unavailable</strong></div></div>
          <h3>What stays public</h3><p className="chain-copy">On-chain transactions, including deposits and withdrawals, are public.</p>
          <h3>Keys and account access</h3><p className="chain-copy">Key setup and recovery are not available yet.</p>
          <button className="button" disabled>Key rotation unavailable</button>
          <h3>Recovery and withdrawals</h3><p className="chain-copy">No custody contract or claim facility is connected. The public market contracts cannot hold or release your trading funds.</p>
          <button className="button" disabled>Recovery unavailable</button>
          <h3>Your session</h3><p className="chain-copy">Disconnect from ZEDGE here. Manage saved permissions in your wallet.</p>
          {wallet.session && <button className="button" onClick={wallet.disconnect}>Disconnect from app</button>}
          <a className="chain-source-link" href="https://github.com/penguinpecker/zedge/tree/main/research" target="_blank" rel="noreferrer">Privacy details <ArrowSquareOut /></a>
        </>}
        {wallet.error && <p className="chain-error" role="alert">{wallet.error}</p>}
      </div>
    </dialog>
  );
}
