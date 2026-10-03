import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { keccak256, type Address, type Hex } from "viem";
import { appMode } from "./mode.ts";
import { DEFAULT_NETWORK, parseAtomicAmount, parseChainId, publicError, transactionExplorerUrl, type NetworkId } from "./networks.ts";
import { firstAccount } from "./wallet.ts";
import { parseManifest, requireTradingReady, verifyDeployment, type ConfiguredManifest, type DeploymentReader } from "./manifest.ts";
import { observationPrice } from "./gateway.ts";
import { registryReadAbi, oracleReadAbi } from "./abi.ts";

const code: Hex = "0x60006000";
const pin = (n: number) => ({ address: `0x${n.toString(16).padStart(40, "0")}` as Address, runtimeCodeHash: keccak256(code) });
const fixture = (): ConfiguredManifest => ({
  schemaVersion: 1, chainId: 2651420, status: "configured", release: "test-fixture", rolePolicy: "immutable-no-admin",
  contracts: { registry: pin(1), oracle: pin(2), provider: pin(3), collateral: pin(4) },
  parameters: { observationWindow: "10", openingGrace: "20", settlementGrace: "60", cutoffBuffer: "5", maxConfidenceBps: "100", btcFeedId: `0x${"11".repeat(32)}`, ethFeedId: `0x${"22".repeat(32)}`, rulesHash: `0x${"33".repeat(32)}`, btcExponent: -8, ethExponent: -8, collateralDecimals: 6 },
});

function reader(manifest = fixture()): DeploymentReader {
  return {
    chainId: async () => manifest.chainId,
    code: async () => code,
    storage: async () => `0x${"0".repeat(64)}`,
    read: async (address, field) => {
      if (field === "version") return address === manifest.contracts.registry.address ? "zedge-round-registry-v1" : "zedge-pyth-boundary-v1";
      if (field === "oracle" || field === "collateral") return manifest.contracts[field].address;
      if (field === "pyth") return manifest.contracts.provider.address;
      if (field === "deploymentChainId") return BigInt(manifest.chainId);
      if (field === "decimals") return manifest.parameters.collateralDecimals;
      const value = manifest.parameters[field as keyof typeof manifest.parameters];
      return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value;
    },
  };
}

test("mode is selected before either app mounts, defaults to demo only, with explicit chain routes", () => {
  assert.equal(appMode("?mode=chain"), "chain");
  assert.equal(appMode("?mode=chain&other=1", "#/portfolio"), "chain");
  assert.equal(appMode("", "#/chain"), "chain");
  assert.equal(appMode("", "#/chain/markets"), "chain");
  assert.equal(appMode("?mode=demo", "#/trade/btc-5m"), "demo");
  assert.equal(appMode("?mode=demo", "#/chain"), "demo");
  assert.equal(appMode("?mode=chainish", "#/chainish"), "demo");
  assert.equal(DEFAULT_NETWORK, 2651420);
});

test("atomic amounts preserve precision beyond safe Number range and reject ambiguous input", () => {
  assert.equal(parseAtomicAmount("9007199254740993.000001", 6), 9007199254740993000001n);
  assert.equal(parseAtomicAmount("0.000000000000000001", 18), 1n);
  for (const invalid of ["1e3", " 1", "1 ", "1,000", "-1", "+1", "01", ".5", "1.", "0", "0.0", "NaN", "Infinity", "1.0000001"]) assert.throws(() => parseAtomicAmount(invalid, 6));
  assert.throws(() => parseAtomicAmount((2n ** 256n).toString(), 0));
});

test("wallet network and account parsers reject malformed or unsafe identifiers", () => {
  assert.equal(parseChainId("0x28751c"), 2651420);
  assert.equal(firstAccount([]), null);
  assert.equal(firstAccount([pin(1).address]), pin(1).address);
  for (const invalid of ["2651420", "0x0", "0x20000000000000", 2651420, null]) assert.throws(() => parseChainId(invalid));
  assert.throws(() => firstAccount(["not-an-address"]));
  assert.throws(() => firstAccount({ address: pin(1).address }));
});

test("wallet errors expose actionable categories without echoing sensitive provider payloads", () => {
  assert.match(publicError({ code: 4001 }), /cancelled/);
  assert.match(publicError({ code: -32002 }), /already waiting/);
  assert.match(publicError({ code: 4902 }), /not configured/);
  assert.doesNotMatch(publicError(new Error("private-order-plaintext")), /private-order-plaintext/);
});

