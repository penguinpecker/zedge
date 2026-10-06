// EVALUATION ONLY. The ZEDGE Vela guest on the local Vela v0.2.0 stack, chain 31337.
// Software TEE with fixed development keys and no attestation, a worthless test token, an unsigned
// fixture oracle; sender, amount and time are trusted from the manager. Nothing here is private,
// secure or production-ready.
//
//   node --experimental-strip-types slice.mjs manifest   # after up.sh: write the stack manifest
//   node --experimental-strip-types slice.mjs all        # the slice; run.sh runs it from clean volumes
//
// Users are fresh random wallets made in this process and funded with anvil_setBalance. Their keys
// never leave the process and are never printed. Admin actions use anvil impersonation; no private
// key is typed or read anywhere.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url);
const repo = new URL("../../../", here);
// ethers and the SDK from the crypto package's pinned install, by the exact files the SDK itself
// resolves, so this script, session.ts and the SDK share one ethers instance.
const { ethers } = await import(new URL("../crypto/node_modules/ethers/lib.esm/index.js", here));
const sdk = await import(new URL("../crypto/node_modules/@horizen/vela-common-ts/dist/node.js", here));
const { EvaluationSession } = await import(new URL("../crypto/session.ts", here));
const codec = await import(new URL("../crypto/guest.ts", here));
const { padBody, REQUEST_BYTES } = await import(new URL("../crypto/pad.ts", here));

export const EVALUATION = "EVALUATION ONLY: local Vela v0.2.0 stack on chain 31337. Software TEE with fixed " +
  "development keys and no attestation; a worthless 6-decimal test token; an unsigned fixture oracle; sender, " +
  "amount and time are trusted from the manager. Not private, not secure, not production-ready.";
const EVIDENCE = new URL("evidence/vela-slice-2026-10-06/", repo);
const RPC = "http://127.0.0.1:8545";
const AUTHORITY = "http://127.0.0.1:8081";
const WASM = new URL("../guest/build/zedge_guest.wasm", here);
const ORIGIN = "http://localhost:5173";
const EPOCH = "1";
const MAX_FEE = 1000n; // wei; the executor charges its minimum and refunds the rest
const UNIT = 1_000_000n; // one token at 6 decimals
const SHARE = 1_000_000; // one share, in engine atoms
const CIPHERTEXT_BYTES = 8220; // an 8,192-byte receipt plus the P-521/AES-GCM envelope (guest README §11)
const REQUEST_CIPHERTEXT_BYTES = REQUEST_BYTES + 28; // every request padded to 2,048 bytes (guest README §4), plus the same envelope
const ZERO = ethers.ZeroAddress;
const PROCESS = 1, ASSOCIATEKEY = 3;
const abi = ethers.AbiCoder.defaultAbiCoder();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const SUB = {
  receipt: "0x" + sha256("zedge.vela.receipt.v1"),
  tick: "0x" + sha256("zedge.vela.tick.v1"),
  clock: "0x" + sha256("zedge.vela.clock.v1"),
  archive: "0x" + sha256("zedge.vela.archive.v1"),
};
// The engine's fixed values (engine/oracle.go, engine/types.go). A mismatch fails the deploy loudly.
const ENGINE_VERSION = 3;
const RULES_VERSION = "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half";
const BTC_FEED = "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const ETH_FEED = "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9";
// voidGrace is the planned mainnet value (300 s, owner decision 2026-10-06): an opened round with no closing
// price is voidable observationWindow + voidGrace = 310 s after its end here.
const ORACLE_POLICY = { decimals: 18, observationWindow: 10, openingGrace: 20, voidGrace: 300, cutoffBuffer: 5 };
const FEE_BPS = 100;
// The one market this deployment mirrors (guest README §2.8, §10): BTC, 15-minute rounds. Anvil's time
// control jumps between a round's moments, so the full 15-minute schedule costs no waiting.
const MARKET = { asset: "BTC", duration: 900 };
const D = MARKET.duration;
const PRICE_OPEN = "97000000000000000000000"; // $97,000 at 18 decimals
const PRICE_CLOSE = "97000000000000000000001"; // one atom higher: round A resolves Up
const KEEPER_GAS = { gasLimit: 1_000_000 }; // explicit: a keeper call made at a pinned future time cannot be estimated now

const ENDPOINT_ABI = [
  "function applicationStateRoots(uint64) view returns (bytes32)",
  "function triggerContracts(uint64) view returns (address)",
  "function appCustody(uint64,address) view returns (uint256)",
  "function totalAppCustody(address) view returns (uint256)",
  "function pendingClaims(address,address) view returns (uint256)",
  "function totalPendingClaims(address) view returns (uint256)",
  "function claim(address,address)",
  "function teeAuthenticator() view returns (address)",
  "function tokenAllowlist() view returns (address)",
  "function authorityRegistry() view returns (address)",
  "function minFeePerRequest() view returns (uint256)",
  "function maxQueueSize() view returns (uint256)",
  "function maxNumOfApplications() view returns (uint256)",
  "function getPendingRequestsSize() view returns (uint256)",
  "function getTriggerQueueSize() view returns (uint256)",
  "function getNextPendingRequest() view returns ((uint256 timestamp,address tokenAddress,uint256 assetAmount,uint256 maxFeeValue,bytes32 requestId,bytes payload,address sender,address facilitator,uint64 applicationId,uint8 protocolVersion,uint8 requestType),bytes32,bool)",
  "function requestById(bytes32) view returns ((uint256 timestamp,address tokenAddress,uint256 assetAmount,uint256 maxFeeValue,bytes32 requestId,bytes payload,address sender,address facilitator,uint64 applicationId,uint8 protocolVersion,uint8 requestType))",
  "function PROTOCOL_VERSION() view returns (uint8)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function submitDeployRequestWithTrigger(uint8,bytes,address) payable returns (bytes32)",
  "event Refund(uint64 indexed applicationId, bytes32 indexed requestId, address indexed to, address tokenAddress, uint256 amount)",
  "event Withdrawal(uint64 indexed applicationId, bytes32 indexed requestId, address indexed to, address tokenAddress, uint256 amount)",
  "event RequestSubmitted(uint64 indexed applicationId, bytes32 indexed requestId, address indexed sender, address facilitator)",
  "event DeployRequestSubmitted(uint64 indexed applicationId, bytes32 requestId, address indexed sender)",
  "event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
  "event DeployRequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
  "event UserEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes encryptedData)",
  "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
  "event StateRootUpdate(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 oldStateRoot, bytes32 newStateRoot)",
  "event PaymentWithdrawn(address tokenAddress, address indexed payee, uint256 amount)",
  "event TriggerExecuted(uint64 indexed applicationId, bytes32 indexed processedRequestId, bool success)",
  "event TriggerWithdraw(uint64 indexed applicationId, bytes32 indexed processedRequestId, bool withdrawSuccess, bool postWithdrawSuccess, (address token, uint256 amount)[] returnedTokens, (address token, uint256 amount)[] failedTokens)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
];
const AUTH_ABI = ["function getTeeSigner() view returns (address)", "function getPubSecp521r1() view returns (bytes)"];
const ALLOWLIST_ABI = ["function addAllowedToken(address)", "function getAllowedTokens() view returns (address[])",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"];
const ROLES = Object.fromEntries(["ADMIN", "DEPLOYER_ROLE", "UPDATE_STATUS_ROLE", "RESET_OPERATOR"].map((r) => [r, ethers.id(r)]));

const provider = new ethers.JsonRpcProvider(RPC, undefined, { pollingInterval: 250, cacheTimeout: -1 });
const iface = new ethers.Interface(ENDPOINT_ABI);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (a) => a.toLowerCase();

// ---------------------------------------------------------------- checks and records

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail, big)}`}`);
  return !!pass;
}
function must(name, pass, detail) {
  if (!check(name, pass, detail)) throw new Error(`stopped: ${name}`);
}
const big = (_, v) => (typeof v === "bigint" ? v.toString() : v);
function write(name, value) {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(new URL(name, EVIDENCE), JSON.stringify({ evaluation: EVALUATION, ...value }, big, 2) + "\n");
}
async function until(what, fn, ms = 180_000, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(every);
  }
}
const stats = (xs) => {
  xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? { n: xs.length, min: xs[0], median: xs[xs.length >> 1], max: xs.at(-1) } : { n: 0 };
};

// ---------------------------------------------------------------- docker (this compose project only)

const stackDir = fileURLToPath(here);
const compose = (args) => execFileSync("sh", ["-c", `. ./lib.sh && compose ${args}`], { cwd: stackDir, encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] });
const project = () => execFileSync("sh", ["-c", ". ./lib.sh && echo $PROJECT"], { cwd: stackDir, encoding: "utf8" }).trim();
const logs = (service) => compose(`logs --no-color ${service}`);
const stackLogs = () => logs("executor manager");

/** Waits until the manager has finished with the last request this client saw completed and both queues
 * are empty. The event is on chain before the manager has seen its own transaction included; a restart in
 * that window is a different test (killDuringInclusion). */
async function quiesce() {
  await until("manager idle", async () => stackLogs().includes(`Manager: Processed request ${lastRequest.slice(2)}"`) &&
    (await S.endpoint.getPendingRequestsSize()) === 0n && (await S.endpoint.getTriggerQueueSize()) === 0n, 60_000, 500);
}
const count = (text, needle) => text.split(needle).length - 1;
// The executor logs each signing and communication key's public half; only the address line is read.
const loggedSigner = (text) => [...text.matchAll(/Secp256k1 \(address\): (?:0x)+([0-9a-fA-F]{40})/g)].map((m) => "0x" + m[1].toLowerCase()).at(-1);
const loggedP521 = (text) => [...text.matchAll(/Communication key P521 \(public\): (0x04[0-9a-fA-F]{264})/g)].map((m) => m[1].toLowerCase()).at(-1);

/** An executor and manager restart, with the manager idle (a restart in flight is killDuringInclusion). */
async function restartExecutorAndManager(label) {
  const lastRoot = await S.endpoint.applicationStateRoots(appId);
  await quiesce();
  const restored = count(stackLogs(), "Keyset restored successfully");
  const t0 = Date.now();
  compose("restart executor manager");
  await until("keyset restored after restart", () => count(stackLogs(), "Keyset restored successfully") > restored, 300_000, 1000);
  const ms = Date.now() - t0;
  check(`${label}: executor restored the keyset with the same signer`, loggedSigner(stackLogs()) === S.teeSigner, ms);
  check(`${label}: on-chain root unchanged by the restart`, (await S.endpoint.applicationStateRoots(appId)) === lastRoot);
  return ms;
}

// ---------------------------------------------------------------- the stack

async function findEndpoint() {
  // The kit's deployer writes its addresses to an environment file in a volume; that file is not
  // read. The endpoint is the contract the deployer created that answers teeAuthenticator().
  const head = await provider.getBlockNumber();
  for (let b = 1; b <= Math.min(head, 64); b++) {
    const block = await provider.getBlock(b, true);
    for (const tx of block.prefetchedTransactions) {
      const r = await provider.getTransactionReceipt(tx.hash);
      if (!r.contractAddress) continue;
      const c = new ethers.Contract(r.contractAddress, ENDPOINT_ABI, provider);
      try {
        await c.teeAuthenticator();
        return lower(r.contractAddress);
      } catch { /* not the endpoint */ }
    }
  }
  throw new Error("no ProcessorEndpoint found on the stack chain");
}

async function roleHolders(address, abi_) {
  const c = new ethers.Contract(address, abi_, provider);
  const out = {};
  for (const e of await c.queryFilter(c.filters.RoleGranted(), 0)) {
    const name = Object.keys(ROLES).find((k) => ROLES[k] === e.args.role) ?? e.args.role;
    (out[name] ??= []).push(lower(e.args.account));
  }
  return out;
}

async function stack() {
  const endpointAddress = await findEndpoint();
  const endpoint = new ethers.Contract(endpointAddress, ENDPOINT_ABI, provider);
  const authAddress = lower(await endpoint.teeAuthenticator());
  const allowlistAddress = lower(await endpoint.tokenAllowlist());
  const auth = new ethers.Contract(authAddress, AUTH_ABI, provider);
  return {
    endpointAddress, endpoint, authAddress, allowlistAddress,
    allowlist: new ethers.Contract(allowlistAddress, ALLOWLIST_ABI, provider),
    teeSigner: lower(await auth.getTeeSigner()),
    enclaveKey: lower(await auth.getPubSecp521r1()),
  };
}

async function manifest() {
  const s = await stack();
  const exec = stackLogs();
  const images = {};
  for (const line of compose("images --format json").trim().split("\n").flatMap((l) => JSON.parse(l))) {
    const ref = `${line.Repository}:${line.Tag}`;
    const inspect = JSON.parse(execFileSync("docker", ["image", "inspect", ref], { encoding: "utf8" }))[0];
    images[line.ContainerName ?? line.Service ?? ref] = { image: ref, id: inspect.Id, repoDigests: inspect.RepoDigests, architecture: inspect.Architecture };
  }
  const code = async (a) => { const c = await provider.getCode(a); return { bytes: (c.length - 2) / 2, keccak: ethers.keccak256(c) }; };
  const wasm = readFileSync(WASM);
  const m = {
    generatedAt: new Date().toISOString(),
    composeProject: project(),
    starterKitCommit: readFileSync(new URL("build/vela-starterkit/.zedge-pin", here), "utf8").trim(),
    chain: { chainId: Number((await provider.getNetwork()).chainId), client: await provider.send("web3_clientVersion", []), blockNumber: await provider.getBlockNumber() },
    images,
    contracts: {
      processorEndpoint: { address: s.endpointAddress, ...(await code(s.endpointAddress)) },
      teeAuthenticator: { address: s.authAddress, ...(await code(s.authAddress)) },
      tokenAllowlist: { address: s.allowlistAddress, ...(await code(s.allowlistAddress)) },
      authorityRegistry: { address: lower(await s.endpoint.authorityRegistry()) },
    },
    endpoint: {
      protocolVersion: Number(await s.endpoint.PROTOCOL_VERSION()), minFeePerRequestWei: await s.endpoint.minFeePerRequest(),
      maxQueueSize: await s.endpoint.maxQueueSize(), maxNumOfApplications: await s.endpoint.maxNumOfApplications(),
    },
    roles: { processorEndpoint: await roleHolders(s.endpointAddress, ENDPOINT_ABI), tokenAllowlist: await roleHolders(s.allowlistAddress, ALLOWLIST_ABI) },
    allowedTokens: (await s.allowlist.getAllowedTokens()).map(lower),
    tee: {
      attestation: "none: software executor, no-attestation authenticator, fixed development keys, keyset recovery type 0",
      signerOnChain: s.teeSigner, signerInExecutorLog: loggedSigner(exec),
      enclaveP521OnChain: s.enclaveKey, enclaveP521InExecutorLog: loggedP521(exec),
    },
    wasm: { path: "adapters/vela/guest/build/zedge_guest.wasm", bytes: wasm.length, sha256: sha256(wasm) },
  };
  write("manifest.json", m);
  check("manifest: chain id is 31337", m.chain.chainId === 31337, m.chain.chainId);
  check("manifest: endpoint has code", m.contracts.processorEndpoint.bytes > 0, m.contracts.processorEndpoint);
  check("manifest: on-chain TEE signer equals the executor's logged signer", m.tee.signerOnChain === m.tee.signerInExecutorLog, m.tee.signerOnChain);
  check("manifest: the enclave's P-521 communication key on chain equals the one the executor logged", m.tee.enclaveP521OnChain === m.tee.enclaveP521InExecutorLog);
  const vela = Object.values(images).filter((i) => i.image.startsWith("horizen/cce-"));
  check("manifest: the Vela images are v0.2.0 linux/amd64 (emulated on this host)", vela.length >= 4 && vela.every((i) => i.architecture === "amd64" && i.image.endsWith(":v0.2.0")), vela.map((i) => i.image));
  return m;
}

