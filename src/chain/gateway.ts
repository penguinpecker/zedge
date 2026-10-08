import { createPublicClient, erc20Abi, formatUnits, isHash, parseAbi, type Address, type Hex, type Abi, type PublicClient } from "viem";
import { registryReadAbi, oracleReadAbi } from "./abi.ts";
import { streamsRegistryReadAbi } from "./streams-abi.ts";
import { verifyRegistryControl, verifyStreamsDeployment, type StreamsChainId, type StreamsManifest, type StreamsReader } from "./streams-manifest.ts";
import { parseOrderbookManifest, verifyOrderbook, type OrderbookManifest, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { BASE_RPC, NETWORKS, type NetworkId } from "./networks.ts";
import { parseManifest, verifyDeployment, type DeploymentManifest, type VerifiedDeployment } from "./manifest.ts";
import { rpcTransport } from "./rpc.ts";

export function chainClient(chainId: NetworkId) {
  return createPublicClient({ chain: NETWORKS[chainId], transport: rpcTransport(NETWORKS[chainId].rpcUrls.default.http[0]) });
}
/** Base, for the vault and the user's USDC. `batch: false` for Alchemy's transfer index, which refuses batched requests. */
export function baseClient(batch = true) {
  return createPublicClient({ transport: rpcTransport(BASE_RPC, { batch }) });
}

export type ChainSnapshot = { chainId: NetworkId; blockNumber: bigint; blockHash: Hex; timestamp: bigint; checkedAt: number };
function fresh(timestamp: bigint) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 180) throw new Error("The network response is stale. Refresh before continuing.");
}
// Each network has one pinned endpoint, so its chain id is read once per page, not on every poll. A mismatch is never remembered.
const confirmedChains = new Set<number>();
async function requireChain(client: { getChainId(): Promise<number> }, chainId: number, message: string) {
  if (confirmedChains.has(chainId)) return;
  if (await client.getChainId() !== chainId) throw new Error(message);
  confirmedChains.add(chainId);
}
const settled = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === "rejected") throw result.reason;
  return result.value;
};
export async function readChain(chainId: NetworkId): Promise<ChainSnapshot> {
  const client = chainClient(chainId);
  await requireChain(client, chainId, "RPC returned a different network.");
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

/** Every read is pinned to one block of one chain. */
export function streamsReader(chain: PublicClient, blockNumber: bigint): StreamsReader {
  return {
    chainId: () => chain.getChainId(),
    code: (address) => chain.getCode({ address, blockNumber }),
    storage: (address, slot) => chain.getStorageAt({ address, slot, blockNumber }),
    read: (address, signature, args = []) => {
      const abi = parseAbi([`function ${signature}`] as string[]);
      const name = signature.slice(0, signature.indexOf("("));
      return chain.readContract({ address, abi, functionName: name, args, blockNumber });
    },
  };
}

export async function checkDeployment(manifest: DeploymentManifest, snapshot: ChainSnapshot): Promise<VerifiedDeployment | null> {
  if (manifest.chainId !== snapshot.chainId) throw new Error("Deployment network mismatch.");
  // Fail closed without reading any contract: an unavailable network and a planned release have nothing to verify.
  if (manifest.status !== "configured") return null;
  fresh(snapshot.timestamp);
  const client = chainClient(snapshot.chainId);
  let result: VerifiedDeployment;
  if (manifest.schemaVersion === 3) {
    const source = createPublicClient({ transport: rpcTransport(BASE_RPC) });
    const sourceBlock = await source.getBlock();
    if (sourceBlock.number === null || !sourceBlock.hash) throw new Error("Base oracle network is unavailable.");
    fresh(sourceBlock.timestamp);
    const readers: Record<StreamsChainId, StreamsReader> = { 8453: streamsReader(source, sourceBlock.number), 26514: streamsReader(client, snapshot.blockNumber) };
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

export async function loadOrderbook(signal?: AbortSignal): Promise<OrderbookManifest> {
  const response = await fetch("/deployments/26514-orderbook.json", { cache: "no-store", signal, credentials: "same-origin" });
  if (!response.ok) throw new Error("Order book information is unavailable.");
  const body = await response.text();
  if (body.length > 16_384) throw new Error("Order book information is invalid.");
  return parseOrderbookManifest(JSON.parse(body) as unknown);
}

/** The private order book at the snapshot's block (and the vault at Base's latest), against the already-verified streams release.
 * A planned release reads nothing. */
export async function checkOrderbook(manifest: OrderbookManifest, streams: StreamsManifest, snapshot: ChainSnapshot): Promise<VerifiedOrderbook | null> {
  if (manifest.status !== "configured" || snapshot.chainId !== 26514) return null;
  fresh(snapshot.timestamp);
  const client = chainClient(26514), base = baseClient();
  const baseBlock = await base.getBlock();
  if (baseBlock.number === null) throw new Error("Base network is unavailable.");
  fresh(baseBlock.timestamp);
  const result = await verifyOrderbook(manifest, streams, streamsReader(client, snapshot.blockNumber), streamsReader(base, baseBlock.number));
  const anchored = await client.getBlock({ blockNumber: snapshot.blockNumber });
  if (anchored.hash !== snapshot.blockHash) throw new Error("Horizen verification snapshot changed; retry.");
  return result;
}

export const PHASES = ["Not scheduled", "Scheduled", "Awaiting opening price", "Trading window", "Closed", "Awaiting resolution", "Resolved", "Voided", "Ready to void"] as const;
export type ObservationRead = { price: bigint; decimals: number; observedAt: bigint; validFrom: bigint | null; reportHash: Hex | null };
export type RoundState = {
  asset: number; duration: number; start: bigint; end: bigint; cutoff: bigint; openingDeadline: bigint;
  /** Streams registry: an opened round can be voided only after this time, and only while no closing price was delivered. Null for the Pyth registry. */
  voidableAfter: bigint | null;
  /** Pyth registry only: the last time a closing observation is accepted. Null for the Streams registry, which has no such deadline. */
  resolutionDeadline: bigint | null;
  openedAt: bigint; resolvedAt: bigint; outcome: number; opening: ObservationRead; closing: ObservationRead;
};
export type RoundRead = { roundId: Hex; phase: number; start: bigint; round: RoundState | null };
/** Captions under the two price boxes. Phase 7 is Voided; phase 8 can be voided now and, with no opening price, can never resolve.
 * While this round has not been read at the displayed block (a new block, or a failed read) its state is unknown, so nothing is promised.
 * `loading`: the market checks have not finished yet (first load or a refresh), so "not verified" is not a failure yet. */
export function priceCaptions(read: RoundRead | null, verified: boolean, failed = false, loading = false): { opening: string; closing: string } {
  const round = read?.round, phase = read?.phase;
  const opened = Boolean(round?.openedAt);
  const pending = !verified ? loading ? "Loading…" : "Unavailable" : failed && !read ? "Unavailable" : !read ? "Loading…" : phase === 0 ? "No scheduled round" : null;
  return {
    opening: opened ? "Verified opening observation" : pending ?? (phase === 7 || phase === 8 ? "No opening price recorded" : "Awaiting opening observation"),
    closing: round?.outcome === 3 ? "Round voided" : round?.resolvedAt ? "Verified closing observation"
      : pending ?? (phase === 8 ? opened ? "No closing price delivered" : "Can only be voided" : "Awaiting resolution"),
  };
}
/** How far back the round view can go (the chart's price history keeps 120 minutes); the next round is the furthest ahead. */
export const OLDEST_ROUND_OFFSET = -6;
export async function readRound(deployment: VerifiedDeployment, snapshot: ChainSnapshot, asset: 0 | 1, duration: 300 | 900, offset: number): Promise<RoundRead> {
  if (deployment.manifest.chainId !== snapshot.chainId || !Number.isInteger(offset) || offset < OLDEST_ROUND_OFFSET || offset > 1) throw new Error("Invalid round request.");
  fresh(snapshot.timestamp);
  const client = chainClient(snapshot.chainId);
  await requireChain(client, snapshot.chainId, "Round RPC network mismatch.");
  const address = deployment.manifest.contracts.registry.address, blockNumber = snapshot.blockNumber;
  const start = snapshot.timestamp / BigInt(duration) * BigInt(duration) + BigInt(offset * duration);
  // Reads that do not depend on each other go out together, as one batch each: the registry's control check with the round id, then the phase with the round.
  // The cached verification is older than this block, and the registry's owner can replace its code at any block.
  // An upgrade or ownership change is refused here, at the block the round is read at, and its mismatch is reported over any other read's failure.
  // roundIdFor and phase have the same read signature across both reviewed schemas.
  const [control, id] = await Promise.allSettled([
    deployment.manifest.schemaVersion === 3 ? verifyRegistryControl(deployment.manifest, streamsReader(client, blockNumber)) : null,
    client.readContract({ address, abi: registryReadAbi, functionName: "roundIdFor", args: [asset, duration, start], blockNumber }),
  ]);
  settled(control);
  const roundId = settled(id);
  // getRound reverts for a round that was never scheduled, so its answer is used only when the phase says the round exists.
  const roundState: Promise<RoundState> = deployment.manifest.schemaVersion === 3
    ? client.readContract({ address, abi: streamsRegistryReadAbi, functionName: "getRound", args: [roundId], blockNumber }).then((raw) => {
      const observation = (value: typeof raw.opening): ObservationRead => ({ price: value.price, decimals: value.decimals, observedAt: BigInt(value.observationsTimestamp), validFrom: BigInt(value.validFromTimestamp), reportHash: value.reportHash });
      return { ...raw, resolutionDeadline: null, opening: observation(raw.opening), closing: observation(raw.closing) };
    })
    : client.readContract({ address, abi: registryReadAbi, functionName: "getRound", args: [roundId], blockNumber }).then((raw) => {
      const observation = (value: typeof raw.opening): ObservationRead => ({ price: value.price, decimals: -value.exponent, observedAt: value.publishTime, validFrom: null, reportHash: null });
      return { ...raw, voidableAfter: null, opening: observation(raw.opening), closing: observation(raw.closing) };
    });
  const [phaseRead, roundRead] = await Promise.allSettled([client.readContract({ address, abi: registryReadAbi, functionName: "phase", args: [roundId], blockNumber }), roundState]);
  const phase = settled(phaseRead);
  if (phase > 8) throw new Error("Unsupported market phase.");
  let round: RoundState | null = null;
  if (phase !== 0) {
    round = settled(roundRead);
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

/** `network` is where the transaction was found: Base (8453) or one of the markets' networks. */
export type TransactionRead = { hash: Hex; status: "pending" | "success" | "reverted"; confirmations: bigint; from: Address; blockNumber: bigint | null; network: NetworkId | 8453 };
export async function readTransaction(chainId: NetworkId | 8453, hash: string): Promise<TransactionRead> {
  if (!isHash(hash)) throw new Error("Enter a 32-byte transaction hash.");
  const client = chainId === 8453 ? baseClient() : chainClient(chainId);
  await requireChain(client, chainId, "Network mismatch.");
  const tx = await client.getTransaction({ hash });
  if (tx.blockNumber === null) return { hash, status: "pending", confirmations: 0n, from: tx.from, blockNumber: null, network: chainId };
  const [receipt, head] = await Promise.all([client.getTransactionReceipt({ hash }), client.getBlockNumber()]);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!receipt.blockHash || receipt.blockHash !== block.hash || tx.blockHash !== receipt.blockHash) throw new Error("Transaction inclusion changed; retry.");
  return { hash, status: receipt.status, confirmations: head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n, from: tx.from, blockNumber: receipt.blockNumber, network: chainId };
}
/** Deposits and payouts are on Base, which is checked first; orders and account requests are on the markets' network. */
export async function findTransaction(network: NetworkId, hash: string): Promise<TransactionRead> {
  try { return await readTransaction(8453, hash); } catch { return readTransaction(network, hash); }
}

export function exactObservationPrice(price: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || price <= 0n) throw new Error("Invalid oracle price.");
  return formatUnits(price, decimals);
}
export function observationPrice(price: bigint, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < -18 || exponent > 0 || price <= 0n) throw new Error("Invalid oracle price.");
  const unit = 10n ** BigInt(-exponent);
  // Rounded half up to cents, the one display rule for prices; settlement compares the exact values.
  const cents = (price * 100n + unit / 2n) / unit;
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
