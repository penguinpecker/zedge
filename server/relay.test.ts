import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair } from "jose";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, stringToHex, toHex, type Address, type Hex, type Log } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { endpointAbi, parseOrderbookManifest, requestTypedData } from "../src/chain/orderbook-manifest.ts";
import { BASE_USDC, permitDomainSeparator, usdcPermitTypedData, vaultAbi } from "../src/chain/vault.ts";
import { DEFAULT_LIMITS, configFromEnv, handle, signerFromEnv, type Answer, type ChainState, type DepositState, type RelayConfig, type Store, type Wire } from "./relay.ts";

const RELAYER_KEY = generatePrivateKey();
const signer = signerFromEnv(RELAYER_KEY)!;
const fresh = () => privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const codeHash = (label: string) => keccak256(stringToHex(label));

/** A configured schema-3 manifest: the live endpoint, an application of the new guest, and the custody pair. Every other
 * address is generated here, so nothing in this file names a deployment that does not exist. */
function configuredManifest(facilitator: Address) {
  const endpoint = "0x0a2703d21b27757fdf27ab807eae9820788010f3", registry = "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744";
  const trigger = fresh(), inbox = fresh(), vault = fresh(), app = "7225536188967924955";
  const engineConfigJson = JSON.stringify({ domain: { chainId: 26514, endpoint, applicationId: app, rulesVersion: 3 }, authority: trigger, collateral: "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c", feeBps: 0,
    oracle: { chainId: 26514, registry, oracle: "0xc800c3f18d35d492ae6b07655d7f31bfe98a4b6b", rulesHash: "0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6",
      btcFeedId: "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8", ethFeedId: "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9",
      decimals: 18, observationWindow: 60, openingGrace: 150, voidGrace: 300, cutoffBuffer: 30 } });
  return { schemaVersion: 3, kind: "zedge-private-orderbook", chainId: 26514, status: "configured", release: "orderbook-test",
    endpoint: { address: endpoint, runtimeCodeHash: codeHash("endpoint"), eip712: { name: "Vela", version: "0" }, requestTypehash: "0x952140b6347f31bf88278b2d6fb6365ec837393094e7a1f12b6dffbdc1333340",
      protocolVersion: 0, minFeePerRequestWei: "1000000000", maxQueueSize: "10", operator: fresh() },
    authenticator: { address: fresh(), runtimeCodeHash: codeHash("authenticator"), owner: fresh(), teeSigner: fresh(), enclavePublicKey: `0x04${"ab".repeat(132)}` },
    tokenAllowlist: { address: fresh(), runtimeCodeHash: codeHash("allowlist") },
    trigger: { address: trigger, implementation: fresh(), implementationCodeHash: codeHash("trigger"), owner: fresh(), registry, inbox, asset: 0, duration: 900 },
    application: { id: app, wasmSha256: "11".repeat(32), origin: "https://zedge-markets.vercel.app", epoch: "1", engineConfigJson, sessionRulesHash: createHash("sha256").update(engineConfigJson).digest("hex"),
      markets: [{ asset: "BTC", duration: 900 }], house: fresh(), stakeLimits: { account: "50000000", boundary: "200000000", houseTotal: "2000000000" }, deployTx: codeHash("deploy"), deployBlock: 27_930_000,
      chainlink: { feedId: "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8", configs: [{ digest: "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee", f: 5, signers: Array.from({ length: 16 }, fresh) }] } },
    custody: { chainId: 8453,
      vault: { address: vault, implementation: fresh(), implementationCodeHash: codeHash("vault"), owner: fresh(), signer: fresh(), limits: { minDeposit: "1000000", maxDeposit: "500000000", maxPayout: "1000000000", dailyPayoutCap: "10000000000" } },
      usdc: { address: BASE_USDC, symbol: "USDC", decimals: 6, permit: { name: "USD Coin", version: "2", domainSeparator: permitDomainSeparator("USD Coin", "2", BASE_USDC, 8453) } },
      messenger: { base: "0x9f5e33f901ad50b50d6a27f63adabea4c81e953c", horizen: "0x4200000000000000000000000000000000000007", minGasLimit: 100000 },
      inbox: { address: inbox, implementation: fresh(), implementationCodeHash: codeHash("inbox"), owner: fresh() }, eip712: { name: "ZEDGE Vault", version: "1" } },
    relayer: { path: "/api/relay", facilitator },
  };
}
const manifest = configuredManifest(signer.address);
const book = parseOrderbookManifest(manifest) as RelayConfig["book"];
const VAULT = book.custody.vault.address;
const ORIGIN = "https://zedge-markets.vercel.app", APP = "test-app", T0 = Date.UTC(2026, 9, 6, 16, 0, 0), CHAIN_TIME = BigInt(T0 / 1000);
const keys = await generateKeyPair("ES256");
const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256" }] };

type Claims = { sub?: string; aud?: string; iss?: string; exp?: number; kid?: string; wallets?: string[]; linked?: unknown };
async function jwt(c: Claims, identity: boolean) {
  const body: Record<string, unknown> = identity ? { linked_accounts: c.linked ?? JSON.stringify((c.wallets ?? []).map((address) => ({ type: "wallet", address, chain_type: "ethereum", wallet_client_type: "privy", connector_type: "embedded" }))) } : { sid: "s" };
  return new SignJWT(body).setProtectedHeader({ alg: "ES256", kid: c.kid ?? "k1", typ: "JWT" }).setIssuer(c.iss ?? "privy.io").setAudience(c.aud ?? APP).setSubject(c.sub ?? "did:privy:alice")
    // jose checks tokens against the wall clock, not the handler's test clock: stamp them from now, or they expire an hour after T0.
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime(c.exp ?? Math.floor(Date.now() / 1000) + 3600).sign(keys.privateKey);
}

