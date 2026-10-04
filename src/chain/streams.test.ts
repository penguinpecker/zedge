import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from "viem";
import { parseManifest, requireTradingReady } from "./manifest.ts";
import { exactObservationPrice, observationPrice } from "./gateway.ts";
import { parseStreamsManifest, STREAMS_SLOTS, streamsHashes, verifyStreamsDeployment, type StreamsChainId, type StreamsManifest, type StreamsReader } from "./streams-manifest.ts";
import { streamsRegistryReadAbi, streamsOracleReadAbi } from "./streams-abi.ts";

const publicManifest = JSON.parse(await readFile(new URL("../../public/deployments/26514.json", import.meta.url), "utf8"));
const clone = () => structuredClone(publicManifest);
const zero: Address = `0x${"0".repeat(40)}`;
const word = (value: Address) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

test("actual schema2 manifest binds both chains, exact precision, canonical route and round rules", () => {
  const m = parseStreamsManifest(publicManifest, 26514);
  assert.equal(parseManifest(publicManifest, 26514).schemaVersion, 2);
  assert.deepEqual(streamsHashes(m), { routeHash: m.parameters.routeHash, rulesHash: m.parameters.rulesHash });
  assert.equal(m.parameters.btcDecimals, 18);
  assert.equal(m.contracts.registry.address, "0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91");
  // Equal addresses on different chains are legitimate, and cannot merge their identities.
  assert.equal(m.contracts.registry.address, m.contracts.sourceOracle.address);
  assert.notEqual(m.contracts.registry.chainId, m.contracts.sourceOracle.chainId);
  assert.throws(requireTradingReady, /No transaction was submitted/);
});

test("schema2 rejects unknown fields, insecure RPCs, chain substitutions and incorrect precision", () => {
  const invalid = [
    (m: typeof publicManifest) => { m.rpcUrls.base = "https://attacker.example/rpc"; },
    (m: typeof publicManifest) => { m.rpcUrls.horizen = "http://horizen.calderachain.xyz/http"; },
    (m: typeof publicManifest) => { m.sourceChainId = 1; },
    (m: typeof publicManifest) => { m.dependencies.verifier.chainId = 26514; },
    (m: typeof publicManifest) => { m.enableTrading = true; },
    (m: typeof publicManifest) => { m.parameters.btcDecimals = 8; },
    (m: typeof publicManifest) => { m.parameters.collateralDecimals = "6"; },
    (m: typeof publicManifest) => { m.parameters.maxConfidenceBps = "100"; },
    (m: typeof publicManifest) => { m.bindings.sourceMessengerName = "evil"; },
    (m: typeof publicManifest) => { m.contracts.publisher.address = m.contracts.sourceOracle.address; },
    (m: typeof publicManifest) => { delete m.dependencies.collateralImplementation; },
    (m: typeof publicManifest) => { m.dependencies.collateralAdmin.runtimeCodeHash = `0x${"0".repeat(64)}`; },
    (m: typeof publicManifest) => { m.rolePolicy = "upgradeable"; },
  ];
  for (const mutate of invalid) { const m = clone(); mutate(m); assert.throws(() => parseStreamsManifest(m, 26514)); }
  assert.throws(() => parseStreamsManifest(publicManifest, 2651420));
});

test("changing time windows, feeds or route addresses cannot retain old committed hashes", () => {
  for (const field of ["openingGrace", "settlementGrace", "cutoffBuffer", "minimumGasLimit"] as const) {
    const m = clone(); m.parameters[field] = String(Number(m.parameters[field]) + 1);
    assert.throws(() => parseStreamsManifest(m, 26514), /hash|rules/);
  }
  const m = clone(); m.contracts.publisher.address = "0x1111111111111111111111111111111111111111";
  assert.throws(() => parseStreamsManifest(m, 26514), /hash/);
});

