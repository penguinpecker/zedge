/** The custody of the private book: the Base vault users deposit into once and are paid from, the Horizen inbox that carries
 * deposit records to the engine, and the guest's public events. Shared by the browser, the relayer and the payout signer so all
 * build and check exactly the same bytes. viem only; no DOM. Every deployed address comes from the manifest's `custody` section. */
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, sha256, size, slice, stringToHex, type Address, type Hex } from "viem";
import { STREAMS_SLOTS, StreamsMismatchError, type StreamsReader } from "./streams-manifest.ts";

// ---------------------------------------------------------------- EIP-712 pieces (re-exported by orderbook-manifest.ts)

export const EIP712_DOMAIN = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] as const;
// EIP712Domain is listed explicitly: some wallets hash an absent domain type as an empty struct.
export const PERMIT_TYPES = { EIP712Domain: EIP712_DOMAIN, Permit: [
  { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;
/** EIP-3009, as Base USDC implements it: a transfer the owner signs and anyone may send, once per random nonce. */
export const TRANSFER_TYPES = { EIP712Domain: EIP712_DOMAIN, TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
export function permitDomainSeparator(name: string, version: string, token: Address, chainId = 26514): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
    keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), token]));
}

// ---------------------------------------------------------------- fixed public facts (read on chain 2026-10-07)

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const MESSENGERS = { base: "0x9f5e33f901ad50b50d6a27f63adabea4c81e953c", horizen: "0x4200000000000000000000000000000000000007", minGasLimit: 100_000 } as const;
export const VAULT_EIP712 = { name: "ZEDGE Vault", version: "1" } as const;
export const PAYOUT_TYPES = { EIP712Domain: EIP712_DOMAIN, Payout: [
  { name: "applicationId", type: "uint64" }, { name: "ordinal", type: "uint64" }, { name: "account", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }] } as const;
export const CUSTODY_MISMATCH = "Custody checks did not pass.";
/** The smallest send out of a user's Base wallet: 0.10 USDC. */
export const MIN_SEND = 100_000n;

// ---------------------------------------------------------------- the manifest's `custody` section

const LIMIT_KEYS = ["minDeposit", "maxDeposit", "maxPayout", "dailyPayoutCap"] as const;
export type CustodyLimits = Record<(typeof LIMIT_KEYS)[number], string>;
type Proxy = { address: Address; implementation: Address; implementationCodeHash: Hex; owner: Address };
export type Custody = {
  chainId: 8453;
  vault: Proxy & { signer: Address; limits: CustodyLimits };
  usdc: { address: Address; symbol: "USDC"; decimals: 6; permit: { name: "USD Coin"; version: "2"; domainSeparator: Hex } };
  messenger: typeof MESSENGERS;
  inbox: Proxy;
  eip712: typeof VAULT_EIP712;
};

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.toSorted().join(",")) throw new Error("Unsupported custody manifest fields.");
  return value as Record<string, unknown>;
}
const fail = (): never => { throw new Error("Invalid custody manifest."); };
const address = (v: unknown): Address => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v) ? v as Address : fail();
const hash = (v: unknown): Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v) && !/^0x0{64}$/.test(v) ? v as Hex : fail();
const decimal = (v: unknown): string => typeof v === "string" && /^[1-9][0-9]{0,29}$/.test(v) && BigInt(v) < 2n ** 128n ? v : fail();
function proxy(value: unknown, extra: readonly string[]) {
  const r = object(value, ["address", "implementation", "implementationCodeHash", "owner", ...extra]);
  return { r, pin: { address: address(r.address), implementation: address(r.implementation), implementationCodeHash: hash(r.implementationCodeHash), owner: address(r.owner) } };
}

