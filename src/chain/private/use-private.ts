/** The signed-in user's private account in React. The client and the Vela SDK are loaded with import() only once a user
 * is signed in on a verified order book, so they are not part of the first chain-mode load. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicClient } from "viem";
import { baseClient, chainClient } from "../gateway.ts";
import { publicError } from "../networks.ts";
import { KEY_CHALLENGE_START, signable, type VerifiedOrderbook } from "../orderbook-manifest.ts";
import type { ChainWallet } from "../privy.tsx";
import { liveNow, readApi } from "../read-api.ts";
import type { PrivateAccount, Snapshot } from "./client.ts";

// A per-viewer convenience: the fingerprint of the key this browser derived before. Never relied on for safety.
const hints = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage blocked: the guard simply has no memory */ } },
};

export function usePrivate(wallet: ChainWallet, orderbook: VerifiedOrderbook | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  // Runs in flight: overlapping actions keep the page busy until the last one ends.
  const [running, setRunning] = useState(0);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const account = useRef<PrivateAccount | null>(null);
  const isPublic = useRef<(e: unknown) => boolean>(() => false);
  // The newest wallet functions, read at call time: a re-render must not recreate the account and drop its key.
  const latest = useRef(wallet);
  useEffect(() => { latest.current = wallet; });
  const manifest = orderbook?.manifest ?? null, address = wallet.signer?.address ?? null;
  const key = manifest && address ? `${manifest.release}:${manifest.relayer.facilitator}:${address}:${generation}` : "";
  const keyHint = manifest && address ? hints.get(`zedge:key:${manifest.application.id}:${address}`) : null;

  // `quiet`: no busy state and no shared error line, for work that reports in its own place (History's read; a deposit, whose
  // stages show on its own line and which can wait for minutes). A run of an account that has since been dropped changes nothing.
  const run = useCallback(async (work: (a: PrivateAccount) => Promise<unknown>, options: { quiet?: boolean } = {}) => {
    const a = account.current;
    if (!a) return false;
    const loud = !options.quiet;
    if (loud) { setRunning((n) => n + 1); setError(""); }
    try { await work(a); return true; }
    catch (e) { if (loud && account.current === a) setError(isPublic.current(e) ? (e as Error).message : publicError(e)); return false; }
    finally { if (loud && account.current === a) setRunning((n) => n - 1); }
  }, []);

  useEffect(() => {
    setSnapshot(null); setError(""); setRunning(0); account.current = null;
    if (!key || !manifest || !address) return;
    let live = true, created: PrivateAccount | null = null;
    // Only ZEDGE's own requests, Base USDC permits to its vault and the key challenge reach the wallet, which signs them without a prompt.
    const refused = () => new Error("ZEDGE refused to ask your wallet for this signature.");
    const signer = {
      address,
      signMessage: (message: string) => { const s = latest.current.signer; if (s?.address !== address) throw new Error("Your wallet changed."); if (!message.startsWith(KEY_CHALLENGE_START)) throw refused(); return s.signMessage(message); },
      signTypedData: (data: Parameters<NonNullable<ChainWallet["signer"]>["signTypedData"]>[0]) => { const s = latest.current.signer; if (s?.address !== address) throw new Error("Your wallet changed."); if (!signable(manifest, data)) throw refused(); return s.signTypedData(data); },
    };
    void import("./client.ts").then((m) => {
      if (!live) return;
      isPublic.current = (e) => e instanceof m.PublicError;
      // History, the cached Portfolio and round results read the read API first (display only); everything else reads the chain.
      const chain = m.indexedChain(m.viemChain(chainClient(26514) as unknown as PublicClient, manifest, baseClient() as unknown as PublicClient), { account: readApi().account, live: liveNow });
      created = new m.PrivateAccount(manifest, signer, chain,
        m.fetchRelay(manifest.relayer.path, () => latest.current.authHeaders()), { hints, onChange: (s) => { if (live) setSnapshot(s); } });
      account.current = created;
      setSnapshot(created.snapshot);
      void created.refreshFunds().catch(() => undefined);
      // One click less: the first account after sign-in unlocks itself (one silent signature, then a sync). After Lock it waits for a click.
      // Refused right after sign-in, it is tried once more (10-08: the wallet service once answered "Session is no longer active").
      if (generation === 0) void run((a) => a.unlock()).then((ok) => { if (!ok && live) setTimeout(() => { if (live) void run((a) => a.unlock()); }, 2_000); });
    }, () => { if (live) setError("Private features could not load. Refresh to try again."); });
    // The Base balance is shown live while signed in: USDC sent from elsewhere appears within 10 s. Not while the tab is hidden.
    const funds = setInterval(() => { if (!document.hidden) void created?.refreshFunds().catch(() => undefined); }, 10_000);
    // The key lives in this tab's memory only: drop it on sign-out, account change and tab close.
    const lock = () => created?.lock();
    window.addEventListener("pagehide", lock);
    return () => { live = false; clearInterval(funds); created?.lock(); account.current = null; window.removeEventListener("pagehide", lock); };
    // Keyed on the release, the relayer and the address on purpose: a re-render must not recreate the account and drop its key.
  }, [key]);

  // Round results: while the account holds shares, look every 2 s for the public result of any held round that ended (the page's
  // shared /v1/live read; the chain at most every 5 s when that fails or lags). One look at a time, none while the tab is hidden; the client
  // spaces out looks after a failed read.
  const unlocked = Boolean(snapshot?.unlocked), holds = Boolean(snapshot?.view?.holdings.length);
  useEffect(() => {
    if (!unlocked || !holds) return;
    let looking = false;
    const look = () => {
      const a = account.current;
      if (!a || looking || document.hidden) return;
      looking = true;
      void a.checkResults().catch(() => undefined).finally(() => { looking = false; });
    };
    const timer = setInterval(look, 2_000);
    return () => clearInterval(timer);
  }, [unlocked, holds]);

  // Lock drops the key now; the next unlock signs again. Signing out ends it: the next sign-in unlocks itself again.
  const lock = useCallback(() => setGeneration((g) => g + 1), []);
  useEffect(() => { if (!address) setGeneration(0); }, [address]);
  // A quiet re-read of the Base wallet balance: no busy state, no error line.
  const refreshFunds = useCallback(() => { void account.current?.refreshFunds().catch(() => undefined); }, []);
  return { snapshot, busy: running > 0, error, run, lock, refreshFunds, hasKeyHint: Boolean(keyHint) };
}
export type PrivateState = ReturnType<typeof usePrivate>;