// A deterministic fake RPC for adversarial identity checks. This is not evidence
// of deployment; the committed manifest and live read-only smoke establish that.
function mockReaders() {
  const m: StreamsManifest = parseStreamsManifest(clone(), 26514);
  const code = "0x6000600055" as Hex;
  for (const p of [...Object.values(m.contracts), ...Object.values(m.dependencies)]) p.runtimeCodeHash = keccak256(code);
  const fields = new Map<string, unknown>(); const storage = new Map<string, Hex>();
  const key = (chainId: number, address: Address, field: string) => `${chainId}:${address.toLowerCase()}:${field}`;
  const add = (p: { chainId: number; address: Address }, values: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(values)) fields.set(key(p.chainId, p.address, field), value);
  };
  const c = m.contracts, d = m.dependencies, p = m.parameters;
  const feeds = { btcFeedId: p.btcFeedId, ethFeedId: p.ethFeedId, btcDecimals: 18, ethDecimals: 18 };
  add(c.sourceOracle, { ...feeds, version: "zedge-chainlink-streams-boundary-v1", verifierProxy: d.verifier.address });
  add(c.registry, { ...feeds, version: "zedge-streams-round-registry-v1", oracle: c.oracle.address, collateral: d.collateral.address, deploymentChainId: 26514, rulesHash: p.rulesHash, PAYOUT_DENOMINATOR: 2, observationWindow: 60, openingGrace: 150, settlementGrace: 3600, cutoffBuffer: 30 });
  const route = { ...feeds, routeHash: p.routeHash, sourceChainId: 8453, destinationChainId: 26514, sourceOracle: c.sourceOracle.address, observationWindow: 60, minimumGasLimit: 600000 };
  add(c.publisher, { ...route, version: "zedge-base-streams-publisher-v1", nativeMessenger: d.sourceMessenger.address, destinationMessenger: d.destinationMessenger.address, destinationOracle: c.oracle.address });
  add(c.oracle, { ...route, version: "zedge-horizen-streams-oracle-v1", nativeMessenger: d.destinationMessenger.address, sourceMessenger: d.sourceMessenger.address, publisher: c.publisher.address });
  add(d.verifier, { typeAndVersion: "VerifierProxy 2.0.0", s_accessController: zero, s_feeManager: d.feeManager.address, owner: m.bindings.chainlinkOwner, getVerifier: d.donVerifier.address });
  add(d.feeManager, { typeAndVersion: "NoOpFeeManager 0.5.1" });
  add(d.donVerifier, { typeAndVersion: "Verifier 2.0.0", owner: m.bindings.chainlinkOwner });
  add(d.sourceMessenger, { otherMessenger: d.destinationMessenger.address, portal: d.portal.address, version: "2.6.0", paused: false });
  add(d.destinationMessenger, { otherMessenger: d.sourceMessenger.address, version: "2.2.0" });
  add(d.addressManager, { getAddress: d.sourceMessengerImplementation.address, owner: d.sourceProxyAdmin.address });
  add(d.sourceProxyAdmin, { owner: m.bindings.sourceProxyAdminOwner });
  add(d.destinationProxyAdmin, { owner: m.bindings.destinationProxyAdminOwner });
  add(d.collateral, { decimals: 6, symbol: "USDC.e", name: "Bridged USDC (Stargate)", owner: d.collateralAdmin.address });
  const set = (at: typeof d.collateral, slot: Hex, value: Address) => storage.set(key(at.chainId, at.address, slot), word(value));
  set(d.collateral, STREAMS_SLOTS.legacyImplementation, d.collateralImplementation.address);
  set(d.collateral, STREAMS_SLOTS.legacyAdmin, d.collateralAdmin.address);
  set(d.portal, STREAMS_SLOTS.implementation, d.portalImplementation.address);
  set(d.portal, STREAMS_SLOTS.admin, d.sourceProxyAdmin.address);
  set(d.destinationMessenger, STREAMS_SLOTS.implementation, d.destinationMessengerImplementation.address);
  set(d.destinationMessenger, STREAMS_SLOTS.admin, d.destinationProxyAdmin.address);
  set(d.destinationProxyAdmin, STREAMS_SLOTS.implementation, d.destinationProxyAdminImplementation.address);
  const mappingSlot = (n: bigint) => keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [d.sourceMessenger.address, n]));
  set(d.sourceMessenger, mappingSlot(1n), d.addressManager.address);
  const name = stringToHex(m.bindings.sourceMessengerName).slice(2);
  storage.set(key(8453, d.sourceMessenger.address, mappingSlot(0n)), `0x${name.padEnd(62, "0")}${(name.length).toString(16).padStart(2, "0")}`);
  const makeReader = (id: StreamsChainId): StreamsReader => ({
    chainId: async () => id, code: async () => code,
    storage: async (a: Address, slot: Hex) => storage.get(key(id, a, slot)) ?? word(zero),
    read: async (a: Address, signature: string, args: readonly unknown[] = []) => {
      const field = signature.slice(0, signature.indexOf("("));
      if (field === "getVerifier") assert.deepEqual(args, [m.bindings.verifiedReportDigest]);
      if (field === "getAddress") assert.deepEqual(args, [m.bindings.sourceMessengerName]);
      const k = key(id, a, field); if (!fields.has(k)) throw new Error("Unknown mock field"); return fields.get(k);
    },
  });
  const readers: Record<StreamsChainId, StreamsReader> = { 8453: makeReader(8453), 26514: makeReader(26514) };
  return { m, readers, fields, storage, key };
}

