import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbiParameters, stringToHex, toHex, type Address, type Hex } from "viem";
import { parseManifest, requireTradingReady } from "./manifest.ts";
import { checkDeployment, exactObservationPrice, observationPrice, priceCaptions, readRound, type RoundRead } from "./gateway.ts";
import { parseStreamsManifest, STREAMS_SLOTS, StreamsMismatchError, streamsHashes, verifyStreamsDeployment, type StreamsChainId, type StreamsManifest, type StreamsReader } from "./streams-manifest.ts";
import { streamsRegistryReadAbi, streamsOracleReadAbi } from "./streams-abi.ts";

const repoFile = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const manifestText = await repoFile("public/deployments/26514.json");
const publicManifest = JSON.parse(manifestText);
const release = JSON.parse(await repoFile("contracts/deployment/mainnet-addresses.json"));
const profileText = await repoFile("contracts/deployment/hybrid-mainnet.json");
const clone = () => structuredClone(publicManifest);
// The verification tests below need a deployed release whatever the committed status is.
const configured = () => ({ ...clone(), status: "configured" });
const zero: Address = `0x${"0".repeat(40)}`;
const word = (value: Address) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

test("actual schema3 manifest binds both chains, exact precision, canonical route and round rules", () => {
  const m = parseStreamsManifest(publicManifest, 26514);
  assert.equal(parseManifest(publicManifest, 26514).schemaVersion, 3);
  assert.deepEqual(streamsHashes(m), { routeHash: m.parameters.routeHash, rulesHash: m.parameters.rulesHash });
  assert.equal(m.parameters.btcDecimals, 18);
  assert.equal(m.parameters.voidGrace, "604800");
  // The retired registry is not pinned in any Horizen role. Its hex is also the kept Base oracle, a different contract.
  const retired = release.retired[0].address.toLowerCase();
  const horizen = [...Object.values(m.contracts), ...Object.values(m.dependencies)].filter((p) => p.chainId === 26514).map((p) => p.address.toLowerCase());
  assert.ok(![...horizen, m.contracts.registry.implementation.toLowerCase()].includes(retired));
  // Equal addresses on different chains are legitimate, and cannot merge their identities.
  const acrossChains = clone(); acrossChains.contracts.registry.implementation = m.contracts.publisher.address;
  assert.equal(parseStreamsManifest(acrossChains, 26514).contracts.registry.implementation, m.contracts.publisher.address);
  const sameChain = clone(); sameChain.contracts.registry.implementation = m.contracts.oracle.address;
  assert.throws(() => parseStreamsManifest(sameChain, 26514), /distinct/);
  assert.throws(requireTradingReady, /No transaction was submitted/);
});

test("the committed manifest is exactly what the committed release and profile generate", async () => {
  const { deploymentManifest, manifestText: text } = await import(new URL("../../scripts/write-deployment-manifest.mjs", import.meta.url).href) as {
    deploymentManifest: (release: unknown, profileText: string) => { status: string }; manifestText: (manifest: unknown) => string;
  };
  assert.equal(manifestText, text(deploymentManifest(release, profileText)));
  // A release is shown as live only once it is recorded as deployed; nothing else maps to "configured".
  assert.equal(deploymentManifest({ ...release, status: "planned" }, profileText).status, "planned");
  const deployed = deploymentManifest({ ...release, status: "deployed" }, profileText);
  assert.equal(parseStreamsManifest(deployed, 26514).status, "configured");
  for (const status of ["configured", "live", undefined]) assert.throws(() => deploymentManifest({ ...release, status }, profileText), /status/);
  assert.throws(() => deploymentManifest({ ...release, schemaVersion: 1 }, profileText), /format/);
  assert.throws(() => deploymentManifest(release, `${profileText} `), /profile/);
  assert.throws(() => deploymentManifest({ ...release, contracts: release.contracts.slice(0, 3) }, profileText), /StreamsRoundRegistry/);
});

test("schema3 rejects unknown fields, insecure RPCs, chain substitutions, incorrect precision and the retired policy", () => {
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
    // The registry is upgradeable by its owner: the old fixed-rules claim and the old schema are refused.
    (m: typeof publicManifest) => { m.rolePolicy = "immutable-no-admin"; },
    (m: typeof publicManifest) => { m.schemaVersion = 2; },
    (m: typeof publicManifest) => { m.status = "deployed"; },
    (m: typeof publicManifest) => { delete m.status; },
    (m: typeof publicManifest) => { delete m.contracts.registry.implementation; },
    (m: typeof publicManifest) => { delete m.contracts.registry.owner; },
    (m: typeof publicManifest) => { m.contracts.registry.owner = `0x${"0".repeat(40)}`; },
    (m: typeof publicManifest) => { m.contracts.registry.implementationCodeHash = `0x${"0".repeat(64)}`; },
    (m: typeof publicManifest) => { m.contracts.oracle.implementation = m.contracts.registry.implementation; },
    (m: typeof publicManifest) => { m.parameters.settlementGrace = "3600"; },
  ];
  for (const mutate of invalid) { const m = clone(); mutate(m); assert.throws(() => parseStreamsManifest(m, 26514)); }
  assert.throws(() => parseStreamsManifest(publicManifest, 2651420));
});