/** The custody section, strictly: Base USDC and the messenger route are fixed; the vault's limits must be ones it accepts. */
export function parseCustody(value: unknown): Custody {
  const r = object(value, ["chainId", "vault", "usdc", "messenger", "inbox", "eip712"]);
  if (r.chainId !== BASE_CHAIN_ID) fail();
  const v = proxy(r.vault, ["signer", "limits"]), l = object(v.r.limits, LIMIT_KEYS);
  const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, decimal(l[k])])) as CustodyLimits, n = (k: keyof CustodyLimits) => BigInt(limits[k]);
  if (!(n("minDeposit") <= n("maxDeposit") && n("maxPayout") <= n("dailyPayoutCap"))) fail();
  const u = object(r.usdc, ["address", "symbol", "decimals", "permit"]), p = object(u.permit, ["name", "version", "domainSeparator"]);
  if (u.address !== BASE_USDC || u.symbol !== "USDC" || u.decimals !== 6 || p.name !== "USD Coin" || p.version !== "2" || hash(p.domainSeparator) !== permitDomainSeparator("USD Coin", "2", BASE_USDC, BASE_CHAIN_ID)) fail();
  const m = object(r.messenger, ["base", "horizen", "minGasLimit"]), e = object(r.eip712, ["name", "version"]);
  if (m.base !== MESSENGERS.base || m.horizen !== MESSENGERS.horizen || m.minGasLimit !== MESSENGERS.minGasLimit || e.name !== VAULT_EIP712.name || e.version !== VAULT_EIP712.version) fail();
  const custody: Custody = { chainId: 8453, vault: { ...v.pin, signer: address(v.r.signer), limits },
    usdc: { address: BASE_USDC, symbol: "USDC", decimals: 6, permit: { name: "USD Coin", version: "2", domainSeparator: p.domainSeparator as Hex } },
    messenger: MESSENGERS, inbox: proxy(r.inbox, []).pin, eip712: VAULT_EIP712 };
  const roles = [custody.vault.address, custody.vault.implementation, custody.vault.signer, custody.inbox.address, custody.inbox.implementation, BASE_USDC, MESSENGERS.base, MESSENGERS.horizen];
  if (new Set(roles).size !== roles.length) fail();
  return custody;
}

// ---------------------------------------------------------------- typed data: the one definition each signer signs and each checker recovers

