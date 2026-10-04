import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { isNetworkId, type NetworkId } from "./networks.ts";
import { parseStreamsManifest, type StreamsManifest } from "./streams-manifest.ts";

export type ContractPin = { address: Address; runtimeCodeHash: Hex };
export type UnavailableManifest = { schemaVersion: 1; chainId: NetworkId; status: "unavailable"; reason: string };
export type ConfiguredManifest = {
  schemaVersion: 1;
  chainId: NetworkId;
  status: "configured";
  release: string;
  rolePolicy: "immutable-no-admin";
  contracts: { registry: ContractPin; oracle: ContractPin; provider: ContractPin; collateral: ContractPin };
  parameters: { observationWindow: string; openingGrace: string; settlementGrace: string; cutoffBuffer: string; maxConfidenceBps: string; btcFeedId: Hex; ethFeedId: Hex; btcExponent: number; ethExponent: number; rulesHash: Hex; collateralDecimals: number };
};
export type DeploymentManifest = UnavailableManifest | ConfiguredManifest | StreamsManifest;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).some((key) => !expected.includes(key)) || expected.some((key) => !(key in value))) {
    throw new Error("Deployment manifest has missing or unsupported fields.");
  }
}

function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/.test(value)) throw new Error("Invalid deployment fingerprint.");
  return value.toLowerCase() as Hex;
}

function contractPin(value: unknown): ContractPin {
  const record = object(value, "contract pin");
  keys(record, ["address", "runtimeCodeHash"]);
  if (typeof record.address !== "string" || !isAddress(record.address) || /^0x0{40}$/i.test(record.address)) throw new Error("Invalid deployment address.");
  return { address: getAddress(record.address), runtimeCodeHash: hash(record.runtimeCodeHash) };
}

function integerString(value: unknown, max: bigint, zero = false): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || (!zero && value === "0") || BigInt(value) > max) throw new Error("Invalid deployment parameter.");
  return value;
}

export function parseManifest(value: unknown, expectedChain: NetworkId): DeploymentManifest {
  const record = object(value, "deployment manifest");
  if (record.schemaVersion === 2) return parseStreamsManifest(value, expectedChain);
  if (record.schemaVersion !== 1 || !isNetworkId(record.chainId) || record.chainId !== expectedChain) throw new Error("Deployment version or network does not match.");
  if (record.status === "unavailable") {
    keys(record, ["schemaVersion", "chainId", "status", "reason"]);
    if (typeof record.reason !== "string" || record.reason.length < 1 || record.reason.length > 300) throw new Error("Invalid deployment status.");
    return { schemaVersion: 1, chainId: expectedChain, status: "unavailable", reason: record.reason };
  }
  keys(record, ["schemaVersion", "chainId", "status", "release", "rolePolicy", "contracts", "parameters"]);
  if (record.status !== "configured" || typeof record.release !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(record.release) || record.rolePolicy !== "immutable-no-admin") throw new Error("Unsupported deployment policy.");
  const pins = object(record.contracts, "contracts");
  keys(pins, ["registry", "oracle", "provider", "collateral"]);
  const params = object(record.parameters, "parameters");
  keys(params, ["observationWindow", "openingGrace", "settlementGrace", "cutoffBuffer", "maxConfidenceBps", "btcFeedId", "ethFeedId", "btcExponent", "ethExponent", "rulesHash", "collateralDecimals"]);
  const contracts = { registry: contractPin(pins.registry), oracle: contractPin(pins.oracle), provider: contractPin(pins.provider), collateral: contractPin(pins.collateral) };
  if (new Set(Object.values(contracts).map((pin) => pin.address)).size !== 4) throw new Error("Deployment contract addresses must differ.");
  const parameters = {
    observationWindow: integerString(params.observationWindow, 60n, true),
    openingGrace: integerString(params.openingGrace, 2n ** 32n - 1n),
    settlementGrace: integerString(params.settlementGrace, 2n ** 32n - 1n),
    cutoffBuffer: integerString(params.cutoffBuffer, 299n),
    maxConfidenceBps: integerString(params.maxConfidenceBps, 10000n),
    btcFeedId: hash(params.btcFeedId), ethFeedId: hash(params.ethFeedId),
    btcExponent: Number(params.btcExponent), ethExponent: Number(params.ethExponent),
    rulesHash: hash(params.rulesHash), collateralDecimals: Number(params.collateralDecimals),
  };
  if (["btcExponent", "ethExponent"].some((key) => typeof params[key] !== "number" || !Number.isInteger(params[key]) || Number(params[key]) < -18 || Number(params[key]) > 0)
    || typeof params.collateralDecimals !== "number" || !Number.isInteger(params.collateralDecimals) || params.collateralDecimals < 0 || params.collateralDecimals > 18
    || BigInt(parameters.observationWindow) + BigInt(parameters.openingGrace) >= 300n - BigInt(parameters.cutoffBuffer)
    || BigInt(parameters.observationWindow) + BigInt(parameters.settlementGrace) > 86_400n) throw new Error("Invalid market rules.");
  if (parameters.btcFeedId === parameters.ethFeedId) throw new Error("Market price feeds must differ.");
  return { schemaVersion: 1, chainId: expectedChain, status: "configured", release: record.release, rolePolicy: "immutable-no-admin", contracts, parameters };
}

