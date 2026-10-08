import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowSquareOut, Copy, LockKey, LockKeyOpen, Wallet, X } from "@phosphor-icons/react";
import { formatUnits, isHash } from "viem";
import { NETWORKS, transactionExplorerUrl, type NetworkId } from "./networks.ts";
import { readTransaction, type TransactionRead } from "./gateway.ts";
import { depositAmount, sendForm } from "./deposit-amount.ts";
import { SIGN_IN_NOT_SET_UP, type ChainWallet } from "./privy.tsx";
import type { VerifiedOrderbook } from "./orderbook-manifest.ts";
import type { ActionState, Phase } from "./private/client.ts";
import type { PrivateState } from "./private/use-private.ts";
import { ActionLine, DepositSteps, usdc } from "./PrivatePanels.tsx";

/** "deposit": the onboarding Deposit window (right after sign-up, or for an account with nothing in it); the same popup, titled Deposit. */
export type DrawerView = "account" | "funds" | "security" | "deposit";
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
  /** Sign in through Privy: closes this popup (Privy's window cannot sit under it) and opens the wallet once the session exists. */
  onSignIn: () => void;
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

type LookupChain = NetworkId | 8453;
const chainName = (chain: LookupChain) => chain === 8453 ? "Base" : NETWORKS[chain].name;
function TransactionLookup({ network }: { network: NetworkId }) {
  const [hash, setHash] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<(TransactionRead & { chain: LookupChain }) | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!isHash(query)) return;
    let cancelled = false, found: LookupChain | null = null;
    let timer: ReturnType<typeof setTimeout>;
    // Base first (deposits and payouts), then Horizen (requests and trades); re-checks stay on the network that found it.
    const read = async () => {
      setLoading(true);
      for (const chain of found ? [found] : [8453, network] as const) {
        try {
          const next = await readTransaction(chain, query);
          if (cancelled) return;
          found = chain;
          setResult({ ...next, chain }); setError(""); setLoading(false);
          if (next.status === "pending" || next.confirmations < 12n) timer = setTimeout(() => void read(), 8000);
          return;
        } catch { /* not on this network, or unreadable: try the next */ }
      }
      if (!cancelled) { setError(`Transaction not found on Base or ${NETWORKS[network].name}. Check the hash and try again.`); setLoading(false); }
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [network, query, attempt]);
  return (
    <details className="chain-details">
      <summary>Check a transaction</summary>
      <p>Track a transaction on Base or {NETWORKS[network].name}.</p>
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
        <span>{result.confirmations.toString()} confirmations · {chainName(result.chain)}</span>
        <small>Transaction status only. Confirmations may change.</small>
        <a href={transactionExplorerUrl(result.chain, result.hash)} target="_blank" rel="noreferrer">View on explorer <ArrowSquareOut /></a>
      </div>}
    </details>
  );
}

