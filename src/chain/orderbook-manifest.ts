/** The private order book's public deployment pins and its chain-facing definitions (request authorization, the Base deposit
 * permit, events), shared by the browser and the relayer so both build and check exactly the same bytes. viem only; no DOM. */
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, sha256, stringToHex, type Address, type Hex } from "viem";
import { STREAMS_SLOTS, StreamsMismatchError, type StreamsManifest, type StreamsReader } from "./streams-manifest.ts";
import { BASE_CHAIN_ID, EIP712_DOMAIN, PERMIT_TYPES, parseCustody, permitDomainSeparator, verifyCustody, type Custody } from "./vault.ts";

export { EIP712_DOMAIN, PERMIT_TYPES, permitDomainSeparator };

export const ORDERBOOK_PLANNED_REASON = "Private trading is not open yet.";
export const OPERATOR_KEYS_CHANGED = "The private exchange's operator keys changed. Private features are paused until this site is updated.";
export const REQUEST_TYPEHASH = "0x952140b6347f31bf88278b2d6fb6365ec837393094e7a1f12b6dffbdc1333340";
export const PROCESS = 1, ASSOCIATEKEY = 3;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const SHARE = 1_000_000, LOT = 1_000;

type Pin = { address: Address; runtimeCodeHash: Hex };
export type EngineConfig = {
  domain: { chainId: number; endpoint: Address; applicationId: string; rulesVersion: number };
  authority: Address; collateral: Address; feeBps: 0;
  oracle: { chainId: number; registry: Address; oracle: Address; rulesHash: Hex; btcFeedId: Hex; ethFeedId: Hex; decimals: number; observationWindow: number; openingGrace: number; voidGrace: number; cutoffBuffer: number };
};
/** The Chainlink DON configurations the guest accepts reports from (guest deploy parameter `chainlink`). */
export type ChainlinkPins = { feedId: Hex; configs: { digest: Hex; f: number; signers: Address[] }[] };
type Head = { schemaVersion: 3; kind: "zedge-private-orderbook"; chainId: 26514; release: string };
/** Nothing deployed yet: the site and the relayer stay closed. */
export type PlannedOrderbook = Head & { status: "planned" };
export type ConfiguredOrderbook = Head & {
  status: "configured";
  endpoint: Pin & { eip712: { name: "Vela"; version: "0" }; requestTypehash: Hex; protocolVersion: 0; minFeePerRequestWei: string; maxQueueSize: string; operator: Address };
  authenticator: Pin & { owner: Address; teeSigner: Address; enclavePublicKey: Hex };
  tokenAllowlist: Pin;
  /** The book's clock and the engine's authority, behind a UUPS proxy. */
  trigger: { address: Address; implementation: Address; implementationCodeHash: Hex; owner: Address; registry: Address; inbox: Address; asset: 0; duration: 900 };
  application: { id: string; wasmSha256: string; origin: string; epoch: string; engineConfigJson: string; sessionRulesHash: string; markets: [{ asset: "BTC"; duration: 900 }];
    house: Address; stakeLimits: { account: string; boundary: string; houseTotal: string }; deployTx: Hex; deployBlock: number; chainlink: ChainlinkPins; engine: EngineConfig };
  /** Users' USDC: deposited once into the Base vault, paid out from it (vault.ts). */
  custody: Custody;
  relayer: { path: "/api/relay"; facilitator: Address };
};
export type OrderbookManifest = PlannedOrderbook | ConfiguredOrderbook;

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.toSorted().join(",")) throw new Error("Unsupported order book manifest fields.");
  return value as Record<string, unknown>;
}
const fail = (): never => { throw new Error("Invalid order book manifest."); };
const address = (v: unknown): Address => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v) ? v as Address : fail();
const hash = (v: unknown): Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && !/^0x0{64}$/.test(v) ? v as Hex : fail();
const hex64 = (v: unknown): string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : fail();
const decimal = (v: unknown, max: bigint): string => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= max ? v : fail();
const pin = (v: unknown, extra: string[]) => { const r = object(v, ["address", "runtimeCodeHash", ...extra]); return { r, pin: { address: address(r.address), runtimeCodeHash: hash(r.runtimeCodeHash) } }; };

