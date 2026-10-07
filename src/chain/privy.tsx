/** Sign-in for chain mode: Privy's popup (email, Google, X or Apple) with an embedded wallet for every user, when this build carries
 * a Privy app ID; without one, sign-in is closed and every private feature stays locked. ZEDGE's own signatures (its requests, the
 * Base deposit permit and the key challenge) are signed silently; the relayer pays every network fee. */
import { createContext, lazy, Suspense, useContext, useMemo, type ReactNode } from "react";
import { PrivyProvider, getIdentityToken, usePrivy, useSignMessage, useSignTypedData, useWallets } from "@privy-io/react-auth";
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
  pending: boolean;
  error: string;
  connect(): void;
  disconnect(): void;
  signer: Signer | null;
  authHeaders(): Promise<Record<string, string>>;
};
export const SIGN_IN_NOT_SET_UP = "Sign-in is not set up for this site yet.";
const closed: ChainWallet = { configured: false, session: null, pending: false, error: "", connect() {}, disconnect() {}, signer: null, authHeaders: async () => ({}) };
const WalletContext = createContext<ChainWallet>(closed);
export const useChainWallet = () => useContext(WalletContext);

const APP_ID = typeof import.meta.env.VITE_PRIVY_APP_ID === "string" && /^[a-z0-9]{20,32}$/.test(import.meta.env.VITE_PRIVY_APP_ID) ? import.meta.env.VITE_PRIVY_APP_ID : "";
// `vite --mode fork` only. Vite replaces MODE at build time, so a production build drops the fork path and its module.
const FORK = import.meta.env.MODE === "fork";
const ForkBoundary = FORK ? lazy(() => import("./private/test-signer.ts").then((m) => ({ default: m.ForkBoundary(WalletContext) }))) : null;
const BASE = defineChain({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [BASE_RPC] } }, blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } } });

export function WalletBoundary({ children }: { children: ReactNode }) {
  if (ForkBoundary) return <Suspense fallback={null}><ForkBoundary>{children}</ForkBoundary></Suspense>;
  if (!APP_ID) return <WalletContext.Provider value={closed}>{children}</WalletContext.Provider>;
  return <PrivyProvider appId={APP_ID} config={{
    // Socials only: every user gets an embedded wallet, so there is nothing to install, switch or fund.
    loginMethods: ["email", "google", "twitter", "apple"],
    appearance: { walletChainType: "ethereum-only", theme: "dark", accentColor: "#c7f86f" },
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
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const embedded = authenticated ? wallets.find((w) => w.walletClientType === "privy") ?? null : null;
  const address = embedded?.address.toLowerCase() as Address | undefined;
  const value = useMemo<ChainWallet>(() => {
    // Silent: only ZEDGE's own signatures reach these calls (use-private.ts checks each one first).
    const silent = { uiOptions: { showWalletUIs: false }, address: embedded?.address };
    const signer: Signer | null = address ? {
      address,
      signMessage: async (message) => normalizeSignature((await signMessage({ message }, silent)).signature),
      signTypedData: async (data) => normalizeSignature((await signTypedData(jsonTypedData(data), silent)).signature),
    } : null;
    return {
      configured: true, pending: !ready, error: "", signer,
      // The embedded wallet signs for any chain: the network step is always done.
      session: address ? { address, chainId: 26514, generation: 0 } : null,
      connect: () => login(),
      disconnect: () => void logout(),
      async authHeaders() {
        const [access, identity] = await Promise.all([getAccessToken(), getIdentityToken()]);
        if (!access || !identity) throw new Error("Sign in again to continue.");
        // Headers, not cookies: no cross-site request can carry them.
        return { authorization: `Bearer ${access}`, "privy-id-token": identity };
      },
    };
  }, [embedded, address, ready, login, logout, getAccessToken, signMessage, signTypedData]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