export interface DeploymentReader {
  chainId(): Promise<number>;
  code(address: Address): Promise<Hex | undefined>;
  storage(address: Address, slot: Hex): Promise<Hex | undefined>;
  read(address: Address, field: string): Promise<unknown>;
}

// EIP-1967 implementation and beacon slots. Other proxy patterns still require
// release review; empty standard slots do not prove external governance is safe.
export const PROXY_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
] as const satisfies readonly Hex[];

export type VerifiedDeployment = { manifest: ConfiguredManifest | StreamsManifest; verified: true };

// A manifest is trusted only as part of a reviewed app release. Matching hashes
// establish release identity, not a contract audit or a verified TEE deployment.
export async function verifyDeployment(manifest: ConfiguredManifest, reader: DeploymentReader): Promise<VerifiedDeployment> {
  if (await reader.chainId() !== manifest.chainId) throw new Error("RPC network does not match the deployment.");
  await Promise.all(Object.values(manifest.contracts).map(async (pin) => {
    const code = await reader.code(pin.address);
    if (!code || code === "0x" || keccak256(code).toLowerCase() !== pin.runtimeCodeHash) throw new Error("Deployed contract code does not match this release.");
    const slots = await Promise.all(PROXY_SLOTS.map((slot) => reader.storage(pin.address, slot)));
    if (slots.some((slot) => !slot || !/^0x0{64}$/i.test(slot))) throw new Error("Proxy dependencies need an explicit implementation and upgrade policy before use.");
  }));
  // Getter checks are defined alongside the registry ABI and validated in tests.
  const registry = manifest.contracts.registry.address;
  const expected: [Address, string, unknown][] = [
    [registry, "version", "zedge-round-registry-v1"],
    [registry, "oracle", manifest.contracts.oracle.address],
    [registry, "collateral", manifest.contracts.collateral.address],
    [registry, "deploymentChainId", BigInt(manifest.chainId)],
    [manifest.contracts.oracle.address, "version", "zedge-pyth-boundary-v1"],
    [manifest.contracts.oracle.address, "pyth", manifest.contracts.provider.address],
    [manifest.contracts.collateral.address, "decimals", manifest.parameters.collateralDecimals],
    ...Object.entries(manifest.parameters).filter(([key]) => key !== "collateralDecimals").map(([key, value]) => [registry, key,
      typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value] as [Address, string, unknown]),
  ];
  await Promise.all(expected.map(async ([address, field, value]) => {
    const actual = await reader.read(address, field);
    const comparable = (v: unknown) => typeof v === "string" ? v.toLowerCase() : typeof v === "number" ? BigInt(v) : v;
    if (comparable(actual) !== comparable(value)) throw new Error("Deployment bindings or policy do not match this release.");
  }));
  return { manifest, verified: true };
}

// No transaction path is enabled until the collateral, matching, enclave,
// oracle and recovery adapters have been implemented and verified together.
export function requireTradingReady(): never {
  throw new Error("Confidential trading is not connected. No transaction was submitted.");
}
