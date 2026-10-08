/** Sign-in for chain mode: Privy's popup (Google or X) with an embedded wallet for every user, when this build carries
 * a Privy app ID; without one, sign-in is closed and every private feature stays locked. ZEDGE's own signatures (its requests, the
 * Base deposit permit and the key challenge) are signed silently; a send out of the wallet is confirmed in Privy's window. The
 * relayer pays every network fee. */
import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react";
import { PrivyProvider, getIdentityToken, useLogin, usePrivy, useSignMessage, useSignTypedData, useWallets } from "@privy-io/react-auth";
import { defineChain, type Address } from "viem";
import { BASE_RPC, NETWORKS } from "./networks.ts";
import { normalizeSignature } from "./orderbook-manifest.ts";
import type { WalletSession } from "./wallet.ts";
import type { Signer, TypedData } from "./private/client.ts";

export type ChainWallet = {
  /** False when this build has no Privy app: sign-in fails closed. */
  configured: boolean;
  /** The embedded wallet, once signed in. Its address is also the user's Base deposit address. */
  session: WalletSession | null;
  /** True while Privy is still loading: Sign in buttons should be disabled until it is false. */
  pending: boolean;
  /** Why the last sign-in failed, in plain English; empty when it succeeded or the user closed the popup. */
  error: string;
  /** This session's sign-in created the account (Privy's first login): the wallet popup opens as the Deposit window. */
  newUser: boolean;
  connect(): void;
  disconnect(): void;
  signer: Signer | null;
  authHeaders(): Promise<Record<string, string>>;
};
export const SIGN_IN_NOT_SET_UP = "Sign-in is not set up for this site yet.";
const closed: ChainWallet = { configured: false, session: null, pending: false, error: "", newUser: false, connect() {}, disconnect() {}, signer: null, authHeaders: async () => ({}) };
const WalletContext = createContext<ChainWallet>(closed);
export const useChainWallet = () => useContext(WalletContext);

const APP_ID = typeof import.meta.env.VITE_PRIVY_APP_ID === "string" && /^[a-z0-9]{20,32}$/.test(import.meta.env.VITE_PRIVY_APP_ID) ? import.meta.env.VITE_PRIVY_APP_ID : "";
// `vite --mode fork` only. Vite replaces MODE at build time, so a production build drops the fork path and its module.
const FORK = import.meta.env.MODE === "fork";
const ForkBoundary = FORK ? lazy(() => import("./private/test-signer.ts").then((m) => ({ default: m.ForkBoundary(WalletContext) }))) : null;
// The site connects no Solana wallets. Passing an empty set stops Privy's "Solana wallet login enabled, but no Solana wallet
// connectors" console warning, which it prints whenever that login is on in the Privy dashboard (turning it off there is the full fix).
const NO_SOLANA_WALLETS = { onMount() {}, onUnmount() {}, get: () => [] };
const SIGN_IN_ERRORS: Record<string, string> = {
  exited_auth_flow: "", // the user closed the popup
  disallowed_login_method: "That sign-in option is off for this site. Use Google or X.",
  too_many_requests: "Too many sign-in attempts. Wait a minute and try again.",
};
const BASE = defineChain({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [BASE_RPC] } }, blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } } });

export function WalletBoundary({ children }: { children: ReactNode }) {
  if (ForkBoundary) return <Suspense fallback={null}><ForkBoundary>{children}</ForkBoundary></Suspense>;
  if (!APP_ID) return <WalletContext.Provider value={closed}>{children}</WalletContext.Provider>;
  return <PrivyProvider appId={APP_ID} config={{
    // Google and X only (owner decision 2026-10-07: email and Apple are off in the Privy dashboard). Every user gets an
    // embedded wallet, so there is nothing to install, switch or fund.
    loginMethods: ["google", "twitter"],
    // The site's charcoal and lime (chain.css --bg, --lime) and its logo. walletList keeps browser-extension wallets detected
    // but leaves out Coinbase, Base Account and WalletConnect, so Privy no longer loads the Coinbase SDK on every visit (its
    // "configured chains are not supported by Coinbase Smart Wallet" message and two HEAD requests to the page).
    appearance: { walletChainType: "ethereum-only", walletList: ["detected_ethereum_wallets"], theme: "#101311", accentColor: "#c7f86f", logo: "/favicon.svg" },
    externalWallets: { solana: { connectors: NO_SOLANA_WALLETS } },
    // No global `showWalletUIs: false`: it would silence every signature and transaction any code on the page asks for.
    embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
    defaultChain: NETWORKS[26514], supportedChains: [NETWORKS[26514], BASE],
  }}><PrivyBridge>{children}</PrivyBridge></PrivyProvider>;
}

/** Typed data as JSON for wallets: numbers as decimal strings, the chain ID as a number. */
export function jsonTypedData(data: TypedData) {
  const message = Object.fromEntries(Object.entries(data.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return { ...data, types: data.types as unknown as Record<string, { name: string; type: string }[]>, domain: { ...data.domain, chainId: Number(data.domain.chainId) }, message };
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState(false);
  // Memoized: Privy re-subscribes these callbacks whenever the object changes.
  const { login } = useLogin(useMemo(() => ({
    onComplete: ({ isNewUser }: { isNewUser: boolean }) => { setError(""); setNewUser(isNewUser); },
    onError: (code: string) => setError(SIGN_IN_ERRORS[code] ?? "Sign-in did not finish. Try again."),
  }), []));
  const { wallets, ready: walletsReady } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  // Not before Privy reports its wallets ready: a signature asked for earlier may be refused ("Session is no longer active").
  const embedded = authenticated && walletsReady ? wallets.find((w) => w.walletClientType === "privy") ?? null : null;
  const address = embedded?.address.toLowerCase() as Address | undefined;
  const value = useMemo<ChainWallet>(() => {
    // Silent: only ZEDGE's own signatures reach these calls (use-private.ts checks each one first).
    const silent = { uiOptions: { showWalletUIs: false }, address: embedded?.address };
    const signer: Signer | null = address ? {
      address,
      signMessage: async (message) => normalizeSignature((await signMessage({ message }, silent)).signature),
      signTypedData: async (data) => normalizeSignature((await signTypedData(jsonTypedData(data), silent)).signature),
      // Shown: the user reads what is sent and where in Privy's window, and confirms it there (use-private.ts lets only sends through).
      confirmTypedData: async (data, text) => normalizeSignature((await signTypedData(jsonTypedData(data), { uiOptions: { showWalletUIs: true, title: "Send USDC", description: text, buttonText: "Send" }, address: embedded?.address })).signature),
    } : null;
    return {
      configured: true, pending: !ready, error, newUser, signer,
      // The embedded wallet signs for any chain: the network step is always done.
      session: address ? { address, chainId: 26514, generation: 0 } : null,
      connect: () => { setError(""); login(); },
      disconnect: () => { setNewUser(false); void logout(); },
      async authHeaders(): Promise<Record<string, string>> {
        // The identity token is optional: Privy issues one only when the app turns it on, and the relayer then checks the wallet is linked.
        const [access, identity] = await Promise.all([getAccessToken(), getIdentityToken().catch(() => null)]);
        if (!access) throw new Error("Sign in again to continue.");
        // Headers, not cookies: no cross-site request can carry them.
        return identity ? { authorization: `Bearer ${access}`, "privy-id-token": identity } : { authorization: `Bearer ${access}` };
      },
    };
  }, [embedded, address, ready, error, newUser, login, logout, getAccessToken, signMessage, signTypedData]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
