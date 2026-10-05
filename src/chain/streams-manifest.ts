import { encodeAbiParameters, getAddress, hexToString, isAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

export const STREAMS_RPCS = { base: "https://base-rpc.publicnode.com", horizen: "https://horizen.calderachain.xyz/http" } as const;
export const STREAMS_DEPENDENCIES = {
  verifier: 8453, feeManager: 8453, donVerifier: 8453, sourceMessenger: 8453,
  sourceMessengerImplementation: 8453, addressManager: 8453, sourceProxyAdmin: 8453,
  portal: 8453, portalImplementation: 8453, destinationMessenger: 26514,
  destinationMessengerImplementation: 26514, destinationProxyAdmin: 26514,
  collateral: 26514, collateralImplementation: 26514, collateralAdmin: 26514,
  destinationProxyAdminImplementation: 26514,
} as const;
export type StreamsChainId = 8453 | 26514;
export type StreamsPin = { chainId: StreamsChainId; address: Address; runtimeCodeHash: Hex };
/** The registry is an ERC-1967 proxy: its own code, the implementation behind it and the owner who can replace that implementation. */
export type StreamsRegistryPin = StreamsPin & { implementation: Address; implementationCodeHash: Hex; owner: Address };
type DependencyName = keyof typeof STREAMS_DEPENDENCIES;
const ROLE_POLICY = "registry-owner-upgradeable-route-immutable";
/** Shown while the release is planned. No contract is read in that state. */
export const STREAMS_PLANNED_REASON = "The round registry for this network has not been recorded as deployed, so no market data is shown.";
/** A check that completed and did not match the release. Unlike a read that failed, retrying cannot help. */
export class StreamsMismatchError extends Error {}
export const STREAMS_MISMATCH_REASON = "Market checks did not pass, so no market data is shown.";
export type StreamsManifest = {
  schemaVersion: 3; chainId: 26514; sourceChainId: 8453; status: "planned" | "configured";
  release: string; rolePolicy: typeof ROLE_POLICY;
  rpcUrls: typeof STREAMS_RPCS;
  contracts: { registry: StreamsRegistryPin } & Record<"oracle" | "publisher" | "sourceOracle", StreamsPin>;
  dependencies: Record<DependencyName, StreamsPin>;
  bindings: { chainlinkOwner: Address; verifiedReportDigest: Hex; sourceProxyAdminOwner: Address; destinationProxyAdminOwner: Address; sourceMessengerName: "OVM_L1CrossDomainMessenger" };
  parameters: { observationWindow: string; openingGrace: string; voidGrace: string; cutoffBuffer: string; minimumGasLimit: string; btcFeedId: Hex; ethFeedId: Hex; btcDecimals: 18; ethDecimals: 18; collateralDecimals: 6; routeHash: Hex; rulesHash: Hex };
};

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.toSorted().join(",")) throw new Error("Unsupported Streams deployment fields.");
  return value as Record<string, unknown>;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error("Invalid Streams deployment address.");
  return getAddress(value);
}
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) throw new Error("Invalid Streams deployment hash.");
  return value.toLowerCase() as Hex;
}
function pin(value: unknown, chainId: StreamsChainId, extra: string[] = []): StreamsPin {
  const r = object(value, ["chainId", "address", "runtimeCodeHash", ...extra]);
  if (r.chainId !== chainId) throw new Error("Streams dependency is on the wrong chain.");
  return { chainId, address: address(r.address), runtimeCodeHash: hash(r.runtimeCodeHash) };
}
function registryPin(value: unknown): StreamsRegistryPin {
  const base = pin(value, 26514, ["implementation", "implementationCodeHash", "owner"]);
  const r = value as Record<string, unknown>;
  return { ...base, implementation: address(r.implementation), implementationCodeHash: hash(r.implementationCodeHash), owner: address(r.owner) };
}
function integer(value: unknown, max: bigint, minimum = 1n): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value) || BigInt(value) < minimum || BigInt(value) > max) throw new Error("Invalid Streams market parameter.");
  return value;
}
const routeTuple = parseAbiParameters("string, (uint256 sourceChainId, uint256 destinationChainId, address sourceMessenger, address destinationMessenger, address sourceOracle, address publisher, address destinationOracle, bytes32 btcFeedId, bytes32 ethFeedId, uint8 btcDecimals, uint8 ethDecimals, uint32 observationWindow, uint32 minimumGasLimit)");
const rulesTuple = parseAbiParameters("string, uint256, (address oracle, address collateral, bytes32 btcFeedId, bytes32 ethFeedId, uint8 btcDecimals, uint8 ethDecimals, uint32 observationWindow, uint32 openingGrace, uint32 voidGrace, uint32 cutoffBuffer)");