// ---------------------------------------------------------------- the slice

const records = []; // every request, in order
// What this slice asks to be credited to and paid out of app custody, in the collateral token, added
// where it asks. The reconciliation compares the chain with these totals, so a withdrawal nobody asked
// for (in a tick, a burst or to the trigger) shows even though the endpoint's own books still balance.
const expected = { credited: 0n, withdrawn: 0n, fees: 0 };
const credit = (u, amount) => { expected.credited += amount; u.credited += amount; };
const debit = (u, amount) => { expected.withdrawn += amount; u.withdrawn += amount; };
const outcomes = []; // every outcome a receipt handed back (guest README §9)
const staging = []; // every book command staged, with how long its activation took
let lastRequest; // the last request this client saw completed
let S, appId, trigger, token, wrongToken, domain, epoch, engineDomain, deployedConfig, admin, K;

const artifact = (url) => {
  const a = JSON.parse(readFileSync(url, "utf8"));
  const bytecode = a.bytecode.object ?? a.bytecode;
  if (bytecode.includes("__$")) throw new Error(`${url} has unlinked libraries`);
  return { abi: a.abi, bytecode };
};
async function deploy(signer, url, ...args) {
  const { abi: abi_, bytecode } = artifact(url);
  const c = await new ethers.ContractFactory(abi_, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return new ethers.Contract(lower(await c.getAddress()), abi_, signer);
}
async function fund(address) {
  await provider.send("anvil_setBalance", [address, "0x8ac7230489e80000"]); // 10 ETH, local only
}
function throwaway() {
  return new ethers.Wallet(ethers.hexlify(randomBytes(32)), provider);
}

/** A user: a fresh wallet, its evaluation session (key derived by a signature in this process) and an SDK client. */
async function user(name) {
  const wallet = throwaway();
  await fund(wallet.address);
  const account = lower(wallet.address);
  const session = new EvaluationSession(domain, account, epoch);
  await session.unlock(wallet);
  const client = new sdk.VelaClient(wallet, false, S.authAddress, S.endpointAddress);
  return { name, wallet, account, session, client, notices: 0, nonce: 0, credited: 0n, withdrawn: 0n, cash: 0, positions: {} };
}

function parseLogs(receipt) {
  return receipt.logs.filter((l) => lower(l.address) === S.endpointAddress).map((l) => {
    const p = iface.parseLog(l);
    return { name: p.name, args: p.args, log: l };
  });
}
async function completion(requestId, fromBlock, deployEvent = false, timeoutMs = 240_000) {
  const filter = deployEvent ? S.endpoint.filters.DeployRequestCompleted(null, requestId) : S.endpoint.filters.RequestCompleted(null, requestId);
  const e = await until(`completion of ${requestId}`, async () => (await S.endpoint.queryFilter(filter, fromBlock)).at(0), timeoutMs, 100);
  const block = await provider.getBlock(e.blockNumber);
  const tx = await provider.getTransactionReceipt(e.transactionHash);
  return { status: Number(e.args.status), errorCode: Number(e.args.errorCode), errorMessage: e.args.errorMessage, fee: e.args.applicationFees,
    block: e.blockNumber, timestamp: block.timestamp, txHash: e.transactionHash, at: Date.now(), gasUsed: Number(tx.gasUsed), events: parseLogs(tx) };
}

/** The guest's tick request (README §8.1, §10): tick, s, o, then s scheduled and o open registry round IDs. */
function tickRequest(data) {
  const b = ethers.getBytes(data);
  const w = (i) => BigInt(ethers.hexlify(b.slice(32 * i, 32 * i + 32)));
  if (b.length < 96) return { tick: w(0), scheduled: [], open: [], bytes: b.length };
  const s = Number(w(1)), o = Number(w(2));
  const ids = Array.from({ length: s + o }, (_, i) => ethers.hexlify(b.slice(96 + 32 * i, 128 + 32 * i)));
  return { tick: w(0), scheduled: ids.slice(0, s), open: ids.slice(s), bytes: b.length };
}
// tick, block, timestamp, applied, skipped, and the Keccak-256 of the payload the tick was fed (guest README §8.4)
const clockRecord = (data) => abi.decode(["uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"], data).map(BigInt);

/** The trigger's answer as the endpoint stored it: the head of the trigger queue at the end of the asking
 * block (one transaction per block here), read from the chain, not from the guest. */
async function trustedPayload(requestId, block) {
  const [req] = await S.endpoint.getNextPendingRequest({ blockTag: block });
  if (req.requestId !== requestId) return { error: "not at the head of the trigger queue" };
  const b = ethers.getBytes(req.payload);
  const w = (i) => BigInt(ethers.hexlify(b.slice(32 * i, 32 * i + 32)));
  const p = { bytes: b.length, hash: ethers.keccak256(req.payload), version: Number(w(0)), chainId: Number(w(1)), endpoint: lower(ethers.getAddress(ethers.dataSlice(req.payload, 76, 96))),
    block: Number(w(3)), timestamp: Number(w(4)), tick: w(5) };
  if (p.version !== 2) return p;
  p.n = Number(w(6));
  p.records = Array.from({ length: p.n }, (_, r) => {
    const at = 7 + 19 * r;
    const obs = (k) => ({ price: abi.decode(["int256"], b.slice(32 * k, 32 * k + 32))[0].toString(), validFromTimestamp: Number(w(k + 1)),
      observationsTimestamp: Number(w(k + 2)), expiresAt: Number(w(k + 3)), reportHash: ethers.hexlify(b.slice(32 * (k + 4), 32 * (k + 5))), decimals: Number(w(k + 5)) });
    return { id: ethers.hexlify(b.slice(32 * at, 32 * at + 32)), asset: Number(w(at + 1)), duration: Number(w(at + 2)), start: Number(w(at + 3)),
      openedAt: Number(w(at + 4)), resolvedAt: Number(w(at + 5)), outcome: Number(w(at + 6)), opening: obs(at + 7), closing: obs(at + 13) };
  });
  return p;
}

/** What section 10 says the trigger must report for this request, computed by the client from the registry
 * at the asking block: asked scheduled rounds that opened or ended, asked open rounds that ended, and the
 * market's next two slots when not asked about. Each record must be getRound word for word. */
async function verifyPayload(p, ask, asking) {
  const at = { blockTag: asking.block };
  const read = async (id) => { try { return await K.view.getRound(id, at); } catch { return undefined; } };
  const want = [];
  const asked = [...ask.scheduled, ...ask.open];
  for (const [i, id] of asked.entries()) {
    const r = await read(id);
    if (r && (Number(r.outcome) !== 0 || (i < ask.scheduled.length && Number(r.openedAt) !== 0))) want.push(id);
  }
  const first = (Math.floor(asking.timestamp / D) + 1) * D;
  for (const start of [first, first + D]) {
    const id = await K.view.roundIdFor(0, D, start, at);
    if (!asked.includes(id) && (await read(id))) want.push(id);
  }
  const words = [];
  for (const rec of p.records) {
    const r = await read(rec.id);
    const o = (x) => ({ price: x.price.toString(), validFromTimestamp: Number(x.validFromTimestamp), observationsTimestamp: Number(x.observationsTimestamp),
      expiresAt: Number(x.expiresAt), reportHash: x.reportHash, decimals: Number(x.decimals) });
    const same = r && rec.asset === Number(r.asset) && rec.duration === Number(r.duration) && rec.start === Number(r.start) && rec.openedAt === Number(r.openedAt) &&
      rec.resolvedAt === Number(r.resolvedAt) && rec.outcome === Number(r.outcome) && JSON.stringify(rec.opening) === JSON.stringify(o(r.opening)) &&
      JSON.stringify(rec.closing) === JSON.stringify(o(r.closing));
    if (!same) words.push(rec.id);
  }
  const header = p.version === 2 && p.chainId === 31337 && p.endpoint === S.endpointAddress && p.block === asking.block && p.timestamp === asking.timestamp && p.tick === ask.tick;
  return { header, records: JSON.stringify(p.records.map((r) => r.id)) === JSON.stringify(want.slice(0, 16)), wordForWord: words.length === 0, want, mismatched: words };
}

/** Follows a submitted request to completion, and its trusted follow-up if any. `mine` names the exact
 * timestamps at which the slice mines the request's transition and its tick, with automine off. */
async function follow(u, label, r, { type = PROCESS, tokenAddress = ZERO, amount = 0n, started, submitted, afterSubmit, mine, hostile } = {}) {
  if (afterSubmit) await afterSubmit();
  if (mine) await mineWhenPending(1, mine[0]);
  const done = await completion(r.requestId, r.transactionReceipt.blockNumber);
  const asks = done.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.tick).map((e) => tickRequest(e.args.data));
  const spawned = done.events.filter((e) => e.name === "RequestSubmitted" && lower(e.args.sender) === trigger);
  let trusted;
  if (spawned.length) {
    const payload = await trustedPayload(spawned[0].args.requestId, done.block);
    if (payload.version === 2 && !hostile) payload.verified = await verifyPayload(payload, asks[0], done);
    if (mine) await mineWhenPending(1, mine[1]);
    const t = await completion(spawned[0].args.requestId, done.block);
    const appEvents = t.events.filter((e) => e.name === "AppEvent");
    trusted = { requestId: spawned[0].args.requestId, status: t.status, errorMessage: t.errorMessage, block: t.block, timestamp: t.timestamp,
      latencyMs: t.at - done.at, gasUsed: t.gasUsed, payload,
      clocks: appEvents.filter((e) => e.args.eventSubType === SUB.clock).map((e) => clockRecord(e.args.data)),
      archives: appEvents.filter((e) => e.args.eventSubType === SUB.archive).map((e) => JSON.parse(ethers.toUtf8String(e.args.data))),
      spawned: t.events.filter((e) => e.name === "RequestSubmitted").length,
      tickRequests: appEvents.filter((e) => e.args.eventSubType === SUB.tick).length, userEvents: t.events.filter((e) => e.name === "UserEvent").length };
  }
  const userEvents = done.events.filter((e) => e.name === "UserEvent");
  // The request as the endpoint stored it at submission: its ciphertext is public calldata and storage.
  const stored = type === PROCESS ? await S.endpoint.requestById(r.requestId, { blockTag: r.transactionReceipt.blockNumber }) : undefined;
  const record = {
    label, sender: u.name, requestId: r.requestId, type, token: lower(tokenAddress), amount, payloadBytes: stored && ethers.dataLength(stored.payload),
    submitBlock: r.transactionReceipt.blockNumber, block: done.block, timestamp: done.timestamp,
    status: done.status === 0 ? "COMPLETED" : "FAILED", errorCode: done.errorCode, errorMessage: done.errorMessage, fee: done.fee, gasUsed: done.gasUsed,
    latencyMs: done.at - (submitted ?? done.at), submitMs: submitted && started ? submitted - started : undefined,
    userEvents: userEvents.map((e) => ({ subtype: e.args.eventSubType, bytes: ethers.dataLength(e.args.encryptedData) })),
    ticks: asks.map((a) => a.tick), asked: asks[0] && { scheduled: asks[0].scheduled, open: asks[0].open, bytes: asks[0].bytes }, spawned: spawned.length, trusted,
    refunds: done.events.filter((e) => e.name === "Refund").map((e) => ({ to: lower(e.args.to), token: lower(e.args.tokenAddress), amount: e.args.amount })),
    withdrawals: done.events.filter((e) => e.name === "Withdrawal").map((e) => ({ to: lower(e.args.to), token: lower(e.args.tokenAddress), amount: e.args.amount })),
  };
  records.push(record);
  lastRequest = trusted?.requestId ?? r.requestId;
  console.log(`      ${label}: ${record.status}${record.errorMessage ? ` (${record.errorMessage})` : ""} in ${record.latencyMs} ms` +
    (trusted ? `; tick ${record.ticks[0]} ${trusted.status === 0 ? "applied" : `FAILED (${trusted.errorMessage})`} ${trusted.latencyMs} ms later` +
      (trusted.payload?.n !== undefined ? `, ${trusted.payload.n} registry record(s)` : "") : ""));
  return { ...record, ciphertexts: userEvents.map((e) => ethers.getBytes(e.args.encryptedData)) };
}

/** Submits one request through the SDK and follows it to completion, and its trusted follow-up if any. */
async function send(u, label, { type = PROCESS, payload = new Uint8Array(), tokenAddress = ZERO, amount = 0n, afterSubmit, hostile } = {}) {
  const started = Date.now();
  const r = await u.client.submitRequestAndWaitForRequestId(0, appId, type, payload, tokenAddress, amount, MAX_FEE);
  return follow(u, label, r, { type, tokenAddress, amount, started, submitted: Date.now(), afterSubmit, hostile });
}

/** Decrypts the one receipt of a request. Its view (guest README §9) gives the account's next nonce: a
 * settlement sweep redeems in the account's own name and uses one. Any outcome it hands back is kept. */
async function receipt(u, req, requestId) {
  if (req.ciphertexts.length !== 1) return { error: `expected one receipt, got ${req.ciphertexts.length}` };
  const r = await u.session.decryptReceipt(req.ciphertexts[0], requestId);
  if (r.status !== "readable") return { error: r.status };
  const body = r.envelope.body;
  if (body.view) u.nonce = body.view.nonce;
  if (body.outcome) outcomes.push({ user: u.name, collectedBy: req.requestId, collectedTick: req.ticks[0], ...body.outcome });
  return { ...body, pad: `${body.pad.length} zeros` };
}

// Every request is padded to one length (pad.ts, guest README §4); the guest refuses any other.
const sync = (u) => u.session.encryptCommand(codec.syncRequestId(u.account), padBody(u.session, codec.syncRequestId(u.account), codec.syncBody()));
function command(u, nonce, fields) {
  const c = { domain: engineDomain, id: codec.commandId(u.account, nonce), nonce, account: u.account, ...fields };
  return { id: c.id, plaintext: c, encrypt: () => u.session.encryptCommand(c.id, padBody(u.session, c.id, codec.commandBody(c))) };
}
async function deposit(u, amount, label, tokenContract = token) {
  await (await tokenContract.mint(u.account, amount)).wait();
  await (await u.client.approveToken(await tokenContract.getAddress(), amount)).wait();
  return send(u, label, { tokenAddress: await tokenContract.getAddress(), amount });
}
async function claim(u, payee, tokenAddress) {
  const c = new ethers.Contract(S.endpointAddress, ENDPOINT_ABI, u.wallet);
  const before = await new ethers.Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(payee);
  const pending = await S.endpoint.pendingClaims(tokenAddress, payee);
  await (await c.claim(tokenAddress, payee)).wait();
  const after = await new ethers.Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(payee);
  return { pending, moved: after - before, left: await S.endpoint.pendingClaims(tokenAddress, payee) };
}