function memoryStore(clock: () => number) {
  const data = new Map<string, { value: string; until: number }>(), sets = new Map<string, Set<string>>();
  const live = (k: string) => { const e = data.get(k); if (e && e.until <= clock()) data.delete(k); return data.get(k); };
  const store: Store & { data: typeof data; sets: typeof sets } = {
    data, sets,
    async set(k, v, o = {}) {
      const exists = live(k);
      if ((o.nx && exists) || (o.xx && !exists)) return null;
      data.set(k, { value: v, until: o.ex ? clock() + o.ex * 1000 : o.px ? clock() + o.px : Infinity });
      return "OK";
    },
    async get(k) { return live(k)?.value ?? null; },
    async del(k) { return data.delete(k) ? 1 : 0; },
    async incrby(k, by) { const e = live(k); const n = Number(e?.value ?? 0) + by; data.set(k, { value: String(n), until: e?.until ?? Infinity }); return n; },
    async decrby(k, by) { return store.incrby(k, -by); },
    async expire(k, s) { const e = live(k); if (!e) return 0; e.until = clock() + s * 1000; return 1; },
    async ttl(k) { const e = live(k); return e ? (e.until === Infinity ? -1 : Math.ceil((e.until - clock()) / 1000)) : -2; },
    async sismember(k, m) { return sets.get(k)?.has(m) ? 1 : 0; },
  };
  return store;
}

type Sim = { ok: true; gas: bigint } | { ok: false; reason: string } | null;
/** One chain: the order book's endpoint (Horizen) or the vault with Base USDC (Base). */
function fakeChain(over: Partial<ChainState> = {}, chainId = 26514) {
  const sent: ReturnType<typeof parseTransaction>[] = [], raws: Hex[] = [];
  const nonces = new Map<string, bigint>(), usdcNonces = new Map<string, bigint>();
  const onBase = chainId === 8453;
  const chain = {
    sent, raws, nonces, usdcNonces, reads: 0, pending: 0, simulate: null as Sim, sendFails: false, knownAfterFailure: false, receipts: true, deposits: 0n,
    // Base read on 2026-10-07: basefee about 0.005 gwei; the vault's planned limits; a deposit measured about 0.56 M gas on a fork.
    ds: { timestamp: CHAIN_TIME, baseFee: 5_000_000n, balance: 10n ** 16n, usdcBalance: 1_000_000_000n, allowance: 0n,
      limits: { minDeposit: 1_000_000n, maxDeposit: 500_000_000n, maxPayout: 1_000_000_000n, dailyPayoutCap: 10_000_000_000n } },
    deposited: (args: { account: Address; amount: bigint }) => args,
  };
  const wire: Wire = {
    async state(sender) {
      chain.reads++;
      return { nonce: nonces.get(sender) ?? 0n, pending: BigInt(chain.pending), balance: 10n ** 16n, baseFee: 252n, timestamp: CHAIN_TIME, ...over };
    },
    async depositState(owner): Promise<DepositState> {
      chain.reads++;
      assert.ok(onBase, "deposits are read on Base");
      const d = chain.ds;
      return { timestamp: d.timestamp, baseFee: d.baseFee, balance: d.balance, usdcBalance: d.usdcBalance, usdcNonce: usdcNonces.get(owner) ?? 0n, allowance: d.allowance, limits: { ...d.limits } };
    },
    // Measured: PROCESS 1.685 M, ASSOCIATEKEY 322 k on a Horizen fork; depositWithPermit about 0.56 M on a Base fork.
    async simulate(_from, to, data) {
      if (chain.simulate) return chain.simulate;
      if (to === VAULT) return { ok: true, gas: 560_000n };
      const call = decodeFunctionData({ abi: endpointAbi, data });
      return { ok: true, gas: call.args[3] === 3 ? 330_000n : 1_700_000n };
    },
    async pendingNonce() { return sent.length; },
    async send(raw) {
      if (chain.sendFails) throw new Error("node said no");
      raws.push(raw); sent.push(parseTransaction(raw));
      const tx = sent.at(-1)!;
      if (tx.to?.toLowerCase() === VAULT) {
        const owner = (decodeFunctionData({ abi: vaultAbi, data: tx.data! }).args[0] as Address).toLowerCase();
        usdcNonces.set(owner, (usdcNonces.get(owner) ?? 0n) + 1n);
        return;
      }
      const call = decodeFunctionData({ abi: endpointAbi, data: tx.data! });
      if (call.functionName === "submitRequestFor") nonces.set((call.args[0] as string).toLowerCase(), (nonces.get((call.args[0] as string).toLowerCase()) ?? 0n) + 1n);
    },
    async known() { return chain.knownAfterFailure; },
    async receipt(hash) {
      const i = raws.findIndex((raw) => keccak256(raw) === hash);
      if (i < 0 || !chain.receipts) return null;
      if (sent[i].to?.toLowerCase() === VAULT) {
        const args = decodeFunctionData({ abi: vaultAbi, data: sent[i].data! }).args as readonly unknown[];
        const e = chain.deposited({ account: args[0] as Address, amount: args[1] as bigint });
        const log = { address: VAULT, topics: encodeEventTopics({ abi: vaultAbi, eventName: "Deposited", args: { index: ++chain.deposits, account: e.account } }),
          data: encodeAbiParameters([{ type: "uint256" }], [e.amount]) } as unknown as Log;
        return { status: "success", gasUsed: 560_000n, effectiveGasPrice: 6_000_000n, l1Fee: 30_000_000_000n, blockNumber: 52_270_000n, logs: [log] };
      }
      const call = decodeFunctionData({ abi: endpointAbi, data: sent[i].data! });
      const logs = call.functionName === "submitRequestFor" ? [{ address: book.endpoint.address, data: encodeAbiParameters([{ type: "address" }], [signer.address]),
        topics: encodeEventTopics({ abi: endpointAbi, eventName: "RequestSubmitted", args: { applicationId: BigInt(book.application.id), requestId: keccak256(hash), sender: call.args[0] as Address } }) } as unknown as Log] : [];
      return { status: "success", gasUsed: 1_650_000n, effectiveGasPrice: 1_000_252n, l1Fee: 170_000_000n, blockNumber: 27_905_600n, logs };
    },
  };
  return { chain, wire };
}