export function streamsHashes(m: StreamsManifest) {
  const p = m.parameters;
  const feeds = { btcFeedId: p.btcFeedId, ethFeedId: p.ethFeedId, btcDecimals: p.btcDecimals, ethDecimals: p.ethDecimals };
  const routeHash = keccak256(encodeAbiParameters(routeTuple, ["zedge-native-streams-route-v1", {
    sourceChainId: 8453n, destinationChainId: 26514n, sourceMessenger: m.dependencies.sourceMessenger.address,
    destinationMessenger: m.dependencies.destinationMessenger.address, sourceOracle: m.contracts.sourceOracle.address,
    publisher: m.contracts.publisher.address, destinationOracle: m.contracts.oracle.address, ...feeds,
    observationWindow: Number(p.observationWindow), minimumGasLimit: Number(p.minimumGasLimit),
  }]));
  const rulesHash = keccak256(encodeAbiParameters(rulesTuple, ["zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half", 26514n, {
    oracle: m.contracts.oracle.address, collateral: m.dependencies.collateral.address, ...feeds,
    observationWindow: Number(p.observationWindow), openingGrace: Number(p.openingGrace),
    voidGrace: Number(p.voidGrace), cutoffBuffer: Number(p.cutoffBuffer),
  }]));
  return { routeHash, rulesHash };
}

export function parseStreamsManifest(value: unknown, expectedChain: number): StreamsManifest {
  const r = object(value, ["schemaVersion", "chainId", "sourceChainId", "status", "release", "rolePolicy", "rpcUrls", "contracts", "dependencies", "bindings", "parameters"]);
  if (r.schemaVersion !== 3 || r.chainId !== 26514 || expectedChain !== 26514 || r.sourceChainId !== 8453 || (r.status !== "planned" && r.status !== "configured") || r.rolePolicy !== ROLE_POLICY || typeof r.release !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(r.release)) throw new Error("Unsupported Streams deployment policy.");
  const rpc = object(r.rpcUrls, ["base", "horizen"]);
  if (rpc.base !== STREAMS_RPCS.base || rpc.horizen !== STREAMS_RPCS.horizen) throw new Error("Unreviewed Streams RPC endpoint.");
  const c = object(r.contracts, ["registry", "oracle", "publisher", "sourceOracle"]);
  const contracts = { registry: registryPin(c.registry), oracle: pin(c.oracle, 26514), publisher: pin(c.publisher, 8453), sourceOracle: pin(c.sourceOracle, 8453) };
  const d = object(r.dependencies, Object.keys(STREAMS_DEPENDENCIES));
  const dependencies = Object.fromEntries(Object.entries(STREAMS_DEPENDENCIES).map(([key, chain]) => [key, pin(d[key], chain)])) as StreamsManifest["dependencies"];
  const allPins = [...Object.values(contracts), ...Object.values(dependencies), { chainId: 26514, address: contracts.registry.implementation }];
  if (new Set(allPins.map((p) => `${p.chainId}:${p.address.toLowerCase()}`)).size !== allPins.length) throw new Error("Streams contract roles must use distinct addresses on each chain.");
  const b = object(r.bindings, ["chainlinkOwner", "verifiedReportDigest", "sourceProxyAdminOwner", "destinationProxyAdminOwner", "sourceMessengerName"]);
  if (b.sourceMessengerName !== "OVM_L1CrossDomainMessenger") throw new Error("Unsupported native proxy name.");
  const bindings: StreamsManifest["bindings"] = { chainlinkOwner: address(b.chainlinkOwner), verifiedReportDigest: hash(b.verifiedReportDigest), sourceProxyAdminOwner: address(b.sourceProxyAdminOwner), destinationProxyAdminOwner: address(b.destinationProxyAdminOwner), sourceMessengerName: b.sourceMessengerName };
  const p = object(r.parameters, ["observationWindow", "openingGrace", "voidGrace", "cutoffBuffer", "minimumGasLimit", "btcFeedId", "ethFeedId", "btcDecimals", "ethDecimals", "collateralDecimals", "routeHash", "rulesHash"]);
  if (p.btcDecimals !== 18 || p.ethDecimals !== 18 || p.collateralDecimals !== 6) throw new Error("Unsupported Streams token or price precision.");
  const parameters: StreamsManifest["parameters"] = {
    observationWindow: integer(p.observationWindow, 60n, 0n), openingGrace: integer(p.openingGrace, 2n ** 32n - 1n), voidGrace: integer(p.voidGrace, 1_814_400n, 86_400n),
    cutoffBuffer: integer(p.cutoffBuffer, 299n), minimumGasLimit: integer(p.minimumGasLimit, 2_000_000n, 200_000n),
    btcFeedId: hash(p.btcFeedId), ethFeedId: hash(p.ethFeedId), btcDecimals: 18, ethDecimals: 18, collateralDecimals: 6, routeHash: hash(p.routeHash), rulesHash: hash(p.rulesHash),
  };
  if (!parameters.btcFeedId.startsWith("0x0003") || !parameters.ethFeedId.startsWith("0x0003") || parameters.btcFeedId === parameters.ethFeedId || BigInt(parameters.observationWindow) + BigInt(parameters.openingGrace) >= 300n - BigInt(parameters.cutoffBuffer)) throw new Error("Invalid Streams round rules.");
  const manifest: StreamsManifest = { schemaVersion: 3, chainId: 26514, sourceChainId: 8453, status: r.status, release: r.release, rolePolicy: ROLE_POLICY, rpcUrls: STREAMS_RPCS, contracts, dependencies, bindings, parameters };
  const computed = streamsHashes(manifest);
  if (computed.routeHash !== parameters.routeHash || computed.rulesHash !== parameters.rulesHash) throw new Error("Streams route or rules hash does not match its configuration.");
  return manifest;
}