test("changing time windows, feeds or route addresses cannot retain old committed hashes", () => {
  for (const field of ["openingGrace", "voidGrace", "cutoffBuffer", "minimumGasLimit"] as const) {
    const m = clone(); m.parameters[field] = String(Number(m.parameters[field]) + 1);
    assert.throws(() => parseStreamsManifest(m, 26514), /hash|rules/);
  }
  const m = clone(); m.contracts.publisher.address = "0x1111111111111111111111111111111111111111";
  assert.throws(() => parseStreamsManifest(m, 26514), /hash/);
});

// A deterministic fake RPC for adversarial identity checks. This is not evidence
// of deployment; the committed manifest and live read-only smoke establish that.
function mockReaders() {
  const m: StreamsManifest = parseStreamsManifest(configured(), 26514);
  const code = "0x6000600055" as Hex;
  for (const p of [...Object.values(m.contracts), ...Object.values(m.dependencies)]) p.runtimeCodeHash = keccak256(code);
  m.contracts.registry.implementationCodeHash = keccak256(code);
  const fields = new Map<string, unknown>(); const storage = new Map<string, Hex>();
  const key = (chainId: number, address: Address, field: string) => `${chainId}:${address.toLowerCase()}:${field}`;
  const add = (p: { chainId: number; address: Address }, values: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(values)) fields.set(key(p.chainId, p.address, field), value);
  };
  const c = m.contracts, d = m.dependencies, p = m.parameters;
  const feeds = { btcFeedId: p.btcFeedId, ethFeedId: p.ethFeedId, btcDecimals: 18, ethDecimals: 18 };
  add(c.sourceOracle, { ...feeds, version: "zedge-chainlink-streams-boundary-v1", verifierProxy: d.verifier.address });
  add(c.registry, { ...feeds, version: "zedge-streams-round-registry-v2", oracle: c.oracle.address, collateral: d.collateral.address, deploymentChainId: 26514, rulesHash: p.rulesHash, PAYOUT_DENOMINATOR: 2, observationWindow: 60, openingGrace: 150, voidGrace: 604800, cutoffBuffer: 30, owner: c.registry.owner, pendingOwner: zero });
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
  set(c.registry, STREAMS_SLOTS.implementation, c.registry.implementation);
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

