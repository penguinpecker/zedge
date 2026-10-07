import { defineChain } from "viem";
import { STREAMS_RPCS } from "./streams-manifest.ts";

// `vite --mode fork` only: the local Anvil forks of Horizen and Base. Vite replaces MODE at build time, so production keeps the public RPCs.
// A keyed gateway set at build time (VITE_HORIZEN_RPC_URL) avoids the public endpoint's per-address limits.
const HORIZEN_RPC = import.meta.env?.MODE === "fork" ? "http://127.0.0.1:38945"
  : /^https:\/\/26514\.rpc\.thirdweb\.com\/[0-9a-f]{32}$/.test(String(import.meta.env?.VITE_HORIZEN_RPC_URL ?? "")) ? String(import.meta.env.VITE_HORIZEN_RPC_URL) : "https://horizen.calderachain.xyz/http";
/** Base, where the vault takes deposits and pays withdrawals. */
export const BASE_RPC = import.meta.env?.MODE === "fork" ? "http://127.0.0.1:39301" : STREAMS_RPCS.base;

export const NETWORKS = {
  2651420: defineChain({
    id: 2651420,
    name: "Horizen testnet",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://horizen-testnet.rpc.caldera.xyz/http"] } },
    blockExplorers: { default: { name: "Horizen testnet explorer", url: "https://explorer-testnet.horizen.io" } },
    testnet: true,
  }),
  26514: defineChain({
    id: 26514,
    name: "Horizen",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [HORIZEN_RPC] } },
    blockExplorers: { default: { name: "Horizen explorer", url: "https://explorer.horizen.io" } },
  }),
} as const;

export type NetworkId = keyof typeof NETWORKS;
export const DEFAULT_NETWORK: NetworkId = 26514;

export function isNetworkId(value: unknown): value is NetworkId {
  return value === 2651420 || value === 26514;
}

/** A transaction on one of the markets' networks, or on Base (8453) for deposits and payouts. */
export function transactionExplorerUrl(network: NetworkId | 8453, hash: string): string {
  if (!isNetworkId(network) && network !== 8453) throw new Error("Unsupported explorer network.");
  if (typeof hash !== "string" || hash.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("Invalid transaction hash.");
  }
  // Keep the link origin independent of input, manifests and provider responses.
  const origin = network === 8453 ? "https://basescan.org" : network === 2651420
    ? "https://explorer-testnet.horizen.io"
    : "https://explorer.horizen.io";
  return new URL(`/tx/${encodeURIComponent(hash)}`, origin).href;
}

export function parseChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid wallet network.");
  const id = BigInt(value);
  if (id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid wallet network.");
  return Number(id);
}

export function parseAtomicAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid token precision.");
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || value.length > 100) throw new Error("Enter a positive amount without separators.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Too many decimal places.");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (result <= 0n || result > 2n ** 256n - 1n) throw new Error("Amount is outside the supported range.");
  return result;
}

export function publicError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === 4001) return "Request cancelled in your wallet. Nothing was submitted.";
  if (code === -32002) return "A wallet request is already waiting. Open your wallet to finish it.";
  if (code === 4902) return "This network is not configured in your wallet. Add it explicitly, then try again.";
  if (code === 4900 || code === 4901) return "Your wallet is disconnected. Reconnect to continue.";
  return "The connection could not complete. Try again or check your wallet.";
}