test("transaction explorer links accept only full hashes on allowlisted HTTPS origins", () => {
  const hash = `0x${"aB".repeat(32)}`;
  assert.equal(transactionExplorerUrl(2651420, hash), `https://explorer-testnet.horizen.io/tx/${hash}`);
  assert.equal(transactionExplorerUrl(26514, hash), `https://explorer.horizen.io/tx/${hash}`);
  for (const invalid of [
    "javascript:alert(1)", "//attacker.example/tx/1", "../settings", "/tx/1?redirect=evil",
    `${hash}?redirect=evil`, `${hash}#fragment`, `${hash}/../settings`, `${hash}\n`,
    `${hash}\r`, `${hash}" onclick="alert(1)`, "%30x" + "ab".repeat(32),
    "0x" + "g".repeat(64), "0x" + "a".repeat(63), "0x" + "a".repeat(65),
  ]) assert.throws(() => transactionExplorerUrl(2651420, invalid), /Invalid transaction hash/);
  assert.throws(() => transactionExplorerUrl(1 as NetworkId, hash), /Unsupported explorer network/);
});

test("deployment manifests fail closed on unknown versions, chain, addresses and policies", () => {
  assert.equal(parseManifest(fixture(), 2651420).status, "configured");
  for (const value of [
    { ...fixture(), chainId: 26514 }, { ...fixture(), schemaVersion: 2 },
    { ...fixture(), rolePolicy: "upgradeable" }, { ...fixture(), enableTrading: true },
    { ...fixture(), contracts: { ...fixture().contracts, oracle: pin(1) } },
    { ...fixture(), contracts: { ...fixture().contracts, provider: pin(0) } },
    { ...fixture(), parameters: { ...fixture().parameters, collateralDecimals: "6" } },
    { ...fixture(), parameters: { ...fixture().parameters, observationWindow: "300" } },
    { ...fixture(), parameters: { ...fixture().parameters, observationWindow: "61" } },
    { ...fixture(), parameters: { ...fixture().parameters, settlementGrace: "86400" } },
    { ...fixture(), parameters: { ...fixture().parameters, ethFeedId: fixture().parameters.btcFeedId } },
  ]) assert.throws(() => parseManifest(value, 2651420));
  assert.equal(parseManifest({ ...fixture(), parameters: { ...fixture().parameters, observationWindow: "0" } }, 2651420).status, "configured");
});

test("contract verification checks real chain, code presence and hashes before trusting bindings", async () => {
  const manifest = fixture();
  assert.equal((await verifyDeployment(manifest, reader())).verified, true);
  await assert.rejects(verifyDeployment(manifest, { ...reader(), chainId: async () => 1 }), /network/);
  await assert.rejects(verifyDeployment(manifest, { ...reader(), code: async () => "0x" }), /code/);
  await assert.rejects(verifyDeployment(manifest, { ...reader(), code: async () => "0x6001" }), /code/);
  await assert.rejects(verifyDeployment(manifest, { ...reader(), storage: async () => `0x${"0".repeat(63)}1` }), /Proxy/);
  await assert.rejects(verifyDeployment(manifest, { ...reader(), storage: async () => undefined }), /Proxy/);
});

test("altered contract identity, collateral, provider or rules fail verification", async () => {
  for (const field of ["version", "oracle", "collateral", "pyth", "deploymentChainId", "decimals", "rulesHash", "openingGrace", "cutoffBuffer", "btcFeedId"]) {
    const base = reader();
    await assert.rejects(verifyDeployment(fixture(), { ...base, read: (address, name) => name === field ? Promise.resolve("unexpected") : base.read(address, name) }), /bindings|policy/);
  }
});

test("the current release declares both networks unavailable and cannot enable trading", async () => {
  for (const id of [2651420, 26514] as const) {
    const data = JSON.parse(await readFile(new URL(`../../public/deployments/${id}.json`, import.meta.url), "utf8")) as unknown;
    assert.equal(parseManifest(data, id).status, "unavailable");
  }
  assert.throws(requireTradingReady, /No transaction was submitted/);
});

test("read-only contract ABI excludes every transaction entrypoint", () => {
  for (const entry of [...registryReadAbi, ...oracleReadAbi]) assert.ok(entry.stateMutability === "view" || entry.stateMutability === "pure");
  assert.ok(registryReadAbi.some((entry) => entry.name === "getRound"));
  assert.ok(registryReadAbi.some((entry) => entry.name === "phase"));
});

test("oracle display uses integer arithmetic and never treats missing prices as zero", () => {
  assert.equal(observationPrice(9739064000000n, -8), "$97,390.64");
  assert.throws(() => observationPrice(0n, -8));
  assert.throws(() => observationPrice(-1n, -8));
  assert.throws(() => observationPrice(1n, -19));
});