/** A send out of the Base wallet to any address: the user confirms the destination and amount in the wallet's own window. */
function SendForm({ priv, own, vault, balance, onDone }: { priv: PrivateState; own: string; vault: string; balance: bigint | null; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <form className="chain-send" onSubmit={(event) => {
      event.preventDefault();
      const check = sendForm(to, amount, balance, own, vault);
      if ("error" in check) { setError(check.error); return; }
      setError(""); setSending(true);
      void priv.run((a) => a.sendFromBase(check.to, check.atoms), { quiet: true }).then((ok) => { if (ok) onDone(); }).finally(() => setSending(false));
    }}>
      <h3>Send USDC on Base</h3>
      <label htmlFor="chain-send-to">To address</label>
      <input id="chain-send-to" value={to} onChange={(event) => setTo(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} />
      <label htmlFor="chain-send-amount">Amount</label>
      <div className="chain-deposit-row">
        <input id="chain-send-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="USDC" autoComplete="off" />
        <button type="button" className="button" disabled={!balance} onClick={() => balance && setAmount(formatUnits(balance, 6))}>Max</button>
      </div>
      {error && <p className="chain-error" role="alert">{error}</p>}
      <button className="button primary chain-full" type="submit" disabled={sending}>{sending ? "Sending…" : "Send"}</button>
      <button type="button" className="chain-text-button" disabled={sending} onClick={onDone}>Cancel</button>
    </form>
  );
}

const SETUP_STEP: Partial<Record<Phase, string>> = { signing: "Signing", sending: "Sending", submitted: "Sent", waiting: "Waiting for the operator" };
/** Setup takes about a minute the first time and half that after a reload: which step it is on, and for how long. */
function SetupProgress({ actions }: { actions: ActionState[] }) {
  const [opened] = useState(Date.now);
  const [now, setNow] = useState(opened);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  // This attempt's steps, newest first: the setup actions since the last failed one.
  const steps = actions.filter((a) => a.action === "Unlock" || a.action === "Register key");
  const failed = steps.findIndex((a) => a.phase === "failed"), current = failed < 0 ? steps : steps.slice(0, failed);
  const since = Math.min(opened, ...current.map((a) => a.startedAt)), a = current[0];
  const step = a?.action === "Register key" ? "Registering your key" : SETUP_STEP[a?.phase ?? "signing"] ?? "Signing";
  return <p className="chain-copy" role="status">Setting up your account · {step}<span aria-hidden="true"> · {Math.max(0, Math.round((now - since) / 1000))} s</span></p>;
}

export default function AccountDrawer({ view, onClose, network, wallet, orderbook, orderbookReason, priv, onSignIn }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [funds, setFunds] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const snap = priv.snapshot, unlocked = Boolean(snap?.unlocked), cash = snap?.view?.cash ?? 0, live = Boolean(orderbook);
  const limits = orderbook?.manifest.custody.vault.limits, vault = orderbook?.manifest.custody.vault.address;
  const address = wallet.session?.address;
  // One click: the default deposit is all of the wallet's USDC up to the largest deposit; a typed amount replaces it.
  const deposit = limits ? depositAmount(funds, snap?.wallet ?? null, limits) : null;
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
  // Setting up: the account is loading, an Unlock or Register key is running, or an unlock is busy before its first step shows.
  // Otherwise a signed-in account that is not unlocked has failed (Retry) or was locked (Unlock).
  const settingUp = !unlocked && ((!snap && !priv.error) || Boolean(setup && !setup.final) || (priv.busy && !snap?.actions.some((a) => !a.final)));
  const failed = !unlocked && !settingUp && setup?.phase === "failed", locked = !unlocked && !settingUp && !failed;
  const unlock = () => void priv.run((a) => a.unlock());
  const depositing = Boolean(snap?.actions.some((a) => a.action === "Deposit"));
  // A deposit still on its way (this page may have stopped waiting): no second one until it lands.
  const moving = snap?.actions.find((a) => a.action === "Deposit")?.final === false;
  // Withdrawn or refunded USDC on Base: the automatic deposit leaves it; the user sends it on or moves it back (up to the largest deposit).
  const held = snap?.held ?? 0n, back = limits && held > BigInt(limits.maxDeposit) ? BigInt(limits.maxDeposit) : held;
  const paidOut = snap?.actions.find((a) => a.action === "Payout")?.phase === "done";
  // Privy's window cannot sit under this popup (it is in the top layer): the popup steps aside while the wallet asks to confirm a send.
  const confirming = snap?.actions.find((a) => a.action === "Send")?.phase === "signing";
  useEffect(() => {
    const element = dialog.current;
    if (confirming && element?.open) element.close();
    else if (!confirming && element && !element.open) element.showModal();
  }, [confirming]);
  return (
    <dialog ref={dialog} className="chain-drawer chain-popup" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
      <div className="chain-drawer-heading">
        <h2 id={titleId}>{wallet.session ? view === "deposit" ? "Deposit" : "Wallet" : "Sign in"}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
      </div>
      <div className="chain-drawer-content">
        {!wallet.session ? <>
          {/* Closed first (by onSignIn): the popup sits in the top layer, above Privy's sign-in window. */}
          <button className="button primary chain-full" disabled={!wallet.configured || wallet.pending} onClick={onSignIn}><Wallet />{wallet.pending ? "Loading…" : "Sign in with Google or X"}</button>
          {!wallet.configured && <p className="chain-copy">{SIGN_IN_NOT_SET_UP}</p>}
        </> : <>
          {!live ? <p className="chain-copy">{orderbookReason || "Deposits open shortly."}</p> : <>
            <dl className="chain-account-values"><div><dt>On Base</dt><dd>{snap?.wallet == null ? "Checking…" : usdc(snap.wallet)}</dd></div><div><dt>Trading</dt><dd>{unlocked ? usdc(cash) : settingUp ? "Setting up…" : failed ? "—" : <><LockKey size={12} /> Locked</>}</dd></div></dl>
            {settingUp && <SetupProgress actions={snap?.actions ?? []} />}
            {locked && <button className="button chain-full" disabled={!snap || priv.busy} onClick={unlock}><LockKeyOpen /> Unlock</button>}
            {address && <div className="chain-deposit-address"><div><h3>Send USDC on Base to</h3><code>{address}</code>
              <button className="chain-text-button" onClick={copy}><Copy size={13} /> {copied ? "Copied" : "Copy"}</button></div><AddressQr address={address} /></div>}
            {limits && deposit && <>
              {snap?.auto ? <>
                <p className="chain-copy">USDC sent here is added to your trading balance automatically while ZEDGE is open. Deposits start at {usdc(BigInt(limits.minDeposit))}.</p>
                <DepositSteps snapshot={snap} idle />
                {held > 0n && <div className="chain-held">
                  <p className="chain-copy">{usdc(held)} paid out to you stays on Base.</p>
                  <div>
                    <button className="button" disabled={sendOpen} onClick={() => setSendOpen(true)}>Send to another wallet</button>
                    <button className="button" disabled={!snap || sending || moving || back < BigInt(limits.minDeposit)}
                      onClick={() => { setSending(true); void priv.run((a) => a.depositFromBase(back), { quiet: true }).finally(() => setSending(false)); }}>{sending ? "Moving…" : "Move back to trading"}</button>
                  </div>
                </div>}
              </> : <>
                {!cash && !depositing && <p className="chain-copy">Send USDC on Base to this address, then press Deposit.</p>}
                <div className="chain-deposit-row">
                  <input id="chain-funds-amount" aria-label="Deposit amount in USDC" inputMode="decimal" value={funds} onChange={(event) => setFunds(event.target.value)} aria-invalid={Boolean(deposit.error)} placeholder={deposit.atoms ? usdc(deposit.atoms).replace(" USDC", "") : "Amount"} autoComplete="off" />
                  <button className="button primary" disabled={!snap || sending || moving || deposit.atoms === 0n}
                    onClick={() => { setSending(true); void priv.run((a) => a.depositFromBase(deposit.atoms), { quiet: true }).then((ok) => ok && setFunds("")).finally(() => setSending(false)); }}>{sending ? "Depositing…" : deposit.atoms ? `Deposit ${usdc(deposit.atoms)}` : "Deposit"}</button>
                </div>
                {deposit.error ? <p className="chain-error">{deposit.error === "format" ? "Enter an amount like 2.5" : `${usdc(BigInt(limits.minDeposit))} to ${usdc(BigInt(limits.maxDeposit))}, up to your balance`}</p>
                  : deposit.short && !funds && snap?.wallet != null && <p className="chain-copy">You have {usdc(snap.wallet)} on Base. Deposits start at {usdc(BigInt(limits.minDeposit))}.</p>}
                <DepositSteps snapshot={snap} idle />
              </>}
              {withdrawAtoms > 0 && <button className="button chain-full" disabled={!unlocked || priv.busy} onClick={() => void priv.run((a) => a.withdraw())}>Withdraw {usdc(withdrawAtoms)}</button>}
              <ActionLine snapshot={snap} names={["Withdraw", "Payout"]} />
              {paidOut && !held && !sendOpen && <button className="chain-text-button" onClick={() => setSendOpen(true)}>Send to another wallet</button>}
              {sendOpen && address && vault && <SendForm priv={priv} own={address} vault={vault} balance={snap?.wallet ?? null} onDone={() => setSendOpen(false)} />}
              <ActionLine snapshot={snap} names={["Send"]} />
            </>}
            {failed && <p className="chain-error" role="alert">{setup?.text} <button className="chain-text-button" disabled={priv.busy} onClick={unlock}>Retry</button></p>}
            {priv.error && !snap?.actions.some((a) => a.text === priv.error) && <p className="chain-error" role="alert">{priv.error}</p>}
          </>}
          <div className="chain-popup-links">
            {unlocked && <button className="chain-text-button" onClick={priv.lock}>Lock</button>}
            <button className="chain-text-button" onClick={() => { onClose(); wallet.disconnect(); }}>Sign out</button>
            <a className="chain-text-button" href="https://github.com/penguinpecker/zedge/tree/main/research" target="_blank" rel="noreferrer">How privacy works <ArrowSquareOut size={12} /></a>
          </div>
          {live && <TransactionLookup key={network} network={network} />}
        </>}
        {wallet.error && <p className="chain-error" role="alert">{wallet.error}</p>}
      </div>
    </dialog>
  );
}