export type Payout = { applicationId: bigint; ordinal: bigint; account: Address; to: Address; amount: bigint };
/** What the payout signer signs and the vault recovers: nonce = (applicationId, ordinal), paid once. */
export function payoutTypedData(custody: Pick<Custody, "vault">, p: Payout) {
  return { domain: { name: VAULT_EIP712.name, version: VAULT_EIP712.version, chainId: BigInt(BASE_CHAIN_ID), verifyingContract: custody.vault.address }, types: PAYOUT_TYPES,
    primaryType: "Payout" as const, message: { applicationId: p.applicationId, ordinal: p.ordinal, account: p.account, to: p.to, amount: p.amount } };
}
/** The user's Base USDC permit to the vault, for exactly the deposited amount. */
export function usdcPermitTypedData(custody: Pick<Custody, "usdc" | "vault">, f: { owner: Address; value: bigint; nonce: bigint; deadline: bigint }) {
  return { domain: { name: custody.usdc.permit.name, version: custody.usdc.permit.version, chainId: BigInt(BASE_CHAIN_ID), verifyingContract: custody.usdc.address }, types: PERMIT_TYPES,
    primaryType: "Permit" as const, message: { owner: f.owner, spender: custody.vault.address, value: f.value, nonce: f.nonce, deadline: f.deadline } };
}
/** The user's send out of the Base wallet (the wallet popup's send form): a USDC transfer the user confirms in the wallet. */
export function usdcTransferTypedData(custody: Pick<Custody, "usdc">, f: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }) {
  return { domain: { name: custody.usdc.permit.name, version: custody.usdc.permit.version, chainId: BigInt(BASE_CHAIN_ID), verifyingContract: custody.usdc.address }, types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization" as const, message: { from: f.from, to: f.to, value: f.value, validAfter: f.validAfter, validBefore: f.validBefore, nonce: f.nonce } };
}

export const vaultAbi = parseAbi([
  "function depositWithPermit(address account, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint64 index)",
  "function withdraw((uint64 applicationId, uint64 ordinal, address account, address to, uint256 amount) p, bytes signature)",
  "function setSigner(address signer_)", "function setLimits((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap) limits_)",
  "function depositCount() view returns (uint64)", "function signer() view returns (address)", "function inbox() view returns (address)", "function owner() view returns (address)",
  "function limits() view returns ((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap))",
  "function paid(uint64 applicationId, uint64 ordinal) view returns (bool)", "function paidOnDay(uint256 day) view returns (uint256)", "function version() view returns (string)",
  "event Deposited(uint64 indexed index, address indexed account, uint256 amount)",
  "event Paid(uint64 indexed applicationId, uint64 indexed ordinal, address indexed to, address account, uint256 amount)",
  "event SignerChanged(address indexed previous, address indexed current)",
  "event LimitsChanged((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap) limits)",
]);
export const inboxAbi = parseAbi([
  "function receiveDeposit(uint64 index, address account, uint256 amount)",
  "function deposits(uint64 index) view returns (address account, uint96 amount)",
  "function recordsFrom(uint64 from, uint256 max) view returns (uint256[] words)",
  "function highest() view returns (uint64)", "function owner() view returns (address)",
  "event DepositReceived(uint64 indexed index, address indexed account, uint256 amount)",
]);
export const usdcAbi = parseAbi([
  "function nonces(address owner) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "event Transfer(address indexed from, address indexed to, uint256 value)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

// ---------------------------------------------------------------- the guest's public app events (data = 32-byte words; subtype = SHA-256 of the label)

const LABELS = ["tick", "clock", "archive", "settle", "credit", "payout", "confirm"] as const;
export const SUBTYPES = Object.fromEntries(LABELS.map((l) => [l, sha256(stringToHex(`zedge.vela.${l}.v1`))])) as Record<(typeof LABELS)[number], Hex>;

/** The event's data as words; null unless it is exactly `count` words. */
export function eventWords(data: Hex, count: number): bigint[] | null {
  if (size(data) !== 32 * count) return null;
  return Array.from({ length: count }, (_, i) => BigInt(slice(data, 32 * i, 32 * (i + 1))));
}
const word = (w: bigint): Hex => `0x${w.toString(16).padStart(64, "0")}`;
const addressWord = (w: bigint): Address => `0x${w.toString(16).padStart(40, "0")}`;
/** `settle`: a round opened, resolved or voided. Outcome 1 Up, 2 Down, 3 Void. */
export function decodeSettle(data: Hex) {
  const w = eventWords(data, 7);
  return w && { roundId: word(w[0]), kind: Number(w[1]), outcome: Number(w[2]), price: w[3], observationsTimestamp: Number(w[4]), reportHash: word(w[5]), source: Number(w[6]) };
}
/** `credit`: a Base deposit index ended credited (1) or refunded through a payout (2). */
export function decodeCredit(data: Hex) {
  const w = eventWords(data, 5);
  return w && { index: w[0], account: addressWord(w[1]), amount: w[2], status: Number(w[3]), payout: w[4] };
}
/** `payout`: the engine approved a withdrawal (kind 1) or a refund (kind 2) for the vault to pay. */
export function decodePayout(data: Hex) {
  const w = eventWords(data, 6);
  return w && { applicationId: w[0], ordinal: w[1], kind: Number(w[2]), account: addressWord(w[3]), to: addressWord(w[4]), amount: w[5] };
}

// ---------------------------------------------------------------- verification against both chains

/** The vault (Base) and the inbox (Horizen) as deployed: proxy implementation and code, owner, signer, the inbox the vault sends
 * to, limits, the vault's EIP-712 domain and Base USDC's permit domain. Fails closed on any difference; a failed read is only a failed read. */
export async function verifyCustody(c: Custody, base: StreamsReader, horizen: StreamsReader): Promise<void> {
  const mismatch = (ok: boolean) => { if (!ok) throw new StreamsMismatchError(CUSTODY_MISMATCH); };
  const lower = (v: unknown) => typeof v === "string" ? v.toLowerCase() : v;
  const equal = (reader: StreamsReader, at: Address, signature: string, expected: unknown) => reader.read(at, signature).then((v) => mismatch(lower(v) === lower(expected)));
  const pinned = (reader: StreamsReader, p: Proxy) => [
    reader.code(p.implementation).then((code) => mismatch(Boolean(code && code !== "0x" && keccak256(code) === p.implementationCodeHash))),
    reader.code(p.address).then((code) => mismatch(Boolean(code && code !== "0x"))),
    reader.storage(p.address, STREAMS_SLOTS.implementation).then((w) => mismatch(Boolean(w && /^0x[0-9a-f]{64}$/i.test(w) && BigInt(w) === BigInt(p.implementation)))),
    equal(reader, p.address, "owner() view returns (address)", p.owner),
  ];
  const v = c.vault.address;
  const jobs = [
    base.chainId().then((id) => mismatch(id === BASE_CHAIN_ID)), horizen.chainId().then((id) => mismatch(id === 26514)),
    ...pinned(base, c.vault), ...pinned(horizen, c.inbox),
    equal(base, v, "signer() view returns (address)", c.vault.signer), equal(base, v, "inbox() view returns (address)", c.inbox.address),
    base.read(v, "limits() view returns ((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap))")
      .then((l) => mismatch(LIMIT_KEYS.every((k) => String((l as Record<string, unknown>)[k]) === c.vault.limits[k]))),
    base.read(v, "eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])").then((d) => {
      const [, name, version, chainId, at] = d as [Hex, string, string, bigint, Address];
      mismatch(name === VAULT_EIP712.name && version === VAULT_EIP712.version && chainId === BigInt(BASE_CHAIN_ID) && lower(at) === v);
    }),
    equal(base, c.usdc.address, "DOMAIN_SEPARATOR() view returns (bytes32)", c.usdc.permit.domainSeparator),
  ];
  const failures = (await Promise.allSettled(jobs)).flatMap((job) => job.status === "rejected" ? [job.reason as unknown] : []);
  if (failures.length) throw failures.find((f) => f instanceof StreamsMismatchError) ?? failures[0];
}
