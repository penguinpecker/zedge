/** Fork builds only (`vite --mode fork`): a key and test tokens injected by the fork harness stand in for Privy.
 * A production build never includes this module; `npm run check` fails if FORK_MARKER appears in dist/. */
import { createElement, useMemo, useState, type Context, type ReactNode } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { normalizeSignature } from "../orderbook-manifest.ts";
import type { ChainWallet } from "../privy.tsx";

export const FORK_MARKER = "ZEDGE-FORK-ONLY";
type ForkWindow = Window & { __ZEDGE_FORK_KEY__?: string; __ZEDGE_FORK_TOKENS__?: { access: string; identity: string } };

export function ForkBoundary(context: Context<ChainWallet>) {
  return function Fork({ children }: { children: ReactNode }) {
    const [account, setAccount] = useState<ReturnType<typeof privateKeyToAccount> | null>(null);
    const [error, setError] = useState("");
    const value = useMemo<ChainWallet>(() => {
      const address = account?.address.toLowerCase() as Address | undefined;
      return {
        configured: true, pending: false, error, newUser: false,
        session: address ? { address, chainId: 26514, generation: 0 } : null,
        signer: account && address ? {
          address,
          signMessage: async (message) => normalizeSignature(await account.signMessage({ message })),
          signTypedData: async (data) => normalizeSignature(await account.signTypedData(data as Parameters<typeof account.signTypedData>[0])),
        } : null,
        connect() {
          const key = (window as ForkWindow).__ZEDGE_FORK_KEY__;
          if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) { setError(`${FORK_MARKER}: no test key injected.`); return; }
          setAccount(privateKeyToAccount(key as Hex));
        },
        disconnect: () => setAccount(null),
        async authHeaders() {
          const tokens = (window as ForkWindow).__ZEDGE_FORK_TOKENS__;
          if (!tokens) throw new Error(`${FORK_MARKER}: no test tokens injected.`);
          return { authorization: `Bearer ${tokens.access}`, "privy-id-token": tokens.identity };
        },
      };
    }, [account, error]);
    return createElement(context.Provider, { value }, children);
  };
}