test("Streams runtime verifier rejects wrong source chain, absent code and substituted implementation code", async () => {
  const { m, readers } = mockReaders();
  assert.equal((await verifyStreamsDeployment(m, readers)).verified, true);
  await assert.rejects(verifyStreamsDeployment(m, { ...readers, 8453: { ...readers[8453], chainId: async () => 1 } }));
  await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code: async () => "0x" } }), /code/);
  await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code: async (a) => a === m.dependencies.collateralImplementation.address ? "0x6001" : readers[26514].code(a) } }), /code/);
});

test("immutable getters, active verifier configuration and upstream roles fail closed on drift", async () => {
  const targets = [["registry", "rulesHash"], ["oracle", "publisher"], ["publisher", "nativeMessenger"], ["sourceOracle", "verifierProxy"], ["verifier", "s_accessController"], ["verifier", "getVerifier"], ["verifier", "owner"], ["sourceMessenger", "paused"], ["collateral", "decimals"]] as const;
  for (const [name, field] of targets) {
    const { m, readers, fields, key } = mockReaders();
    const at = name in m.contracts ? m.contracts[name as keyof typeof m.contracts] : m.dependencies[name as keyof typeof m.dependencies];
    fields.set(key(at.chainId, at.address, field), "unexpected");
    await assert.rejects(verifyStreamsDeployment(m, readers), /binding|policy/);
  }
});

test("legacy collateral proxy and native resolved proxy storage are checked, not inferred from empty EIP1967 slots", async () => {
  for (const slot of [STREAMS_SLOTS.legacyAdmin, STREAMS_SLOTS.legacyImplementation]) {
    const { m, readers, storage, key } = mockReaders();
    storage.set(key(26514, m.dependencies.collateral.address, slot), word(zero));
    await assert.rejects(verifyStreamsDeployment(m, readers), /binding|policy/);
  }
  const { m, readers } = mockReaders();
  await assert.rejects(verifyStreamsDeployment(m, { ...readers, 8453: { ...readers[8453], storage: async (a, s) => a === m.dependencies.sourceMessenger.address ? undefined : readers[8453].storage(a, s) } }), /storage|proxy/);
});

test("18-decimal prices preserve tie-sensitive digits while display shorthand never determines settlement", () => {
  const a = 85106875216891330000000n, b = a + 1n;
  assert.equal(exactObservationPrice(a, 18), "85106.87521689133");
  assert.equal(exactObservationPrice(b, 18), "85106.875216891330000001");
  assert.equal(observationPrice(a, -18), observationPrice(b, -18));
  assert.throws(() => exactObservationPrice(0n, 18));
});

test("Streams frontend ABI exactly matches committed read-only contract functions and excludes writes", async () => {
  for (const [name, abi] of [["StreamsRoundRegistry", streamsRegistryReadAbi], ["HorizenStreamsOracle", streamsOracleReadAbi]] as const) {
    const full = JSON.parse(await readFile(new URL(`../../contracts/abi/${name}.json`, import.meta.url), "utf8"));
    assert.deepEqual(abi, full.filter((e: { type: string; stateMutability?: string }) => e.type === "function" && ["view", "pure"].includes(e.stateMutability ?? "")));
    assert.ok(abi.every((e) => ["view", "pure"].includes(e.stateMutability)));
  }
});
