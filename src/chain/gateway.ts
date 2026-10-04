import { createPublicClient, erc20Abi, formatUnits, isHash, parseAbi, type Address, type Hex, type Abi } from "viem";
import { registryReadAbi, oracleReadAbi } from "./abi.ts";
import { streamsRegistryReadAbi } from "./streams-abi.ts";
import { STREAMS_RPCS, verifyStreamsDeployment, type StreamsChainId, type StreamsReader } from "./streams-manifest.ts";
import { NETWORKS, type NetworkId } from "./networks.ts";
import { parseManifest, verifyDeployment, type DeploymentManifest, type VerifiedDeployment } from "./manifest.ts";
import { rpcTransport } from "./rpc.ts";

export function chainClient(chainId: NetworkId) {
  return createPublicClient({ chain: NETWORKS[chainId], transport: rpcTransport(NETWORKS[chainId].rpcUrls.default.http[0]) });
}

export type ChainSnapshot = { chainId: NetworkId; blockNumber: bigint; blockHash: Hex; timestamp: bigint; checkedAt: number };
function fresh(timestamp: bigint) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 180) throw new Error("The network response is stale. Refresh before continuing.");
}
export async function readChain(chainId: NetworkId): Promise<ChainSnapshot> {
  const client = chainClient(chainId);
  if (await client.getChainId() !== chainId) throw new Error("RPC returned a different network.");
  const block = await client.getBlock();
  if (block.number === null || !block.hash) throw new Error("Waiting for a confirmed block.");
  fresh(block.timestamp);
  return { chainId, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, checkedAt: Date.now() };
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
  fresh(snapshot.timestamp);
  const client = chainClient(snapshot.chainId);
  let result: VerifiedDeployment;
  if (manifest.schemaVersion === 2) {
    const source = createPublicClient({ transport: rpcTransport(STREAMS_RPCS.base) });
    const sourceBlock = await source.getBlock();
    if (sourceBlock.number === null || !sourceBlock.hash) throw new Error("Base oracle network is unavailable.");
    fresh(sourceBlock.timestamp);
    const reader = (chain: typeof source | typeof client, blockNumber: bigint): StreamsReader => ({
      chainId: () => chain.getChainId(),
      code: (address) => chain.getCode({ address, blockNumber }),
      storage: (address, slot) => chain.getStorageAt({ address, slot, blockNumber }),
      read: (address, signature, args = []) => {
        const abi = parseAbi([`function ${signature}`] as string[]);
        const name = signature.slice(0, signature.indexOf("("));
        return chain.readContract({ address, abi, functionName: name, args, blockNumber });
      },
    });
    const readers: Record<StreamsChainId, StreamsReader> = { 8453: reader(source, sourceBlock.number), 26514: reader(client, snapshot.blockNumber) };
    result = await verifyStreamsDeployment(manifest, readers);
    const anchored = await source.getBlock({ blockNumber: sourceBlock.number });
    if (anchored.hash !== sourceBlock.hash) throw new Error("Base verification snapshot changed; retry.");
  } else {
    const getters = [...registryReadAbi, ...oracleReadAbi, ...erc20Abi].filter((entry) => entry.type === "function" && entry.inputs.length === 0);
    result = await verifyDeployment(manifest, {
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
  const anchored = await client.getBlock({ blockNumber: snapshot.blockNumber });
  if (anchored.hash !== snapshot.blockHash) throw new Error("Horizen verification snapshot changed; retry.");
  fresh(snapshot.timestamp);
  return result;
}

export const PHASES = ["Not scheduled", "Scheduled", "Awaiting opening price", "Trading window", "Closed", "Awaiting resolution", "Resolved", "Voided", "Ready to void"] as const;
export type ObservationRead = { price: bigint; decimals: number; observedAt: bigint; validFrom: bigint | null; reportHash: Hex | null };
export type RoundState = {
  asset: number; duration: number; start: bigint; end: bigint; cutoff: bigint; openingDeadline: bigint; resolutionDeadline: bigint;
  openedAt: bigint; resolvedAt: bigint; outcome: number; opening: ObservationRead; closing: ObservationRead;
};
export type RoundRead = { roundId: Hex; phase: number; start: bigint; round: RoundState | null };
export async function readRound(deployment: VerifiedDeployment, snapshot: ChainSnapshot, asset: 0 | 1, duration: 300 | 900, offset: number): Promise<RoundRead> {
  if (deployment.manifest.chainId !== snapshot.chainId || ![-1, 0, 1].includes(offset)) throw new Error("Invalid round request.");
  fresh(snapshot.timestamp);
  const client = chainClient(snapshot.chainId);
  if (await client.getChainId() !== snapshot.chainId) throw new Error("Round RPC network mismatch.");
  const address = deployment.manifest.contracts.registry.address;
  const start = snapshot.timestamp / BigInt(duration) * BigInt(duration) + BigInt(offset * duration);
  // roundIdFor and phase have the same read signature across both reviewed schemas.
  const roundId = await client.readContract({ address, abi: registryReadAbi, functionName: "roundIdFor", args: [asset, duration, start], blockNumber: snapshot.blockNumber });
  const phase = await client.readContract({ address, abi: registryReadAbi, functionName: "phase", args: [roundId], blockNumber: snapshot.blockNumber });
  if (phase > 8) throw new Error("Unsupported market phase.");
  let round: RoundState | null = null;
  if (phase !== 0) {
    if (deployment.manifest.schemaVersion === 2) {
      const raw = await client.readContract({ address, abi: streamsRegistryReadAbi, functionName: "getRound", args: [roundId], blockNumber: snapshot.blockNumber });
      const observation = (value: typeof raw.opening): ObservationRead => ({ price: value.price, decimals: value.decimals, observedAt: BigInt(value.observationsTimestamp), validFrom: BigInt(value.validFromTimestamp), reportHash: value.reportHash });
      round = { ...raw, opening: observation(raw.opening), closing: observation(raw.closing) };
    } else {
      const raw = await client.readContract({ address, abi: registryReadAbi, functionName: "getRound", args: [roundId], blockNumber: snapshot.blockNumber });
      const observation = (value: typeof raw.opening): ObservationRead => ({ price: value.price, decimals: -value.exponent, observedAt: value.publishTime, validFrom: null, reportHash: null });
      round = { ...raw, opening: observation(raw.opening), closing: observation(raw.closing) };
    }
    if (round.asset !== asset || round.duration !== duration || round.start !== start || round.end !== start + BigInt(duration)) throw new Error("Round identity did not match.");
  }
  const anchored = await client.getBlock({ blockNumber: snapshot.blockNumber });
  if (anchored.hash !== snapshot.blockHash) throw new Error("Round snapshot changed; retry.");
  fresh(snapshot.timestamp);
  return { roundId, phase, start, round };
}

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
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!receipt.blockHash || receipt.blockHash !== block.hash || tx.blockHash !== receipt.blockHash) throw new Error("Transaction inclusion changed; retry.");
  return { hash, status: receipt.status, confirmations: head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n, from: tx.from, blockNumber: receipt.blockNumber };
}

export function exactObservationPrice(price: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || price <= 0n) throw new Error("Invalid oracle price.");
  return formatUnits(price, decimals);
}
export function observationPrice(price: bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < -18 || exponent > 0 || price <= 0n) throw new Error("Invalid oracle price.");
  const unit = 10n ** BigInt(-exponent);
  const cents = price * 100n / unit;
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