/** Schema 3: planned (only the five head fields) or configured (every contract deployed and the relayer named). */
export function parseOrderbookManifest(value: unknown): OrderbookManifest {
  const status = value && typeof value === "object" ? (value as Record<string, unknown>).status : undefined;
  const r = object(value, status === "planned" ? ["schemaVersion", "kind", "chainId", "status", "release"]
    : ["schemaVersion", "kind", "chainId", "status", "release", "endpoint", "authenticator", "tokenAllowlist", "trigger", "application", "custody", "relayer"]);
  if (r.schemaVersion !== 3 || r.kind !== "zedge-private-orderbook" || r.chainId !== 26514 || (status !== "planned" && status !== "configured") || typeof r.release !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(r.release)) fail();
  const head: Head = { schemaVersion: 3, kind: "zedge-private-orderbook", chainId: 26514, release: r.release as string };
  if (status === "planned") return { ...head, status: "planned" };
  const e = pin(r.endpoint, ["eip712", "requestTypehash", "protocolVersion", "minFeePerRequestWei", "maxQueueSize", "operator"]);
  const eip712 = object(e.r.eip712, ["name", "version"]);
  if (eip712.name !== "Vela" || eip712.version !== "0" || e.r.requestTypehash !== REQUEST_TYPEHASH || e.r.protocolVersion !== 0) fail();
  const endpoint = { ...e.pin, eip712: { name: "Vela", version: "0" }, requestTypehash: REQUEST_TYPEHASH, protocolVersion: 0, minFeePerRequestWei: decimal(e.r.minFeePerRequestWei, 10n ** 15n),
    maxQueueSize: decimal(e.r.maxQueueSize, 1000n), operator: address(e.r.operator) } as const;
  const au = pin(r.authenticator, ["owner", "teeSigner", "enclavePublicKey"]);
  if (typeof au.r.enclavePublicKey !== "string" || !/^0x04[0-9a-f]{264}$/.test(au.r.enclavePublicKey)) fail();
  const authenticator = { ...au.pin, owner: address(au.r.owner), teeSigner: address(au.r.teeSigner), enclavePublicKey: au.r.enclavePublicKey as Hex };
  const tokenAllowlist = pin(r.tokenAllowlist, []).pin;
  const t = object(r.trigger, ["address", "implementation", "implementationCodeHash", "owner", "registry", "inbox", "asset", "duration"]);
  if (t.asset !== 0 || t.duration !== 900) fail();
  const trigger = { address: address(t.address), implementation: address(t.implementation), implementationCodeHash: hash(t.implementationCodeHash), owner: address(t.owner),
    registry: address(t.registry), inbox: address(t.inbox), asset: 0, duration: 900 } as const;
  const a = object(r.application, ["id", "wasmSha256", "origin", "epoch", "engineConfigJson", "sessionRulesHash", "markets", "house", "stakeLimits", "deployTx", "deployBlock", "chainlink"]);
  if (typeof a.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(a.id) || BigInt(a.id) >= 2n ** 64n || typeof a.origin !== "string" || !/^https:\/\/[a-z0-9.-]+$|^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(a.origin) ||
    a.epoch !== "1" || JSON.stringify(a.markets) !== '[{"asset":"BTC","duration":900}]' || typeof a.deployBlock !== "number" || !Number.isSafeInteger(a.deployBlock) || a.deployBlock < 1 || typeof a.engineConfigJson !== "string" || a.engineConfigJson.length > 4096) fail();
  const limits = object(a.stakeLimits, ["account", "boundary", "houseTotal"]);
  const engine = engineConfig(a.engineConfigJson as string);
  const application = { id: a.id as string, wasmSha256: hex64(a.wasmSha256), origin: a.origin as string, epoch: "1", engineConfigJson: a.engineConfigJson as string, sessionRulesHash: hex64(a.sessionRulesHash),
    markets: [{ asset: "BTC", duration: 900 }] as [{ asset: "BTC"; duration: 900 }], house: address(a.house),
    stakeLimits: { account: decimal(limits.account, 10n ** 15n), boundary: decimal(limits.boundary, 10n ** 15n), houseTotal: decimal(limits.houseTotal, 10n ** 15n) },
    deployTx: hash(a.deployTx), deployBlock: a.deployBlock as number, chainlink: chainlink(a.chainlink, engine.oracle.btcFeedId), engine };
  if (sha256(stringToHex(application.engineConfigJson)).slice(2) !== application.sessionRulesHash) fail();
  const custody = parseCustody(r.custody);
  const relayer = object(r.relayer, ["path", "facilitator"]);
  if (relayer.path !== "/api/relay") fail();
  const m: ConfiguredOrderbook = { ...head, status: "configured", endpoint, authenticator, tokenAllowlist, trigger, application, custody, relayer: { path: "/api/relay", facilitator: address(relayer.facilitator) } };
  const g = m.application.engine;
  // The guest checks every request against this configuration; a manifest that names other contracts than it is refused here.
  if (g.domain.chainId !== 26514 || g.domain.endpoint !== endpoint.address || g.domain.applicationId !== application.id || g.authority !== trigger.address ||
    g.oracle.chainId !== 26514 || g.oracle.registry !== trigger.registry || trigger.inbox !== custody.inbox.address) fail();
  // One key per role: the payout signer never shares the relayer's key or Base nonce.
  const roles = [endpoint.address, authenticator.address, tokenAllowlist.address, trigger.address, trigger.implementation, application.house, endpoint.operator, m.relayer.facilitator,
    custody.vault.address, custody.vault.implementation, custody.vault.signer, custody.inbox.address, custody.inbox.implementation];
  if (new Set(roles).size !== roles.length) fail();
  return m;
}