function relay(options: { config?: Partial<RelayConfig>; state?: Partial<ChainState>; invited?: string[] } = {}) {
  let clock = T0;
  const store = memoryStore(() => clock), { chain, wire } = fakeChain(options.state), base = fakeChain({}, 8453), logs: string[] = [];
  const config: RelayConfig = { book, privyAppId: APP, jwks, allowedOrigin: ORIGIN, inviteOnly: Boolean(options.invited), dailyBudgetWei: 3_000_000_000_000_000n, minBalanceWei: 500_000_000_000_000n,
    baseDailyBudgetWei: 2_000_000_000_000_000n, baseMinBalanceWei: 200_000_000_000_000n, limits: DEFAULT_LIMITS, ...options.config };
  if (options.invited) store.sets.set("relay:invited", new Set(options.invited));
  const deps = { config, store, wire, base: base.wire, signer, now: () => clock, sleep: async (ms: number) => { clock += ms; }, log: (l: string) => logs.push(l) };
  const post = async (body: unknown, headers: Record<string, string> = {}, method = "POST"): Promise<Answer> =>
    handle({ method, headers: new Headers({ origin: ORIGIN, ...headers }), body: typeof body === "string" ? body : JSON.stringify(body) }, deps);
  return { post, chain, base: base.chain, store, logs, deps, advance: (ms: number) => { clock += ms; } };
}

const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
const addr = (a: { address: string }) => a.address.toLowerCase() as Address;
async function auth(c: Claims = {}) {
  const wallets = c.wallets ?? [addr(alice)];
  return { authorization: `Bearer ${await jwt({ ...c, wallets }, false)}`, "privy-id-token": await jwt({ ...c, wallets }, true) };
}
type Req = { who?: typeof alice; type?: 1 | 3; bytes?: number; token?: Address; amount?: bigint; nonce?: bigint; deadline?: bigint; permit?: Hex; signFor?: typeof book };
async function request(r: Req = {}) {
  const who = r.who ?? alice, type = r.type ?? 1, amount = r.amount ?? 0n, deadline = r.deadline ?? CHAIN_TIME + 120n;
  const payload = (r.bytes === 0 ? "0x" : toHex(new Uint8Array(r.bytes ?? (type === 3 ? 133 : 2076)).fill(7))) as Hex;
  const token = r.token ?? "0x0000000000000000000000000000000000000000";
  const signature = await who.signTypedData(requestTypedData(r.signFor ?? book, { sender: addr(who), requestType: type, payload, tokenAddress: token, assetAmount: amount, nonce: r.nonce ?? 0n, deadline }));
  return { kind: "request", sender: addr(who), requestType: type, payload, tokenAddress: token, assetAmount: amount.toString(), deadline: deadline.toString(), signature, permit: r.permit ?? "0x" };
}
type Dep = { who?: typeof alice; amount?: bigint; deadline?: bigint; nonce?: bigint; signedAmount?: bigint; spender?: Address };
/** The browser's one-click deposit: a silent permit of exactly the amount to the vault (normalized to v 27/28 by viem). */
async function deposit(d: Dep = {}) {
  const who = d.who ?? alice, amount = d.amount ?? 50_000_000n, deadline = d.deadline ?? CHAIN_TIME + 1200n;
  const typed = usdcPermitTypedData({ ...book.custody, vault: { ...book.custody.vault, address: d.spender ?? VAULT } }, { owner: addr(who), value: d.signedAmount ?? amount, nonce: d.nonce ?? 0n, deadline });
  return { kind: "base-deposit", owner: addr(who), amount: amount.toString(), deadline: deadline.toString(), permit: await who.signTypedData(typed) };
}
const nothingSent = (r: ReturnType<typeof relay>) => r.chain.sent.length + r.base.sent.length === 0;

test("a valid request is sent as submitRequestFor on the pinned endpoint and application, with the user as sender and the 1 gwei fee", async () => {
  const r = relay();
  const body = await request();
  const a = await r.post(body, await auth());
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.facilitator, signer.address);
  assert.match(String(a.body.requestId), /^0x[0-9a-f]{64}$/);
  const [tx] = r.chain.sent;
  const call = decodeFunctionData({ abi: endpointAbi, data: tx.data! });
  assert.equal(call.functionName, "submitRequestFor");
  assert.deepEqual(call.args.slice(0, 3), [alice.address, 0, 7225536188967924955n]);
  assert.equal(call.args[8], body.signature);
  assert.equal(tx.to?.toLowerCase(), book.endpoint.address);
  assert.deepEqual([tx.chainId, tx.value, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gas, tx.nonce], [26514, 1_000_000_000n, 1_000_000n, 1_000_504n, 2_040_000n, 0]);
  // The budget holds the real cost, rounded up to whole Mwei.
  assert.equal(await r.store.get("relay:spent:26514:20261006"), String(Math.ceil(Number(1_650_000n * 1_000_252n + 170_000_000n + 1_000_000_000n) / 1e6)));
  assert.equal(await r.store.get(`relay:inflight:26514:${addr(alice)}`), null);
});