test("a planned release fails closed: it is never verified and nothing is read from a contract or an RPC", async () => {
  const planned = parseManifest({ ...clone(), status: "planned" }, 26514);
  assert.equal(planned.status, "planned");
  // These readers pass a configured release (asserted above), so the refusal comes from the status alone.
  const { m, readers } = mockReaders();
  await assert.rejects(verifyStreamsDeployment({ ...m, status: "planned" }, readers), /planned/);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A planned release must not reach the network."); };
  try {
    const snapshot = { chainId: 26514, blockNumber: 1n, blockHash: `0x${"1".repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)), checkedAt: Date.now() } as const;
    assert.equal(await checkDeployment(planned, snapshot), null);
  } finally { globalThis.fetch = realFetch; }
});

test("a registry upgrade, substituted implementation code, another owner or a pending owner fails verification", async () => {
  const other: Address = "0x1111111111111111111111111111111111111111";
  { // Implementation slot mismatch: the proxy now points at other code, whatever that code is.
    const { m, readers, storage, key } = mockReaders();
    storage.set(key(26514, m.contracts.registry.address, STREAMS_SLOTS.implementation), word(other));
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
    storage.set(key(26514, m.contracts.registry.address, STREAMS_SLOTS.implementation), word(zero));
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
  }
  { // Implementation code-hash mismatch: the slot is right but the code at that address is not the reviewed build.
    const { m, readers } = mockReaders();
    const substituted = (a: Address) => a === m.contracts.registry.implementation ? Promise.resolve("0x6001" as Hex) : readers[26514].code(a);
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code: substituted } }), /code/);
    const absent = (a: Address) => a === m.contracts.registry.implementation ? Promise.resolve("0x" as Hex) : readers[26514].code(a);
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code: absent } }), /code/);
  }
  { // Owner mismatch: ownership was handed over.
    const { m, readers, fields, key } = mockReaders();
    fields.set(key(26514, m.contracts.registry.address, "owner"), other);
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
  }
  { // Pending owner present: a two-step handover has started, even though owner() is unchanged.
    const { m, readers, fields, key } = mockReaders();
    fields.set(key(26514, m.contracts.registry.address, "pendingOwner"), other);
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
  }
  for (const slot of [STREAMS_SLOTS.admin, STREAMS_SLOTS.beacon]) { // No second upgrade path may appear beside the owner.
    const { m, readers, storage, key } = mockReaders();
    storage.set(key(26514, m.contracts.registry.address, slot), word(other));
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
  }
  { // A route contract that turns out to be a proxy is refused: those three are fixed.
    const { m, readers, storage, key } = mockReaders();
    storage.set(key(26514, m.contracts.oracle.address, STREAMS_SLOTS.implementation), word(other));
    await assert.rejects(verifyStreamsDeployment(m, readers), /ownership|policy/);
  }
});

test("a check that completed and did not pass is a mismatch, a read that failed is not, and the mismatch is the one reported", async () => {
  const other: Address = "0x1111111111111111111111111111111111111111";
  { // A handover in progress: the check completed, and retrying cannot make it pass.
    const { m, readers, fields, key } = mockReaders();
    fields.set(key(26514, m.contracts.registry.address, "pendingOwner"), other);
    await assert.rejects(verifyStreamsDeployment(m, readers), StreamsMismatchError);
  }
  { // Other code at a pinned address, and a proxy slot that does not hold an address.
    const { m, readers } = mockReaders();
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 8453: { ...readers[8453], code: async () => "0x6001" } }), StreamsMismatchError);
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], storage: async () => undefined } }), StreamsMismatchError);
    const nameSlot = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [m.dependencies.sourceMessenger.address, 0n]));
    const unnamed: StreamsReader = { ...readers[8453], storage: async (a, slot) => slot === nameSlot ? word(zero) : readers[8453].storage(a, slot) };
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 8453: unnamed }), StreamsMismatchError);
  }
  const offline = new Error("HTTP request failed.");
  const failing = (readers: Record<StreamsChainId, StreamsReader>, delayed?: string): Record<StreamsChainId, StreamsReader> => ({ ...readers, 26514: { ...readers[26514], read: async (a, signature, args) => {
    if (signature.startsWith("rulesHash(")) throw offline;
    if (delayed && signature.startsWith(`${delayed}(`)) await new Promise((resolve) => setTimeout(resolve, 5));
    return readers[26514].read(a, signature, args);
  } } });
  { // An endpoint failure with nothing else wrong stays an endpoint failure.
    const { m, readers } = mockReaders();
    await assert.rejects(verifyStreamsDeployment(m, failing(readers)), (error) => error === offline);
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code: async () => { throw offline; } } }), (error) => error === offline);
  }
  { // The failed read is earlier in the list and settles first; a mismatch found after it is still what the visitor is told.
    const { m, readers, fields, key } = mockReaders();
    fields.set(key(26514, m.dependencies.collateral.address, "decimals"), 8);
    await assert.rejects(verifyStreamsDeployment(m, failing(readers, "decimals")), StreamsMismatchError);
    const code = async (a: Address) => {
      if (a === m.contracts.oracle.address) throw offline;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return a === m.dependencies.collateral.address ? "0x6001" : readers[26514].code(a);
    };
    await assert.rejects(verifyStreamsDeployment(m, { ...readers, 26514: { ...readers[26514], code } }), StreamsMismatchError);
  }
});

test("every round read checks the registry's implementation, owner and pending owner again at the block it reads", async () => {
  // The real readRound over a fake JSON-RPC endpoint. A verification is cached for two minutes; the registry's owner can replace its code in any block.
  const { m } = mockReaders();
  const registry = m.contracts.registry, other: Address = "0x1111111111111111111111111111111111111111";
  const now = Math.floor(Date.now() / 1000), block = "0x7", blockHash: Hex = `0x${"7".repeat(64)}`;
  const snapshot = { chainId: 26514, blockNumber: 7n, blockHash, timestamp: BigInt(now), checkedAt: Date.now() } as const;
  const released = { implementation: registry.implementation, owner: registry.owner, pendingOwner: zero };
  let state = released;
  const readAt = new Set<unknown>();
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === "eth_chainId") return toHex(26514);
    if (method === "eth_getBlockByNumber") return { number: block, hash: blockHash, timestamp: toHex(now) };
    readAt.add(params.at(-1));
    if (method === "eth_getStorageAt") return word(params[1] === STREAMS_SLOTS.implementation ? state.implementation : zero);
    const { functionName } = decodeFunctionData({ abi: streamsRegistryReadAbi, data: (params[0] as { data: Hex }).data });
    const result = { roundIdFor: blockHash, phase: 0, owner: state.owner, pendingOwner: state.pendingOwner }[functionName as string];
    return encodeFunctionResult({ abi: streamsRegistryReadAbi, functionName, result: result as never });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    type Call = { id: number; method: string; params?: unknown[] };
    const body = JSON.parse(String(init?.body)) as Call | Call[];
    const reply = (call: Call) => ({ jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params ?? []) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const deployment = { manifest: m, verified: true as const };
    assert.equal((await readRound(deployment, snapshot, 0, 300, 0)).phase, 0);
    for (const changed of [{ implementation: other }, { implementation: zero }, { owner: other }, { pendingOwner: other }]) {
      state = { ...released, ...changed };
      await assert.rejects(readRound(deployment, snapshot, 0, 300, 0), StreamsMismatchError, JSON.stringify(changed));
    }
    state = released;
    assert.equal((await readRound(deployment, snapshot, 0, 300, 0)).phase, 0);
    assert.deepEqual([...readAt], [block]);
  } finally { globalThis.fetch = realFetch; }
});

test("registry and route getters, active verifier configuration and upstream roles fail closed on drift", async () => {
  const targets = [["registry", "rulesHash"], ["registry", "version"], ["registry", "voidGrace"], ["oracle", "publisher"], ["publisher", "nativeMessenger"], ["sourceOracle", "verifierProxy"], ["verifier", "s_accessController"], ["verifier", "getVerifier"], ["verifier", "owner"], ["sourceMessenger", "paused"], ["collateral", "decimals"]] as const;
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

test("price boxes never promise an observation that a voided or void-only round cannot receive", () => {
  const observation = { price: 1n, decimals: 18, observedAt: 1n, validFrom: 1n, reportHash: null };
  const read = (phase: number, openedAt: bigint, outcome = 0, resolvedAt = 0n): RoundRead => ({
    roundId: `0x${"1".repeat(64)}`, phase, start: 300n,
    round: { asset: 0, duration: 300, start: 300n, end: 600n, cutoff: 570n, openingDeadline: 510n, voidableAfter: 605_460n, resolutionDeadline: null, openedAt, resolvedAt, outcome, opening: observation, closing: observation },
  });
  const cases: [string, RoundRead, string, string][] = [
    ["never opened, can only be voided", read(8, 0n), "No opening price recorded", "Can only be voided"],
    ["never opened, voided", read(7, 0n, 3, 700n), "No opening price recorded", "Round voided"],
    ["opened, no closing price by the timeout", read(8, 400n), "Verified opening observation", "No closing price delivered"],
    ["opened, voided", read(7, 400n, 3, 700_000n), "Verified opening observation", "Round voided"],
    ["opened, ended, closing price still expected", read(5, 400n), "Verified opening observation", "Awaiting resolution"],
    ["started, opening price still expected", read(2, 0n), "Awaiting opening observation", "Awaiting resolution"],
    ["resolved", read(6, 400n, 1, 650n), "Verified opening observation", "Verified closing observation"],
  ];
  for (const [name, state, opening, closing] of cases) {
    const captions = priceCaptions(state, true);
    assert.deepEqual(captions, { opening, closing }, name);
    if (state.phase === 7 || state.phase === 8) assert.doesNotMatch(`${captions.opening} ${captions.closing}`, /Awaiting/, name);
  }
  assert.deepEqual(priceCaptions({ roundId: `0x${"1".repeat(64)}`, phase: 0, start: 300n, round: null }, true), { opening: "No scheduled round", closing: "No scheduled round" });
  assert.deepEqual(priceCaptions(null, false), { opening: "Unavailable", closing: "Unavailable" });
  // Verified, but this round is not read at the displayed block: every new block until its read finishes, and after a failed read.
  // The round may be voided, so neither box may say a price is awaited.
  assert.deepEqual(priceCaptions(null, true), { opening: "Loading…", closing: "Loading…" });
  assert.deepEqual(priceCaptions(null, true, true), { opening: "Unavailable", closing: "Unavailable" });
});

test("Market Rules does not call the price contracts fixed without naming what they depend on that can change", async () => {
  const paragraph = (await repoFile("src/pages/legal-content.tsx")).split("<p>").find((text) => text.includes("deliver them to the registry’s network are fixed"));
  assert.match(paragraph ?? "", /fixed\. They rely on Chainlink’s verifier and the networks’ bridge contracts, which the operators of those contracts can change\./);
});

test("Streams frontend ABI exactly matches committed read-only contract functions and excludes writes", async () => {
  for (const [name, abi] of [["StreamsRoundRegistry", streamsRegistryReadAbi], ["HorizenStreamsOracle", streamsOracleReadAbi]] as const) {
    const full = JSON.parse(await readFile(new URL(`../../contracts/abi/${name}.json`, import.meta.url), "utf8"));
    assert.deepEqual(abi, full.filter((e: { type: string; stateMutability?: string }) => e.type === "function" && ["view", "pure"].includes(e.stateMutability ?? "")));
    assert.ok(abi.every((e) => ["view", "pure"].includes(e.stateMutability)));
  }
});
