#!/usr/bin/env node
// ZEDGE house market maker (README.md). Rests Up and Down quotes on the private BTC 15-minute order book as the house,
// sending its own requests with its own gas (never through the relayer). Refuses to start without --mainnet or
// --fork <loopback Anvil URL>. Never prints the key.
//
//   node --experimental-strip-types services/market-maker/main.mjs <command> (--mainnet | --fork URL) [--settings FILE]
//   commands: run [--dry-run] | status | deposit <usdc> | withdraw <usdc>
// Custody is the Base vault: deposit signs a Base USDC permit and calls the vault's depositWithPermit (the house pays its own
// Base gas); withdraw asks the engine for a payout to the house on Base, which the payout signer pays.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SHARE, apply, fairUp, plan, quotes, realizedSigma, spotCheck, worstStake } from "./pricing.mjs";

const CHAIN = 26514, BASE = 8453, DURATION = 900, PROCESS = 1, ASSOCIATEKEY = 3, PUB_KEY_NOT_REGISTERED = 9, MAX_REFUSALS = 3;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RULES_VERSION = "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half";
/** The live deployment, from the committed order-book manifest (scripts/write-orderbook-manifest.mjs wrote it from chain reads).
 * Public values only, read from the manifest rather than written here. Refused while the manifest is planned. */