export interface StreamsReader {
  chainId(): Promise<number>;
  code(address: Address): Promise<Hex | undefined>;
  storage(address: Address, slot: Hex): Promise<Hex | undefined>;
  read(address: Address, signature: string, args?: readonly unknown[]): Promise<unknown>;
}
const ZERO = "0x0000000000000000000000000000000000000000";
export const STREAMS_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  legacyImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  legacyAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
} as const satisfies Record<string, Hex>;
const comparable = (v: unknown) => typeof v === "string" ? v.toLowerCase() : typeof v === "number" ? BigInt(v) : v;
function equal(actual: unknown, expected: unknown) {
  if (comparable(actual) !== comparable(expected)) throw new StreamsMismatchError("Streams binding, ownership or policy does not match this release.");
}
function returns(reader: StreamsReader, at: Address, signature: string, expected: unknown, args?: readonly unknown[]) {
  return reader.read(at, signature, args).then((actual) => equal(actual, expected));
}
function holds(reader: StreamsReader, at: Address, slot: Hex, expected: Address) {
  return reader.storage(at, slot).then((word) => {
    if (!word || !/^0x[0-9a-f]{64}$/i.test(word) || !/^0x0{24}/i.test(word)) throw new StreamsMismatchError("Streams proxy storage is invalid.");
    equal(`0x${word.slice(-40)}`, expected);
  });
}
/** Waits for every check, then reports a mismatch in preference to a failed read, whichever settled first. */
async function settle(jobs: Promise<unknown>[]) {
  const failures = (await Promise.allSettled(jobs)).flatMap((job) => job.status === "rejected" ? [job.reason as unknown] : []);
  if (failures.length) throw failures.find((failure) => failure instanceof StreamsMismatchError) ?? failures[0];
}

/** Who controls the registry's code at the reader's block: the implementation behind the proxy, the owner who can replace it, and no handover in progress.
 * Part of every verification, and repeated with every round read because a cached verification is older than the block a round is read at. */
