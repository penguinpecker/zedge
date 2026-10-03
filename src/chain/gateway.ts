import { createPublicClient, erc20Abi, http, isHash, type Address, type Hex, type Abi } from "viem";
import { registryReadAbi, oracleReadAbi } from "./abi.ts";
import { NETWORKS, type NetworkId } from "./networks.ts";
import { parseManifest, verifyDeployment, type DeploymentManifest, type VerifiedDeployment } from "./manifest.ts";

export function chainClient(chainId: NetworkId) {
  return createPublicClient({ chain: NETWORKS[chainId], transport: http(NETWORKS[chainId].rpcUrls.default.http[0], { timeout: 10_000, retryCount: 1 }) });
}

export type ChainSnapshot = { chainId: NetworkId; blockNumber: bigint; timestamp: bigint; checkedAt: number };

export async function readChain(chainId: NetworkId): Promise<ChainSnapshot> {
  const client = chainClient(chainId);
  if (await client.getChainId() !== chainId) throw new Error("RPC returned a different network.");
  const block = await client.getBlock();
  if (block.number === null) throw new Error("Waiting for a confirmed block.");
  if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 180) throw new Error("The network response is stale. Refresh before continuing.");
  return { chainId, blockNumber: block.number, timestamp: block.timestamp, checkedAt: Date.now() };
}

export async function loadManifest(chainId: NetworkId, signal?: AbortSignal): Promise<DeploymentManifest> {
  const response = await fetch(`/deployments/${chainId}.json`, { cache: "no-store", signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("Deployment information is unavailable.");
  const body = await response.text();
  if (body.length > 16_384) throw new Error("Deployment information is invalid.");
  return parseManifest(JSON.parse(body) as unknown, chainId);
}

export async function checkDeployment(manifest: DeploymentManifest, snapshot: ChainSnapshot): Promise<VerifiedDeployment | null> {
  if (manifest.chainId !== snapshot.chainId) throw new Error("Deployment network mismatch.");
  if (manifest.status === "unavailable") return null;
  const client = chainClient(snapshot.chainId);
  const getters = [...registryReadAbi, ...oracleReadAbi, ...erc20Abi].filter((entry) => entry.type === "function" && entry.inputs.length === 0);
  return verifyDeployment(manifest, {
    chainId: () => client.getChainId(),
    code: (address) => client.getCode({ address, blockNumber: snapshot.blockNumber }),
    storage: (address, slot) => client.getStorageAt({ address, slot, blockNumber: snapshot.blockNumber }),
    read: async (address, field) => {
      const definition = getters.find((entry) => entry.name === field);
      if (!definition) throw new Error("Unsupported contract identity check.");
      return client.readContract({ address, abi: [definition] as Abi, functionName: field, blockNumber: snapshot.blockNumber });
    },
  });
}

export const PHASES = ["Not scheduled", "Scheduled", "Awaiting opening price", "Trading window", "Closed", "Awaiting resolution", "Resolved", "Voided", "Ready to void"] as const;

export async function readRound(deployment: VerifiedDeployment, snapshot: ChainSnapshot, asset: 0 | 1, duration: 300 | 900, offset: number) {
  if (deployment.manifest.chainId !== snapshot.chainId || ![-1, 0, 1].includes(offset)) throw new Error("Invalid round request.");
  const client = chainClient(snapshot.chainId);
  const address = deployment.manifest.contracts.registry.address;
  const start = snapshot.timestamp / BigInt(duration) * BigInt(duration) + BigInt(offset * duration);
  const roundId = await client.readContract({ address, abi: registryReadAbi, functionName: "roundIdFor", args: [asset, duration, start], blockNumber: snapshot.blockNumber });
  const phase = await client.readContract({ address, abi: registryReadAbi, functionName: "phase", args: [roundId], blockNumber: snapshot.blockNumber });
  if (phase > 8) throw new Error("Unsupported market phase.");
  if (phase === 0) return { roundId, phase, start, round: null };
  const round = await client.readContract({ address, abi: registryReadAbi, functionName: "getRound", args: [roundId], blockNumber: snapshot.blockNumber });
  if (round.asset !== asset || round.duration !== duration || round.start !== start) throw new Error("Round identity did not match.");
  return { roundId, phase, start, round };
}

export type RoundRead = Awaited<ReturnType<typeof readRound>>;

export async function gasBalance(chainId: NetworkId, address: Address): Promise<bigint> {
  const client = chainClient(chainId);
  if (await client.getChainId() !== chainId) throw new Error("Network mismatch.");
  return client.getBalance({ address });
}

export type TransactionRead = { hash: Hex; status: "pending" | "success" | "reverted"; confirmations: bigint; from: Address; blockNumber: bigint | null };

export async function readTransaction(chainId: NetworkId, hash: string): Promise<TransactionRead> {
  if (!isHash(hash)) throw new Error("Enter a 32-byte transaction hash.");
  const client = chainClient(chainId);
  if (await client.getChainId() !== chainId) throw new Error("Network mismatch.");
  const tx = await client.getTransaction({ hash });
  if (tx.blockNumber === null) return { hash, status: "pending", confirmations: 0n, from: tx.from, blockNumber: null };
  const [receipt, head] = await Promise.all([client.getTransactionReceipt({ hash }), client.getBlockNumber()]);
  return { hash, status: receipt.status, confirmations: head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n, from: tx.from, blockNumber: receipt.blockNumber };
}

export function observationPrice(price: bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < -18 || exponent > 0 || price <= 0n) throw new Error("Invalid oracle price.");
  const unit = 10n ** BigInt(-exponent);
  const cents = price * 100n / unit;
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