export function mainnetDeployment(book) {
  if (book?.kind !== "zedge-private-orderbook" || book.chainId !== CHAIN) fail("public/deployments/26514-orderbook.json is not Horizen's order-book manifest");
  if (book.status !== "configured") fail("the order-book manifest is planned: nothing is deployed to quote on yet");
  return {
    rpc: HORIZEN_RPC, crossCheckRpc: null, baseRpc: BASE_RPC, // Caldera's public endpoint refuses this network, so its cross-check skipped every round
    endpoint: book.endpoint.address, authenticator: book.authenticator.address, trigger: book.trigger.address, registry: book.trigger.registry,
    applicationId: book.application.id, applicationFingerprint: book.application.wasmSha256, origin: book.application.origin, epoch: book.application.epoch,
    house: book.application.house, keyFile: `${homedir()}/.config/zedge/house.key`, minFeeWei: BigInt(book.endpoint.minFeePerRequestWei),
    teeSigner: book.authenticator.teeSigner, enclaveKey: book.authenticator.enclavePublicKey, sessionRulesHash: book.application.sessionRulesHash, vault: book.custody.vault.address,
  };
}
const committedBook = () => JSON.parse(readFileSync(new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8"));
// The thirdweb Horizen gateway is rate-limited without a client id; the operator keeps it in a private file.
// An Alchemy key in ~/.config/zedge/alchemy.key gives Base reads a keyed endpoint; otherwise Base's own public one.
const BASE_RPC = (() => { try { const k = readFileSync(`${homedir()}/.config/zedge/alchemy.key`, "utf8").trim(); if (/^[A-Za-z0-9_-]{16,64}$/.test(k)) return `https://base-mainnet.g.alchemy.com/v2/${k}`; } catch {} return "https://mainnet.base.org"; })();
// A private Horizen endpoint in ~/.config/zedge/horizen.url (https, never logged) comes first, when present.
const HORIZEN_RPC = (() => {
  try { const url = readFileSync(`${homedir()}/.config/zedge/horizen.url`, "utf8").trim(); if (/^https:\/\/\S+$/.test(url)) return url; } catch {}
  try { const id = readFileSync(`${homedir()}/.config/zedge/thirdweb.id`, "utf8").trim(); if (/^[0-9a-f]{32}$/.test(id)) return `https://26514.rpc.thirdweb.com/${id}`; } catch {}
  return "https://26514.rpc.thirdweb.com";
})();
const USAGE = "usage: main.mjs <run [--dry-run] | status | deposit <usdc> | withdraw <usdc>> (--mainnet | --fork http://127.0.0.1:<port>) [--settings <file>]";
const COINBASE = "https://api.exchange.coinbase.com/products/BTC-USD", KRAKEN = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD";

const lower = (x) => String(x).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const usdc = (atoms) => (Number(atoms) / 1e6).toFixed(2);
const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
/** A refusal to start or to act. Always fatal, printed without a stack. */
function fail(message) { throw Object.assign(new Error(message), { refused: true }); }

/** The endpoint's shared queue is too full for this request. A cancel_all still goes out until one slot is left (the endpoint
 * refuses at 10): the relayer admits users up to 6 pending, and their requests must not keep stale house quotes alive. */
export function queueFull(queue, op) { return queue >= (op === "cancel_all" ? 9n : 5n); }

/** The /quotes body (README "Quotes for the site"): per outcome, the lowest resting sell (ask) and the highest resting buy (bid) of
 * `view` in round r ({ id, start }) at chain time `now`, as { cents, shares }, or null where none rests. */
export function houseQuotes(view, r, now, at = Date.now()) {
  const mine = view.orders.filter((o) => o.roundId === r.id && o.expiry > now && o.remaining > 0);
  const best = (outcome, side) => {
    const os = mine.filter((o) => o.outcome === outcome && o.side === side);
    if (!os.length) return null;
    const cents = (side === "sell" ? Math.min : Math.max)(...os.map((o) => o.price));
    return { cents, shares: os.filter((o) => o.price === cents).reduce((n, o) => n + o.remaining, 0) / SHARE };
  };
  return { at, start: r.start, up: { ask: best("up", "sell"), bid: best("up", "buy") }, down: { ask: best("down", "sell"), bid: best("down", "buy") } };
}

/** --mainnet, or --fork with a loopback http URL. Nothing else runs. */
export function target(a) {
  if (a.mainnet && a.fork !== undefined) fail("pass one of --mainnet and --fork, not both");
  if (a.mainnet) return { mode: "mainnet", rpc: HORIZEN_RPC };
  if (a.fork === undefined) fail("refusing to run without --mainnet or --fork http://127.0.0.1:<port>");
  let u;
  try { u = new URL(a.fork); } catch { fail(`--fork: not a URL: ${a.fork}`); }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password) {
    fail("--fork takes a loopback http URL: http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>");
  }
  return { mode: "fork", rpc: a.fork };
}

/** The node must serve Horizen's chain ID, and under --fork it must be Anvil (a local fork), never a real node. */
export async function checkNode(send, mode) {
  if (mode === "fork") {
    const version = String(await send("web3_clientVersion", []));
    if (!/anvil/i.test(version)) fail(`--fork: the node at that URL is not Anvil (${version.slice(0, 40)})`);
  }
  const chainId = Number(BigInt(await send("eth_chainId", [])));
  if (chainId !== CHAIN) fail(`the node serves chain ${chainId}, not Horizen ${CHAIN}`);
}

/** Base must be chain 8453, and under --fork an Anvil fork. */
export async function checkBase(send, mode) {
  if (mode === "fork" && !/anvil/i.test(String(await send("web3_clientVersion", [])))) fail("settings.fork.baseRpc: the node at that URL is not Anvil");
  const chainId = Number(BigInt(await send("eth_chainId", [])));
  if (chainId !== BASE) fail(`the Base node serves chain ${chainId}, not ${BASE}`);
}

// Tuning: [default, lowest, highest]. The defaults are the spec's (README).
const TUNING = { halfSpreadCents: [3, 1, 20], quoteShares: [10, 1, 1000], mintSets: [40, 1, 10_000], maxStakeUsdc: [100, 1, 2000],
  quoteLifetimeSeconds: [180, 60, 600], requoteDriftCents: [8, 1, 50], maxRpcPerRound: [300, 50, 5000], pollSeconds: [10, 2, 60] };
const FORK_FIELDS = ["applicationFingerprint", "applicationId", "authenticator", "baseRpc", "endpoint", "epoch", "house", "keyFile", "origin", "registry", "trigger", "vault"];

/** Settings: tuning, and under --fork only the fork's deployment (--mainnet uses the manifest's). Unknown fields are refused. */
export function settingsFrom(json, mode, book = mode === "mainnet" ? committedBook() : null) {
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("settings: expected a JSON object");
  const s = { ...Object.fromEntries(Object.entries(TUNING).map(([k, [v]]) => [k, v])), minEthWei: 200_000_000_000_000n };
  for (const [k, v] of Object.entries(json)) {
    if (k === "fork") continue;
    if (k === "minEthWei") {
      if (typeof v !== "string" || !/^[0-9]{1,30}$/.test(v)) fail("settings.minEthWei: wei as a decimal string");
      s.minEthWei = BigInt(v);
      continue;
    }
    const range = TUNING[k];
    if (!range) fail(`settings: unknown field ${k}`);
    if (!Number.isInteger(v) || v < range[1] || v > range[2]) fail(`settings.${k}: an integer from ${range[1]} to ${range[2]}`);
    s[k] = v;
  }
  if (s.mintSets < s.quoteShares) fail("settings.mintSets must be at least settings.quoteShares");
  if (mode === "mainnet") {
    if (json.fork !== undefined) fail("settings.fork is for --fork only; --mainnet uses the pinned deployment");
    return { ...s, deployment: mainnetDeployment(book) };
  }
  const f = json.fork;
  if (!f || typeof f !== "object" || Object.keys(f).sort().join() !== FORK_FIELDS.join()) fail(`settings.fork needs exactly: ${FORK_FIELDS.join(", ")}`);
  for (const k of ["authenticator", "endpoint", "house", "registry", "trigger", "vault"]) if (!/^0x[0-9a-f]{40}$/.test(f[k])) fail(`settings.fork.${k}: a lowercase 0x address`);
  if (typeof f.baseRpc !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(f.baseRpc)) fail("settings.fork.baseRpc: the loopback URL of a Base Anvil fork");
  if (!/^[1-9][0-9]{0,19}$/.test(f.applicationId) || !/^[0-9a-f]{64}$/.test(f.applicationFingerprint) || !/^[1-9][0-9]{0,9}$/.test(f.epoch) ||
      typeof f.origin !== "string" || typeof f.keyFile !== "string") fail("settings.fork: applicationId (decimal), applicationFingerprint (64 hex), epoch, origin and keyFile");
  return { ...s, deployment: { ...f, keyFile: resolve(f.keyFile) } };
}

function readKey(file) {
  let st;
  try { st = lstatSync(file); } catch { fail(`${file}: no key file there`); }
  if (!st.isFile() || (st.mode & 0o777) !== 0o600) fail(`${file}: must be a regular file (not a link) with mode 600`);
  const key = readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${file}: expected 0x and 64 hex digits`);
  return key;
}

/** One sending process per key: its requests are sequential, and the guest freezes an account holding a staged command. */
function lock(keyFile) {
  const path = `${keyFile}.lock`;
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    let alive;
    try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; }
    if (alive) fail(`another market-maker process (pid ${pid}) holds ${path}`);
    unlinkSync(path);
    return lock(keyFile);
  }
  process.on("exit", () => { try { unlinkSync(path); } catch { /* gone */ } });
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "zedge-market-maker" }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}
const feeds = {};
/** BTC spot: Coinbase's mid, checked against Kraken's (pricing.mjs spotCheck). Both are read at every decision. */
async function spot() {
  const [cb, kr] = await Promise.allSettled([getJson(`${COINBASE}/ticker`), getJson(KRAKEN)]);
  const at = Date.now();
  if (cb.status === "fulfilled") feeds.coinbase = { mid: (Number(cb.value.bid) + Number(cb.value.ask)) / 2, at };
  const k = kr.status === "fulfilled" && !kr.value.error?.length && Object.values(kr.value.result ?? {})[0];
  if (k) feeds.kraken = { mid: (Number(k.a?.[0]) + Number(k.b?.[0])) / 2, at };
  return spotCheck(feeds.coinbase, feeds.kraken, Date.now());
}
/** σ from the last 60 Coinbase 1-minute candles ([time, low, high, open, close, volume]). */
async function sigma() {
  const candles = await getJson(`${COINBASE}/candles?granularity=60`);
  return realizedSigma([...candles].sort((x, y) => y[0] - x[0]).slice(0, 60).map((c) => Number(c[4])).reverse());
}

async function main(argv) {
  const { values: a, positionals: [cmd, amount, ...extra] } = parseArgs({ args: argv, allowPositionals: true,
    options: { mainnet: { type: "boolean" }, fork: { type: "string" }, settings: { type: "string" }, "dry-run": { type: "boolean" } } });
  const arity = { run: 0, status: 0, deposit: 1, withdraw: 1 };
  if (!Object.hasOwn(arity, cmd) || (amount === undefined ? 0 : 1) !== arity[cmd] || extra.length) fail(USAGE);
  if (a["dry-run"] && cmd !== "run") fail("--dry-run goes with run");
  const t = target(a);
  let json = {};
  if (a.settings) try { json = JSON.parse(readFileSync(a.settings, "utf8")); } catch (e) { fail(`settings: ${e.message}`); }
  const s = settingsFrom(json, t.mode);
  const dep = s.deployment, dry = !!a["dry-run"];

  const crypto = new URL("../../adapters/vela/crypto/", import.meta.url);
  const { ethers } = await import(new URL("node_modules/ethers/lib.esm/index.js", crypto));
  const sdk = await import(new URL("node_modules/@horizen/vela-common-ts/dist/node.js", crypto));
  const { EvaluationSession } = await import(new URL("session.ts", crypto));
  const codec = await import(new URL("guest.ts", crypto));
  const { padBody } = await import(new URL("pad.ts", crypto));

  let rpcCalls = 0;
  class Horizen extends ethers.JsonRpcProvider {
    // Horizen's own fee level (base ~252 wei, tip 1,000,000 wei), as demo-house.mjs and fork-round.mjs pay it.
    async getFeeData() { return new ethers.FeeData(null, 2_000_504n, 1_000_000n); }
    async _send(payload) { rpcCalls += Array.isArray(payload) ? payload.length : 1; return super._send(payload); }
  }
  const connection = (url, attempts) => { const f = new ethers.FetchRequest(url); f.setThrottleParams({ maxAttempts: attempts }); return f; };
  const provider = new Horizen(connection(t.rpc, 3), CHAIN, { staticNetwork: true, pollingInterval: 3000 });
  await checkNode((m, p) => provider.send(m, p), t.mode);

  const wallet = new ethers.Wallet(readKey(dep.keyFile), provider), account = lower(wallet.address);
  if (account !== dep.house) fail(`the key in ${dep.keyFile} is not the house ${dep.house}`);
  if (cmd !== "status" && !dry) lock(dep.keyFile);

  const OBS = "tuple(int192 price,uint32 validFromTimestamp,uint32 observationsTimestamp,uint32 expiresAt,bytes32 reportHash,uint8 decimals)";
  const CONFIG = { oracle: "address", collateral: "address", btcFeedId: "bytes32", ethFeedId: "bytes32", btcDecimals: "uint8", ethDecimals: "uint8",
    observationWindow: "uint32", openingGrace: "uint32", voidGrace: "uint32", cutoffBuffer: "uint32", rulesHash: "bytes32" };
  const REGISTRY_ABI = [...Object.entries(CONFIG).map(([k, type]) => `function ${k}() view returns (${type})`),
    `function getRound(bytes32) view returns (tuple(uint8 asset,uint32 duration,uint64 start,uint64 end,uint64 cutoff,uint64 openingDeadline,uint64 voidableAfter,uint64 openedAt,uint64 resolvedAt,uint8 outcome,${OBS} opening,${OBS} closing))`];
  const endpoint = new ethers.Contract(dep.endpoint, [
    "function triggerContracts(uint64) view returns (address)", "function applicationStateRoots(uint64) view returns (bytes32)",
    "function minFeePerRequest() view returns (uint256)", "function getPendingRequestsSize() view returns (uint256)",
    "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
    "event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
    "event UserEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes encryptedData)",
  ], provider);
  const registry = new ethers.Contract(dep.registry, REGISTRY_ABI, provider);
  const auth = new ethers.Contract(dep.authenticator, ["function getPubSecp521r1() view returns (bytes)", "function getTeeSigner() view returns (address)"], provider);
  const APP = BigInt(dep.applicationId), abi = ethers.AbiCoder.defaultAbiCoder();

  // The engine configuration, rebuilt from the registry exactly as the deploy request built it (demo-house.mjs).
  const keys = Object.keys(CONFIG), values = await Promise.all(keys.map((k) => registry[k]()));
  const cfg = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  const rulesHash = ethers.keccak256(abi.encode(["string", "uint256", "tuple(address,address,bytes32,bytes32,uint8,uint8,uint32,uint32,uint32,uint32)"],
    [RULES_VERSION, CHAIN, [cfg.oracle, cfg.collateral, cfg.btcFeedId, cfg.ethFeedId, cfg.btcDecimals, cfg.ethDecimals, cfg.observationWindow, cfg.openingGrace, cfg.voidGrace, cfg.cutoffBuffer]]));
  if (rulesHash !== lower(cfg.rulesHash)) fail("the registry's rules hash is not the one the engine reproduces");
  const collateral = lower(cfg.collateral);
  const config = { domain: { chainId: CHAIN, endpoint: dep.endpoint, applicationId: dep.applicationId, rulesVersion: 3 }, authority: dep.trigger, collateral, feeBps: 0,
    oracle: { chainId: CHAIN, registry: dep.registry, oracle: lower(cfg.oracle), rulesHash, btcFeedId: cfg.btcFeedId, ethFeedId: cfg.ethFeedId, decimals: Number(cfg.btcDecimals),
      observationWindow: Number(cfg.observationWindow), openingGrace: Number(cfg.openingGrace), voidGrace: Number(cfg.voidGrace), cutoffBuffer: Number(cfg.cutoffBuffer) } };
  const sessionRulesHash = sha256(JSON.stringify(config));
  if (t.mode === "mainnet" && sessionRulesHash !== dep.sessionRulesHash) fail("the engine configuration rebuilt from the registry is not the deployed one");

  // The operator's keys and the request fee: pinned on mainnet, taken at start on a fork; re-checked every round.
  const [enclaveKey, teeSigner, fee] = await Promise.all([auth.getPubSecp521r1().then(lower), auth.getTeeSigner().then(lower), endpoint.minFeePerRequest()]);
  if (t.mode === "mainnet" && (enclaveKey !== dep.enclaveKey || teeSigner !== dep.teeSigner || fee !== dep.minFeeWei)) {
    fail("the exchange's operator keys or request fee changed; not trading until this bot is updated");
  }
  if (fee > 1_000_000_000n) fail(`the request fee is ${fee} wei, above 1 gwei`);
  async function deploymentProblem() {
    const [trigger, root, k, signer, f] = await Promise.all([endpoint.triggerContracts(APP), endpoint.applicationStateRoots(APP),
      auth.getPubSecp521r1(), auth.getTeeSigner(), endpoint.minFeePerRequest()]);
    if (lower(trigger) !== dep.trigger) return "the application's trigger changed";
    if (root === ethers.ZeroHash) return "the application has no state root";
    if (lower(k) !== enclaveKey || lower(signer) !== teeSigner) return "the exchange's operator keys changed";
    if (f !== fee) return "the request fee changed";
    return null;
  }
  const startProblem = await deploymentProblem();
  if (startProblem) fail(startProblem);

  const domain = { chainId: CHAIN, endpoint: dep.endpoint, applicationId: dep.applicationId, applicationFingerprint: dep.applicationFingerprint, rulesHash: sessionRulesHash, origin: dep.origin };
  const session = new EvaluationSession(domain, account, { id: dep.epoch, enclavePublicKey: enclaveKey });
  const client = new sdk.VelaClient(wallet, false, dep.authenticator, dep.endpoint);
  const cross = dep.crossCheckRpc && new ethers.Contract(dep.registry, REGISTRY_ABI, new ethers.JsonRpcProvider(connection(dep.crossCheckRpc, 1), CHAIN, { staticNetwork: true }));

  /** Round `start` as the engine derives it (engine NewRoundSpec and RoundID; fork-round.mjs). */
  function roundAt(start) {
    const o = config.oracle, end = start + DURATION;
    const registryRoundId = ethers.keccak256(abi.encode(["uint256", "address", "bytes32", "uint8", "uint32", "uint64"], [CHAIN, dep.registry, rulesHash, 0, DURATION, start]));
    const spec = { asset: "BTC", feed: o.btcFeedId, registryRoundId, start, end, cutoff: end - o.cutoffBuffer, observationWindow: o.observationWindow,
      openingDeadline: start + o.observationWindow + o.openingGrace, voidableAfter: end + o.observationWindow + o.voidGrace };
    return { ...spec, id: sha256(JSON.stringify({ config, round: spec })) };
  }
  /** The engine's own opening of round r: the guest's public `settle` event (kind 1), from the exact Chainlink report, seconds
   * after the boundary and well before the registry records it. Null while there is none in the last ten minutes of blocks. */
  const SETTLE = `0x${sha256("zedge.vela.settle.v1")}`;
  async function engineOpening(r, head) {
    const logs = await endpoint.queryFilter(endpoint.filters.AppEvent(APP, null, SETTLE), Math.max(0, head - 600), head);
    for (const l of logs) {
      const w = ethers.getBytes(l.args.data);
      if (w.length !== 224) continue;
      const word = (i) => ethers.hexlify(w.slice(32 * i, 32 * i + 32)), roundId = word(0), kind = Number(BigInt(word(1))), price = BigInt(word(3));
      // The round's engine ID or its registry ID, whichever the event carries.
      if (kind === 1 && (roundId === `0x${r.id}` || roundId === lower(r.registryRoundId))) return { price, openedAt: Number(BigInt(word(4))), s0: Number(ethers.formatUnits(price, 18)), engine: true };
    }
    return null;
  }
  /** The registry's opening of round r, or null while it has none (or the round is not created yet). */
  async function opening(reg, r, blockTag) {
    let g;
    try { g = await reg.getRound(r.registryRoundId, { blockTag }); } catch { return null; }
    if (Number(g.cutoff) !== r.cutoff || Number(g.end) !== r.end) return { problem: "the registry's round terms differ from the engine's" };
    if (Number(g.openedAt) === 0 || Number(g.outcome) !== 0) return null;
    return { price: g.opening.price, openedAt: Number(g.openedAt), s0: Number(ethers.formatUnits(g.opening.price, Number(g.opening.decimals))) };
  }

  // ---- requests (the house's own submitRequest, as demo-house.mjs and fork-round.mjs send them)

  let lastCompletionBlock = -1;
  const parse = (l) => { try { return endpoint.interface.parseLog(l); } catch { return null; } };
  async function request(label, type, payload, token = ethers.ZeroAddress, assetAmount = 0n) {
    const sent = await client.submitRequestAndWaitForRequestId(0, APP, type, payload, token, assetAmount, fee);
    const from = sent.transactionReceipt.blockNumber;
    log("submitted", { label, tx: sent.transactionReceipt.hash, requestId: sent.requestId });
    for (const end = Date.now() + 15 * 60_000; Date.now() < end;) {
      await sleep(3000);
      try {
        const e = (await endpoint.queryFilter(endpoint.filters.RequestCompleted(APP, sent.requestId), from)).at(0);
        if (!e) continue;
        const rc = await provider.getTransactionReceipt(e.transactionHash);
        lastCompletionBlock = e.blockNumber;
        const cts = rc.logs.filter((l) => lower(l.address) === dep.endpoint).map(parse)
          .filter((p) => p?.name === "UserEvent" && p.args.applicationId === APP).map((p) => ethers.getBytes(p.args.encryptedData));
        return { status: Number(e.args.status), errorCode: Number(e.args.errorCode), errorMessage: e.args.errorMessage, tx: e.transactionHash, cts };
      } catch (err) { log("poll error", { message: err.shortMessage ?? err.message }); }
    }
    // Still in the endpoint's queue: one request in flight at a time, so stop rather than send around it.
    throw Object.assign(new Error(`request ${sent.requestId} has not completed in 15 minutes; nothing was resent`), { refused: true });
  }
  async function readReceipt(cts, id) {
    for (const ct of cts) { const r = await session.decryptReceipt(ct, id); if (r.status === "readable") return r.envelope.body; }
    return null;
  }

  const EMPTY = { nonce: 0, cash: 0, reservedCash: 0, holdings: [], orders: [] };
  let view = EMPTY, staged = false; // the latest receipt's view, and whether a book command of ours awaits its outcome
  const summary = (v) => ({ cash: usdc(v.cash), reserved: usdc(v.reservedCash), stake: usdc(worstStake(v)),
    orders: v.orders.map((o) => `${o.side} ${o.outcome} ${o.remaining / SHARE}@${o.price}${o.filled ? ` filled ${o.filled / SHARE}` : ""}`),
    holdings: v.holdings.map((h) => `${h.roundId.slice(0, 8)} up ${(h.up + h.reservedUp) / SHARE} down ${(h.down + h.reservedDown) / SHARE}`) });

  /** One engine command (or a sync) in one request. The nonce comes from the latest view, plus one for a staged
   * command that has not come back yet; a wrong guess is a private refusal whose receipt carries the right view. */
  async function send(c) {
    const isSync = c.op === "sync", nonce = view.nonce + 1 + (staged ? 1 : 0);
    const id = isSync ? codec.syncRequestId(account) : codec.commandId(account, nonce);
    const body = isSync ? codec.syncBody() : codec.commandBody({ domain: config.domain, id, nonce, account, ...c });
    const done = await request(c.op, PROCESS, await session.encryptCommand(id, padBody(session, id, body)));
    if (done.status !== 0) { log("failed", { op: c.op, errorCode: done.errorCode, error: done.errorMessage }); return { done }; }
    const b = await readReceipt(done.cts, id);
    if (!b) { log("unreadable receipt", { op: c.op, tx: done.tx }); return { done }; }
    if (b.outcome || b.status === "staged" || /nonce/.test(b.reason ?? "")) staged = b.status === "staged";
    view = b.view ? (b.status === "staged" ? apply(b.view, c) : b.view) : EMPTY;
    log("receipt", { op: c.op, status: b.status, reason: b.reason, outcome: b.outcome && `${b.outcome.status}${b.outcome.reason ? `: ${b.outcome.reason}` : ""}`, ...summary(view) });
    return { done, body: b };
  }
  // "insufficient available …" means a user filled a house quote since the last receipt (the view was stale); the
  // receipt carries the true view, so it is not counted against the round's refusals.
  const refused = ({ done, body }) => done.status !== 0 || !body ||
    (body.outcome?.status === "rejected" && !/insufficient available/.test(body.outcome.reason ?? "")) ||
    (body.status === "rejected" && !/nonce|waiting for its tick|insufficient available/.test(body.reason ?? ""));

  /** Unlock (one silent local signature), then a sync; registers the key first if the host has none (error 9). */
  async function startup() {
    await session.unlock(wallet);
    let r = await send({ op: "sync" });
    if (r.done.status !== 0 && r.done.errorCode === PUB_KEY_NOT_REGISTERED) {
      const k = await request("associate key", ASSOCIATEKEY, await session.associationPayload());
      if (k.status !== 0) fail(`key registration failed: ${k.errorMessage}`);
      r = await send({ op: "sync" });
    }
    if (!r.body) fail("the startup sync returned no readable receipt");
  }
  const units = (text, min) => {
    if (!/^[0-9]{1,9}(\.[0-9]{1,6})?$/.test(text ?? "")) fail("amount: USDC, at most 6 decimals");
    const v = ethers.parseUnits(text, 6);
    if (v < min) fail(`amount: at least ${usdc(min)} USDC`);
    return v;
  };
  // Base: the house's USDC and the vault. A fork deployment names a loopback Base Anvil fork.
  const base = new ethers.JsonRpcProvider(connection(dep.baseRpc, 3), BASE, { staticNetwork: true });
  await checkBase((m, p) => base.send(m, p), t.mode);
  const baseUsdc = new ethers.Contract(BASE_USDC, ["function balanceOf(address) view returns (uint256)", "function nonces(address) view returns (uint256)"], base);

  // ---- subcommands

  if (cmd === "status") {
    const head = await provider.getBlock("latest"), r = roundAt(Math.floor(head.timestamp / DURATION) * DURATION);
    const [eth, baseEth, walletUsdc, queue, open] = await Promise.all([provider.getBalance(account), base.getBalance(account), baseUsdc.balanceOf(account),
      endpoint.getPendingRequestsSize(), engineOpening(r, head.number).then((o) => o ?? opening(registry, r, head.number))]);
    const sp = await spot(), sg = await sigma().catch(() => null);
    const p = sp.ok && open?.s0 && sg ? fairUp(sp.spot, open.s0, sg, r.end - head.timestamp) : null;
    return log("status", { mode: t.mode, house: account, eth: ethers.formatEther(eth), baseEth: ethers.formatEther(baseEth), baseUsdc: usdc(walletUsdc),
      queue: Number(queue), chainTime: head.timestamp, sessionRulesHash, round: { start: r.start, cutoff: r.cutoff, end: r.end, id: r.id, opening: open?.s0 ?? null, openedBy: open ? (open.engine ? "engine" : "registry") : null },
      spot: sp, sigma: sg, p, quotes: p === null ? null : quotes(p, s.halfSpreadCents) });
  }
  if (cmd === "deposit") {
    // Into the Base vault with a permit the house signs; the house sends it and pays the Base gas. Every deposit spends one of
    // the guest's 4,096 evidence IDs. The engine credits it about a minute later (the Horizen inbox, then a tick).
    const atoms = units(amount, 1_000_000n);
    const vault = new ethers.Contract(dep.vault, ["function depositWithPermit(address,uint256,uint256,uint8,bytes32,bytes32) returns (uint64)",
      "function limits() view returns (uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap)",
      "event Deposited(uint64 indexed index, address indexed account, uint256 amount)"], wallet.connect(base));
    const [balance, nonce, limits, block] = await Promise.all([baseUsdc.balanceOf(account), baseUsdc.nonces(account), vault.limits(), base.getBlock("latest")]);
    if (balance < atoms) fail(`the house wallet holds ${usdc(balance)} USDC on Base`);
    if (atoms < limits.minDeposit || atoms > limits.maxDeposit) fail(`the vault takes ${usdc(limits.minDeposit)} to ${usdc(limits.maxDeposit)} USDC per deposit`);
    const deadline = BigInt(block.timestamp + 1200);
    const sig = ethers.Signature.from(await wallet.signTypedData({ name: "USD Coin", version: "2", chainId: BASE, verifyingContract: BASE_USDC },
      { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { owner: account, spender: dep.vault, value: atoms, nonce, deadline }));
    const rc = await (await vault.depositWithPermit(account, atoms, deadline, sig.v, sig.r, sig.s)).wait();
    const index = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Deposited")?.args.index;
    return log("deposited on Base", { usdc: usdc(atoms), index: index?.toString() ?? null, tx: rc.hash, note: "credited by the order book in about a minute; status or run shows the cash" });
  }
  if (cmd === "withdraw") {
    const atoms = units(amount, 1n);
    await startup();
    if (BigInt(view.cash) < atoms) fail(`the house's free private cash is ${usdc(view.cash)} USDC`);
    const r = await send({ op: "request_withdrawal", amount: Number(atoms), destination: account });
    if (r.body?.status !== "applied") fail(`withdrawal not applied: ${r.body?.reason || r.done.errorMessage || "unreadable receipt"}`);
    return log("withdrawal requested", { usdc: usdc(atoms), to: account, note: "the payout signer pays it to the house on Base" });
  }

  // ---- run: one decision per loop, at most one request in flight

  let stopping = false, wake = () => {};
  const stop = () => { if (stopping) process.exit(1); stopping = true; log("stopping"); wake(); }; // a second signal exits at once
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // GET /quotes for the indexer on the private network: the house's resting quotes only, never balances or keys. Not under --dry-run,
  // whose orders are simulated. A server error is logged and the bot quotes on without it.
  let quoted = null;
  if (process.env.HOUSE_QUOTES_PORT && !dry) {
    const server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/quotes") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(quoted));
    });
    const serverError = (e) => log("quotes server error", { code: e.code ?? e.name });
    server.on("error", serverError);
    try { server.listen(Number(process.env.HOUSE_QUOTES_PORT), "::", () => log("serving quotes", { port: server.address().port })); } catch (e) { serverError(e); }
  }
  if (dry) view = { ...EMPTY, cash: 200 * SHARE }; // a simulated 200 USDC; nothing is signed or sent
  else await startup();
  const nap = () => new Promise((done) => { const timer = setTimeout(done, s.pollSeconds * 1000); wake = () => { clearTimeout(timer); done(); }; });
  let noted = "";
  const note = (reason, fields) => { if (reason !== noted) log("waiting", { reason, ...fields }); noted = reason; };
  let r = null, errors = 0, beat = 0;
  /** Queue and gas guards, read just before a request. A cancel_all goes out below the ETH floor while it can. */
  async function clear(c) {
    const [queue, eth] = await Promise.all([endpoint.getPendingRequestsSize(), provider.getBalance(account)]);
    r.eth0 ??= eth; r.eth = eth;
    if (queueFull(queue, c.op)) return note(`the endpoint queue holds ${queue} requests`), false;
    if (eth < s.minEthWei && c.op !== "cancel_all") return note(`house ETH ${ethers.formatEther(eth)} is below the floor`), false;
    return true;
  }
  log("running", { mode: t.mode, dryRun: dry, house: account, settings: { ...s, deployment: undefined } });
  /** One decision. Returns true once stopped. */
  async function step() {
    const head = await provider.getBlock("latest"), now = head.timestamp, start = Math.floor(now / DURATION) * DURATION;
    if (r?.start !== start) {
      const blocked = await deploymentProblem(); // before the round is taken on, so a failed read is read again
      if (r) log("round done", { start: r.start, requests: r.requests, refusals: r.refusals, rpcCalls: rpcCalls - r.calls0, ethBefore: r.eth0, ethAfter: r.eth });
      r = { ...roundAt(start), blocked, requests: 0, refusals: 0, calls0: rpcCalls, open: null, sigma: null, crossChecked: !cross, crossChecks: 0, crossAt: 0 };
    }
    quoted = houseQuotes(view, r, now); // every decision, so also right after every receipt (a step that sends returns without a nap)
    if (stopping) { // cancel what rests in the open round, then exit
      if (!dry && view.orders.some((o) => o.roundId === r.id && o.expiry > now) && now < r.cutoff && (await clear({ op: "cancel_all" }))) await send({ op: "cancel_all", roundId: r.id });
      log("stopped", summary(view));
      return true;
    }
    if (!r.open && !r.blocked) {
      // The engine's own opening (from the exact Chainlink report) first; the registry's record is the fallback.
      const o = await engineOpening(r, head.number) ?? await opening(registry, r, head.number);
      if (o?.problem) r.blocked = o.problem;
      else if (o) { r.open = { ...o, seenBlock: head.number }; r.crossChecked ||= o.engine; log("round open", { start, cutoff: r.cutoff, s0: o.s0, by: o.engine ? "engine" : "registry" }); }
    }
    if (r.open && !r.crossChecked && r.crossChecks < 3 && Date.now() - r.crossAt >= 60_000) { // one read on the operator's RPC
      r.crossChecks++; r.crossAt = Date.now();
      const o = await opening(cross, r, "latest").catch(() => null);
      r.crossChecked = !!o && o.price === r.open.price && o.openedAt === r.open.openedAt;
    }
    if (r.blocked || !r.open || !r.crossChecked) { note(r.blocked ?? (r.open ? "opening price not confirmed on the second RPC" : "round not open yet"), { start }); await nap(); return false; }
    if (!dry && !r.open.engine && !(lastCompletionBlock > r.open.seenBlock)) { // our next request's tick mirrors the registry opening into the engine
      if (await clear({ op: "sync" })) { r.requests++; await send({ op: "sync" }); } else await nap();
      return false;
    }
    if (!r.sigma) r.sigma = await sigma().catch((e) => (note(`volatility unavailable: ${e.message}`), null));
    const sp = await spot();
    const p = sp.ok && r.sigma ? fairUp(sp.spot, r.open.s0, r.sigma, r.end - now) : null;
    const c = plan(view, r, now, p, s);
    if (Date.now() - beat >= 60_000) { beat = Date.now(); log("market", { secondsLeft: r.end - now, spot: sp.ok ? sp.spot : sp.reason, s0: r.open.s0, sigma: r.sigma, p, quotes: p === null ? null : quotes(p, s.halfSpreadCents), ...summary(view) }); }
    const held = !c ? (p === null && !sp.ok ? sp.reason : null)
      : c.op === "cancel_all" ? null
      : r.refusals >= MAX_REFUSALS ? `${r.refusals} refusals this round; no new quotes until the next`
      : rpcCalls - r.calls0 > s.maxRpcPerRound ? `RPC budget of ${s.maxRpcPerRound} calls spent this round` : null;
    if (!c || held) { if (held) note(held); await nap(); return false; }
    if (dry) { log("would send", { ...c, p }); view = apply(view, c); await nap(); return false; }
    if (!(await clear(c))) { await nap(); return false; }
    noted = "";
    r.requests++;
    if (refused(await send(c))) r.refusals++;
    return false;
  }
  for (;;) {
    try {
      if (await step()) return;
      errors = 0;
    } catch (e) {
      const limited = /429|Too Many Requests|rate limit/i.test(`${e.shortMessage ?? ""} ${e.message ?? ""} ${e.info?.responseStatus ?? ""}`);
      if (e.refused || (!limited && ++errors >= 5)) throw e; // five failed loops in a row stop the bot; a rate limit only slows it
      log("error", { message: e.shortMessage ?? e.message, limited });
      await (limited ? new Promise((r) => setTimeout(r, 30_000)) : nap());
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(`market-maker: ${e.refused ? e.message : (e.stack ?? e.message)}`); process.exit(1); });
}
