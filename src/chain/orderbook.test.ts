import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { concat, encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { OPERATOR_KEYS_CHANGED, REQUEST_TYPEHASH, engineRound, normalizeSignature, parseOrderbookManifest, permitDomainSeparator, requestTypedData, verifyOrderbook, type ConfiguredOrderbook } from "./orderbook-manifest.ts";
import { parseStreamsManifest, StreamsMismatchError, type StreamsReader } from "./streams-manifest.ts";
import { BASE_USDC, SUBTYPES, decodeCredit, decodePayout, decodeSettle, payoutTypedData, usdcPermitTypedData } from "./vault.ts";

const repoFile = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const committed = JSON.parse(await repoFile("public/deployments/26514-orderbook.json"));
const fixture = JSON.parse(await repoFile("src/chain/testdata/orderbook-configured.json"));
const streams = parseStreamsManifest(JSON.parse(await repoFile("public/deployments/26514.json")), 26514);
const RELAYER = "0x5555555555555555555555555555555555555555";
const configured = () => structuredClone(fixture);
const book = parseOrderbookManifest(configured()) as ConfiguredOrderbook;
const word = (t: string) => keccak256(stringToHex(t));
const words = (...w: bigint[]): Hex => concat(w.map((x) => `0x${x.toString(16).padStart(64, "0")}` as Hex));

test("the committed manifest is planned (nothing deployed yet); a configured one pins the engine, the trigger, Chainlink and the vault", () => {
  assert.deepEqual(parseOrderbookManifest(committed), { schemaVersion: 3, kind: "zedge-private-orderbook", chainId: 26514, status: "planned", release: committed.release });
  assert.equal(book.status, "configured");
  assert.equal(book.application.engine.authority, book.trigger.address);
  assert.equal(book.application.engine.collateral, "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c", "the engine's collateral stays the registry's: its rules hash commits to it");
  assert.equal(book.application.engine.oracle.rulesHash, streams.parameters.rulesHash);
  assert.equal(book.application.chainlink.configs[0].signers.length, 16);
  assert.equal(book.custody.usdc.address, BASE_USDC);
  assert.equal(book.trigger.inbox, book.custody.inbox.address);
  assert.ok(JSON.stringify(fixture).length <= 16_384);
});

test("the request authorization is the contract's own EIP-712 digest, rebuilt word by word, and recovers to its signer", async () => {
  assert.equal(word("RequestAuthorization(address sender,uint8 protocolVersion,uint64 applicationId,uint8 requestType,bytes32 payloadHash,address tokenAddress,uint256 assetAmount,uint256 nonce,uint256 deadline)"), REQUEST_TYPEHASH);
  const user = privateKeyToAccount(generatePrivateKey());
  const sender = user.address.toLowerCase() as Address;
  const payload: Hex = `0x${"ab".repeat(2076)}`;
  for (const f of [
    { sender, requestType: 1 as const, payload, tokenAddress: "0x0000000000000000000000000000000000000000" as Address, assetAmount: 0n, nonce: 7n, deadline: 1_791_301_620n },
    { sender, requestType: 1 as const, payload: "0x" as Hex, tokenAddress: RELAYER as Address, assetAmount: 20_000_000n, nonce: 0n, deadline: 1n },
    { sender, requestType: 3 as const, payload: `0x04${"11".repeat(132)}` as Hex, tokenAddress: "0x0000000000000000000000000000000000000000" as Address, assetAmount: 0n, nonce: 2n ** 255n, deadline: 2n ** 256n - 1n },
  ]) {
    const typed = requestTypedData(book, f);
    const domain = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [word("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), word("Vela"), word("0"), 26514n, book.endpoint.address]));
    const struct = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address, uint8, uint64, uint8, bytes32, address, uint256, uint256, uint256"),
      [REQUEST_TYPEHASH, f.sender, 0, 7225536188967924955n, f.requestType, keccak256(f.payload), f.tokenAddress, f.assetAmount, f.nonce, f.deadline]));
    assert.equal(hashTypedData(typed), keccak256(concat(["0x1901", domain, struct])));
    const signature = normalizeSignature(await user.signTypedData(typed));
    assert.equal((await recoverTypedDataAddress({ ...typed, signature })).toLowerCase(), sender);
    // Any other application, endpoint, nonce or payload is a different digest.
    assert.notEqual(hashTypedData(requestTypedData(book, { ...f, nonce: f.nonce + 1n })), hashTypedData(typed));
    assert.notEqual(hashTypedData(requestTypedData({ ...book, application: { ...book.application, id: "1" } }, f)), hashTypedData(typed));
  }
});

test("the deposit permit is Base USDC's own (the separator read on chain), to the vault, and the payout is the vault's EIP-712 digest", async () => {
  assert.equal(permitDomainSeparator("USD Coin", "2", BASE_USDC, 8453), "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f");
  assert.notEqual(permitDomainSeparator("USD Coin", "1", BASE_USDC, 8453), book.custody.usdc.permit.domainSeparator);
  const user = privateKeyToAccount(generatePrivateKey());
  const permit = usdcPermitTypedData(book.custody, { owner: user.address, value: 20_000_000n, nonce: 3n, deadline: 1_791_301_620n });
  assert.equal(permit.message.spender, book.custody.vault.address);
  const permitStruct = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address, address, uint256, uint256, uint256"),
    [word("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), user.address, book.custody.vault.address, 20_000_000n, 3n, 1_791_301_620n]));
  assert.equal(hashTypedData(permit), keccak256(concat(["0x1901", book.custody.usdc.permit.domainSeparator, permitStruct])));
  assert.equal(await recoverTypedDataAddress({ ...permit, signature: await user.signTypedData(permit) }), user.address);

  const p = { applicationId: 7225536188967924955n, ordinal: 4n, account: user.address, to: user.address, amount: 12_500_000n };
  const domain = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [word("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), word("ZEDGE Vault"), word("1"), 8453n, book.custody.vault.address]));
  const struct = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint64, uint64, address, address, uint256"),
    [word("Payout(uint64 applicationId,uint64 ordinal,address account,address to,uint256 amount)"), p.applicationId, p.ordinal, p.account, p.to, p.amount]));
  assert.equal(hashTypedData(payoutTypedData(book.custody, p)), keccak256(concat(["0x1901", domain, struct])));
  assert.notEqual(hashTypedData(payoutTypedData(book.custody, { ...p, ordinal: 5n })), hashTypedData(payoutTypedData(book.custody, p)), "each ordinal is paid once");
});

test("the guest's public events: subtypes are SHA-256 of their labels, and only an exact word count decodes", () => {
  assert.deepEqual([SUBTYPES.settle, SUBTYPES.credit, SUBTYPES.payout, SUBTYPES.confirm], [
    "0x9724dc1f896290cab5003edb2c481613b0c459f9303c263ec7329d4cb9a96b8a", "0xb1807d8ab6b87b4b474b995387ae70c1a0c01ddb90d1917c6d19137492025a83",
    "0x9fc2837b9dcfdefb06f5377ff328e142b9ed980ed670176fafad9020c17462e9", "0x5e1da736494552c71e66d707b803cd0347c26ea64f7b1dcb89d0c0375ce29b0a"]);
  assert.equal(SUBTYPES.tick.slice(0, 10), "0x8af869f3");
  const id = BigInt(`0x${engineRound(book, 1_791_301_500).id}`), account = BigInt(RELAYER);
  assert.deepEqual(decodeSettle(words(id, 2n, 1n, 10n ** 23n, 1_791_302_400n, 7n, 1n)), { roundId: `0x${engineRound(book, 1_791_301_500).id}`, kind: 2, outcome: 1, price: 10n ** 23n, observationsTimestamp: 1_791_302_400, reportHash: `0x${"7".padStart(64, "0")}`, source: 1 });
  assert.deepEqual(decodeCredit(words(9n, account, 5_000_000n, 1n, 0n)), { index: 9n, account: RELAYER, amount: 5_000_000n, status: 1, payout: 0n });
  assert.deepEqual(decodePayout(words(7225536188967924955n, 3n, 1n, account, account, 2_000_000n)), { applicationId: 7225536188967924955n, ordinal: 3n, kind: 1, account: RELAYER, to: RELAYER, amount: 2_000_000n });
  assert.equal(decodeCredit(words(9n, account, 5_000_000n, 1n)), null);
  assert.equal(decodePayout(`${words(1n, 2n, 3n, 4n, 5n, 6n)}00`), null);
});

test("signatures are normalized to 65 bytes with v 27 or 28, so every wallet kind derives the same key and OpenZeppelin recovers them", () => {
  const base = `0x${"12".repeat(64)}`;
  assert.equal(normalizeSignature(`${base}00`), `${base}1b`);
  assert.equal(normalizeSignature(`${base}01`), `${base}1c`);
  assert.equal(normalizeSignature(`${base.toUpperCase().replace("0X", "0x")}1B`), `${base}1b`);
  for (const bad of [`${base}02`, `${base}1d`, `${base}25`, base, `${base}1b00`, "0x", 42, null]) assert.throws(() => normalizeSignature(bad));
});

test("engine round IDs are computed offline exactly as the registry and the guest compute them", () => {
  const round = engineRound(book, 1_791_301_500);
  // The live round that opened at 21:15 IST on 2026-10-06 (records.txt).
  assert.equal(round.spec.registryRoundId, "0xc493319ec34e01cc4ced23a97543c50cefd4dc4d85a3dc502814b10256b3a3eb");
  assert.deepEqual([round.spec.cutoff, round.spec.openingDeadline, round.spec.voidableAfter], [1_791_302_370, 1_791_301_710, 1_791_302_760]);
  assert.match(round.id, /^[0-9a-f]{64}$/);
  assert.throws(() => engineRound(book, 1_791_301_501));
});

test("the parser is strict: unknown fields, other contracts, shared keys, a reordered engine configuration, a weak signer set or another USDC all fail", () => {
  const mutations: [string, (m: ReturnType<typeof configured>) => void][] = [
    ["extra field", (m) => { m.extra = 1; }],
    ["checksummed address", (m) => { m.endpoint.address = "0x0A2703d21b27757fdf27ab807eae9820788010f3"; }],
    ["short enclave key", (m) => { m.authenticator.enclavePublicKey = m.authenticator.enclavePublicKey.slice(0, -2); }],
    ["engine config spacing", (m) => { m.application.engineConfigJson = JSON.stringify(JSON.parse(m.application.engineConfigJson), null, 1); }],
    ["engine config names another endpoint", (m) => { m.application.engineConfigJson = m.application.engineConfigJson.replace(m.endpoint.address, RELAYER); }],
    ["rules hash", (m) => { m.application.sessionRulesHash = "0".repeat(64); }],
    ["fee", (m) => { m.application.engineConfigJson = m.application.engineConfigJson.replace('"feeBps":0', '"feeBps":1'); }],
    ["configured without relayer", (m) => { m.relayer.facilitator = null; }],
    ["planned with contracts", (m) => { m.status = "planned"; }],
    ["relayer is the house", (m) => { m.relayer.facilitator = m.application.house; }],
    ["payout signer is the relayer", (m) => { m.custody.vault.signer = m.relayer.facilitator; }],
    ["typehash", (m) => { m.endpoint.requestTypehash = `0x${"1".repeat(64)}`; }],
    ["insecure origin", (m) => { m.application.origin = "http://zedge-markets.vercel.app"; }],
    ["trigger reads another inbox", (m) => { m.trigger.inbox = `0x${"8".repeat(40)}`; }],
    ["another USDC", (m) => { m.custody.usdc.address = "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c"; }],
    ["permit version", (m) => { m.custody.usdc.permit.version = "1"; }],
    ["another messenger", (m) => { m.custody.messenger.base = RELAYER; }],
    ["deposit limits inverted", (m) => { m.custody.vault.limits.minDeposit = "600000000"; }],
    ["payout above the daily cap", (m) => { m.custody.vault.limits.maxPayout = "20000000000"; }],
    ["fewer than 3f + 1 signers", (m) => { m.application.chainlink.configs[0].signers.pop(); }],
    ["duplicate signer", (m) => { const s = m.application.chainlink.configs[0].signers; s[1] = s[0]; }],
    ["another feed", (m) => { m.application.chainlink.feedId = `0x0003b778${"0".repeat(56)}`; }],
  ];
  assert.ok(parseOrderbookManifest(configured()));
  for (const [name, mutate] of mutations) {
    const m = configured();
    mutate(m);
    assert.throws(() => parseOrderbookManifest(m), /manifest/, name);
  }
  assert.throws(() => parseOrderbookManifest({ ...committed, schemaVersion: 2 }), /manifest/);
});

/** Horizen and Base as a deployed book would answer, with overrides. */
function readers(overrides: Record<string, unknown> = {}, failing = ""): [StreamsReader, StreamsReader] {
  const m = book, t = m.trigger, v = m.custody.vault, e = m.endpoint.address;
  const answers: Record<string, unknown> = {
    [`${e}:REQUEST_AUTHORIZATION_TYPEHASH`]: REQUEST_TYPEHASH, [`${e}:minFeePerRequest`]: 1_000_000_000n, [`${e}:maxQueueSize`]: 10n,
    [`${e}:teeAuthenticator`]: m.authenticator.address, [`${e}:tokenAllowlist`]: m.tokenAllowlist.address, [`${e}:triggerContracts`]: t.address,
    [`${e}:feeCollector`]: m.endpoint.operator, [`${e}:applicationStateRoots`]: `0x${"9".repeat(64)}`,
    [`${e}:eip712Domain`]: ["0x0f", "Vela", "0", 26514n, e, `0x${"0".repeat(64)}`, []],
    [`${m.authenticator.address}:owner`]: m.authenticator.owner, [`${m.authenticator.address}:getTeeSigner`]: m.authenticator.teeSigner, [`${m.authenticator.address}:getPubSecp521r1`]: m.authenticator.enclavePublicKey,
    [`${t.address}:owner`]: t.owner, [`${t.address}:processorEndpoint`]: e, [`${t.address}:registry`]: t.registry, [`${t.address}:inbox`]: t.inbox, [`${t.address}:asset`]: 0, [`${t.address}:duration`]: 900,
    [`${m.custody.inbox.address}:owner`]: m.custody.inbox.owner,
    [`${v.address}:owner`]: v.owner, [`${v.address}:signer`]: v.signer, [`${v.address}:inbox`]: m.custody.inbox.address,
    [`${v.address}:limits`]: Object.fromEntries(Object.entries(v.limits).map(([k, x]) => [k, BigInt(x)])),
    [`${v.address}:eip712Domain`]: ["0x0f", "ZEDGE Vault", "1", 8453n, v.address, `0x${"0".repeat(64)}`, []],
    [`${BASE_USDC}:DOMAIN_SEPARATOR`]: m.custody.usdc.permit.domainSeparator,
    ...overrides,
  };
  const code = (hash: Hex): Hex => `0x${hash.slice(2)}`;
  const codes: Record<string, Hex> = { [t.address]: "0x60", [v.address]: "0x60", [m.custody.inbox.address]: "0x60",
    [t.implementation]: code(t.implementationCodeHash), [v.implementation]: code(v.implementationCodeHash), [m.custody.inbox.implementation]: code(m.custody.inbox.implementationCodeHash) };
  for (const pin of [m.endpoint, m.authenticator, m.tokenAllowlist]) codes[pin.address] = code(pin.runtimeCodeHash);
  const slots: Record<string, Hex> = { [t.address]: `0x${t.implementation.slice(2).padStart(64, "0")}`, [v.address]: `0x${v.implementation.slice(2).padStart(64, "0")}`,
    [m.custody.inbox.address]: `0x${m.custody.inbox.implementation.slice(2).padStart(64, "0")}`, ...(overrides.slots as Record<string, Hex> | undefined) };
  const one = (chainId: number): StreamsReader => ({
    chainId: async () => Number(overrides[`chainId:${chainId}`] ?? chainId),
    code: async (address) => codes[address],
    storage: async (address) => slots[address],
    read: async (address, signature) => {
      const key = `${address}:${signature.slice(0, signature.indexOf("("))}`;
      if (key === failing) throw new Error("rpc timeout");
      if (!(key in answers)) throw new Error(`unexpected read ${key}`);
      return answers[key];
    },
  });
  return [one(26514), one(8453)];
}
// The fake readers serve each contract's pinned hash as its code; pin the keccak of those bytes instead.
const verifiable = () => {
  const m = parseOrderbookManifest(configured()) as ConfiguredOrderbook;
  for (const pin of [m.endpoint, m.authenticator, m.tokenAllowlist]) pin.runtimeCodeHash = keccak256(`0x${pin.runtimeCodeHash.slice(2)}`);
  for (const p of [m.trigger, m.custody.vault, m.custody.inbox]) p.implementationCodeHash = keccak256(`0x${p.implementationCodeHash.slice(2)}`);
  return m;
};

test("verification passes on the deployment as read, and fails closed on a new executor key, a rebinding, another vault signer or an upgrade", async () => {
  const m = verifiable();
  assert.equal((await verifyOrderbook(m, streams, ...readers())).verified, true);
  await assert.rejects(verifyOrderbook(parseOrderbookManifest(committed), streams, ...readers()), /not open yet/);
  for (const [field, value] of [[`${m.authenticator.address}:getPubSecp521r1`, `0x04${"7".repeat(264)}`], [`${m.authenticator.address}:getTeeSigner`, RELAYER], [`${m.authenticator.address}:owner`, RELAYER]] as const) {
    await assert.rejects(verifyOrderbook(m, streams, ...readers({ [field]: value })), (e: Error) => e instanceof StreamsMismatchError && e.message === OPERATOR_KEYS_CHANGED, field);
  }
  const v = m.custody.vault.address;
  for (const [field, value] of [
    [`${m.trigger.address}:asset`, 1], [`${m.trigger.address}:inbox`, RELAYER], [`${m.trigger.address}:owner`, RELAYER], [`${m.endpoint.address}:triggerContracts`, RELAYER],
    [`${m.endpoint.address}:applicationStateRoots`, `0x${"0".repeat(64)}`], [`${m.endpoint.address}:eip712Domain`, ["0x0f", "Vela", "1", 26514n, m.endpoint.address, `0x${"0".repeat(64)}`, []]],
    [`${v}:signer`, RELAYER], [`${v}:inbox`, RELAYER], [`${v}:limits`, { minDeposit: 1n, maxDeposit: 500_000_000n, maxPayout: 1_000_000_000n, dailyPayoutCap: 10_000_000_000n }],
    [`${v}:eip712Domain`, ["0x0f", "ZEDGE Vault", "1", 1n, v, `0x${"0".repeat(64)}`, []]], [`${BASE_USDC}:DOMAIN_SEPARATOR`, `0x${"1".repeat(64)}`],
    [`${m.custody.inbox.address}:owner`, RELAYER], ["chainId:26514", 1], ["chainId:8453", 1], ["slots", { [v]: `0x${"8".repeat(64)}` }],
  ] as const) {
    await assert.rejects(verifyOrderbook(m, streams, ...readers({ [field]: value })), StreamsMismatchError, field);
  }
  const code = verifiable(); code.custody.vault.implementationCodeHash = `0x${"3".repeat(64)}`;
  await assert.rejects(verifyOrderbook(code, streams, ...readers()), StreamsMismatchError);
  // A read that failed is not a mismatch: retrying can help.
  await assert.rejects(verifyOrderbook(m, streams, ...readers({}, `${m.trigger.address}:registry`)), (e: Error) => !(e instanceof StreamsMismatchError) && /timeout/.test(e.message));
  // The engine must read the verified streams release.
  const other = structuredClone(streams); other.parameters.cutoffBuffer = "31";
  await assert.rejects(verifyOrderbook(m, other, ...readers()), StreamsMismatchError);
});