function chainlink(value: unknown, feedId: Hex): ChainlinkPins {
  const r = object(value, ["feedId", "configs"]);
  if (r.feedId !== feedId || !Array.isArray(r.configs) || r.configs.length < 1 || r.configs.length > 4) fail();
  const configs = (r.configs as unknown[]).map((c) => {
    const o = object(c, ["digest", "f", "signers"]);
    if (typeof o.f !== "number" || !Number.isSafeInteger(o.f) || o.f < 1 || o.f > 10 || !Array.isArray(o.signers) || o.signers.length < 3 * o.f + 1 || o.signers.length > 31) fail();
    const signers = (o.signers as unknown[]).map(address);
    if (new Set(signers).size !== signers.length) fail();
    return { digest: hash(o.digest), f: o.f as number, signers };
  });
  if (new Set(configs.map((c) => c.digest)).size !== configs.length) fail();
  return { feedId, configs };
}

function engineConfig(json: string): EngineConfig {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return fail(); }
  const r = object(v, ["domain", "authority", "collateral", "feeBps", "oracle"]);
  const d = object(r.domain, ["chainId", "endpoint", "applicationId", "rulesVersion"]);
  const o = object(r.oracle, ["chainId", "registry", "oracle", "rulesHash", "btcFeedId", "ethFeedId", "decimals", "observationWindow", "openingGrace", "voidGrace", "cutoffBuffer"]);
  const int = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : fail();
  if (r.feeBps !== 0 || d.rulesVersion !== 3 || typeof d.applicationId !== "string" || o.decimals !== 18) fail();
  const config: EngineConfig = { domain: { chainId: int(d.chainId), endpoint: address(d.endpoint), applicationId: d.applicationId as string, rulesVersion: 3 }, authority: address(r.authority), collateral: address(r.collateral), feeBps: 0,
    oracle: { chainId: int(o.chainId), registry: address(o.registry), oracle: address(o.oracle), rulesHash: hash(o.rulesHash), btcFeedId: hash(o.btcFeedId), ethFeedId: hash(o.ethFeedId), decimals: 18,
      observationWindow: int(o.observationWindow), openingGrace: int(o.openingGrace), voidGrace: int(o.voidGrace), cutoffBuffer: int(o.cutoffBuffer) } };
  // Re-serialized in the guest's key order: a reordered or re-spaced string would hash differently from what the guest stores.
  if (JSON.stringify(config) !== json) fail();
  return config;
}

// ---------------------------------------------------------------- typed data: the one definition the browser signs and the relayer recovers