test("tokens are verified with the app's public key only: wrong audience, issuer, key, algorithm, expiry or user are refused before any RPC", async () => {
  const r = relay();
  const body = await request();
  const good = await auth();
  const hs256 = await new SignJWT({ linked_accounts: "[]" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer("privy.io").setAudience(APP).setSubject("did:privy:alice").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("x".repeat(32)));
  const none = new UnsecuredJWT({ linked_accounts: JSON.stringify([{ type: "wallet", address: addr(alice), chain_type: "ethereum" }]) }).setIssuer("privy.io").setAudience(APP).setSubject("did:privy:alice").setIssuedAt().setExpirationTime("1h").encode();
  const cases: Record<string, Record<string, string>> = {
    "no tokens": {},
    "wrong audience": await auth({ aud: "another-app" }),
    "wrong issuer": await auth({ iss: "evil.example" }),
    "unknown key id": await auth({ kid: "k2" }),
    "expired": await auth({ exp: Math.floor(T0 / 1000) - 120 }),
    "HS256": { authorization: `Bearer ${hs256}`, "privy-id-token": good["privy-id-token"] },
    "alg none": { authorization: good.authorization, "privy-id-token": none },
    "different users": { authorization: (await auth({ sub: "did:privy:bob" })).authorization, "privy-id-token": good["privy-id-token"] },
    "no ethereum wallet": { authorization: good.authorization, "privy-id-token": await jwt({ linked: JSON.stringify([{ type: "email", address: "a@b.c" }]) }, true) },
    "malformed accounts": { authorization: good.authorization, "privy-id-token": await jwt({ linked: "not json" }, true) },
    // An identity token is meant for backends: in both headers it is not an access token (no session, an identity).
    "identity token twice": { authorization: `Bearer ${good["privy-id-token"]}`, "privy-id-token": good["privy-id-token"] },
  };
  for (const [name, headers] of Object.entries(cases)) {
    const a = await r.post(body, headers);
    assert.deepEqual([a.status, a.body.code], [401, "UNAUTHENTICATED"], name);
  }
  // Another key pair entirely, with a matching kid.
  const other = await generateKeyPair("ES256");
  const forged = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer("privy.io").setAudience(APP).setSubject("did:privy:alice").setIssuedAt().setExpirationTime("1h").sign(other.privateKey);
  assert.equal((await r.post(body, { ...good, authorization: `Bearer ${forged}` })).body.code, "UNAUTHENTICATED");
  assert.equal(r.chain.reads, 0);
  assert.equal(r.chain.sent.length, 0);
});

test("the sender (or depositor) must be one of the signed-in user's own wallets; the origin and the invite list are enforced", async () => {
  const r = relay();
  assert.equal((await r.post(await request({ who: bob }), await auth())).body.code, "SENDER_NOT_LINKED");
  assert.equal((await r.post(await deposit({ who: bob }), await auth())).body.code, "SENDER_NOT_LINKED");
  // Without an identity token the request's own signature proves the sender: a signed-in session relays it.
  const accessOnly = { authorization: (await auth()).authorization };
  for (const body of [await request(), await request({ who: bob })]) assert.ok(!["UNAUTHENTICATED", "SENDER_NOT_LINKED"].includes(String((await relay().post(body, accessOnly)).body.code)));
  assert.equal((await r.post(await request(), { ...(await auth()), origin: "https://evil.example" })).body.code, "ORIGIN_NOT_ALLOWED");
  assert.equal((await r.post(await request(), await auth(), "GET")).body.code, "ORIGIN_NOT_ALLOWED");
  const invite = relay({ invited: ["did:privy:carol"] });
  assert.equal((await invite.post(await request(), await auth())).body.code, "NOT_INVITED");
  const invited = relay({ invited: ["did:privy:alice"] });
  assert.equal((await invited.post(await request(), await auth())).status, 200);
  assert.ok(nothingSent(r));
});

test("only the guest's shapes are paid for: a 133-byte key or a 2,076-byte request, never a deposit through the endpoint", async () => {
  const r = relay(), headers = await auth();
  const refused: [string, unknown, string][] = [
    ["226-byte ASSOCIATEKEY (with seed)", await request({ type: 3, bytes: 226 }), "UNSUPPORTED_REQUEST"],
    ["2,075-byte request", await request({ bytes: 2075 }), "UNSUPPORTED_REQUEST"],
    ["empty PROCESS", await request({ bytes: 0 }), "UNSUPPORTED_REQUEST"],
    ["a Horizen USDC.e deposit (the guest holds no Horizen custody)", await request({ bytes: 0, amount: 5_000_000n, token: book.application.engine.collateral, permit: `0x${"11".repeat(96)}` }), "UNSUPPORTED_REQUEST"],
    ["a request carrying a token", await request({ token: "0x1111111111111111111111111111111111111111" }), "UNSUPPORTED_REQUEST"],
    ["a request carrying an amount", await request({ amount: 1n }), "UNSUPPORTED_REQUEST"],
    ["command with a permit", { ...(await request()), permit: `0x${"11".repeat(96)}` }, "UNSUPPORTED_REQUEST"],
    ["a claim (retired)", { kind: "claim", payee: addr(alice) }, "BAD_REQUEST"],
    ["a bridge (retired)", { kind: "bridge-in", owner: addr(alice), amount: "1000000" }, "BAD_REQUEST"],
    ["request type 2", { ...(await request()), requestType: 2 }, "BAD_REQUEST"],
    ["an endpoint field", { ...(await request()), endpoint: "0x1111111111111111111111111111111111111111" }, "BAD_REQUEST"],
    ["an application field", { ...(await request()), applicationId: "1" }, "BAD_REQUEST"],
    ["short signature", { ...(await request()), signature: "0x1234" }, "BAD_REQUEST"],
    ["not JSON", "{", "BAD_REQUEST"],
    ["over 8 KiB", JSON.stringify({ ...(await request()), pad: "0".repeat(8200) }), "BAD_REQUEST"],
  ];
  for (const [name, body, code] of refused) assert.equal((await r.post(body, headers)).body.code, code, name);
  assert.ok(nothingSent(r));
  assert.equal(r.chain.reads + r.base.reads, 0);
  assert.equal((await r.post(await request({ type: 3 }), headers)).status, 200, "a key registration");
});

test("the signature is recovered at the on-chain nonce for this endpoint and application; the deadline must be 15 s to 10 min ahead", async () => {
  const r = relay(), headers = await auth();
  r.chain.nonces.set(addr(alice), 1n);
  assert.equal((await r.post(await request({ nonce: 0n }), headers)).body.code, "SIGNATURE_MISMATCH");
  const otherApp = { ...book, application: { ...book.application, id: "1" } };
  assert.equal((await r.post(await request({ nonce: 1n, signFor: otherApp }), headers)).body.code, "SIGNATURE_MISMATCH");
  assert.equal((await r.post(await request({ nonce: 1n, deadline: CHAIN_TIME + 14n }), headers)).body.code, "DEADLINE_OUT_OF_RANGE");
  assert.equal((await r.post(await request({ nonce: 1n, deadline: CHAIN_TIME + 601n }), headers)).body.code, "DEADLINE_OUT_OF_RANGE");
  assert.ok(nothingSent(r));
  assert.equal((await r.post(await request({ nonce: 1n }), headers)).status, 200);
});

test("queue, fee, balance, simulation and gas guards refuse without sending, reserving or keeping the idempotency record", async () => {
  const cases: [string, (r: ReturnType<typeof relay>) => void, string, unknown?][] = [
    ["queue at 6", (r) => { r.chain.pending = 6; }, "QUEUE_BUSY", 20],
    ["revert", (r) => { r.chain.simulate = { ok: false, reason: "InvalidPermit" }; }, "SIMULATION_REVERTED"],
    ["gas", (r) => { r.chain.simulate = { ok: true, gas: 2_000_001n }; }, "GAS_ABOVE_CAP"],
  ];
  for (const [name, setup, code, retryAfter] of cases) {
    const r = relay(), headers = await auth(), body = await request();
    setup(r);
    const a = await r.post(body, headers);
    assert.equal(a.body.code, code, name);
    if (retryAfter) assert.equal(a.body.retryAfter, retryAfter);
    if (code === "SIMULATION_REVERTED") assert.equal(a.body.reason, "InvalidPermit");
    assert.equal(r.chain.sent.length, 0, name);
    assert.equal(await r.store.get("relay:spent:26514:20261006"), null, name);
    // The same signed authorization goes through once the condition clears.
    r.chain.pending = 0; r.chain.simulate = null;
    assert.equal((await r.post(body, headers)).status, 200, name);
  }
  const hot = relay({ state: { baseFee: 2_000_001n } });
  assert.equal((await hot.post(await request(), await auth())).body.code, "FEE_ABOVE_CAP");
  const poor = relay({ state: { balance: 10n ** 14n } });
  assert.equal((await poor.post(await request(), await auth())).body.code, "RELAYER_UNFUNDED");
  const low = relay({ state: { balance: 9n * 10n ** 14n } });
  await low.post(await request(), await auth());
  assert.ok(low.logs.some((l) => l.includes("RELAYER_LOW")));
});

test("per-user, per-day, deposit, global and budget limits answer with a retry time and undo their reservation", async () => {
  const r = relay(), headers = await auth(), stale = await request({ nonce: 5n });
  // Limits count every well-formed call from a linked wallet, refused or not, before any RPC.
  for (let i = 0; i < 20; i++) assert.equal((await r.post(stale, headers)).body.code, "SIGNATURE_MISMATCH");
  const readsBefore = r.chain.reads;
  const limited = await r.post(await request(), headers);
  assert.equal(r.chain.reads, readsBefore);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.ok(Number(limited.body.retryAfter) > 0 && Number(limited.body.retryAfter) <= 600);
  r.advance(601_000);
  assert.equal((await r.post(await request({ deadline: CHAIN_TIME + 120n }), headers)).status, 200, "the window resets");

  const deposits = relay(), dh = await auth();
  for (let i = 0; i < 5; i++) { deposits.base.simulate = { ok: false, reason: "x" }; await deposits.post(await deposit({ amount: BigInt(2_000_000 + i) }), dh); }
  const daily = await deposits.post(await deposit(), dh);
  assert.deepEqual([daily.body.code, daily.body.retryAfter], ["DAILY_LIMIT", 8 * 3600], "five deposits per user per UTC day");

  const global = relay({ config: { limits: { ...DEFAULT_LIMITS, globalHour: 1 } } });
  await global.post(await request({ nonce: 5n }), await auth());
  const g = await global.post(await request({ who: bob }), await auth({ sub: "did:privy:bob", wallets: [addr(bob)] }));
  assert.equal(g.body.code, "RATE_LIMITED");

  const tight = relay({ config: { dailyBudgetWei: 1_000_000_000_000n } });
  const b = await tight.post(await request(), await auth());
  assert.equal(b.body.code, "BUDGET_EXHAUSTED");
  assert.equal(b.body.retryAfter, 8 * 3600, "seconds to UTC midnight");
  assert.equal(await tight.store.get("relay:spent:26514:20261006"), "0");
  assert.equal(tight.chain.sent.length, 0);
});

test("idempotency: concurrent identical posts send once; a replay returns the same transaction; two users get consecutive relayer nonces", async () => {
  const r = relay(), headers = await auth(), body = await request();
  const answers = await Promise.all(Array.from({ length: 5 }, () => r.post(body, headers)));
  assert.equal(r.chain.sent.length, 1);
  const tx = answers.find((a) => a.status === 200 && !a.body.duplicate)?.body.txHash;
  assert.ok(tx);
  for (const a of answers) assert.ok((a.status === 200 && a.body.txHash === tx) || a.status === 202 || a.body.code === "IN_FLIGHT", JSON.stringify(a.body));
  const replay = await r.post(body, headers);
  assert.deepEqual([replay.status, replay.body.duplicate, replay.body.txHash], [200, true, tx]);
  assert.equal(r.chain.sent.length, 1);

  const two = relay();
  const [a, b] = await Promise.all([two.post(await request(), await auth()), two.post(await request({ who: bob }), await auth({ sub: "did:privy:bob", wallets: [addr(bob)] }))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(two.chain.sent.map((t) => t.nonce).sort(), [0, 1]);
});

test("a send error is never resent and never reads as 'not sent': the outcome is unknown, the record stays; no receipt answers 202 within 15 s", async () => {
  // The node may have taken it although eth_sendRawTransaction failed (a timeout after acceptance, another gateway backend).
  const r = relay(), headers = await auth(), body = await request();
  r.chain.sendFails = true;
  const unknown = await r.post(body, headers);
  assert.deepEqual([unknown.status, unknown.body.code], [502, "SEND_UNKNOWN"]);
  assert.match(String(unknown.body.txHash), /^0x[0-9a-f]{64}$/);
  assert.equal(await r.store.get("relay:lock:26514"), null);
  r.chain.sendFails = false;
  const again = await r.post(body, headers);
  assert.deepEqual([again.status, again.body.txHash, again.body.duplicate], [202, unknown.body.txHash, true], "the same signature is never sent twice");
  r.chain.knownAfterFailure = true;
  r.chain.sendFails = true;
  const known = await r.post(await request({ who: bob }), await auth({ sub: "did:privy:bob", wallets: [addr(bob)] }));
  assert.deepEqual([known.status, known.body.code], [202, "SENT_UNCONFIRMED"], "the node had it: counted as sent");

  // A failure after the broadcast (here the store) answers with the transaction, never as a refusal.
  const late = relay(), lh = await auth(), set = late.store.set.bind(late.store);
  late.store.set = async (k, v, o) => { if (k === "relay:nonce:26514") throw new Error("upstash: transient"); return set(k, v, o); };
  const after = await late.post(await request(), lh);
  assert.deepEqual([after.status, after.body.code, after.body.txHash], [202, "SENT_UNCONFIRMED", keccak256(late.chain.raws[0])]);

  // The receipt is awaited only while the function has time (Vercel stops it at 30 s); the client follows the chain after that.
  const slow = relay(), sh = await auth(), sb = await request();
  slow.chain.receipts = false;
  const started = slow.deps.now();
  const first = await slow.post(sb, sh);
  assert.deepEqual([first.status, first.body.code], [202, "SENT_UNCONFIRMED"]);
  assert.ok(slow.deps.now() - started <= 16_000, `answered after ${slow.deps.now() - started} ms`);
  const repeat = await slow.post(sb, sh);
  assert.deepEqual([repeat.status, repeat.body.txHash, repeat.body.duplicate], [202, first.body.txHash, true]);
  assert.equal(slow.chain.sent.length, 1);
});

test("a transaction the node accepted and then lost holds the relayer nonce for 30 s at most, not for good", async () => {
  const r = relay(), headers = await auth();
  r.chain.receipts = false;
  r.deps.wire!.pendingNonce = async () => 0; // the node dropped nonce 0: its pending count never moves
  assert.equal((await r.post(await request(), headers)).body.code, "SENT_UNCONFIRMED");
  r.chain.nonces.clear(); // never mined: the user's request nonce is still 0
  r.advance(31_000);
  r.chain.receipts = true;
  assert.equal((await r.post(await request({ who: bob }), await auth({ sub: "did:privy:bob", wallets: [addr(bob)] }))).status, 200);
  assert.deepEqual(r.chain.sent.map((t) => t.nonce), [0, 0], "the next transaction takes the chain's nonce again, so it can mine");
  // Within the 30 s the stored value bridges the node's count, and a store ahead of the chain is logged for the operator.
  const fast = relay(), fh = await auth();
  fast.chain.receipts = false;
  fast.deps.wire!.pendingNonce = async () => 0;
  await fast.post(await request(), fh);
  await fast.post(await request({ who: bob }), await auth({ sub: "did:privy:bob", wallets: [addr(bob)] }));
  assert.deepEqual(fast.chain.sent.map((t) => t.nonce), [0, 1]);
  assert.ok(fast.logs.some((l) => l.includes('"alert":"NONCE_AHEAD"')));
});

test("a counter is created with its expiry: one failed EXPIRE does not rate-limit a user for ever", async () => {
  const r = relay(), headers = await auth(), expire = r.store.expire.bind(r.store);
  let fail = true;
  r.store.expire = async (k, s) => { if (fail) { fail = false; throw new Error("upstash: transient"); } return expire(k, s); };
  assert.equal((await r.post(await request(), headers)).body.code, "STORE_UNAVAILABLE");
  const ttl = await r.store.ttl("relay:u10m:did:privy:alice");
  assert.ok(ttl > 0 && ttl <= 600, `ttl ${ttl}`);
  for (let i = 0; i < 25; i++) await r.store.incrby("relay:u10m:did:privy:alice", 1);
  r.advance(601_000);
  assert.equal((await r.post(await request(), headers)).status, 200);
});

test("logs carry no token, linked account, payload, signature, permit or key; the relayer stays closed without its settings", async () => {
  const r = relay(), headers = await auth(), body = await request(), dep = await deposit();
  await r.post(body, headers);
  await r.post(await request({ who: bob }), headers);
  await r.post(dep, headers);
  const all = r.logs.join("\n");
  assert.ok(r.logs.length >= 3 && all.includes('"code":"OK"') && all.includes('"chain":8453,"kind":"base-deposit"') && all.includes('"amount":"50000000"'));
  for (const secret of [headers.authorization.slice(7), headers["privy-id-token"], body.signature.slice(2), body.payload.slice(2, 200), dep.permit.slice(2), RELAYER_KEY.slice(2), "did:privy:alice", "linked_accounts"]) {
    assert.ok(!all.includes(secret), "a log line leaked private data");
  }
  const env = { PRIVY_APP_ID: APP, PRIVY_JWKS: JSON.stringify(jwks) };
  const planned = { schemaVersion: 3, kind: "zedge-private-orderbook", chainId: 26514, status: "planned", release: "orderbook-test" };
  assert.equal(configFromEnv(env, planned), null, "a planned manifest keeps the relayer closed");
  const configured = manifest;
  assert.equal(configFromEnv(env, configured)?.inviteOnly, true, "invite-only by default");
  assert.deepEqual([configFromEnv(env, configured)?.baseDailyBudgetWei, configFromEnv(env, configured)?.baseMinBalanceWei], [2_000_000_000_000_000n, 200_000_000_000_000n], "Base budget defaults");
  assert.equal(configFromEnv({ ...env, RELAY_BASE_DAILY_BUDGET_WEI: "0.002" }, configured), null);
  assert.equal(configFromEnv({ ...env, PRIVY_JWKS: "{}" }, configured), null);
  assert.equal(signerFromEnv("0x1234"), null);
  const wrongKey = relay();
  wrongKey.deps.signer = signerFromEnv(generatePrivateKey())!;
  assert.equal((await wrongKey.post(await request(), headers)).body.code, "RELAYER_UNFUNDED", "a key that is not the manifest's relayer sends nothing");
  wrongKey.deps.store = null as never;
  wrongKey.deps.signer = signer;
  assert.equal((await wrongKey.post(await request(), headers)).body.code, "STORE_UNAVAILABLE");
});

// ---------------------------------------------------------------- Base deposits into the vault (base-deposit)

test("a deposit goes to the vault on Base as depositWithPermit(owner, amount, deadline, v, r, s); the answer carries the Deposited index", async () => {
  const r = relay(), body = await deposit();
  const a = await r.post(body, await auth());
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.index, "1");
  assert.equal(r.chain.sent.length, 0, "nothing on Horizen");
  const [tx] = r.base.sent;
  assert.deepEqual([tx.chainId, tx.to?.toLowerCase(), tx.value ?? 0n, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gas], [8453, VAULT, 0n, 1_000_000n, 11_000_000n, 672_000n]);
  const call = decodeFunctionData({ abi: vaultAbi, data: tx.data! });
  const sig = body.permit;
  assert.equal(call.functionName, "depositWithPermit");
  assert.deepEqual(call.args, [alice.address, 50_000_000n, CHAIN_TIME + 1200n, Number.parseInt(sig.slice(130), 16), `0x${sig.slice(2, 66)}`, `0x${sig.slice(66, 130)}`]);
  assert.ok(Number(await r.store.get("relay:spent:8453:20261006")) > 0, "Base spends its own budget");
  assert.equal(await r.store.get("relay:spent:26514:20261006"), null);
});

test("deposit shapes: exact fields, a whole amount of at most 13 digits, a 65-byte permit with v 27 or 28", async () => {
  const r = relay(), headers = await auth(), good = await deposit();
  const bad: [string, unknown][] = [
    ["extra field", { ...good, to: addr(bob) }], ["missing deadline", { ...good, deadline: undefined }], ["amount zero", { ...good, amount: "0" }],
    ["amount as a number", { ...good, amount: 50_000_000 }], ["14 digits", { ...good, amount: "10000000000000" }], ["decimal", { ...good, amount: "1.5" }],
    ["v 0", { ...good, permit: `${good.permit.slice(0, 130)}00` }], ["64 bytes", { ...good, permit: good.permit.slice(0, 130) }], ["owner not an address", { ...good, owner: "0x1234" }],
  ];
  for (const [name, body] of bad) assert.equal((await r.post(body, headers)).body.code, "BAD_REQUEST", name);
  assert.ok(nothingSent(r));
  assert.equal(r.base.reads, 0);
});

test("the permit is recovered at the token's on-chain nonce, to this vault, for exactly the amount; an allowance that covers it also passes", async () => {
  const r = relay(), headers = await auth();
  r.base.usdcNonces.set(addr(alice), 2n);
  assert.equal((await r.post(await deposit({ nonce: 1n }), headers)).body.code, "PERMIT_MISMATCH", "stale nonce");
  assert.equal((await r.post(await deposit({ nonce: 2n, signedAmount: 49_000_000n }), headers)).body.code, "PERMIT_MISMATCH", "another amount");
  assert.equal((await r.post(await deposit({ nonce: 2n, spender: fresh() }), headers)).body.code, "PERMIT_MISMATCH", "another spender");
  assert.ok(nothingSent(r));
  r.base.ds.allowance = 50_000_000n;
  assert.equal((await r.post(await deposit({ nonce: 0n, signedAmount: 1n }), headers)).status, 200, "the allowance covers it");
  assert.equal((await r.post(await deposit({ nonce: 3n, amount: 20_000_000n }), headers)).status, 200);
});

test("the vault's limits, the wallet's balance and a 1 min to 1 h deadline are checked against Base before anything is sent", async () => {
  const cases: [string, Dep, (r: ReturnType<typeof relay>) => void, string][] = [
    ["below the minimum", { amount: 999_999n }, () => {}, "AMOUNT_OUT_OF_RANGE"],
    ["above the maximum", { amount: 500_000_001n }, () => {}, "AMOUNT_OUT_OF_RANGE"],
    ["deposits halted (max 0)", {}, (r) => { r.base.ds.limits.maxDeposit = 0n; }, "AMOUNT_OUT_OF_RANGE"],
    ["above the balance", {}, (r) => { r.base.ds.usdcBalance = 49_999_999n; }, "AMOUNT_ABOVE_BALANCE"],
    ["deadline under a minute", { deadline: CHAIN_TIME + 59n }, () => {}, "DEADLINE_OUT_OF_RANGE"],
    ["deadline over an hour", { deadline: CHAIN_TIME + 3601n }, () => {}, "DEADLINE_OUT_OF_RANGE"],
    ["Base fee above the cap", {}, (r) => { r.base.ds.baseFee = 99_000_001n; }, "FEE_ABOVE_CAP"],
    ["relayer without Base ETH", {}, (r) => { r.base.ds.balance = 10n ** 14n; }, "RELAYER_UNFUNDED"],
    ["the vault would refuse", {}, (r) => { r.base.simulate = { ok: false, reason: "AmountOutOfRange" }; }, "SIMULATION_REVERTED"],
    // 1.25 M gas x 1.2 is past 1.5 M: the Horizen deposit fee is being pumped. Nothing is sent; the user's USDC stays put.
    ["pumped deposit fee", {}, (r) => { r.base.simulate = { ok: true, gas: 1_250_001n }; }, "FEE_ABOVE_CAP"],
  ];
  for (const [name, d, setup, code] of cases) {
    const r = relay(), headers = await auth(), body = await deposit(d);
    setup(r);
    const a = await r.post(body, headers);
    assert.equal(a.body.code, code, name);
    assert.ok(nothingSent(r), name);
    assert.equal(await r.store.get("relay:spent:8453:20261006"), null, name);
    assert.equal(await r.store.get(`relay:dep:${keccak256(body.permit)}`), null, `${name}: no idempotency record kept`);
  }
  const ok = relay();
  ok.base.simulate = { ok: true, gas: 1_250_000n };
  assert.equal((await ok.post(await deposit(), await auth())).status, 200, "1.5 M gas exactly is still sent");
});

test("idempotency: four concurrent identical deposits send one transaction; a replay answers with the same index", async () => {
  // Every post counts toward the five deposits a day, replays included: limits are counted before anything else.
  const r = relay(), headers = await auth(), body = await deposit();
  const answers = await Promise.all(Array.from({ length: 4 }, () => r.post(body, headers)));
  assert.equal(r.base.sent.length, 1);
  assert.equal(answers.filter((a) => a.status === 200 && !a.body.duplicate).length, 1);
  const replay = await r.post(body, headers);
  assert.deepEqual([replay.status, replay.body.duplicate, replay.body.index], [200, true, "1"]);
  assert.equal(r.base.sent.length, 1);
});

test("Base and Horizen have their own lock, nonce, in-flight mark and budget: one chain's sender never waits for the other's", async () => {
  const r = relay(), headers = await auth();
  await r.store.set("relay:lock:26514", "held by another instance", { px: 15_000 });
  const a = await r.post(await deposit(), headers);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(r.base.sent[0].nonce, 0);
  await r.store.del("relay:lock:26514");
  await r.store.set("relay:lock:8453", "held", { px: 15_000 });
  assert.equal((await r.post(await request(), headers)).status, 200);
  assert.equal(r.chain.sent[0].nonce, 0);
});

test("a deposit receipt without the vault's Deposited event for this owner and amount reads as REVERTED", async () => {
  const r = relay(), headers = await auth();
  r.base.deposited = (e) => ({ ...e, amount: e.amount - 1n });
  assert.equal((await r.post(await deposit(), headers)).body.code, "REVERTED");
  const other = relay();
  other.base.deposited = (e) => ({ ...e, account: addr(bob) });
  assert.equal((await other.post(await deposit(), await auth())).body.code, "REVERTED");
});