/** With automine off: waits until n transactions are in the pool, then mines one block at that timestamp
 * (or at the chain's own time). The manager's transitions wait in the pool for it. */
async function mineWhenPending(n, timestamp) {
  await until(`${n} pending transaction(s)`, async () => Number((await provider.send("txpool_status", [])).pending) >= n, 120_000, 100);
  await provider.send("evm_mine", timestamp === undefined ? [] : [timestamp]);
}

async function deployEverything(operator) {
  const findAdmin = await roleHolders(S.endpointAddress, ENDPOINT_ABI);
  admin = findAdmin.DEPLOYER_ROLE?.[0];
  const allowAdmin = (await roleHolders(S.allowlistAddress, ALLOWLIST_ABI)).ADMIN?.[0];
  must("stack: endpoint has a deployer and the allowlist an admin", admin && allowAdmin && admin === allowAdmin, { admin, allowAdmin });

  const out = new URL("contracts/build/out/", here);
  token = await deploy(operator, new URL("EvaluationToken.sol/EvaluationToken.json", out));
  wrongToken = await deploy(operator, new URL("EvaluationToken.sol/EvaluationToken.json", out));
  const tokenAddress = lower(await token.getAddress());
  check("contracts: test token has 6 decimals", Number(await token.decimals()) === 6);

  // Round registry behind its proxy, with the unsigned fixture oracle, from contracts/out (read-only).
  const cout = new URL("contracts/out/", repo);
  const oracle = await deploy(operator, new URL("MockStreamsBoundaryOracle.sol/MockStreamsBoundaryOracle.json", cout));
  await (await oracle.configure(BTC_FEED, ETH_FEED, 18, 18, ORACLE_POLICY.observationWindow, 31337)).wait();
  const impl = await deploy(operator, new URL("StreamsRoundRegistry.sol/StreamsRoundRegistry.json", cout));
  const config = [await oracle.getAddress(), tokenAddress, BTC_FEED, ETH_FEED, 18, 18, ORACLE_POLICY.observationWindow, ORACLE_POLICY.openingGrace, ORACLE_POLICY.voidGrace, ORACLE_POLICY.cutoffBuffer];
  const setup = impl.interface.encodeFunctionData("initialize", [config, operator.address]);
  const proxy = await deploy(operator, new URL("ERC1967Proxy.sol/ERC1967Proxy.json", cout), await impl.getAddress(), setup);
  const registryAddress = lower(await proxy.getAddress());
  const registry = new ethers.Contract(registryAddress, impl.interface, provider);
  const implSlot = await provider.getStorage(registryAddress, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  check("registry: proxy points at the implementation", lower(ethers.getAddress("0x" + implSlot.slice(26))) === lower(await impl.getAddress()));
  check("registry: fixture oracle is labelled insecure", (await oracle.version()) === "insecure-streams-test-fixture");
  const rulesHash = ethers.keccak256(abi.encode(
    ["string", "uint256", "tuple(address,address,bytes32,bytes32,uint8,uint8,uint32,uint32,uint32,uint32)"], [RULES_VERSION, 31337, config]));
  check("registry: on-chain rules hash equals the engine's computation", (await registry.rulesHash()) === rulesHash, rulesHash);
  // The keeper: the operator wallet, calling the registry's permissionless functions and the fixture oracle.
  K = { registry: registry.connect(operator), view: registry, oracle, address: registryAddress, rulesHash };

  // The trigger reads this registry and mirrors this one market (guest README §10).
  const triggerContract = await deploy(operator, new URL("EvaluationClockTrigger.sol/EvaluationClockTrigger.json", out), S.endpointAddress, registryAddress, 0, D);
  trigger = lower(await triggerContract.getAddress());
  check("contracts: trigger answers only this endpoint, reads this registry and mirrors BTC 15-minute rounds",
    lower(await triggerContract.processorEndpoint()) === S.endpointAddress && lower(await triggerContract.registry()) === registryAddress &&
    Number(await triggerContract.asset()) === 0 && Number(await triggerContract.duration()) === D);

  // The admin allow-lists both test tokens, impersonated on the local chain.
  await provider.send("anvil_impersonateAccount", [admin]);
  const adminSigner = await provider.getSigner(admin);
  const allow = S.allowlist.connect(adminSigner);
  for (const t of [token, wrongToken]) await (await allow.addAllowedToken(await t.getAddress())).wait();
  check("allowlist: both test tokens allowed", (await S.allowlist.getAllowedTokens()).map(lower).includes(tokenAddress));

  // Constructor parameters: canonical JSON in the Go field order the guest re-encodes and compares.
  const engineConfig = (applicationId) => ({
    domain: { chainId: 31337, endpoint: S.endpointAddress, applicationId, rulesVersion: ENGINE_VERSION },
    authority: trigger, collateral: tokenAddress, feeBps: FEE_BPS,
    oracle: { chainId: 31337, registry: registryAddress, oracle: lower(oracle.target), rulesHash,
      btcFeedId: BTC_FEED, ethFeedId: ETH_FEED, ...ORACLE_POLICY },
  });
  const wasm = readFileSync(WASM);
  const fingerprint = sha256(wasm);
  const params = JSON.stringify({ engine: engineConfig(""), applicationFingerprint: fingerprint, origin: ORIGIN, epoch: EPOCH, markets: [MARKET] });
  must("deploy: parameters survive the SDK's JSON round trip byte for byte", JSON.stringify(JSON.parse(params)) === params);

  const form = new FormData();
  form.append("wasm", new Blob([wasm]), "zedge_guest.wasm");
  const upload = await (await fetch(`${AUTHORITY}/deploy/upload`, { method: "POST", body: form })).json();
  check("deploy: authority service stored the wasm under its SHA-256", upload.wasmSha256 === fingerprint && upload.artifactId === `sha256:${fingerprint}`, upload);

  const deployer = new sdk.VelaClient(adminSigner, false, S.authAddress, S.endpointAddress);
  const started = Date.now();
  const sent = await deployer.submitDeployRequestWithTriggerAndWaitForRequestId(0, MAX_FEE, ethers.getBytes("0x" + fingerprint), JSON.parse(params), trigger);
  await provider.send("anvil_stopImpersonatingAccount", [admin]);
  appId = BigInt.asUintN(64, BigInt(sent.requestId) >> 192n);
  const done = await completion(sent.requestId, sent.transactionReceipt.blockNumber, true);
  const deployMs = done.at - started;
  const tx = await provider.getTransaction(sent.transactionReceipt.hash);
  const [, payload, triggerArg] = iface.decodeFunctionData("submitDeployRequestWithTrigger", tx.data);
  const descriptorText = ethers.toUtf8String(payload);
  const descriptor = JSON.parse(descriptorText);
  must("deploy: request COMPLETED", done.status === 0, { errorCode: done.errorCode, errorMessage: done.errorMessage });
  check("deploy: application state root is non-zero", (await S.endpoint.applicationStateRoots(appId)) !== ethers.ZeroHash);
  check("deploy: trigger is bound to the application", lower(await S.endpoint.triggerContracts(appId)) === trigger && lower(triggerArg) === trigger);
  check("deploy: descriptor wasm hash equals the built artifact", descriptor.wasmSha256 === fingerprint && descriptor.artifactId === `sha256:${fingerprint}`, descriptor.wasmSha256);
  check("deploy: descriptor carries the constructor parameters verbatim, markets included", descriptorText.includes(`"constructorParams":${params}`));

  epoch = { id: EPOCH, enclavePublicKey: S.enclaveKey };
  deployedConfig = engineConfig(appId.toString());
  engineDomain = deployedConfig.domain;
  domain = { chainId: 31337, endpoint: S.endpointAddress, applicationId: appId.toString(), applicationFingerprint: fingerprint,
    rulesHash: sha256(JSON.stringify(deployedConfig)), origin: ORIGIN };
  return { applicationId: appId.toString(), deployRequestId: sent.requestId, deployBlock: done.block, deployMs, deployFeeWei: done.fee,
    token: tokenAddress, wrongToken: lower(await wrongToken.getAddress()), trigger, registry: registryAddress, registryImplementation: lower(await impl.getAddress()),
    oracle: lower(oracle.target), rulesHash, admin, wasmSha256: fingerprint, constructorParams: JSON.parse(params), envelopeDomain: domain };
}

// ---------------------------------------------------------------- reconciliation, from chain logs only

/** The custody legs, cheap enough for every step: the endpoint holds exactly what it owes, app custody is
 * what the slice had credited less what it asked to withdraw, and the Withdrawal events are those withdrawals. */
async function books(label) {
  const tokenAddress = lower(token.target);
  const balance = await token.balanceOf(S.endpointAddress);
  const custody = await S.endpoint.appCustody(appId, tokenAddress);
  const total = await S.endpoint.totalAppCustody(tokenAddress);
  const pending = await S.endpoint.totalPendingClaims(tokenAddress);
  const withdrawn = (await S.endpoint.queryFilter(S.endpoint.filters.Withdrawal(appId), 0)).filter((e) => lower(e.args.tokenAddress) === tokenAddress).reduce((a, e) => a + e.args.amount, 0n);
  const triggerHolds = await token.balanceOf(trigger);
  const out = { endpointBalance: balance, appCustody: custody, totalPendingClaims: pending, withdrawalEvents: withdrawn, credited: expected.credited, askedToWithdraw: expected.withdrawn };
  check(`${label}: books: token balance = custody + pending claims; custody = credited - withdrawn (client totals); Withdrawal events = withdrawals asked for; trigger holds nothing`,
    balance === total + pending && custody === total && custody === expected.credited - expected.withdrawn && withdrawn === expected.withdrawn && triggerHolds === 0n, out);
  return out;
}

async function reconcile(label) {
  const all_ = (await provider.getLogs({ address: S.endpointAddress, fromBlock: 0, toBlock: "latest" }))
    .map((l) => ({ ...iface.parseLog(l), log: l })).filter((e) => e.name);
  const mine = all_.filter((e) => e.args.applicationId === undefined || e.args.applicationId === appId);
  const tokenAddress = lower(token.target);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
  const of = (name) => mine.filter((e) => e.name === name);
  const submittedDeposits = sum(records.filter((r) => r.token === tokenAddress).map((r) => r.amount));
  const refunded = sum(of("Refund").filter((e) => lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
  const withdrawn = sum(of("Withdrawal").filter((e) => lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
  const returned = sum(of("TriggerWithdraw").flatMap((e) => e.args.returnedTokens).filter((t) => lower(t.token) === tokenAddress).map((t) => t.amount));
  const claimed = sum(all_.filter((e) => e.name === "PaymentWithdrawn" && lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
  const balance = await token.balanceOf(S.endpointAddress);
  const custody = await S.endpoint.appCustody(appId, tokenAddress);
  const totalCustody = await S.endpoint.totalAppCustody(tokenAddress);
  const pending = await S.endpoint.totalPendingClaims(tokenAddress);
  const triggerHolds = await token.balanceOf(trigger);
  const out = { submittedDeposits, refunded, withdrawn, triggerReturned: returned, claimed, endpointBalance: balance, appCustody: custody, totalAppCustody: totalCustody, totalPendingClaims: pending,
    expectedCredited: expected.credited, expectedWithdrawn: expected.withdrawn, triggerHolds };
  check(`${label}: endpoint token balance = app custody + pending claims, exactly`, balance === totalCustody + pending && custody === totalCustody, out);
  check(`${label}: app custody = deposits submitted - refunds - withdrawals + trigger returns, exactly`, custody === submittedDeposits - refunded - withdrawn + returned, out);
  check(`${label}: pending claims = refunds + withdrawals - claims paid, exactly`, pending === refunded + withdrawn - claimed, out);
  check(`${label}: the trigger returned nothing to custody`, returned === 0n);
  // The legs above restate the endpoint's own books, which balance for any withdrawal the guest emits.
  // These compare them with what the slice asked for.
  check(`${label}: app custody = deposits this slice had credited - withdrawals it had asked for, exactly`, custody === expected.credited - expected.withdrawn, out);
  check(`${label}: Withdrawal events add up to the withdrawals this slice asked for, and the trigger holds no collateral`, withdrawn === expected.withdrawn && triggerHolds === 0n, out);
  // The second test token and ETH: the endpoint holds exactly what it owes. ETH also holds the maximum
  // fee of every request still queued: every request here offers MAX_FEE, and trusted requests none.
  const owed = async (t) => (await S.endpoint.totalAppCustody(t)) + (await S.endpoint.totalPendingClaims(t));
  const queued = await S.endpoint.getPendingRequestsSize();
  const others = {
    wrongToken: { balance: await wrongToken.balanceOf(S.endpointAddress), owed: await owed(lower(wrongToken.target)) },
    eth: { balance: await provider.getBalance(S.endpointAddress), owed: (await owed(ZERO)) + queued * MAX_FEE, queuedRequests: queued },
  };
  check(`${label}: second token and ETH: endpoint balance = custody + pending claims (+ queued fees for ETH), exactly`,
    others.wrongToken.balance === others.wrongToken.owed && others.eth.balance === others.eth.owed, others);

  // Every receipt has the one size, and every state root follows the previous one.
  const userEvents = of("UserEvent");
  check(`${label}: every receipt ciphertext is ${CIPHERTEXT_BYTES} bytes with the one receipt subtype`,
    userEvents.length > 0 && userEvents.every((e) => ethers.dataLength(e.args.encryptedData) === CIPHERTEXT_BYTES && e.args.eventSubType === SUB.receipt),
    { receipts: userEvents.length, sizes: [...new Set(userEvents.map((e) => ethers.dataLength(e.args.encryptedData)))] });
  const sized = records.filter((r) => r.type === PROCESS && r.payloadBytes > 0 && r.status === "COMPLETED");
  check(`${label}: every completed request's ciphertext, as the endpoint stored it, is ${REQUEST_CIPHERTEXT_BYTES} bytes whatever it carries`,
    sized.length > 0 && sized.every((r) => r.payloadBytes === REQUEST_CIPHERTEXT_BYTES), { requests: sized.length, sizes: [...new Set(sized.map((r) => r.payloadBytes))] });
  const roots = of("StateRootUpdate");
  const broken = roots.slice(1).filter((e, i) => e.args.oldStateRoot !== roots[i].args.newStateRoot).length;
  check(`${label}: state roots form one chain from the deploy root (the endpoint enforces it; this checks the log reading)`, broken === 0 && roots[0].args.oldStateRoot === ethers.ZeroHash && (await S.endpoint.applicationStateRoots(appId)) === roots.at(-1).args.newStateRoot, { transitions: roots.length, broken });

  // Every tick request is answered by exactly one trusted request in the same transaction, and every
  // applied clock record is the asking block's number and time and the Keccak-256 of the payload the
  // trigger answered. That hash is checked against the trusted request's ID, which the endpoint derives
  // from it (generateRequestId(trigger, app, TRUSTPROCESS = 4, keccak256(payload), 0, 0, queue index);
  // the index is searched), so from chain events alone, and against the payload follow() read from the
  // trigger queue at the asking block. Anvil keeps no state from before its restart, so the payload is
  // not read again here.
  const byTx = (h) => mine.filter((e) => e.log.transactionHash === h);
  const tickEvents = of("AppEvent").filter((e) => e.args.eventSubType === SUB.tick);
  const tickOf = (e) => tickRequest(e.args.data).tick;
  const lostOnPurpose = new Set(records.filter((r) => r.lostOnPurpose).map((r) => r.ticks[0]));
  const answers = tickEvents.map((e) => ({ tick: tickOf(e), trusted: byTx(e.log.transactionHash).filter((x) => x.name === "RequestSubmitted" && lower(x.args.sender) === trigger).length }));
  check(`${label}: every tick request gets exactly one trusted request (except ticks lost on purpose)`,
    answers.every((a) => a.trusted === (lostOnPurpose.has(a.tick) ? 0 : 1)), { tickRequests: answers.length, lostOnPurpose: [...lostOnPurpose] });
  const clocks = of("AppEvent").filter((e) => e.args.eventSubType === SUB.clock);
  const submitted = all_.filter((e) => e.name === "RequestSubmitted").length; // a bound on the trigger queue's index
  const wrong = [];
  for (const c of clocks) {
    const [k, number, time, , , hash] = clockRecord(c.args.data);
    const asking = tickEvents.find((t) => tickOf(t) === k);
    const block = asking && await provider.getBlock(asking.log.blockNumber);
    if (!block || BigInt(block.number) !== number || BigInt(block.timestamp) !== time) wrong.push({ k, number, time, asking: block && { number: block.number, timestamp: block.timestamp } });
    const committed = Array.from({ length: submitted + 1 }, (_, i) => ethers.keccak256(abi.encode(["address", "uint64", "uint8", "bytes32", "address", "uint256", "uint256"],
      [trigger, appId, 4, ethers.toBeHex(hash, 32), ZERO, 0, i]))).includes(c.args.requestId);
    const read = records.find((r) => r.trusted?.requestId === c.args.requestId)?.trusted.payload?.hash;
    if (!committed || (read !== undefined && BigInt(read) !== hash)) wrong.push({ k, committed, read, record: ethers.toBeHex(hash, 32) });
    // A tick asks for another only to carry on past MaxActivations (16) due commands; this slice never has
    // more than two due at once, so here no clock record may ask for a tick.
    if (byTx(c.log.transactionHash).some((x) => (x.name === "AppEvent" && x.args.eventSubType === SUB.tick) || (x.name === "RequestSubmitted" && lower(x.args.sender) === trigger))) wrong.push({ k, loop: true });
  }
  check(`${label}: every clock record equals the asking block's number and timestamp and the Keccak-256 of the payload the trigger stored (bound by the trusted request's ID, and equal to the payload read at the asking block), and asks for no tick (never more than 16 commands due here)`, clocks.length > 0 && wrong.length === 0, { clockRecords: clocks.length, wrong });
  const failedOrFree = records.filter((r) => r.status === "FAILED" || r.type === ASSOCIATEKEY || r.label.startsWith("deposit"));
  check(`${label}: failed, key and deposit-only requests ask for no tick`, failedOrFree.every((r) => r.ticks.length === 0 && r.spawned === 0), failedOrFree.length);
  const payloads = records.filter((r) => r.trusted?.payload?.verified);
  check(`${label}: every version-2 trigger answer read from the chain has the asking block's clock words and exactly the records section 10 calls for, each getRound word for word`,
    payloads.length > 0 && payloads.every((r) => r.trusted.payload.verified.header && r.trusted.payload.verified.records && r.trusted.payload.verified.wordForWord),
    { answers: payloads.length, records: payloads.reduce((a, r) => a + r.trusted.payload.n, 0), wrong: payloads.filter((r) => !(r.trusted.payload.verified.header && r.trusted.payload.verified.records && r.trusted.payload.verified.wordForWord)).map((r) => ({ label: r.label, ...r.trusted.payload.verified })) });
  return { label, ...out, others, receipts: userEvents.length, transitions: roots.length, tickRequests: answers.length, clockRecords: clocks.length };
}

const RAW_DEPOSIT = "Wasmtime Runtime: Raw deposit result from WASM: ";
const rawDeposits = () => entries([stackLogs()]).filter((e) => e.message.startsWith(RAW_DEPOSIT));

/** A deposit-only request, and the engine's own ledger against the chain. v0.2.0 shows the ledger in one
 * place only: the executor logs every deposit result with the whole state in clear (the leak scan's
 * finding). Failed deposits are logged too, so only the state of a deposit-only request that completed,
 * with nothing after it, is the committed one. It also holds every account's positions, which are compared
 * with the client's own expectations. */
async function ledgerDeposit(u, amount, label, traders = []) {
  const before = rawDeposits().length;
  const probe = await deposit(u, amount, label);
  credit(u, amount);
  u.cash += Number(amount);
  u.notices++;
  const body = await receipt(u, probe, codec.noticeRequestId(u.account, u.notices));
  const logged = await until("the probe's logged deposit result", () => rawDeposits().slice(before).at(-1), 30_000, 1000);
  const stateText = Buffer.from(JSON.parse(logged.message.slice(logged.message.indexOf("{"))).state, "base64").toString("utf8");
  const state = JSON.parse(stateText);
  const tokenAddress = lower(token.target);
  const withdrawals = (await S.endpoint.queryFilter(S.endpoint.filters.Withdrawal(appId), 0)).filter((e) => lower(e.args.tokenAddress) === tokenAddress);
  const ledger = {
    stateBytes: stateText.length,
    depositOrdinal: { logged: state.deposits, receipt: body.deposit },
    custody: { engine: BigInt(state.engine.custody), app: await S.endpoint.appCustody(appId, tokenAddress) },
    paidOut: { engine: BigInt(state.engine.paidOut), withdrawalEvents: withdrawals.reduce((a, e) => a + e.args.amount, 0n) },
    deposited: { engine: BigInt(state.engine.deposited), creditedBySlice: expected.credited },
    claimable: BigInt(state.engine.claimable),
    fees: { engine: state.engine.fees, computedByClient: expected.fees },
  };
  check(`${label}: credited, and the logged state is its own (same ordinal)`, probe.status === "COMPLETED" && body.status === "credited" &&
    BigInt(body.receipt?.amount ?? 0) === amount && state.deposits === body.deposit, ledger.depositOrdinal);
  check(`${label}: engine custody = app custody, paidOut = Withdrawal events, deposited = deposits credited, claimable = 0, fees = the client's own sum, exactly`,
    ledger.custody.engine === ledger.custody.app && ledger.paidOut.engine === ledger.paidOut.withdrawalEvents && ledger.deposited.engine === ledger.deposited.creditedBySlice &&
    ledger.claimable === 0n && ledger.fees.engine === ledger.fees.computedByClient, ledger);
  for (const t of traders) {
    const a = state.engine.accounts.find((x) => x.id === t.account);
    const got = { cash: a?.cash, reservedCash: a?.reservedCash, holdings: held(a?.holdings) };
    const want = { cash: t.cash, reservedCash: 0, holdings: expectedHoldings(t) };
    check(`${label}: the engine's ledger holds ${t.name}'s positions as the client computed them`, JSON.stringify(got) === JSON.stringify(want), { got, want });
  }
  return ledger;
}

// ---------------------------------------------------------------- phases

async function lifecycle() {
  const alice = await user("alice");
  const bob = await user("bob");

  // Key registration (no seed), then the bootstrap sync that sets the clock.
  const assoc = await alice.session.associationPayload();
  check("alice: association payload is the 133-byte form without a seed", assoc.length === 133);
  const key = await send(alice, "alice associate key", { type: ASSOCIATEKEY, payload: assoc });
  check("alice: key registered (COMPLETED, no receipt, no tick)", key.status === "COMPLETED" && key.userEvents.length === 0 && key.ticks.length === 0, key.errorMessage);
  const early = await deposit(alice, 1n * UNIT, "deposit before the clock");
  check("deposit before the first tick fails with the clock error and is refunded", early.status === "FAILED" && early.errorMessage.includes("zedge: clock not initialised") && early.refunds.some((r) => r.to === alice.account && r.amount === UNIT), early.errorMessage);
  const first = await send(alice, "alice first sync", { payload: await sync(alice) });
  const firstBody = await receipt(alice, first, codec.syncRequestId(alice.account));
  check(`first sync: one ${CIPHERTEXT_BYTES}-byte receipt, judged at clock 0`, first.status === "COMPLETED" && firstBody.type === "sync" && firstBody.status === "requested" && firstBody.at?.tick === 0 && first.userEvents[0]?.bytes === CIPHERTEXT_BYTES, firstBody);
  check("first sync: asks for tick 1 (no round held: three words) and the trusted request sets the clock", first.ticks[0] === 1n && first.asked?.bytes === 96 && first.trusted?.status === 0 && first.trusted.clocks[0]?.[0] === 1n, first.trusted?.clocks);
  // The rounds come from the trigger: it creates the market's next two slots in the registry, and the same
  // tick creates them in the engine (guest README §10).
  check("first tick: the trigger created the next two BTC 15-minute slots in the registry and reported both; the tick created both in the engine",
    first.trusted?.payload?.version === 2 && first.trusted.payload.n === 2 && first.trusted.payload.records.every((r) => r.duration === D && r.start > first.timestamp) &&
    first.trusted.clocks[0][3] === 2n && first.trusted.clocks[0][4] === 0n, first.trusted?.payload);

  // Deposit, receipt, withdrawal request, claim.
  const amount = 100n * UNIT;
  const dep = await deposit(alice, amount, "deposit alice 100");
  credit(alice, amount);
  alice.notices++;
  const depBody = await receipt(alice, dep, codec.noticeRequestId(alice.account, alice.notices));
  check("deposit: COMPLETED with one receipt and no tick", dep.status === "COMPLETED" && dep.userEvents.length === 1 && dep.ticks.length === 0, dep.errorMessage);
  check("deposit: receipt decrypts to the credited amount and registers the account", depBody.type === "deposit" && depBody.status === "credited" && BigInt(depBody.receipt?.amount ?? 0) === amount && depBody.registered === true && depBody.deposit === 1, depBody);
  const second = await send(alice, "alice sync (rounds held)", { payload: await sync(alice) });
  check("next tick request: lists the two rounds the engine now holds as scheduled", second.asked?.scheduled.length === 2 && second.asked.open.length === 0 &&
    second.asked.scheduled.every((id) => first.trusted.payload.records.some((r) => r.id === id)), second.asked);
  const w = command(alice, alice.nonce + 1, { op: "request_withdrawal", amount: Number(40n * UNIT), destination: alice.account });
  const wd = await send(alice, "alice withdraw 40", { payload: await w.encrypt() });
  debit(alice, 40n * UNIT);
  const wdBody = await receipt(alice, wd, w.id);
  check("withdrawal: applied, one Withdrawal of 40 to alice, one tick", wd.status === "COMPLETED" && wdBody.status === "applied" && wd.withdrawals.length === 1 && wd.withdrawals[0].amount === 40n * UNIT && wd.withdrawals[0].to === alice.account && wd.ticks.length === 1 && wd.trusted?.status === 0, { body: wdBody, withdrawals: wd.withdrawals });
  const paid = await claim(alice, alice.account, token.target);
  check("claim: moves exactly the credited amount (40 + the 1 refunded before the clock) and clears it", paid.moved === 41n * UNIT && paid.left === 0n, paid);
  const dup = await send(alice, "alice duplicate withdrawal", { payload: await w.encrypt() });
  const dupBody = await receipt(alice, dup, w.id);
  check("duplicate command: retry receipt, no second withdrawal", dup.status === "COMPLETED" && dupBody.status === "retry" && dup.withdrawals.length === 0, dupBody.status);
  check("alice's wallet: 101 minted and deposited, 41 claimed back", (await token.balanceOf(alice.account)) === 41n * UNIT);

  // A second account, withdrawing to a third address that anyone can claim for.
  await send(bob, "bob associate key", { type: ASSOCIATEKEY, payload: await bob.session.associationPayload() });
  const bdep = await deposit(bob, 25n * UNIT, "deposit bob 25");
  credit(bob, 25n * UNIT);
  bob.notices++;
  check("bob: deposit receipt decrypts", (await receipt(bob, bdep, codec.noticeRequestId(bob.account, 1))).status === "credited");
  const outside = lower(throwaway().address);
  const bw = command(bob, bob.nonce + 1, { op: "request_withdrawal", amount: Number(10n * UNIT), destination: outside });
  const bwd = await send(bob, "bob withdraw 10 to a third address", { payload: await bw.encrypt() });
  debit(bob, 10n * UNIT);
  check("bob: withdrawal to a third address is credited to it", (await receipt(bob, bwd, bw.id)).status === "applied" && bwd.withdrawals[0]?.to === outside);
  const thirdClaim = await claim(alice, outside, token.target);
  check("claim by anyone pays the destination", thirdClaim.moved === 10n * UNIT && (await token.balanceOf(outside)) === 10n * UNIT, thirdClaim);
  const bad = command(bob, bob.nonce + 1, { op: "request_withdrawal", amount: 1, destination: S.endpointAddress });
  const badReq = await send(bob, "bob withdraw to the endpoint", { payload: await bad.encrypt() });
  const badBody = await receipt(bob, badReq, bad.id);
  check("withdrawal to the endpoint: private refusal (COMPLETED, rejected receipt, no withdrawal)", badReq.status === "COMPLETED" && badBody.status === "rejected" && badReq.withdrawals.length === 0, badBody.reason);
  // To the trigger: the endpoint would pay it out at once to a contract that returns nothing (README §7.1).
  // A refused command consumes no nonce, so the same nonce is free again.
  const toTrigger = command(bob, bob.nonce + 1, { op: "request_withdrawal", amount: Number(5n * UNIT), destination: trigger });
  const toTriggerReq = await send(bob, "bob withdraw 5 to the trigger", { payload: await toTrigger.encrypt() });
  const toTriggerBody = await receipt(bob, toTriggerReq, toTrigger.id);
  check("withdrawal to the trigger: private refusal (COMPLETED, rejected for its destination, no withdrawal, the trigger holds nothing)",
    toTriggerReq.status === "COMPLETED" && toTriggerBody.status === "rejected" && toTriggerBody.reason === "withdrawal destination not allowed" &&
    toTriggerReq.withdrawals.length === 0 && (await token.balanceOf(trigger)) === 0n, toTriggerBody.reason);

  // Negative cases from the guest README.
  const carol = { ...(await user("carol")) }; // no ASSOCIATEKEY
  const noKey = await deposit(carol, 5n * UNIT, "deposit without a key");
  check("deposit without a key: FAILED and refunded as a claim", noKey.status === "FAILED" && noKey.refunds.some((r) => r.to === carol.account && r.amount === 5n * UNIT), { code: noKey.errorCode, message: noKey.errorMessage });
  const carolBack = await claim(carol, carol.account, token.target);
  check("deposit without a key: the refund claim pays it back", carolBack.moved === 5n * UNIT && (await token.balanceOf(carol.account)) === 5n * UNIT, carolBack);
  const wrong = await deposit(alice, 3n * UNIT, "deposit of the wrong token", wrongToken);
  check("wrong token: FAILED with the public error and refunded in that token", wrong.status === "FAILED" && wrong.errorMessage.includes("zedge: unsupported token") && wrong.refunds.some((r) => r.token === lower(wrongToken.target) && r.amount === 3n * UNIT), wrong.errorMessage);
  const eth = await send(alice, "deposit of ETH", { tokenAddress: ZERO, amount: 12345n });
  const ethRefund = 12345n + MAX_FEE - (await S.endpoint.minFeePerRequest()); // the deposit and the unused fee, in one Refund
  check("ETH deposit: FAILED as an unsupported token; one refund to alice of the deposit plus the unused fee, exactly", eth.status === "FAILED" && eth.errorMessage.includes("zedge: unsupported token") &&
    eth.refunds.length === 1 && eth.refunds[0].to === alice.account && eth.refunds[0].token === ZERO && eth.refunds[0].amount === ethRefund, { message: eth.errorMessage, refunds: eth.refunds, expected: ethRefund });

  // Oversized payload: a client that skips session.ts's limit. Its own raw P-521 key, registered first.
  const dave = await user("dave");
  const raw = await sdk.generateKeyPair();
  await send(dave, "dave associate raw key", { type: ASSOCIATEKEY, payload: await sdk.buildAssociateKeyPayload(raw.publicKey) });
  const enclave = await sdk.importPublicKeyFromHex(S.enclaveKey);
  const oversized = await sdk.encrypt(raw.privateKey, enclave, new Uint8Array(16_385).fill(0x7b));
  const over = await send(dave, "oversized payload (16,385 bytes)", { payload: oversized });
  check("oversized payload: FAILED with the public envelope error, no receipt, no tick", over.status === "FAILED" && over.errorMessage.includes("zedge: malformed envelope") && over.userEvents.length === 0 && over.ticks.length === 0, over.errorMessage);
  // What session.ts encrypts for guest.ts's body without pad.ts: refused for its length alone.
  const bare = await send(alice, "unpadded sync", { payload: await alice.session.encryptCommand(codec.syncRequestId(alice.account), codec.syncBody()) });
  check("unpadded request: FAILED with the public envelope error, no receipt, no tick", bare.status === "FAILED" && bare.errorMessage.includes("zedge: malformed envelope") &&
    bare.userEvents.length === 0 && bare.ticks.length === 0 && bare.payloadBytes < REQUEST_CIPHERTEXT_BYTES, { message: bare.errorMessage, bytes: bare.payloadBytes });
  return { alice, bob, carol, dave };
}

async function clock({ alice }) {
  // Exact time: the next block, the one that commits the asking transition, is stamped by Anvil.
  const target = (await provider.getBlock("latest")).timestamp + 1000;
  const exact = await send(alice, "sync at a chosen block time", { payload: await sync(alice), afterSubmit: () => provider.send("evm_setNextBlockTimestamp", [target]) });
  check("clock: the asking block carries the chosen time", exact.timestamp === target, exact.timestamp);
  check("clock: the record is (tick, asking block number, asking block time)", exact.trusted?.clocks[0]?.[0] === exact.ticks[0] && exact.trusted.clocks[0][1] === BigInt(exact.block) && exact.trusted.clocks[0][2] === BigInt(target), exact.trusted?.clocks);

  await provider.send("evm_increaseTime", [3600]);
  const jump = await send(alice, "sync an hour later", { payload: await sync(alice) });
  const jumpBody = await receipt(alice, jump, codec.syncRequestId(alice.account));
  check("clock: an hour of chain time later the record follows the chain", jump.trusted?.clocks[0]?.[2] === BigInt(jump.timestamp) && jump.timestamp >= target + 3600, { asking: jump.timestamp, record: jump.trusted?.clocks[0] });
  check("clock: the receipt names the clock it was judged at (the previous tick)", jumpBody.at?.tick === Number(exact.ticks[0]) && jumpBody.at?.timestamp === target, jumpBody.at);

  // A lost tick: the trigger reverts (its code swapped for PUSH1 0 PUSH1 0 REVERT), the endpoint swallows it.
  const code = await provider.getCode(trigger);
  await provider.send("anvil_setCode", [trigger, "0x60006000fd"]);
  const lost = await send(alice, "sync while the trigger reverts", { payload: await sync(alice) });
  await provider.send("anvil_setCode", [trigger, code]);
  records.at(-1).lostOnPurpose = true;
  check("lost tick: request COMPLETED, tick asked, no trusted request", lost.status === "COMPLETED" && lost.ticks.length === 1 && lost.spawned === 0 && !lost.trusted);
  check("lost tick: trigger code restored byte for byte", (await provider.getCode(trigger)) === code);
  const next = await send(alice, "sync after the lost tick", { payload: await sync(alice) });
  const nextBody = await receipt(alice, next, codec.syncRequestId(alice.account));
  check("lost tick: the next request's tick replaces it", next.ticks[0] === lost.ticks[0] + 1n && next.trusted?.status === 0 && next.trusted.clocks[0]?.[0] === next.ticks[0], next.trusted?.clocks);
  check("lost tick: the next receipt shows the lost tick was never applied", nextBody.at?.tick === Number(jump.ticks[0]), nextBody.at);
  const after = await send(alice, "sync after the replacement", { payload: await sync(alice) });
  check("lost tick: and the one after shows the replacement applied", (await receipt(alice, after, codec.syncRequestId(alice.account))).at?.tick === Number(next.ticks[0]));

  // A registry that misbehaves can delay rounds but must not stop the clock (guest README §10). Its proxy's
  // code is swapped for one that burns all the gas it is given, then for one that reverts. Each tick goes
  // through the real endpoint, whose try/catch and the manager's own gas estimate decide whether it lands.
  const registryCode = await provider.getCode(K.address);
  const hostile = {};
  for (const [name, bytecode] of [["burns all its gas", "0x5b600056"], ["reverts", "0x60006000fd"]]) {
    await provider.send("anvil_setCode", [K.address, bytecode]);
    const r = await send(alice, `sync while the registry ${name}`, { payload: await sync(alice), hostile: true });
    await provider.send("anvil_setCode", [K.address, registryCode]);
    const p = r.trusted?.payload;
    hostile[name] = { askingGasUsed: r.gasUsed, trustedStatus: r.trusted?.status, records: p?.n, clock: r.trusted?.clocks[0] };
    check(`registry ${name}: the tick still lands and applies, with the clock words of the asking block and no registry record`,
      r.status === "COMPLETED" && r.trusted?.status === 0 && p?.version === 2 && p.n === 0 && p.block === r.block && p.timestamp === r.timestamp &&
      r.trusted.clocks[0]?.[2] === BigInt(r.timestamp), hostile[name]);
  }
  check("registry: proxy code restored byte for byte", (await provider.getCode(K.address)) === registryCode);
  const back = await send(alice, "sync after the registry is restored", { payload: await sync(alice) });
  check("registry restored: the next tick reads it again (its answer is verified against getRound)", back.trusted?.status === 0 && back.trusted.payload?.verified?.records === true, back.trusted?.payload?.verified);
  return { exact: { tick: exact.ticks[0], block: exact.block, timestamp: target }, lostTick: lost.ticks[0], replacedBy: next.ticks[0], hostileRegistry: hostile };
}

async function burst({ bob }) {
  // Measure: eight syncs submitted back to back; each is two transitions (the request and its tick).
  const n = 8;
  const started = Date.now();
  const sent = [];
  for (let i = 0; i < n; i++) sent.push(await bob.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, await sync(bob), ZERO, 0n, MAX_FEE));
  const submitted = Date.now();
  const done = [];
  for (const s of sent) {
    const c = await completion(s.requestId, s.transactionReceipt.blockNumber);
    const spawned = c.events.find((e) => e.name === "RequestSubmitted" && lower(e.args.sender) === trigger);
    const t = spawned && await completion(spawned.args.requestId, c.block);
    done.push({ request: c.status, trusted: t?.status, end: t?.at ?? c.at });
    lastRequest = spawned?.args.requestId ?? s.requestId;
    records.push({ label: "burst sync", sender: "bob", requestId: s.requestId, type: PROCESS, token: ZERO, amount: 0n, status: c.status === 0 ? "COMPLETED" : "FAILED",
      ticks: c.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.tick).map((e) => tickRequest(e.args.data).tick), spawned: spawned ? 1 : 0, userEvents: [] });
  }
  const end = Math.max(...done.map((d) => d.end));
  const transitions = 2 * n;
  const result = { requests: n, transitions, submitMs: submitted - started, wallMs: end - started, transitionsPerMinute: Math.round((transitions * 60_000) / (end - started)) };
  check("burst: all requests and their ticks COMPLETED", done.every((d) => d.request === 0 && d.trusted === 0), result);
  return result;
}

async function restart({ alice }, logSnapshots) {
  const restartMs = await restartExecutorAndManager("restart");
  const a = await send(alice, "sync after executor+manager restart", { payload: await sync(alice) });
  check("restart: a sync and its tick complete after the restart", a.status === "COMPLETED" && a.trusted?.status === 0);
  // Root continuity is enforced by the endpoint (previous root) and the executor (state hash = root). What
  // shows the ledger was not rolled back is the next nonce being accepted: the engine takes only previous + 1.
  const w = command(alice, alice.nonce + 1, { op: "request_withdrawal", amount: Number(5n * UNIT), destination: alice.account });
  const wd = await send(alice, "withdraw 5 after restart", { payload: await w.encrypt() });
  debit(alice, 5n * UNIT);
  check("restart: alice's next-nonce withdrawal is applied (the ledger was not rolled back)", (await receipt(alice, wd, w.id)).status === "applied" && wd.withdrawals[0]?.amount === 5n * UNIT);

  // compose down with volumes kept, then up again.
  await quiesce();
  const rootBefore = await S.endpoint.applicationStateRoots(appId);
  const blockBefore = await provider.getBlockNumber();
  const timeBefore = (await provider.getBlock(blockBefore)).timestamp;
  logSnapshots.push(stackLogs());
  const t1 = Date.now();
  compose("down");
  compose("up -d --quiet-pull");
  await until("handshake after compose up", () => /Handshake successful/.test(stackLogs()), 300_000, 1000);
  const upMs = Date.now() - t1;
  const exec = stackLogs();
  const sameChain = (await provider.getBlockNumber()) >= blockBefore && (await S.endpoint.applicationStateRoots(appId).catch(() => ethers.ZeroHash)) === rootBefore;
  check("down/up: chain state survived (block height and application root)", sameChain, { blockBefore, blockAfter: await provider.getBlockNumber(), upMs });
  check("down/up: executor restored the keyset (not a new one) with the same signer", exec.includes("Keyset restored successfully") && !exec.includes("generating new keyset") && loggedSigner(exec) === S.teeSigner);
  if (!sameChain) return { restartMs, downUpMs: upMs, continued: false };
  const b = await send(alice, "sync after compose down/up", { payload: await sync(alice) });
  check("down/up: block time did not go backwards", b.timestamp >= timeBefore, { lastBefore: timeBefore, firstAfter: b.timestamp });
  const w2 = command(alice, alice.nonce + 1, { op: "request_withdrawal", amount: Number(5n * UNIT), destination: alice.account });
  const wd2 = await send(alice, "withdraw 5 after down/up", { payload: await w2.encrypt() });
  debit(alice, 5n * UNIT);
  check("down/up: the tick and alice's next-nonce withdrawal are applied (the ledger was not rolled back)", b.trusted?.status === 0 && (await receipt(alice, wd2, w2.id)).status === "applied");
  const paid = await claim(alice, alice.account, token.target);
  check("down/up: claim pays both post-restart withdrawals", paid.moved === 10n * UNIT, paid);
  return { restartMs, downUpMs: upMs, continued: true };
}

// ---------------------------------------------------------------- one round, then a void (guest README §9, §10)

const nextSlot = (t) => (Math.floor(t / D) + 1) * D;
const notional = (quantity, price) => Math.floor(quantity / 100) * price; // engine/codec.go: a lot keeps it exact
const tradeFee = (n) => Math.ceil((n * FEE_BPS) / 10_000); // per order on its cumulative notional; one fill each here
const OBSERVATION = "tuple(int192 price,uint32 validFromTimestamp,uint32 observationsTimestamp,uint32 expiresAt,bytes32 reportHash,uint8 decimals)";

/** A registry round and the engine's round for it, both derived by the client: the registry ID as the
 * registry computes it, the engine ID as SHA-256 of {config, round} (engine/codec.go). */
function roundAt(start) {
  const registryRoundId = ethers.keccak256(abi.encode(["uint256", "address", "bytes32", "uint8", "uint32", "uint64"], [31337, K.address, K.rulesHash, 0, D, start]));
  const p = ORACLE_POLICY;
  const spec = { asset: MARKET.asset, feed: BTC_FEED, registryRoundId, start, end: start + D, cutoff: start + D - p.cutoffBuffer, observationWindow: p.observationWindow,
    openingDeadline: start + p.observationWindow + p.openingGrace, voidableAfter: start + D + p.observationWindow + p.voidGrace };
  return { ...spec, id: sha256(JSON.stringify({ config: deployedConfig, round: spec })) };
}
/** A fixture observation for a boundary: signed window containing it, observed one second after it. */
function fixture(boundary, price) {
  return { price, validFromTimestamp: boundary - 1, observationsTimestamp: boundary + 1, expiresAt: boundary + 86_400,
    reportHash: ethers.keccak256(ethers.toUtf8Bytes(`zedge evaluation fixture ${boundary} ${price}`)), decimals: 18 };
}
const tuple = (o) => [BigInt(o.price), o.validFromTimestamp, o.observationsTimestamp, o.expiresAt, o.reportHash, o.decimals];
const evidence = (o) => abi.encode([OBSERVATION], [tuple(o)]);

/** A keeper transaction mined at an exact block time. */
async function keeperAt(timestamp, label, fn) {
  await provider.send("evm_setNextBlockTimestamp", [timestamp]);
  const r = await (await fn()).wait();
  must(`keeper: ${label}, mined at ${timestamp}`, r.status === 1 && (await provider.getBlock(r.blockNumber)).timestamp === timestamp);
  return r;
}
/** The keeper voids every registry round whose opening was never recorded and whose opening deadline has
 * passed (opening missing): the permissionless call anyone may make. */
async function voidMissedOpenings(label) {
  const now = (await provider.getBlock("latest")).timestamp;
  const voided = [];
  for (const e of await K.view.queryFilter(K.view.filters.RoundCreated(), 0)) {
    const r = await K.view.getRound(e.args.roundId);
    if (Number(r.outcome) === 0 && Number(r.openedAt) === 0 && now > Number(r.openingDeadline) + 1) {
      await (await K.registry.voidRound(e.args.roundId, KEEPER_GAS)).wait();
      voided.push({ id: e.args.roundId, start: Number(r.start), resolvedAt: Number((await K.view.getRound(e.args.roundId)).resolvedAt) });
    }
  }
  console.log(`      keeper (${label}): voided ${voided.length} round(s) whose opening was never recorded`);
  return voided;
}

const position = (u, round) => (u.positions[round.id] ??= { roundId: round.id, up: 0, down: 0, reservedUp: 0, reservedDown: 0 });
const held = (holdings) => (holdings ?? []).filter((h) => h.up || h.down || h.reservedUp || h.reservedDown).map((h) => ({ roundId: h.roundId, up: h.up, down: h.down, reservedUp: h.reservedUp, reservedDown: h.reservedDown }))
  .sort((a, b) => a.roundId.localeCompare(b.roundId));
const expectedHoldings = (u) => held(Object.values(u.positions));
/** The account's view (engine.AccountView in its receipt) against what the client computed on its own. */
function expectView(u, body, label, { orders = 0 } = {}) {
  const v = body.view;
  const got = { cash: v?.cash, reservedCash: v?.reservedCash, holdings: held(v?.holdings), orders: v?.orders.length };
  const want = { cash: u.cash, reservedCash: 0, holdings: expectedHoldings(u), orders };
  return check(`${label}: ${u.name}'s view equals the client's own figures (cash, reservations, shares per round, orders)`, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
/** An archive record (public, guest README §10) is the engine's hash chain: recompute its digest. */
function archiveDigest(a) {
  return sha256(JSON.stringify({ domain: "ZEDGE_ROUND_ARCHIVE_V3", count: a.count, previousRoot: a.previousRoot, round: a.round }));
}

async function collect(u, label) {
  const r = await send(u, label, { payload: await sync(u) });
  return { r, b: await receipt(u, r, codec.syncRequestId(u.account)) };
}
/** How long a staged command waited: from its staging transition on chain to the tick that activated it
 * (wall clock and chain time), and from its submission. */
const staged = (u, c, op, r) => ({ who: u.name, commandId: c.id, op, tick: r.ticks[0], stagedBlock: r.block, stagedTimestamp: r.timestamp,
  activatedBlock: r.trusted?.block, activatedTimestamp: r.trusted?.timestamp, activationMs: r.trusted?.latencyMs,
  submitToActivationMs: r.latencyMs + (r.trusted?.latencyMs ?? NaN), activationChainSeconds: r.trusted && r.trusted.timestamp - r.timestamp });
/** Stages a book command: the reply is a staged receipt naming the tick it asked for, and that tick
 * activates it at the asking block's time (guest README §9). */
async function stage(u, label, fields) {
  const c = command(u, u.nonce + 1, fields);
  const r = await send(u, label, { payload: await c.encrypt() });
  const b = await receipt(u, r, c.id);
  check(`${label}: staged (receipt names its tick) and that tick applied`, r.status === "COMPLETED" && b.status === "staged" && BigInt(b.tick) === r.ticks[0] && r.trusted?.status === 0, { status: b.status, reason: b.reason, tick: b.tick });
  staging.push(staged(u, c, fields.op, r));
  return { c, r, b };
}

async function rounds({ alice, bob }, logSnapshots) {
  const startedAt = Date.now();
  const firstRecord = records.length;
  for (const u of [alice, bob]) u.cash = Number(u.credited - u.withdrawn); // nothing is in a round yet
  const result = { market: MARKET, roundSeconds: D };

  // 0. Rounds the trigger created before this phase and nobody opened: the keeper voids them (opening
  // missing), and the next tick mirrors each void from the registry's record and archives it.
  await quiesce();
  const earlier = await voidMissedOpenings("before round A");
  const zero = await collect(alice, "alice sync before round A");
  expectView(alice, zero.b, "before round A");
  // Round A: the next slot at least 30 seconds ahead. The tick that just ran created it (the next two slots).
  const A = roundAt(nextSlot((await provider.getBlock("latest")).timestamp + 30));
  must("round A: the client's registry ID equals the registry's, and the trigger created it in the registry",
    A.registryRoundId === (await K.view.roundIdFor(0, D, A.start)) && Number(await K.view.phase(A.registryRoundId)) === 1, { A: A.registryRoundId, start: A.start });
  result.roundA = { start: A.start, cutoff: A.cutoff, end: A.end, registryRoundId: A.registryRoundId, engineRoundId: A.id };
  await books("round A, before the opening");

  // 1. The opening: a fixture observation written to the fixture oracle, recorded by the registry inside
  // the opening window; the next tick mirrors it with the registry's own time.
  const openA = fixture(A.start, PRICE_OPEN);
  await keeperAt(A.start + 2, "fixture oracle caches round A's opening observation", () => K.oracle.setCached(BTC_FEED, A.start, tuple(openA), KEEPER_GAS));
  await keeperAt(A.start + 3, "registry records round A's opening", () => K.registry.recordOpening(A.registryRoundId, evidence(openA), KEEPER_GAS));
  const opening = await collect(bob, "bob sync: the tick mirrors round A's opening");
  must("round A: the engine holds it as scheduled (bob's tick request lists it)", opening.r.asked?.scheduled.includes(A.registryRoundId), opening.r.asked);
  check("round A: the trigger reported the registry's opening and the tick applied it",
    opening.r.trusted?.payload?.records?.some((r) => r.id === A.registryRoundId && r.openedAt === A.start + 3 && r.opening.price === PRICE_OPEN) && opening.r.trusted.clocks[0][3] >= 1n, opening.r.trusted?.clocks);
  expectView(bob, opening.b, "round A open");
  await books("round A open");

  // 2. Fresh deposits, each checked against the engine ledger the executor logged for it.
  await ledgerDeposit(alice, 30n * UNIT, "deposit alice 30 (round A)", [alice, bob]);
  await ledgerDeposit(bob, 20n * UNIT, "deposit bob 20 (round A)", [alice, bob]);

  // 3. Alice mints ten complete sets: ten tokens locked, ten Up and ten Down.
  const mint = command(alice, alice.nonce + 1, { op: "mint", roundId: A.id, quantity: 10 * SHARE });
  const mr = await send(alice, "alice mints 10 sets in round A", { payload: await mint.encrypt() });
  const mb = await receipt(alice, mr, mint.id);
  alice.cash -= 10 * SHARE;
  Object.assign(position(alice, A), { up: 10 * SHARE, down: 10 * SHARE });
  check("round A: the mint is applied for the round ID the client derived, and the next tick request lists round A as open",
    mb.status === "applied" && mb.receipt?.roundId === A.id && mb.receipt.amount === 10 * SHARE && mr.asked?.open.includes(A.registryRoundId), { status: mb.status, reason: mb.reason, receipt: mb.receipt });
  expectView(alice, mb, "after the mint");
  await books("after the mint");

  // 4. Alice rests a sell of all ten Up at 60.
  const sell = await stage(alice, "alice stages a sell: 10 Up at 60, GTC", { op: "place_order", roundId: A.id, outcome: "up", side: "sell", price: 60, quantity: 10 * SHARE, tif: "gtc", expiry: A.cutoff, maxFee: tradeFee(notional(10 * SHARE, 60)) });
  Object.assign(position(alice, A), { up: 0, reservedUp: 10 * SHARE });
  const rest = await collect(alice, "alice collects her order's outcome");
  check("alice's sell rests: outcome applied by its own tick, receipt resting, one order of 10 in her view",
    rest.b.outcome?.commandId === sell.c.id && rest.b.outcome.status === "applied" && BigInt(rest.b.outcome.tick) === sell.r.ticks[0] && rest.b.outcome.receipt?.status === "resting" &&
    rest.b.view?.orders[0]?.id === sell.c.id && rest.b.view.orders[0].remaining === 10 * SHARE, rest.b.outcome);
  expectView(alice, rest.b, "alice's sell resting", { orders: 1 });
  await books("alice's sell resting");

  // 5. The executor and the manager restart while the order rests.
  result.restartWhileRestingMs = await restartExecutorAndManager("restart while alice's order rests");

  // 6. Bob buys four Up at up to 65, IOC: it crosses alice's 60 and fills four of her ten at her price.
  const buy = await stage(bob, "bob stages a crossing buy: 4 Up at up to 65, IOC", { op: "place_order", roundId: A.id, outcome: "up", side: "buy", price: 65, quantity: 4 * SHARE, tif: "ioc", expiry: A.cutoff, maxFee: tradeFee(notional(4 * SHARE, 65)) });
  const fillA = { price: 60, quantity: 4 * SHARE, notional: notional(4 * SHARE, 60) };
  fillA.fee = tradeFee(fillA.notional); // charged to the buyer and the seller each
  bob.cash -= fillA.notional + fillA.fee;
  position(bob, A).up += fillA.quantity;
  alice.cash += fillA.notional - fillA.fee;
  position(alice, A).reservedUp -= fillA.quantity;
  expected.fees += 2 * fillA.fee;
  const filled = await collect(bob, "bob collects his fill");
  const f = filled.b.outcome?.receipt?.fills ?? [];
  check(`bob's fill: one fill as taker, buying ${fillA.quantity} Up atoms at the maker's ${fillA.price} with a fee of ${fillA.fee} atoms (computed by the client), order filled`,
    filled.b.outcome?.commandId === buy.c.id && filled.b.outcome.status === "applied" && filled.b.outcome.receipt.status === "filled" && f.length === 1 &&
    f[0].role === "taker" && f[0].side === "buy" && f[0].outcome === "up" && f[0].price === fillA.price && f[0].quantity === fillA.quantity && f[0].fee === fillA.fee, { fills: f, want: fillA });
  check("the fill names no counterparty: bob's receipt carries only his own order", f.every((x) => x.orderId === buy.c.id) && !JSON.stringify(filled.b).includes(alice.account), f);
  expectView(bob, filled.b, "after bob's fill");
  result.fill = { ...fillA, bobPaid: fillA.notional + fillA.fee, aliceReceived: fillA.notional - fillA.fee };

  // 7. Alice learns of the fill from her view and cancels the remainder.
  const cancel = await stage(alice, "alice stages a cancel of the remaining six", { op: "cancel_order", orderId: sell.c.id });
  const o = cancel.b.view?.orders[0];
  check(`alice learns of the partial fill from her view: 4 of 10 filled at 60, notional ${fillA.notional}, fee ${fillA.fee}, proceeds ${fillA.notional - fillA.fee} in her cash`,
    o?.filled === fillA.quantity && o.remaining === 6 * SHARE && o.filledNotional === fillA.notional && o.feePaid === fillA.fee && cancel.b.view.cash === alice.cash, o);
  Object.assign(position(alice, A), { up: 6 * SHARE, reservedUp: 0 });
  const cancelled = await collect(alice, "alice collects her cancel");
  check("alice's cancel applied: no order left, six Up back in her hands", cancelled.b.outcome?.commandId === cancel.c.id && cancelled.b.outcome.status === "applied" && cancelled.b.view?.orders.length === 0, cancelled.b.outcome);
  expectView(alice, cancelled.b, "after alice's cancel");
  await books("after alice's cancel");

  // 8. The cutoff, to the second (guest README §9): an order whose staging block is stamped cutoff - 1 is
  // admitted; one stamped exactly at the cutoff is refused. Automine is off and the slice mines each block
  // at the second it names, so nothing else can land in between.
  const cut = await cutoffStaging({ alice, bob }, A);

  // 9. Right after (round C's opening window is 30 seconds from its start, round A's end): round A resolves
  // Up in the registry and round C opens on the same boundary observation. The tick of bob's next request
  // mirrors both, sweeps round A in each account's own name and archives it.
  const C = roundAt(A.end);
  const close = fixture(A.end, PRICE_CLOSE);
  await keeperAt(A.end + 2, "fixture oracle caches the boundary observation at round A's end (round C's start)", () => K.oracle.setCached(BTC_FEED, A.end, tuple(close), KEEPER_GAS));
  await keeperAt(A.end + 3, "registry resolves round A", () => K.registry.resolveRound(A.registryRoundId, evidence(close), KEEPER_GAS));
  await keeperAt(A.end + 4, "registry records round C's opening", () => K.registry.recordOpening(C.registryRoundId, evidence(close), KEEPER_GAS));
  const regA = await K.view.getRound(A.registryRoundId);
  check("registry: round A resolved Up at end + 3 from the closing fixture", Number(regA.outcome) === 1 && Number(regA.resolvedAt) === A.end + 3);
  result.roundC = { start: C.start, cutoff: C.cutoff, voidableAfter: C.voidableAfter, registryRoundId: C.registryRoundId, engineRoundId: C.id };

  const { admitted, refused } = cut;
  const adm = await collect(admitted.u, `${admitted.u.name} collects the order staged at cutoff - 1 (this request's tick resolves A, opens C, sweeps and archives A)`);
  check(`cutoff - 1: ${admitted.u.name}'s order was admitted at its tick (resting) and released by the checkpoint of the tick at the cutoff: no order, nothing reserved`,
    adm.b.outcome?.commandId === admitted.cmd.id && adm.b.outcome.status === "applied" && BigInt(adm.b.outcome.tick) === admitted.r.ticks[0] && adm.b.outcome.receipt?.status === "resting" &&
    adm.b.view?.orders.length === 0 && adm.b.view.reservedCash === 0 && held(adm.b.view.holdings).every((h) => h.reservedUp === 0), adm.b.outcome);
  expectView(admitted.u, adm.b, "after the cutoff, before the sweep");
  const settleA = adm.r;
  const archA = settleA.trusted?.archives.find((a) => a.round.id === A.id);
  check("round A: the trigger reported the resolution and the opening, and the tick applied both (round C now open)",
    settleA.trusted?.payload?.records?.some((r) => r.id === A.registryRoundId && r.outcome === 1 && r.resolvedAt === A.end + 3) &&
    settleA.trusted.payload.records.some((r) => r.id === C.registryRoundId && r.openedAt === A.end + 4) && settleA.trusted.clocks[0][3] >= 2n, settleA.trusted?.clocks);
  check("round A: archived in the same tick, as the engine resolved it from the registry: Up, the fixture prices, nothing left locked",
    archA && archA.round.status === "resolved" && archA.round.outcome === "up" && archA.round.spec.registryRoundId === A.registryRoundId &&
    archA.round.opening?.price === PRICE_OPEN && archA.round.closing?.price === PRICE_CLOSE && archA.round.opening.reportHash === openA.reportHash &&
    archA.round.locked === 0 && archA.round.upSupply === 0 && archA.round.downSupply === 0 && archA.hash === archiveDigest(archA), archA);
  // The sweep: every share of the winning side pays one token, the losing side nothing (engine redeem).
  const sweptA = { alice: position(alice, A).up, bob: position(bob, A).up };
  alice.cash += sweptA.alice;
  bob.cash += sweptA.bob;
  delete alice.positions[A.id];
  delete bob.positions[A.id];
  result.redemptionA = sweptA;
  const nonces = { alice: alice.nonce, bob: bob.nonce };
  const ref = await collect(refused.u, `${refused.u.name} collects the order staged at the cutoff`);
  check(`at the cutoff: ${refused.u.name}'s order was refused at activation (round closed); nothing changed by it`,
    ref.b.outcome?.commandId === refused.cmd.id && ref.b.outcome.status === "rejected" && ref.b.outcome.reason === "round closed" && ref.b.view?.orders.length === 0, ref.b.outcome);
  const again = await collect(admitted.u, `${admitted.u.name} collects after the sweep`);
  const after = { [refused.u.name]: ref.b.view?.nonce, [admitted.u.name]: again.b.view?.nonce };
  check(`the sweep paid ${sweptA.alice} atoms to alice and ${sweptA.bob} to bob in their own names (each nonce advanced by one; the refused order used none) and round A is gone from their holdings`,
    after.alice === nonces.alice + 1 && after.bob === nonces.bob + 1, { before: nonces, after });
  expectView(refused.u, ref.b, "after the sweep of round A");
  expectView(admitted.u, again.b, "after the sweep of round A");
  result.cutoff = { cutoff: A.cutoff, admitted: { who: admitted.u.name, blockTime: admitted.r.timestamp, tick: admitted.r.ticks[0] },
    refused: { who: refused.u.name, blockTime: refused.r.timestamp, tick: refused.r.ticks[0], reason: ref.b.outcome?.reason } };
  await books("after round A settled");

  // 10. Round C: alice mints four sets and sells two Up to bob at 40.
  const mintC = command(alice, alice.nonce + 1, { op: "mint", roundId: C.id, quantity: 4 * SHARE });
  const mcr = await send(alice, "alice mints 4 sets in round C", { payload: await mintC.encrypt() });
  const mcb = await receipt(alice, mcr, mintC.id);
  alice.cash -= 4 * SHARE;
  Object.assign(position(alice, C), { up: 4 * SHARE, down: 4 * SHARE });
  check("round C: mint applied for the client's round ID", mcb.status === "applied" && mcb.receipt?.roundId === C.id, { status: mcb.status, reason: mcb.reason });
  const sellC = await stage(alice, "alice stages a sell: 2 Up at 40 in round C", { op: "place_order", roundId: C.id, outcome: "up", side: "sell", price: 40, quantity: 2 * SHARE, tif: "gtc", expiry: C.cutoff, maxFee: tradeFee(notional(2 * SHARE, 40)) });
  Object.assign(position(alice, C), { up: 2 * SHARE, reservedUp: 2 * SHARE });
  const buyC = await stage(bob, "bob stages a buy: 2 Up at 40 in round C, IOC", { op: "place_order", roundId: C.id, outcome: "up", side: "buy", price: 40, quantity: 2 * SHARE, tif: "ioc", expiry: C.cutoff, maxFee: tradeFee(notional(2 * SHARE, 40)) });
  const fillC = { price: 40, quantity: 2 * SHARE, notional: notional(2 * SHARE, 40) };
  fillC.fee = tradeFee(fillC.notional);
  bob.cash -= fillC.notional + fillC.fee;
  position(bob, C).up += fillC.quantity;
  alice.cash += fillC.notional - fillC.fee;
  position(alice, C).reservedUp -= fillC.quantity;
  expected.fees += 2 * fillC.fee;
  const aC = await collect(alice, "alice collects her round C sell");
  check("round C: alice's sell applied, then filled in full by bob (no order left)", aC.b.outcome?.commandId === sellC.c.id && aC.b.outcome.status === "applied" && aC.b.view?.orders.length === 0, aC.b.outcome);
  expectView(alice, aC.b, "round C traded");
  const bC = await collect(bob, "bob collects his round C fill");
  const fc = bC.b.outcome?.receipt?.fills ?? [];
  check(`round C: bob's fill is ${fillC.quantity} Up atoms at 40 with a fee of ${fillC.fee} (computed by the client)`,
    bC.b.outcome?.commandId === buyC.c.id && fc.length === 1 && fc[0].price === 40 && fc[0].quantity === fillC.quantity && fc[0].fee === fillC.fee, fc);
  expectView(bob, bC.b, "round C traded");
  await books("round C traded");

  // 11. Round C's closing price never arrives. One second after voidableAfter (its end + 310 s, the 300 s
  // grace) the registry voids it, and the round starting at C's end was never opened: the keeper voids it
  // too (opening missing). One tick mirrors every void from the registry's record, sweeps round C
  // half-and-half, archives them.
  const beforeVoid = { alice: alice.nonce, bob: bob.nonce };
  await keeperAt(C.voidableAfter + 1, "registry voids round C (opened, no closing price by voidableAfter)", () => K.registry.voidRound(C.registryRoundId, KEEPER_GAS));
  const missed = await voidMissedOpenings("five minutes after round C's end without its closing price");
  const regC = await K.view.getRound(C.registryRoundId);
  check("registry: round C voidable at its end + 310, void at its end + 311, and the round starting at its end voided for a missing opening",
    Number(regC.voidableAfter) === C.end + 310 && Number(regC.resolvedAt) === C.end + 311 && Number(regC.outcome) === 3 && missed.some((m) => m.start === C.end),
    { voidableAfter: Number(regC.voidableAfter), resolvedAt: Number(regC.resolvedAt), missed: missed.map((m) => m.start) });
  const settleC = await send(alice, "alice sync: the tick voids C and the unopened rounds, sweeps C, archives them", { payload: await sync(alice) });
  const archC = settleC.trusted?.archives.find((a) => a.round.id === C.id);
  const archMissed = missed.map((m) => settleC.trusted?.archives.find((a) => a.round.spec.registryRoundId === m.id));
  check("round C: the void is mirrored from the registry's record and archived: void, opened at the fixture price, no closing, nothing left locked",
    archC && archC.round.status === "void" && archC.round.outcome === "void" && archC.round.opening?.price === PRICE_CLOSE && !archC.round.closing &&
    archC.round.locked === 0 && archC.round.upSupply === 0 && archC.round.downSupply === 0 && archC.hash === archiveDigest(archC), archC && { status: archC.round.status, outcome: archC.round.outcome });
  check("the rounds never opened are mirrored as void from the registry's record (opening missing) and archived with no supply",
    archMissed.every((a) => a && a.round.status === "void" && !a.round.opening && a.round.upSupply === 0 && a.round.locked === 0 && a.hash === archiveDigest(a)), archMissed.map((a) => a && { start: a.round.spec.start, status: a.round.status }));
  // Half-and-half: a void pays half a token per share of either side (engine redeem: up/2 + down/2).
  const half = (u) => Math.floor(position(u, C).up / 2) + Math.floor(position(u, C).down / 2);
  const sweptC = { alice: half(alice), bob: half(bob) };
  alice.cash += sweptC.alice;
  bob.cash += sweptC.bob;
  delete alice.positions[C.id];
  delete bob.positions[C.id];
  result.redemptionC = sweptC;
  const aV = await collect(alice, "alice collects after the void");
  const bV = await collect(bob, "bob collects after the void");
  check(`round C settled half-and-half in each account's own name: alice (2 Up, 4 Down) got ${sweptC.alice} atoms, bob (2 Up) got ${sweptC.bob}`,
    aV.b.view?.cash === alice.cash && bV.b.view?.cash === bob.cash && aV.b.view.nonce === beforeVoid.alice + 1 && bV.b.view.nonce === beforeVoid.bob + 1,
    { sweptC, cash: { alice: aV.b.view?.cash, bob: bV.b.view?.cash }, nonces: { alice: aV.b.view?.nonce, bob: bV.b.view?.nonce } });
  expectView(alice, aV.b, "after the void of round C");
  expectView(bob, bV.b, "after the void of round C");

  // Every archive record so far forms the engine's archive hash chain from its initial root.
  const archives = records.slice(0).flatMap((r) => r.trusted?.archives ?? []).sort((a, b) => a.count - b.count);
  const chained = archives.every((a, i) => a.previousRoot === (i === 0 ? sha256("ZEDGE_ARCHIVES_V3") : archives[i - 1].hash) && a.count === i + 1 && a.hash === archiveDigest(a));
  check("archive records: one hash chain from the engine's initial root, each digest recomputed by the client", archives.length >= 3 && chained, archives.map((a) => ({ count: a.count, status: a.round.status, start: a.round.spec.start })));
  result.archived = archives.map((a) => ({ count: a.count, start: a.round.spec.start, status: a.round.status, outcome: a.round.outcome }));
  result.voidedForMissingOpening = { beforeRoundA: earlier.map((m) => m.start), afterRoundCVoid: missed.map((m) => m.start) };

  // 12. Both withdraw and claim: bob everything, alice all but ten tokens (later phases use them).
  for (const [u, keep] of [[bob, 0], [alice, 10 * SHARE]]) {
    const amount = u.cash - keep;
    const wc = command(u, u.nonce + 1, { op: "request_withdrawal", amount, destination: u.account });
    const wr = await send(u, `${u.name} withdraws ${amount} atoms`, { payload: await wc.encrypt() });
    const wb = await receipt(u, wr, wc.id);
    debit(u, BigInt(amount));
    u.cash -= amount;
    const before = await token.balanceOf(u.account);
    const paid = await claim(u, u.account, token.target);
    check(`${u.name}: withdrawal of ${amount} atoms applied, one Withdrawal event, and the claim moved exactly that`,
      wb.status === "applied" && wr.withdrawals.length === 1 && wr.withdrawals[0].amount === BigInt(amount) && paid.moved === BigInt(amount) && (await token.balanceOf(u.account)) === before + BigInt(amount), { amount, paid });
    expectView(u, wb, `${u.name} after withdrawing`);
  }
  await books("after both withdrew and claimed");
  result.engineLedgerAfterRounds = await ledgerDeposit(alice, 1n * UNIT, "deposit alice 1 (engine ledger after the rounds)", [alice, bob]);

  // Measurements of this phase, from its own records.
  result.span = [firstRecord, records.length];
  const mine = records.slice(firstRecord);
  const minutes = (Date.now() - startedAt) / 60_000;
  const userRequests = mine.filter((r) => r.type === PROCESS);
  const ticks = mine.filter((r) => r.trusted);
  const byTick = {};
  for (const x of outcomes) byTick[x.tick] = (byTick[x.tick] ?? 0) + 1;
  result.measurements = {
    wallMinutes: Number(minutes.toFixed(2)),
    requestsPerMinute: Number((userRequests.length / minutes).toFixed(2)),
    transitionsPerMinute: Number(((userRequests.length + ticks.length) / minutes).toFixed(2)),
    ticksPerRequest: { processRequests: userRequests.length, ticks: ticks.length, asking: userRequests.filter((r) => r.ticks.length === 1).length,
      depositOnly: mine.filter((r) => r.label.startsWith("deposit")).length, continuationTicks: ticks.filter((r) => r.trusted.tickRequests > 0).length },
    activationsPerTickObserved: { byTick, max: Math.max(...Object.values(byTick)), ticksWithActivations: Object.keys(byTick).length },
    stagedToActivationMs: stats(staging.map((s) => s.activationMs)),
    submitToActivationMs: stats(staging.map((s) => s.submitToActivationMs)),
    registryRecordsPerTick: stats(ticks.map((r) => r.trusted.payload?.n)),
    trustedPayloadBytes: stats(ticks.map((r) => r.trusted.payload?.bytes)),
    askingTransitionGas: stats(mine.filter((r) => r.trusted).map((r) => r.gasUsed)),
    tickTransitionGas: stats(ticks.map((r) => r.trusted.gasUsed)),
  };
  logSnapshots.push(stackLogs());
  return result;
}

/** README §9's cutoff to the second, on one round: one order staged by a block stamped cutoff - 1 is
 * admitted and rests, the other staged by a block stamped exactly at the cutoff is refused; the
 * checkpoint of the tick at the cutoff releases the first before activating the second. Both are
 * submitted in one block; the endpoint queues them in that block's order, which decides which is which.
 * Their outcomes are collected by the caller. */
async function cutoffStaging({ alice, bob }, A) {
  const c = A.cutoff;
  await quiesce();
  const now = (await provider.getBlock("latest")).timestamp;
  must("cutoff: the chain is still before round A's cutoff", now < c - 2, { now, cutoff: c });
  const orders = [
    { u: bob, cmd: command(bob, bob.nonce + 1, { op: "place_order", roundId: A.id, outcome: "up", side: "buy", price: 30, quantity: 2 * SHARE, tif: "gtc", expiry: c, maxFee: tradeFee(notional(2 * SHARE, 30)) }) },
    { u: alice, cmd: command(alice, alice.nonce + 1, { op: "place_order", roundId: A.id, outcome: "up", side: "sell", price: 70, quantity: 1 * SHARE, tif: "gtc", expiry: c, maxFee: tradeFee(notional(SHARE, 70)) }) },
  ];
  for (const o of orders) o.payload = await o.cmd.encrypt();
  await provider.send("evm_setAutomine", [false]);
  try {
    const t0 = Date.now();
    const pending = [];
    for (const o of orders) {
      pending.push(o.u.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, o.payload, ZERO, 0n, MAX_FEE));
      await until("submission in the pool", async () => Number((await provider.send("txpool_status", [])).pending) >= pending.length, 60_000, 100);
    }
    await mineWhenPending(2); // both submissions in one block, at the chain's own time
    const sent = await Promise.all(pending);
    orders.forEach((o, i) => { o.sent = sent[i]; });
    orders.sort((x, y) => x.sent.transactionReceipt.index - y.sent.transactionReceipt.index);
    const t1 = Date.now();
    // The manager takes the first request, then its tick (the trigger queue goes first), then the second, then its tick.
    orders[0].r = await follow(orders[0].u, `${orders[0].u.name}'s order staged by a block at cutoff - 1`, orders[0].sent, { started: t0, submitted: t1, mine: [c - 1, c] });
    orders[1].r = await follow(orders[1].u, `${orders[1].u.name}'s order staged by a block at the cutoff`, orders[1].sent, { started: t0, submitted: t1, mine: [c, c] });
  } finally {
    await provider.send("evm_setAutomine", [true]);
  }
  for (const o of orders) {
    const b = await receipt(o.u, o.r, o.cmd.id);
    staging.push(staged(o.u, o.cmd, "place_order", o.r));
    check(`cutoff: ${o.u.name}'s order staged in a block stamped ${o.r.timestamp === c ? "exactly at" : "one second before"} the cutoff, and its tick carries that time`,
      b.status === "staged" && o.r.trusted?.status === 0 && o.r.trusted.clocks[0]?.[2] === BigInt(o.r.timestamp), { blockTime: o.r.timestamp, cutoff: c, tick: o.r.ticks[0] });
  }
  check("cutoff: the two staging blocks are stamped cutoff - 1 and exactly the cutoff", orders[0].r.timestamp === c - 1 && orders[1].r.timestamp === c,
    { [orders[0].u.name]: orders[0].r.timestamp, [orders[1].u.name]: orders[1].r.timestamp, cutoff: c });
  return { admitted: orders[0], refused: orders[1] };
}

async function millisecond({ alice }) {
  // Last clock step: Anvil's time cannot go back, so every later tick is refused too.
  const ms = Date.now() + 10_000_000;
  const r = await send(alice, "sync stamped in milliseconds", { payload: await sync(alice), afterSubmit: () => provider.send("evm_setNextBlockTimestamp", [ms]) });
  const judged = (await receipt(alice, r, codec.syncRequestId(alice.account))).at;
  check("millisecond time: the asking block carries a millisecond timestamp", r.timestamp === ms, r.timestamp);
  check("millisecond time: the trusted request is refused and sets no clock", r.trusted?.status === 1 && r.trusted.errorMessage.includes("zedge: malformed trusted payload") && r.trusted.clocks.length === 0, r.trusted?.errorMessage);
  const later = await send(alice, "sync after the refused tick", { payload: await sync(alice) });
  const body = await receipt(alice, later, codec.syncRequestId(alice.account));
  check("millisecond time: the clock stays at the last seconds tick", body.at?.timestamp < 4_294_967_296 && JSON.stringify(body.at) === JSON.stringify(judged), body.at);
  return { tick: r.ticks[0], timestamp: ms, error: r.trusted?.errorMessage };
}

async function killDuringInclusion({ alice }, logSnapshots) {
  // Destructive. The completion event is on chain about a second before the manager sees its own
  // transaction included. A restart in that window: does the manager pick up again?
  await quiesce();
  const w = command(alice, alice.nonce + 1, { op: "request_withdrawal", amount: Number(3n * UNIT), destination: alice.account });
  const sent = await alice.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, await w.encrypt(), ZERO, 0n, MAX_FEE);
  const done = await completion(sent.requestId, sent.transactionReceipt.blockNumber);
  debit(alice, 3n * UNIT);
  const since = new Date().toISOString();
  compose("restart executor manager");
  const restartedAt = Date.now();
  await sleep(30_000);
  const after = compose(`logs --no-color --since ${since} manager`);
  const raced = after.includes("Failed to submit state update for error: error waiting for tx inclusion: context canceled");
  const fatal = after.includes("unrecoverable disalignment between DB and chain");
  const restarts = Number(execFileSync("docker", ["inspect", "vela-skit-manager", "--format", "{{.RestartCount}}"], { encoding: "utf8" }).trim());
  const probe = await alice.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, await sync(alice), ZERO, 0n, MAX_FEE);
  let probeOutcome;
  try {
    const c = await completion(probe.requestId, probe.transactionReceipt.blockNumber, false, 60_000);
    probeOutcome = { completed: true, status: c.status };
  } catch {
    probeOutcome = { completed: false, waitedMs: 60_000 };
  }
  // A claim already credited is paid without the manager.
  const paid = await claim(alice, alice.account, token.target);
  const stuck = await S.endpoint.appCustody(appId, token.target);
  const result = { killedAfterOnChainCompletionMs: restartedAt - done.at, rollbackOfAnIncludedTransaction: raced, managerRefusesToStart: fatal,
    managerRestartCountAfter30s: restarts, probeSync: probeOutcome, creditedClaimStillPaid: paid.moved, appCustodyLeftWithNoExit: stuck,
    managerLines: after.split("\n").filter((l) => /disalignment|State root mismatch|context canceled|Rollback/.test(l)).slice(0, 6)
      .map((l) => (l.match(/"message":"([^"]{0,240})/) ?? [])[1]).filter(Boolean) };
  check("kill during inclusion: recorded (the manager either resumes or refuses to start)", raced ? fatal && !probeOutcome.completed : probeOutcome.completed, result);
  check("kill during inclusion: an already-credited claim is still paid", paid.moved === paid.pending && paid.pending === 3n * UNIT, paid);
  logSnapshots.push(stackLogs());
  return result;
}

async function managerVolumeLost({ alice }, logSnapshots) {
  // Destructive, so last: the manager's database (keyset recovery data, application state) is removed.
  logSnapshots.push(stackLogs());
  const since = new Date().toISOString();
  compose("rm -sf manager");
  execFileSync("docker", ["volume", "rm", `${project()}_vela-skit-manager-data`], { stdio: "ignore" });
  compose("up -d --no-deps manager");
  const t0 = Date.now();
  await sleep(45_000);
  const sent = await alice.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, await sync(alice), ZERO, 0n, MAX_FEE);
  let outcome;
  try {
    const c = await completion(sent.requestId, sent.transactionReceipt.blockNumber, false, 120_000);
    outcome = { completed: true, status: c.status, errorCode: c.errorCode, errorMessage: c.errorMessage };
  } catch (e) {
    outcome = { completed: false, waitedMs: Date.now() - t0, note: String(e.message) };
  }
  const exec = logs("executor"), man = logs("manager");
  const after = compose(`logs --no-color --since ${since} executor manager`);
  const signer = loggedSigner(after);
  const lines = (text) => text.split("\n").filter((l) => /error|Error|ERROR|fail|Fail|keyset|Keyset|mismatch|root/.test(l))
    .slice(-25).map((l) => l.replace(/0x[0-9a-fA-F]{64,}/g, (h) => `<hex:${h.length - 2}>`).slice(0, 400));
  const result = { outcome, executorSignerAfter: signer, signerChanged: signer !== S.teeSigner, newKeysetGenerated: after.includes("generating new keyset"),
    keysetRestored: after.includes("Keyset restored successfully"), linesAfterRemoval: lines(after) };
  check("manager volume removed: processing does not continue from a wrong state", !outcome.completed || outcome.status !== 0, outcome);
  logSnapshots.push(exec + "\n" + man);
  return result;
}

// ---------------------------------------------------------------- leak scan and timings from the logs

// The executor sends its log lines to the manager's log server, so after start-up they appear in the
// manager container's output. Every snapshot is both containers' output; lines are de-duplicated.
function entries(snapshots) {
  const seen = new Set();
  const out = [];
  for (const line of snapshots.join("\n").split("\n")) {
    const i = line.indexOf('{"level"');
    if (i < 0 || seen.has(line.slice(i))) continue;
    seen.add(line.slice(i));
    try {
      const j = JSON.parse(line.slice(i));
      const m = j.time.match(/(\d{4})-(\w{3})-(\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/);
      out.push({ level: j.level, caller: j.caller.replace(/^\/(build|app)\//, ""), message: j.message, at: Date.parse(`${m[3]} ${m[2]} ${m[1]} ${m[4]} UTC`) });
    } catch { /* not a JSON log line */ }
  }
  return out;
}

/** What the host's logs hold in clear. Stores counts, source locations and field names only, no log text. */
function leakScan(snapshots, users) {
  const log = entries(snapshots);
  const where = (xs) => [...new Set(xs.map((e) => `${e.caller} (${e.level})`))];
  const b64 = (s) => Buffer.from(s, "base64").toString("utf8");
  const raw = log.filter((e) => e.message.startsWith(RAW_DEPOSIT));
  const salts = new Set(), stateFields = new Set(), receiptFields = new Set();
  let states = 0, receipts = 0, recipients = 0, amounts = 0;
  for (const e of raw) {
    const r = JSON.parse(e.message.slice(e.message.indexOf("{")));
    if (r.state) {
      const st = JSON.parse(b64(r.state));
      states++;
      Object.keys(st).forEach((k) => stateFields.add(k));
      if (st.salt) salts.add(st.salt);
    }
    for (const ev of r.events ?? []) {
      if (ev.userId) recipients++;
      const pt = JSON.parse(b64(ev.data));
      receipts++;
      Object.keys(pt.body ?? {}).forEach((k) => receiptFields.add(`body.${k}`));
      if (pt.body?.receipt?.amount) amounts++;
    }
  }
  const text = log.map((e) => e.message).join("\n");
  // Any other long base64 in any message, decoded and searched for guest plaintext.
  const others = log.filter((e) => !raw.includes(e)).flatMap((e) => (e.message.match(/[A-Za-z0-9+/]{80,}={0,2}/g) ?? []).map((m) => ({ e, d: b64(m) })));
  const markers = ['"salt"', '"engine"', '"kind":"command"', '"kind":"receipt"', "request_withdrawal", "place_order"];
  const hidden = Object.fromEntries(markers.map((k) => [k, where(others.filter((o) => o.d.includes(k)).map((o) => o.e))]).filter(([, v]) => v.length));
  const plain = Object.fromEntries(markers.map((k) => [k, where(log.filter((e) => !raw.includes(e) && e.message.includes(k)))]).filter(([, v]) => v.length));
  const named = (needle) => where(log.filter((e) => e.message.toLowerCase().includes(needle)));
  return {
    rawDepositResult: {
      lines: raw.length, at: where(raw), statesInClear: states, stateFields: [...stateFields],
      distinctSaltsInClear: salts.size, receiptPlaintextsInClear: receipts, receiptFields: [...receiptFields],
      receiptsWithAmount: amounts, recipientIdsInClear: recipients,
    },
    depositTokenAndValue: where(log.filter((e) => /Processing deposit for application .*token: 0x[0-9a-fA-F]{40}/.test(e.message))),
    depositSender: where(log.filter((e) => /deposit for sender 0x[0-9a-fA-F]{40}/.test(e.message))),
    stateSizeEveryRequest: where(log.filter((e) => /state size: \d+/.test(e.message))),
    payloadSizeEveryRequest: where(log.filter((e) => /payload size: \d+/.test(e.message))),
    guestPlaintextElsewhere: plain, guestPlaintextInOtherBase64: hidden,
    userAddresses: Object.fromEntries(users.map((u) => [u.name, named(u.account.slice(2))])),
    userWalletKeysInLogs: users.filter((u) => text.toLowerCase().includes(u.wallet.privateKey.slice(2).toLowerCase())).length,
    salt: salts.size ? [...salts][0] : undefined,
  };
}

/** Executor and manager time per request, from the log timestamps (millisecond resolution), and the guest
 * state size the host logged for each PROCESS request (the state as that request found it). */
function timings(snapshots) {
  const log = entries(snapshots);
  const id = (m) => (m.match(/[0-9a-f]{64}/) ?? [])[0];
  const type = {}, start = {}, end = {}, mStart = {}, mEnd = {}, size = {};
  const polls = [], stateBytes = [];
  let current;
  for (const e of log) {
    const m = e.message;
    const s = m.match(/state size: (\d+)/);
    if (s) {
      stateBytes.push(Number(s[1]));
      if (current) size[current] ??= Number(s[1]);
    }
    if (m.startsWith("Processing Process app request: ")) type[id(m)] = m.match(/\(type: (\w+)\)/)?.[1];
    if (m.startsWith("Processing deploy app request: ")) type[id(m)] = "deploy";
    if (m.startsWith("Executor: Processing request ") || m.startsWith("Executor: Deploying application for request ")) { start[id(m)] ??= e.at; current = id(m); }
    if ((e.caller.endsWith("executor.go:849") && m.startsWith("Executor: Successfully processed request ")) || m.startsWith("Executor: Returning signed error payload for request ")) end[id(m)] ??= e.at;
    if (m.startsWith("Executor: Successfully deployed application")) end[Object.keys(type).findLast((k) => type[k] === "deploy")] ??= e.at;
    if (m.startsWith("Manager: processing request ")) { mStart[id(m)] ??= e.at; polls.push(e.at); }
    if (m.startsWith("Manager: Processed request ") && !m.includes(" for application ")) mEnd[id(m)] ??= e.at;
  }
  const byType = {};
  for (const k of Object.keys(start)) (byType[type[k] ?? "unknown"] ??= []).push(end[k] - start[k]);
  const gaps = polls.slice(1).map((t, i) => t - polls[i]).filter((g) => g < 60_000);
  const perRequest = Object.fromEntries(Object.keys(start).map((k) => [k, { type: type[k], executorMs: end[k] - start[k], stateBytes: size[k] }]));
  return {
    executorMsPerRequest: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, stats(v)])),
    managerMsPerRequest: stats(Object.keys(mStart).map((k) => mEnd[k] - mStart[k])),
    managerStartGapMs: stats(gaps),
    // The guest state size the host logs for each request: what the per-request times above were taken on.
    stateBytesLogged: stats(stateBytes),
    perRequest,
  };
}

async function all() {
  S = await stack();
  const operator = throwaway();
  await fund(operator.address);
  const logSnapshots = [];
  const deployment = await deployEverything(operator);
  console.log(`      application ${deployment.applicationId} deployed in ${deployment.deployMs} ms`);
  const people = await lifecycle();
  const recon1 = await reconcile("after lifecycle");
  // Restarts first: Anvil does not keep an evm_increaseTime offset across compose down/up, so after the
  // clock tests or the rounds its block time would go backwards and the guest would rightly refuse every tick.
  const restartResult = await restart(people, logSnapshots);
  const roundResult = await rounds(people, logSnapshots);
  const recon2 = await reconcile("after the rounds");
  const clockResult = await clock(people);
  const burstResult = await burst(people);
  const ledger = await ledgerDeposit(people.alice, 1n * UNIT, "deposit alice 1 (engine ledger probe)");
  const msResult = await millisecond(people);
  const recon3 = await reconcile("after restarts and clock tests");
  logSnapshots.push(stackLogs());
  const killed = await killDuringInclusion(people, logSnapshots);
  const lost = await managerVolumeLost(people, logSnapshots);
  const recon4 = await reconcile("at the end, after the destructive phases");
  const scan = leakScan(logSnapshots, [people.alice, people.bob, people.carol, people.dave]);
  const raw = scan.rawDepositResult;
  check("leak scan: v0.2.0 logs every deposit result at INFO: the whole guest state, salt included, and the receipt plaintext (expected)",
    raw.lines > 0 && raw.statesInClear > 0 && raw.stateFields.includes("salt") && raw.receiptPlaintextsInClear > 0, raw);
  check("leak scan: no command or receipt plaintext outside the raw deposit result", Object.keys(scan.guestPlaintextElsewhere).length === 0 && Object.keys(scan.guestPlaintextInOtherBase64).length === 0,
    { plain: scan.guestPlaintextElsewhere, base64: scan.guestPlaintextInOtherBase64 });
  check("leak scan: no user wallet key in any log", scan.userWalletKeysInLogs === 0);
  delete scan.salt; // the value itself is not kept in the evidence
  const timing = timings(logSnapshots);
  // State size per step: each PROCESS request's input state, as the host logged it; and the executor's time
  // for every request and tick of the rounds phase.
  for (const r of records) {
    const t = timing.perRequest[r.requestId?.slice(2)];
    if (t) Object.assign(r, { executorMs: t.executorMs, stateBytesIn: t.stateBytes });
    const tt = r.trusted && timing.perRequest[r.trusted.requestId.slice(2)];
    if (tt) r.trusted.executorMs = tt.executorMs;
  }
  const roundSteps = records.slice(...roundResult.span);
  roundResult.measurements.statePerStep = roundSteps.map((r) => ({ step: r.label, stateBytesIn: r.stateBytesIn, executorMs: r.executorMs, tickExecutorMs: r.trusted?.executorMs, registryRecords: r.trusted?.payload?.n }));
  roundResult.measurements.tickExecutorMs = stats(roundSteps.map((r) => r.trusted?.executorMs));
  roundResult.measurements.requestExecutorMs = stats(roundSteps.map((r) => r.executorMs));
  roundResult.measurements.stateBytesIn = stats(roundSteps.map((r) => r.stateBytesIn));
  delete timing.perRequest;
  const lat = (f) => records.filter(f).map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const requestLatency = lat((r) => r.latencyMs !== undefined);
  const trustedLatency = records.map((r) => r.trusted?.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const measurements = {
    deployMs: deployment.deployMs,
    requestLatencyMs: { n: requestLatency.length, min: requestLatency[0], median: requestLatency[requestLatency.length >> 1], max: requestLatency.at(-1) },
    trustedAfterRequestMs: { n: trustedLatency.length, min: trustedLatency[0], median: trustedLatency[trustedLatency.length >> 1], max: trustedLatency.at(-1) },
    executor: timing, burst: burstResult, restart: restartResult, rounds: roundResult.measurements,
  };
  write("slice.json", { deployment, reconciliation: [recon1, recon2, recon3, recon4], engineLedger: ledger, rounds: roundResult, outcomes, staging, clock: clockResult, millisecond: msResult,
    killDuringInclusion: killed, managerVolumeRemoved: lost, measurements, requests: records.map(({ ciphertexts, ...r }) => r), checks });
  write("leak-scan.json", { note: "What the executor and manager logs of this run hold in clear: counts, source locations and field names only; no log text or value is stored.", scan });
  console.log(`      rounds measurements: ${JSON.stringify(roundResult.measurements && { requestsPerMinute: roundResult.measurements.requestsPerMinute, transitionsPerMinute: roundResult.measurements.transitionsPerMinute, stagedToActivationMs: roundResult.measurements.stagedToActivationMs, tickExecutorMs: roundResult.measurements.tickExecutorMs, stateBytesIn: roundResult.measurements.stateBytesIn }, big)}`);
  return { measurements };
}

const phase = process.argv[2];
try {
  if (phase === "manifest") await manifest();
  else if (phase === "all") await all();
  else throw new Error("usage: slice.mjs manifest|all");
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
  console.error(e.stack);
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${EVALUATION}\n${phase}: ${checks.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