export const REQUEST_TYPES = { EIP712Domain: EIP712_DOMAIN, RequestAuthorization: [
  { name: "sender", type: "address" }, { name: "protocolVersion", type: "uint8" }, { name: "applicationId", type: "uint64" }, { name: "requestType", type: "uint8" },
  { name: "payloadHash", type: "bytes32" }, { name: "tokenAddress", type: "address" }, { name: "assetAmount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;

type BookPins = Pick<ConfiguredOrderbook, "chainId" | "endpoint" | "application">;
export type RequestFields = { sender: Address; requestType: typeof PROCESS | typeof ASSOCIATEKEY; payload: Hex; tokenAddress: Address; assetAmount: bigint; nonce: bigint; deadline: bigint };
export function requestTypedData(book: BookPins, f: RequestFields) {
  return { domain: { name: "Vela", version: "0", chainId: BigInt(book.chainId), verifyingContract: book.endpoint.address }, types: REQUEST_TYPES, primaryType: "RequestAuthorization" as const,
    message: { sender: f.sender, protocolVersion: 0, applicationId: BigInt(book.application.id), requestType: f.requestType, payloadHash: keccak256(f.payload), tokenAddress: f.tokenAddress,
      assetAmount: f.assetAmount, nonce: f.nonce, deadline: f.deadline } };
}

/** What ZEDGE's signer signs: this book's request authorization on Horizen, and a Base USDC permit to this book's vault of at most
 * the vault's largest deposit. Anything else is refused before the wallet sees it. */
export function signable(book: BookPins & Pick<ConfiguredOrderbook, "custody">, data: { domain: { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string }; primaryType: string; message: Record<string, unknown> }): boolean {
  const d = data.domain, m = data.message, lower = (v: unknown) => String(v).toLowerCase(), int = (v: unknown) => typeof v === "bigint" ? v : -1n;
  const chainId = BigInt(d.chainId ?? 0), c = book.custody;
  if (data.primaryType === "RequestAuthorization") return chainId === BigInt(book.chainId) && d.name === "Vela" && lower(d.verifyingContract) === book.endpoint.address && int(m.applicationId) === BigInt(book.application.id);
  return data.primaryType === "Permit" && chainId === BigInt(BASE_CHAIN_ID) && d.name === c.usdc.permit.name && d.version === c.usdc.permit.version && lower(d.verifyingContract) === c.usdc.address &&
    lower(m.spender) === c.vault.address && int(m.value) > 0n && int(m.value) <= BigInt(c.vault.limits.maxDeposit);
}
/** The start of the one message ZEDGE asks a wallet to sign: the private-data key challenge (adapters/vela/crypto/session.ts). */
export const KEY_CHALLENGE_START = "ZEDGE private data key — evaluation only\n";

/** 65 bytes with v = 27 or 28: OpenZeppelin's ECDSA.recover and the token's permit need it, and the key derivation hashes these exact bytes. */
export function normalizeSignature(signature: unknown): Hex {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("The wallet returned an unexpected signature.");
  const v = Number.parseInt(signature.slice(130), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) throw new Error("The wallet returned an unexpected signature.");
  return `${signature.slice(0, 130).toLowerCase()}${(v < 27 ? v + 27 : v).toString(16)}` as Hex;
}
/** The 96-byte `abi.encode(uint8 v, bytes32 r, bytes32 s)` that submitRequestFor decodes. */
export function encodePermit(signature: Hex): Hex {
  const s = normalizeSignature(signature);
  return encodeAbiParameters(parseAbiParameters("uint8, bytes32, bytes32"), [Number.parseInt(s.slice(130), 16), `0x${s.slice(2, 66)}`, `0x${s.slice(66, 130)}`]);
}

export const endpointAbi = parseAbi([
  "function submitRequestFor(address sender, uint8 protocolVersion, uint64 applicationId, uint8 requestType, bytes payload, address tokenAddress, uint256 assetAmount, uint256 deadline, bytes requestSignature, bytes depositPermit) payable returns (bytes32)",
  "function claim(address tokenAddress, address payee)",
  "function facilitatorNonces(address) view returns (uint256)", "function getPendingRequestsSize() view returns (uint256)", "function pendingClaims(address, address) view returns (uint256)",
  "event RequestSubmitted(uint64 indexed applicationId, bytes32 indexed requestId, address indexed sender, address facilitator)",
  "event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
  "event UserEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes encryptedData)",
  "event Refund(uint64 indexed applicationId, bytes32 indexed requestId, address indexed to, address tokenAddress, uint256 amount)",
  "event Withdrawal(uint64 indexed applicationId, bytes32 indexed requestId, address indexed to, address tokenAddress, uint256 amount)",
  "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
  "event PaymentWithdrawn(address tokenAddress, address indexed payee, uint256 amount)",
  "error FeeValueBelowMinimum()", "error InvalidValue()", "error InvalidProtocolVersion()", "error InvalidApplicationId()", "error InvalidSignature()", "error InvalidPayload()",
  "error QueueThresholdExceeded()", "error TransferFailed()", "error InvalidRequestType()", "error TransferAmountMismatch()", "error DeadlineExpired()", "error InvalidSigner()", "error InvalidPermit()", "error TokenNotAllowed()",
  "error ECDSAInvalidSignature()", "error ECDSAInvalidSignatureLength(uint256 length)", "error ECDSAInvalidSignatureS(bytes32 s)", "error ReentrancyGuardReentrantCall()", "error SafeERC20FailedOperation(address token)",
]);

// ---------------------------------------------------------------- engine rounds (as fork-round.mjs builds them)

export type EngineRoundSpec = { asset: "BTC"; feed: Hex; registryRoundId: Hex; start: number; end: number; cutoff: number; observationWindow: number; openingDeadline: number; voidableAfter: number };
export function engineRound(book: Pick<ConfiguredOrderbook, "application">, start: number): { id: string; spec: EngineRoundSpec } {
  const o = book.application.engine.oracle, duration = 900;
  if (!Number.isSafeInteger(start) || start % duration !== 0) throw new Error("Invalid round start.");
  const registryRoundId = keccak256(encodeAbiParameters(parseAbiParameters("uint256, address, bytes32, uint8, uint32, uint64"), [26514n, o.registry, o.rulesHash, 0, duration, BigInt(start)]));
  const spec: EngineRoundSpec = { asset: "BTC", feed: o.btcFeedId, registryRoundId, start, end: start + duration, cutoff: start + duration - o.cutoffBuffer, observationWindow: o.observationWindow,
    openingDeadline: start + o.observationWindow + o.openingGrace, voidableAfter: start + duration + o.observationWindow + o.voidGrace };
  return { id: sha256(stringToHex(`{"config":${book.application.engineConfigJson},"round":${JSON.stringify(spec)}}`)).slice(2), spec };
}

// ---------------------------------------------------------------- verification against the chain, at one block

/** `withdrawOnly`: the trigger proxy runs WITHDRAW_ONLY_TRIGGER, so the application credits no new deposit (it is being replaced,
 * docs/cutover-politics.md): its balances can still be withdrawn, and the site offers nothing else. */
export type VerifiedOrderbook = { manifest: ConfiguredOrderbook; verified: true; withdrawOnly?: true };

/** The trigger implementations a book's proxy may run: the manifest's own (`trigger.implementation`, pinned by address and code hash),
 * or WithdrawOnlyBookClockTrigger (adapters/vela/stack/contracts), which the cutover's freeze deploys at an address only the deployer's
 * nonce decides. So that one is pinned by its code: the Keccak-256 of its runtime with its one immutable, UUPS's own address, zeroed
 * at these byte offsets, where the deployed code must hold exactly its own address. Measured on the forge build that reproduces the
 * live BookClockTrigger 0x6f85… byte for byte (same offsets there). */
export const WITHDRAW_ONLY_TRIGGER = { codeHash: "0x92103c702b6d02b2ef76c06e80b9b477ea1454b9755fe287142fe080b83ac706" as Hex, self: [2711, 2752, 3057] } as const;
/** Whether `code`, deployed at `at`, is the pinned code. */
export function runsPinnedCode(code: Hex | undefined, at: Address, pin: { codeHash: Hex; self: readonly number[] }): boolean {
  let hex = code?.slice(2).toLowerCase() ?? "";
  const word = at.slice(2).toLowerCase().padStart(64, "0");
  for (const start of pin.self) {
    if (hex.slice(2 * start, 2 * start + 64) !== word) return false;
    hex = `${hex.slice(0, 2 * start)}${"0".repeat(64)}${hex.slice(2 * start + 64)}`;
  }
  return keccak256(`0x${hex}`) === pin.codeHash;
}

/** Release identity and operator-key checks at the readers' blocks (Horizen, and Base for the vault). Fails closed on any change,
 * including a new executor key. `streams` is the already-verified streams manifest: the engine configuration must name its
 * registry, oracle, rules, feeds and collateral. */
export async function verifyOrderbook(m: OrderbookManifest, streams: StreamsManifest, reader: StreamsReader, base: StreamsReader, frozen = WITHDRAW_ONLY_TRIGGER): Promise<VerifiedOrderbook> {
  if (m.status !== "configured") throw new Error(ORDERBOOK_PLANNED_REASON);
  const mismatch = (ok: boolean, message = "Private order book checks did not pass.") => { if (!ok) throw new StreamsMismatchError(message); };
  const g = m.application.engine, o = g.oracle, p = streams.parameters;
  mismatch(o.registry === streams.contracts.registry.address.toLowerCase() && o.oracle === streams.contracts.oracle.address.toLowerCase() && o.rulesHash === p.rulesHash &&
    o.btcFeedId === p.btcFeedId && o.ethFeedId === p.ethFeedId && o.decimals === p.btcDecimals && String(o.observationWindow) === p.observationWindow && String(o.openingGrace) === p.openingGrace &&
    String(o.voidGrace) === p.voidGrace && String(o.cutoffBuffer) === p.cutoffBuffer && g.collateral === streams.dependencies.collateral.address.toLowerCase());
  mismatch(await reader.chainId() === 26514);
  const lower = (v: unknown) => typeof v === "string" ? v.toLowerCase() : v;
  const read = (at: Address, signature: string, args?: readonly unknown[]) => reader.read(at, signature, args);
  const equal = (at: Address, signature: string, expected: unknown, args?: readonly unknown[], message?: string) => read(at, signature, args).then((v) => mismatch(lower(v) === lower(expected), message));
  const e = m.endpoint.address, t = m.trigger, app = BigInt(m.application.id);
  let withdrawOnly = false;
  const jobs: Promise<unknown>[] = [m.endpoint, m.authenticator, m.tokenAllowlist, { address: t.implementation, runtimeCodeHash: t.implementationCodeHash }].map(async (pin) => {
    const code = await reader.code(pin.address);
    mismatch(Boolean(code && code !== "0x" && keccak256(code) === pin.runtimeCodeHash));
  });
  jobs.push(read(e, "eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])").then((d) => {
    const [, name, version, chainId, at] = d as [Hex, string, string, bigint, Address];
    mismatch(name === "Vela" && version === "0" && chainId === 26514n && lower(at) === e);
  }));
  jobs.push(equal(e, "REQUEST_AUTHORIZATION_TYPEHASH() view returns (bytes32)", REQUEST_TYPEHASH), equal(e, "minFeePerRequest() view returns (uint256)", BigInt(m.endpoint.minFeePerRequestWei)),
    equal(e, "maxQueueSize() view returns (uint256)", BigInt(m.endpoint.maxQueueSize)), equal(e, "teeAuthenticator() view returns (address)", m.authenticator.address),
    equal(e, "tokenAllowlist() view returns (address)", m.tokenAllowlist.address), equal(e, "triggerContracts(uint64) view returns (address)", t.address, [app]),
    equal(e, "feeCollector() view returns (address)", m.endpoint.operator),
    read(e, "applicationStateRoots(uint64) view returns (bytes32)", [app]).then((root) => mismatch(typeof root === "string" && !/^0x0{64}$/.test(root))),
    equal(m.authenticator.address, "owner() view returns (address)", m.authenticator.owner, undefined, OPERATOR_KEYS_CHANGED),
    equal(m.authenticator.address, "getTeeSigner() view returns (address)", m.authenticator.teeSigner, undefined, OPERATOR_KEYS_CHANGED),
    equal(m.authenticator.address, "getPubSecp521r1() view returns (bytes)", m.authenticator.enclavePublicKey, undefined, OPERATOR_KEYS_CHANGED),
    reader.storage(t.address, STREAMS_SLOTS.implementation).then(async (w) => {
      mismatch(Boolean(w && /^0x0{24}[0-9a-f]{40}$/i.test(w)));
      const at = `0x${w!.slice(-40).toLowerCase()}` as Address;
      if (at === t.implementation) return;
      mismatch(runsPinnedCode(await reader.code(at), at, frozen));
      withdrawOnly = true;
    }),
    equal(t.address, "owner() view returns (address)", t.owner), equal(t.address, "processorEndpoint() view returns (address)", e),
    equal(t.address, "registry() view returns (address)", t.registry), equal(t.address, "inbox() view returns (address)", t.inbox),
    equal(t.address, "asset() view returns (uint8)", 0), equal(t.address, "duration() view returns (uint32)", 900),
    verifyCustody(m.custody, base, reader));
  const failures = (await Promise.allSettled(jobs)).flatMap((job) => job.status === "rejected" ? [job.reason as unknown] : []);
  // A changed operator key is named; any other difference is a mismatch; a failed read is only a failed read.
  if (failures.length) throw failures.find((f) => f instanceof StreamsMismatchError && f.message === OPERATOR_KEYS_CHANGED) ?? failures.find((f) => f instanceof StreamsMismatchError) ?? failures[0];
  return withdrawOnly ? { manifest: m, verified: true, withdrawOnly: true } : { manifest: m, verified: true };
}