export async function verifyRegistryControl(m: StreamsManifest, reader: StreamsReader) {
  const registry = m.contracts.registry;
  await settle([
    holds(reader, registry.address, STREAMS_SLOTS.implementation, registry.implementation),
    returns(reader, registry.address, "owner() view returns (address)", registry.owner),
    returns(reader, registry.address, "pendingOwner() view returns (address)", ZERO),
  ]);
}

/** Release identity and current upstream governance checks, not hardware attestation or trading readiness.
 * Run on every verification: a registry upgrade, ownership change or pending transfer fails it until a new manifest ships.
 * Every difference it finds is a StreamsMismatchError; an error from a reader passes through unchanged. */
export async function verifyStreamsDeployment(m: StreamsManifest, readers: Record<StreamsChainId, StreamsReader>) {
  if (m.status !== "configured") throw new Error("This Streams release is planned, not deployed.");
  for (const id of [8453, 26514] as const) equal(await readers[id].chainId(), id);
  const registry = m.contracts.registry;
  const pins: StreamsPin[] = [...Object.values(m.contracts), ...Object.values(m.dependencies), { chainId: 26514, address: registry.implementation, runtimeCodeHash: registry.implementationCodeHash }];
  await settle(pins.map(async (p) => {
    const code = await readers[p.chainId].code(p.address);
    if (!code || code === "0x" || keccak256(code) !== p.runtimeCodeHash) throw new StreamsMismatchError("Streams deployed code does not match this release.");
  }));
  const jobs: Promise<unknown>[] = [verifyRegistryControl(m, readers[26514])];
  const call = (p: StreamsPin, signature: string, expected: unknown, args?: readonly unknown[]) => jobs.push(returns(readers[p.chainId], p.address, signature, expected, args));
  const stored = (p: StreamsPin, slot: Hex, expected: Address) => jobs.push(holds(readers[p.chainId], p.address, slot, expected));
  const d = m.dependencies; const c = m.contracts; const p = m.parameters;
  const versions = { registry: "zedge-streams-round-registry-v2", oracle: "zedge-horizen-streams-oracle-v1", publisher: "zedge-base-streams-publisher-v1", sourceOracle: "zedge-chainlink-streams-boundary-v1" };
  for (const key of Object.keys(c) as (keyof typeof c)[]) {
    const at = c[key]; call(at, "version() view returns (string)", versions[key]);
    for (const k of ["btcFeedId", "ethFeedId"] as const) call(at, `${k}() view returns (bytes32)`, p[k]);
    for (const k of ["btcDecimals", "ethDecimals"] as const) call(at, `${k}() view returns (uint8)`, p[k]);
    // The three route contracts are not proxies. The registry is one; verifyRegistryControl pins what is behind it.
    if (key !== "registry") stored(at, STREAMS_SLOTS.implementation, ZERO);
    for (const slot of [STREAMS_SLOTS.admin, STREAMS_SLOTS.beacon]) stored(at, slot, ZERO);
  }
  call(c.sourceOracle, "verifierProxy() view returns (address)", d.verifier.address);
  call(c.registry, "oracle() view returns (address)", c.oracle.address);
  call(c.registry, "collateral() view returns (address)", d.collateral.address);
  call(c.registry, "deploymentChainId() view returns (uint256)", 26514);
  call(c.registry, "rulesHash() view returns (bytes32)", p.rulesHash);
  call(c.registry, "PAYOUT_DENOMINATOR() view returns (uint8)", 2);
  for (const k of ["observationWindow", "openingGrace", "voidGrace", "cutoffBuffer"] as const) call(c.registry, `${k}() view returns (uint32)`, BigInt(p[k]));
  for (const at of [c.publisher, c.oracle]) {
    call(at, "routeHash() view returns (bytes32)", p.routeHash);
    call(at, "sourceChainId() view returns (uint256)", 8453);
    call(at, "destinationChainId() view returns (uint256)", 26514);
    call(at, "sourceOracle() view returns (address)", c.sourceOracle.address);
    for (const k of ["observationWindow", "minimumGasLimit"] as const) call(at, `${k}() view returns (uint32)`, BigInt(p[k]));
  }
  call(c.publisher, "destinationOracle() view returns (address)", c.oracle.address);
  call(c.publisher, "destinationMessenger() view returns (address)", d.destinationMessenger.address);
  call(c.publisher, "nativeMessenger() view returns (address)", d.sourceMessenger.address);
  call(c.oracle, "publisher() view returns (address)", c.publisher.address);
  call(c.oracle, "sourceMessenger() view returns (address)", d.sourceMessenger.address);
  call(c.oracle, "nativeMessenger() view returns (address)", d.destinationMessenger.address);
  call(d.verifier, "typeAndVersion() view returns (string)", "VerifierProxy 2.0.0");
  call(d.verifier, "s_accessController() view returns (address)", ZERO);
  call(d.verifier, "s_feeManager() view returns (address)", d.feeManager.address);
  call(d.verifier, "getVerifier(bytes32) view returns (address)", d.donVerifier.address, [m.bindings.verifiedReportDigest]);
  call(d.verifier, "owner() view returns (address)", m.bindings.chainlinkOwner);
  call(d.feeManager, "typeAndVersion() view returns (string)", "NoOpFeeManager 0.5.1");
  call(d.donVerifier, "typeAndVersion() view returns (string)", "Verifier 2.0.0");
  call(d.donVerifier, "owner() view returns (address)", m.bindings.chainlinkOwner);
  call(d.sourceMessenger, "otherMessenger() view returns (address)", d.destinationMessenger.address);
  call(d.sourceMessenger, "portal() view returns (address)", d.portal.address);
  call(d.sourceMessenger, "version() view returns (string)", "2.6.0");
  call(d.sourceMessenger, "paused() view returns (bool)", false);
  call(d.destinationMessenger, "otherMessenger() view returns (address)", d.sourceMessenger.address);
  call(d.destinationMessenger, "version() view returns (string)", "2.2.0");
  call(d.addressManager, "getAddress(string) view returns (address)", d.sourceMessengerImplementation.address, [m.bindings.sourceMessengerName]);
  call(d.addressManager, "owner() view returns (address)", d.sourceProxyAdmin.address);
  call(d.sourceProxyAdmin, "owner() view returns (address)", m.bindings.sourceProxyAdminOwner);
  call(d.destinationProxyAdmin, "owner() view returns (address)", m.bindings.destinationProxyAdminOwner);
  call(d.collateral, "decimals() view returns (uint8)", 6);
  call(d.collateral, "symbol() view returns (string)", "USDC.e");
  call(d.collateral, "name() view returns (string)", "Bridged USDC (Stargate)");
  call(d.collateral, "owner() view returns (address)", d.collateralAdmin.address);
  stored(d.portal, STREAMS_SLOTS.implementation, d.portalImplementation.address);
  stored(d.portal, STREAMS_SLOTS.admin, d.sourceProxyAdmin.address);
  stored(d.destinationMessenger, STREAMS_SLOTS.implementation, d.destinationMessengerImplementation.address);
  stored(d.destinationMessenger, STREAMS_SLOTS.admin, d.destinationProxyAdmin.address);
  stored(d.destinationProxyAdmin, STREAMS_SLOTS.implementation, d.destinationProxyAdminImplementation.address);
  stored(d.collateral, STREAMS_SLOTS.legacyImplementation, d.collateralImplementation.address);
  stored(d.collateral, STREAMS_SLOTS.legacyAdmin, d.collateralAdmin.address);
  const mappingSlot = (index: bigint) => keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [d.sourceMessenger.address, index]));
  stored(d.sourceMessenger, mappingSlot(1n), d.addressManager.address);
  jobs.push(readers[8453].storage(d.sourceMessenger.address, mappingSlot(0n)).then((word) => {
    if (!word || !/^0x[0-9a-f]{64}$/i.test(word)) throw new StreamsMismatchError("Missing resolved proxy name.");
    const size = Number(BigInt(`0x${word.slice(-2)}`)) / 2;
    if (!Number.isInteger(size) || size < 1 || size > 31) throw new StreamsMismatchError("Unsupported resolved proxy string.");
    equal(hexToString(`0x${word.slice(2, 2 + size * 2)}`), m.bindings.sourceMessengerName);
    if (!/^0*$/.test(word.slice(2 + size * 2, -2))) throw new StreamsMismatchError("Noncanonical resolved proxy string.");
  }));
  await settle(jobs);
  return { manifest: m, verified: true as const };
}
