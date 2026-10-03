import { getAddress, isAddress, type Address } from "viem";
import { useEffect, useRef, useState } from "react";
import { NETWORKS, parseChainId, publicError, type NetworkId } from "./networks.ts";

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export type WalletSession = { address: Address; chainId: number; generation: number };

export function firstAccount(value: unknown): Address | null {
  if (!Array.isArray(value)) throw new Error("Invalid wallet response.");
  if (value.length === 0) return null;
  if (typeof value[0] !== "string" || !isAddress(value[0])) throw new Error("Invalid wallet address.");
  return getAddress(value[0]);
}

export function useWallet() {
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const operation = useRef(0);
  const enabled = useRef(false);

  useEffect(() => {
    const detect = () => {
      const injected = (window as Window & { ethereum?: WalletProvider }).ethereum;
      if (injected?.request) setProvider(injected);
    };
    detect();
    window.addEventListener("ethereum#initialized", detect);
    return () => window.removeEventListener("ethereum#initialized", detect);
  }, []);

  useEffect(() => {
    if (!provider) return;
    const injected = provider;
    enabled.current = false;
    ++operation.current;
    setSession(null);
    setPending(false);
    setError("");
    const changed = () => {
      const sequence = ++generation.current;
      setSession(null);
      setError("");
      if (!enabled.current) return;
      void Promise.all([
        injected.request({ method: "eth_accounts" }),
        injected.request({ method: "eth_chainId" }),
      ]).then(([accounts, chainId]) => {
        if (sequence !== generation.current || !enabled.current) return;
        const address = firstAccount(accounts);
        setSession(address ? { address, chainId: parseChainId(chainId), generation: sequence } : null);
      }).catch(() => {
        if (sequence === generation.current) setError("Wallet state changed. Connect again to continue.");
      });
    };
    const disconnected = () => {
      ++generation.current;
      ++operation.current;
      enabled.current = false;
      setSession(null);
      setPending(false);
      setError("Your wallet disconnected. Connect again to continue.");
    };
    injected.on?.("accountsChanged", changed);
    injected.on?.("chainChanged", changed);
    injected.on?.("disconnect", disconnected);
    return () => {
      ++generation.current;
      ++operation.current;
      enabled.current = false;
      injected.removeListener?.("accountsChanged", changed);
      injected.removeListener?.("chainChanged", changed);
      injected.removeListener?.("disconnect", disconnected);
    };
  }, [provider]);

  const connect = async () => {
    if (!provider || pending) return;
    const currentOperation = ++operation.current;
    setPending(true);
    setError("");
    enabled.current = true;
    try {
      await provider.request({ method: "eth_requestAccounts" });
      if (!enabled.current || currentOperation !== operation.current) return;
      const sequence = ++generation.current;
      const [accounts, chainId] = await Promise.all([
        provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
      ]);
      if (sequence !== generation.current || !enabled.current || currentOperation !== operation.current) return;
      const address = firstAccount(accounts);
      setSession(address ? { address, chainId: parseChainId(chainId), generation: sequence } : null);
      if (!address) setError("No account was selected in your wallet.");
    } catch (cause) {
      if (currentOperation === operation.current) setError(publicError(cause));
    } finally {
      if (currentOperation === operation.current) setPending(false);
    }
  };

  const switchNetwork = async (id: NetworkId, add = false) => {
    if (!provider || pending) return;
    const currentOperation = ++operation.current;
    setPending(true);
    setError("");
    const chain = NETWORKS[id];
    try {
      if (add) {
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: `0x${id.toString(16)}`, chainName: chain.name,
          nativeCurrency: chain.nativeCurrency, rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: [chain.blockExplorers.default.url],
        }] });
      } else {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${id.toString(16)}` }] });
      }
      if (!enabled.current || currentOperation !== operation.current) return;
      const sequence = ++generation.current;
      const [accounts, chainId] = await Promise.all([
        provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
      ]);
      if (sequence !== generation.current || !enabled.current || currentOperation !== operation.current) return;
      const address = firstAccount(accounts);
      const actualChain = parseChainId(chainId);
      setSession(address ? { address, chainId: actualChain, generation: sequence } : null);
      if (actualChain !== id) setError("Your wallet has not switched to the selected network yet.");
    } catch (cause) {
      if (currentOperation === operation.current) setError(publicError(cause));
    } finally {
      if (currentOperation === operation.current) setPending(false);
    }
  };

  const disconnect = () => {
    enabled.current = false;
    ++generation.current;
    ++operation.current;
    setSession(null);
    setPending(false);
    setError("");
  };
  return { provider, session, pending, error, connect, switchNetwork, disconnect };
}

export type WalletState = ReturnType<typeof useWallet>;
