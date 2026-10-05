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

export const EVALUATION = "EVALUATION ONLY: local Vela v0.2.0 stack on chain 31337. Software TEE with fixed " +
  "development keys and no attestation; a worthless 6-decimal test token; an unsigned fixture oracle; sender, " +
  "amount and time are trusted from the manager. Not private, not secure, not production-ready.";
const EVIDENCE = new URL("evidence/vela-slice-2026-10-05/", repo);
const RPC = "http://127.0.0.1:8545";
const AUTHORITY = "http://127.0.0.1:8081";
const WASM = new URL("../guest/build/zedge_guest.wasm", here);
const ORIGIN = "http://localhost:5173";
const EPOCH = "1";
const MAX_FEE = 1000n; // wei; the executor charges its minimum and refunds the rest
const UNIT = 1_000_000n; // one token at 6 decimals
const CIPHERTEXT_BYTES = 2076; // a 2,048-byte receipt plus the P-521/AES-GCM envelope
const ZERO = ethers.ZeroAddress;
const PROCESS = 1, ASSOCIATEKEY = 3;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const SUB = {
  receipt: "0x" + sha256("zedge.vela.receipt.v1"),
  tick: "0x" + sha256("zedge.vela.tick.v1"),
  clock: "0x" + sha256("zedge.vela.clock.v1"),
};
// The engine's fixed values (engine/oracle.go, engine/types.go). A mismatch fails the deploy loudly.
const ENGINE_VERSION = 3;
const RULES_VERSION = "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half";
const BTC_FEED = "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const ETH_FEED = "0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9";
const ORACLE_POLICY = { decimals: 18, observationWindow: 10, openingGrace: 20, voidGrace: 86400, cutoffBuffer: 5 };

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

async function roleHolders(address, abi) {
  const c = new ethers.Contract(address, abi, provider);
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
  check("manifest: on-chain enclave key equals the executor's logged communication key", m.tee.enclaveP521OnChain === m.tee.enclaveP521InExecutorLog);
  const vela = Object.values(images).filter((i) => i.image.startsWith("horizen/cce-"));
  check("manifest: the Vela images are v0.2.0 linux/amd64 (emulated on this host)", vela.length >= 4 && vela.every((i) => i.architecture === "amd64" && i.image.endsWith(":v0.2.0")), vela.map((i) => i.image));
  return m;
}

// ---------------------------------------------------------------- the slice

const records = []; // every request, in order
// What this slice asks to be credited to and paid out of app custody, in the collateral token, added
// where it asks. The reconciliation compares the chain with these totals, so a withdrawal nobody asked
// for (in a tick, a burst or to the trigger) shows even though the endpoint's own books still balance.
const expected = { credited: 0n, withdrawn: 0n };
let lastRequest; // the last request this client saw completed
let S, appId, trigger, token, wrongToken, domain, epoch, engineDomain, admin;

const artifact = (url) => {
  const a = JSON.parse(readFileSync(url, "utf8"));
  const bytecode = a.bytecode.object ?? a.bytecode;
  if (bytecode.includes("__$")) throw new Error(`${url} has unlinked libraries`);
  return { abi: a.abi, bytecode };
};
async function deploy(signer, url, ...args) {
  const { abi, bytecode } = artifact(url);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return new ethers.Contract(lower(await c.getAddress()), abi, signer);
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
  return { name, wallet, account, session, client, notices: 0, nonce: 0 };
}

function parseLogs(receipt) {
  return receipt.logs.filter((l) => lower(l.address) === S.endpointAddress).map((l) => {
    const p = iface.parseLog(l);
    return { name: p.name, args: p.args, log: l };
  });
}
async function completion(requestId, fromBlock, deployEvent = false, timeoutMs = 240_000) {
  const filter = deployEvent ? S.endpoint.filters.DeployRequestCompleted(null, requestId) : S.endpoint.filters.RequestCompleted(null, requestId);
  const e = await until(`completion of ${requestId}`, async () => (await S.endpoint.queryFilter(filter, fromBlock)).at(0), timeoutMs);
  const block = await provider.getBlock(e.blockNumber);
  return { status: Number(e.args.status), errorCode: Number(e.args.errorCode), errorMessage: e.args.errorMessage, fee: e.args.applicationFees,
    block: e.blockNumber, timestamp: block.timestamp, txHash: e.transactionHash, at: Date.now(), events: parseLogs(await provider.getTransactionReceipt(e.transactionHash)) };
}

/** Submits one request through the SDK and follows it to completion, and its trusted follow-up if any. */
async function send(u, label, { type = PROCESS, payload = new Uint8Array(), tokenAddress = ZERO, amount = 0n, afterSubmit } = {}) {
  const started = Date.now();
  const r = await u.client.submitRequestAndWaitForRequestId(0, appId, type, payload, tokenAddress, amount, MAX_FEE);
  const submitted = Date.now();
  if (afterSubmit) await afterSubmit();
  const done = await completion(r.requestId, r.transactionReceipt.blockNumber);
  const ticks = done.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.tick).map((e) => BigInt(e.args.data));
  const spawned = done.events.filter((e) => e.name === "RequestSubmitted" && lower(e.args.sender) === trigger);
  let trusted;
  if (spawned.length) {
    const t = await completion(spawned[0].args.requestId, done.block);
    const clocks = t.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.clock).map((e) => ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256"], e.args.data).map(BigInt));
    trusted = { requestId: spawned[0].args.requestId, status: t.status, errorMessage: t.errorMessage, block: t.block, timestamp: t.timestamp,
      latencyMs: t.at - done.at, clocks, spawned: t.events.filter((e) => e.name === "RequestSubmitted").length,
      tickRequests: t.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.tick).length, userEvents: t.events.filter((e) => e.name === "UserEvent").length };
  }
  const userEvents = done.events.filter((e) => e.name === "UserEvent");
  const record = {
    label, sender: u.name, requestId: r.requestId, type, token: lower(tokenAddress), amount,
    submitBlock: r.transactionReceipt.blockNumber, block: done.block, timestamp: done.timestamp,
    status: done.status === 0 ? "COMPLETED" : "FAILED", errorCode: done.errorCode, errorMessage: done.errorMessage, fee: done.fee,
    latencyMs: done.at - submitted, submitMs: submitted - started,
    userEvents: userEvents.map((e) => ({ subtype: e.args.eventSubType, bytes: ethers.dataLength(e.args.encryptedData) })),
    ticks, spawned: spawned.length, trusted,
    refunds: done.events.filter((e) => e.name === "Refund").map((e) => ({ to: lower(e.args.to), token: lower(e.args.tokenAddress), amount: e.args.amount })),
    withdrawals: done.events.filter((e) => e.name === "Withdrawal").map((e) => ({ to: lower(e.args.to), token: lower(e.args.tokenAddress), amount: e.args.amount })),
  };
  records.push(record);
  lastRequest = trusted?.requestId ?? r.requestId;
  console.log(`      ${label}: ${record.status}${record.errorMessage ? ` (${record.errorMessage})` : ""} in ${record.latencyMs} ms` +
    (trusted ? `; tick ${ticks[0]} ${trusted.status === 0 ? "applied" : `FAILED (${trusted.errorMessage})`} ${trusted.latencyMs} ms later` : ""));
  return { ...record, ciphertexts: userEvents.map((e) => ethers.getBytes(e.args.encryptedData)) };
}

async function receipt(u, req, requestId) {
  if (req.ciphertexts.length !== 1) return { error: `expected one receipt, got ${req.ciphertexts.length}` };
  const r = await u.session.decryptReceipt(req.ciphertexts[0], requestId);
  return r.status === "readable" ? { ...r.envelope.body, pad: `${r.envelope.body.pad.length} zeros` } : { error: r.status };
}

const sync = (u) => u.session.encryptCommand(codec.syncRequestId(u.account), codec.syncBody());
function command(u, nonce, fields) {
  const c = { domain: engineDomain, id: codec.commandId(u.account, nonce), nonce, account: u.account, ...fields };
  return { id: c.id, plaintext: c, encrypt: () => u.session.encryptCommand(c.id, codec.commandBody(c)) };
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

async function deployEverything(operator) {
  const findAdmin = await roleHolders(S.endpointAddress, ENDPOINT_ABI);
  admin = findAdmin.DEPLOYER_ROLE?.[0];
  const allowAdmin = (await roleHolders(S.allowlistAddress, ALLOWLIST_ABI)).ADMIN?.[0];
  must("stack: endpoint has a deployer and the allowlist an admin", admin && allowAdmin && admin === allowAdmin, { admin, allowAdmin });

  const out = new URL("contracts/build/out/", here);
  token = await deploy(operator, new URL("EvaluationToken.sol/EvaluationToken.json", out));
  wrongToken = await deploy(operator, new URL("EvaluationToken.sol/EvaluationToken.json", out));
  const triggerContract = await deploy(operator, new URL("EvaluationClockTrigger.sol/EvaluationClockTrigger.json", out), S.endpointAddress);
  trigger = lower(await triggerContract.getAddress());
  const tokenAddress = lower(await token.getAddress());
  check("contracts: test token has 6 decimals", Number(await token.decimals()) === 6);
  check("contracts: trigger answers only this endpoint", lower(await triggerContract.processorEndpoint()) === S.endpointAddress);

  // Round registry behind its proxy, with the unsigned fixture oracle, from contracts/out (read-only).
  const cout = new URL("contracts/out/", repo);
  const oracle = await deploy(operator, new URL("MockStreamsBoundaryOracle.sol/MockStreamsBoundaryOracle.json", cout));
  await (await oracle.configure(BTC_FEED, ETH_FEED, 18, 18, ORACLE_POLICY.observationWindow, 31337)).wait();
  const impl = await deploy(operator, new URL("StreamsRoundRegistry.sol/StreamsRoundRegistry.json", cout));
  const config = [await oracle.getAddress(), tokenAddress, BTC_FEED, ETH_FEED, 18, 18, ORACLE_POLICY.observationWindow, ORACLE_POLICY.openingGrace, ORACLE_POLICY.voidGrace, ORACLE_POLICY.cutoffBuffer];
  const setup = impl.interface.encodeFunctionData("initialize", [config, operator.address]);
  const proxy = await deploy(operator, new URL("ERC1967Proxy.sol/ERC1967Proxy.json", cout), await impl.getAddress(), setup);
  const registry = new ethers.Contract(await proxy.getAddress(), impl.interface, provider);
  const implSlot = await provider.getStorage(await proxy.getAddress(), "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  check("registry: proxy points at the implementation", lower(ethers.getAddress("0x" + implSlot.slice(26))) === lower(await impl.getAddress()));
  check("registry: fixture oracle is labelled insecure", (await oracle.version()) === "insecure-streams-test-fixture");
  const rulesHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "uint256", "tuple(address,address,bytes32,bytes32,uint8,uint8,uint32,uint32,uint32,uint32)"], [RULES_VERSION, 31337, config]));
  check("registry: on-chain rules hash equals the engine's computation", (await registry.rulesHash()) === rulesHash, rulesHash);

  // The admin allow-lists both test tokens, impersonated on the local chain.
  await provider.send("anvil_impersonateAccount", [admin]);
  const adminSigner = await provider.getSigner(admin);
  const allow = S.allowlist.connect(adminSigner);
  for (const t of [token, wrongToken]) await (await allow.addAllowedToken(await t.getAddress())).wait();
  check("allowlist: both test tokens allowed", (await S.allowlist.getAllowedTokens()).map(lower).includes(tokenAddress));

  // Constructor parameters: canonical JSON in the Go field order the guest re-encodes and compares.
  const engineConfig = (applicationId) => ({
    domain: { chainId: 31337, endpoint: S.endpointAddress, applicationId, rulesVersion: ENGINE_VERSION },
    authority: trigger, collateral: tokenAddress, feeBps: 100,
    oracle: { chainId: 31337, registry: lower(registry.target), oracle: lower(oracle.target), rulesHash,
      btcFeedId: BTC_FEED, ethFeedId: ETH_FEED, ...ORACLE_POLICY },
  });
  const wasm = readFileSync(WASM);
  const fingerprint = sha256(wasm);
  const params = JSON.stringify({ engine: engineConfig(""), applicationFingerprint: fingerprint, origin: ORIGIN, epoch: EPOCH });
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
  check("deploy: descriptor carries the constructor parameters verbatim", descriptorText.includes(`"constructorParams":${params}`));

  epoch = { id: EPOCH, enclavePublicKey: S.enclaveKey };
  engineDomain = { chainId: 31337, endpoint: S.endpointAddress, applicationId: appId.toString(), rulesVersion: ENGINE_VERSION };
  domain = { chainId: 31337, endpoint: S.endpointAddress, applicationId: appId.toString(), applicationFingerprint: fingerprint,
    rulesHash: sha256(JSON.stringify(engineConfig(appId.toString()))), origin: ORIGIN };
  return { applicationId: appId.toString(), deployRequestId: sent.requestId, deployBlock: done.block, deployMs, deployFeeWei: done.fee,
    token: tokenAddress, wrongToken: lower(await wrongToken.getAddress()), trigger, registry: lower(registry.target), registryImplementation: lower(await impl.getAddress()),
    oracle: lower(oracle.target), rulesHash, admin, wasmSha256: fingerprint, constructorParams: JSON.parse(params), envelopeDomain: domain };
}

// ---------------------------------------------------------------- end-of-run reconciliation, from chain logs only

async function reconcile(label) {
  const all = (await provider.getLogs({ address: S.endpointAddress, fromBlock: 0, toBlock: "latest" }))
    .map((l) => ({ ...iface.parseLog(l), log: l })).filter((e) => e.name);
  const mine = all.filter((e) => e.args.applicationId === undefined || e.args.applicationId === appId);
  const tokenAddress = lower(token.target);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
  const of = (name) => mine.filter((e) => e.name === name);
  const submittedDeposits = sum(records.filter((r) => r.token === tokenAddress).map((r) => r.amount));
  const refunded = sum(of("Refund").filter((e) => lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
  const withdrawn = sum(of("Withdrawal").filter((e) => lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
  const returned = sum(of("TriggerWithdraw").flatMap((e) => e.args.returnedTokens).filter((t) => lower(t.token) === tokenAddress).map((t) => t.amount));
  const claimed = sum(all.filter((e) => e.name === "PaymentWithdrawn" && lower(e.args.tokenAddress) === tokenAddress).map((e) => e.args.amount));
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
  const roots = of("StateRootUpdate");
  const broken = roots.slice(1).filter((e, i) => e.args.oldStateRoot !== roots[i].args.newStateRoot).length;
  check(`${label}: state roots form one chain from the deploy root (the endpoint enforces it; this checks the log reading)`, broken === 0 && roots[0].args.oldStateRoot === ethers.ZeroHash && (await S.endpoint.applicationStateRoots(appId)) === roots.at(-1).args.newStateRoot, { transitions: roots.length, broken });

  // Every tick request is answered by exactly one trusted request in the same transaction, and every
  // applied clock record is the asking block's number and time.
  const byTx = (h) => mine.filter((e) => e.log.transactionHash === h);
  const tickEvents = of("AppEvent").filter((e) => e.args.eventSubType === SUB.tick);
  const lostOnPurpose = new Set(records.filter((r) => r.lostOnPurpose).map((r) => r.ticks[0]));
  const answers = tickEvents.map((e) => ({ tick: BigInt(e.args.data), trusted: byTx(e.log.transactionHash).filter((x) => x.name === "RequestSubmitted" && lower(x.args.sender) === trigger).length }));
  check(`${label}: every tick request gets exactly one trusted request (except ticks lost on purpose)`,
    answers.every((a) => a.trusted === (lostOnPurpose.has(a.tick) ? 0 : 1)), { tickRequests: answers.length, lostOnPurpose: [...lostOnPurpose] });
  const clocks = of("AppEvent").filter((e) => e.args.eventSubType === SUB.clock);
  const wrong = [];
  for (const c of clocks) {
    const [k, number, time] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256"], c.args.data).map(BigInt);
    const asking = tickEvents.find((t) => BigInt(t.args.data) === k);
    const block = asking && await provider.getBlock(asking.log.blockNumber);
    if (!block || BigInt(block.number) !== number || BigInt(block.timestamp) !== time) wrong.push({ k, number, time, asking: block && { number: block.number, timestamp: block.timestamp } });
    if (byTx(c.log.transactionHash).some((x) => (x.name === "AppEvent" && x.args.eventSubType === SUB.tick) || (x.name === "RequestSubmitted" && lower(x.args.sender) === trigger))) wrong.push({ k, loop: true });
  }
  check(`${label}: every clock record equals the asking block's number and timestamp, and asks for no tick`, clocks.length > 0 && wrong.length === 0, { clockRecords: clocks.length, wrong });
  const failedOrFree = records.filter((r) => r.status === "FAILED" || r.type === ASSOCIATEKEY || r.label.startsWith("deposit"));
  check(`${label}: failed, key and deposit-only requests ask for no tick`, failedOrFree.every((r) => r.ticks.length === 0 && r.spawned === 0), failedOrFree.length);
  return { label, ...out, others, receipts: userEvents.length, transitions: roots.length, tickRequests: answers.length, clockRecords: clocks.length };
}

const RAW_DEPOSIT = "Wasmtime Runtime: Raw deposit result from WASM: ";
const rawDeposits = () => entries([stackLogs()]).filter((e) => e.message.startsWith(RAW_DEPOSIT));

/** The engine's own ledger against the chain. v0.2.0 shows it in one place only: the executor logs every
 * deposit result with the whole state in clear (the leak scan's finding). Failed deposits are logged too,
 * so only the state of a deposit-only request that completed, with nothing after it, is the committed one. */
async function engineLedger({ alice }) {
  const before = rawDeposits().length;
  const amount = 1n * UNIT;
  const probe = await deposit(alice, amount, "deposit alice 1 (engine ledger probe)");
  expected.credited += amount;
  alice.notices++;
  const body = await receipt(alice, probe, codec.noticeRequestId(alice.account, alice.notices));
  const logged = await until("the probe's logged deposit result", () => rawDeposits().slice(before).at(-1), 30_000, 1000);
  const state = JSON.parse(Buffer.from(JSON.parse(logged.message.slice(logged.message.indexOf("{"))).state, "base64").toString("utf8"));
  const tokenAddress = lower(token.target);
  const withdrawals = (await S.endpoint.queryFilter(S.endpoint.filters.Withdrawal(appId), 0)).filter((e) => lower(e.args.tokenAddress) === tokenAddress);
  const ledger = {
    depositOrdinal: { logged: state.deposits, receipt: body.deposit },
    custody: { engine: BigInt(state.engine.custody), app: await S.endpoint.appCustody(appId, tokenAddress) },
    paidOut: { engine: BigInt(state.engine.paidOut), withdrawalEvents: withdrawals.reduce((a, e) => a + e.args.amount, 0n) },
    deposited: { engine: BigInt(state.engine.deposited), creditedBySlice: expected.credited },
    claimable: BigInt(state.engine.claimable),
  };
  check("engine ledger: the probe deposit is credited and the logged state is its own (same ordinal)", probe.status === "COMPLETED" && body.status === "credited" &&
    BigInt(body.receipt?.amount ?? 0) === amount && state.deposits === body.deposit, ledger.depositOrdinal);
  check("engine ledger: engine custody = app custody, paidOut = Withdrawal events, deposited = deposits credited, claimable = 0, exactly",
    ledger.custody.engine === ledger.custody.app && ledger.paidOut.engine === ledger.paidOut.withdrawalEvents && ledger.deposited.engine === ledger.deposited.creditedBySlice && ledger.claimable === 0n, ledger);
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
  check("first sync: one 2,076-byte receipt, judged at clock 0", first.status === "COMPLETED" && firstBody.type === "sync" && firstBody.status === "requested" && firstBody.at?.tick === 0 && first.userEvents[0]?.bytes === CIPHERTEXT_BYTES, firstBody);
  check("first sync: asks for tick 1 and the trusted request sets the clock", first.ticks[0] === 1n && first.trusted?.status === 0 && first.trusted.clocks[0]?.[0] === 1n, first.trusted);

  // Deposit, receipt, withdrawal request, claim.
  const amount = 100n * UNIT;
  const dep = await deposit(alice, amount, "deposit alice 100");
  expected.credited += amount;
  alice.notices++;
  const depBody = await receipt(alice, dep, codec.noticeRequestId(alice.account, alice.notices));
  check("deposit: COMPLETED with one receipt and no tick", dep.status === "COMPLETED" && dep.userEvents.length === 1 && dep.ticks.length === 0, dep.errorMessage);
  check("deposit: receipt decrypts to the credited amount and registers the account", depBody.type === "deposit" && depBody.status === "credited" && BigInt(depBody.receipt?.amount ?? 0) === amount && depBody.registered === true && depBody.deposit === 1, depBody);
  alice.nonce = 1;
  const w = command(alice, ++alice.nonce, { op: "request_withdrawal", amount: Number(40n * UNIT), destination: alice.account });
  const wd = await send(alice, "alice withdraw 40", { payload: await w.encrypt() });
  expected.withdrawn += 40n * UNIT;
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
  expected.credited += 25n * UNIT;
  bob.notices++;
  check("bob: deposit receipt decrypts", (await receipt(bob, bdep, codec.noticeRequestId(bob.account, 1))).status === "credited");
  const outside = lower(throwaway().address);
  bob.nonce = 1;
  const bw = command(bob, ++bob.nonce, { op: "request_withdrawal", amount: Number(10n * UNIT), destination: outside });
  const bwd = await send(bob, "bob withdraw 10 to a third address", { payload: await bw.encrypt() });
  expected.withdrawn += 10n * UNIT;
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
  const big = await sdk.encrypt(raw.privateKey, enclave, new Uint8Array(16_385).fill(0x7b));
  const over = await send(dave, "oversized payload (16,385 bytes)", { payload: big });
  check("oversized payload: FAILED with the public envelope error, no receipt, no tick", over.status === "FAILED" && over.errorMessage.includes("zedge: malformed envelope") && over.userEvents.length === 0 && over.ticks.length === 0, over.errorMessage);
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
  return { exact: { tick: exact.ticks[0], block: exact.block, timestamp: target }, lostTick: lost.ticks[0], replacedBy: next.ticks[0] };
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
      ticks: c.events.filter((e) => e.name === "AppEvent" && e.args.eventSubType === SUB.tick).map((e) => BigInt(e.args.data)), spawned: spawned ? 1 : 0, userEvents: [] });
  }
  const end = Math.max(...done.map((d) => d.end));
  const transitions = 2 * n;
  const result = { requests: n, transitions, submitMs: submitted - started, wallMs: end - started, transitionsPerMinute: Math.round((transitions * 60_000) / (end - started)) };
  check("burst: all requests and their ticks COMPLETED", done.every((d) => d.request === 0 && d.trusted === 0), result);
  return result;
}

async function restart({ alice }, logSnapshots) {
  const lastRoot = await S.endpoint.applicationStateRoots(appId);
  await quiesce();
  const restored = count(stackLogs(), "Keyset restored successfully");
  const t0 = Date.now();
  compose("restart executor manager");
  await until("keyset restored after restart", () => count(stackLogs(), "Keyset restored successfully") > restored, 300_000, 1000);
  const restartMs = Date.now() - t0;
  check("restart: executor restored the keyset with the same signer", loggedSigner(stackLogs()) === S.teeSigner, restartMs);
  check("restart: on-chain root unchanged by the restart", (await S.endpoint.applicationStateRoots(appId)) === lastRoot);
  const a = await send(alice, "sync after executor+manager restart", { payload: await sync(alice) });
  check("restart: a sync and its tick complete after the restart", a.status === "COMPLETED" && a.trusted?.status === 0);
  // Root continuity is enforced by the endpoint (previous root) and the executor (state hash = root). What
  // shows the ledger was not rolled back is the next nonce being accepted: the engine takes only previous + 1.
  const w = command(alice, ++alice.nonce, { op: "request_withdrawal", amount: Number(5n * UNIT), destination: alice.account });
  const wd = await send(alice, "withdraw 5 after restart", { payload: await w.encrypt() });
  expected.withdrawn += 5n * UNIT;
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
  const w2 = command(alice, ++alice.nonce, { op: "request_withdrawal", amount: Number(5n * UNIT), destination: alice.account });
  const wd2 = await send(alice, "withdraw 5 after down/up", { payload: await w2.encrypt() });
  expected.withdrawn += 5n * UNIT;
  check("down/up: the tick and alice's next-nonce withdrawal are applied (the ledger was not rolled back)", b.trusted?.status === 0 && (await receipt(alice, wd2, w2.id)).status === "applied");
  const paid = await claim(alice, alice.account, token.target);
  check("down/up: claim pays both post-restart withdrawals", paid.moved === 10n * UNIT, paid);
  return { restartMs, downUpMs: upMs, continued: true };
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
  const w = command(alice, ++alice.nonce, { op: "request_withdrawal", amount: Number(3n * UNIT), destination: alice.account });
  const sent = await alice.client.submitRequestAndWaitForRequestId(0, appId, PROCESS, await w.encrypt(), ZERO, 0n, MAX_FEE);
  const done = await completion(sent.requestId, sent.transactionReceipt.blockNumber);
  expected.withdrawn += 3n * UNIT;
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
  const markers = ['"salt"', '"engine"', '"kind":"command"', '"kind":"receipt"', "request_withdrawal"];
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

/** Executor and manager time per request, from the log timestamps (millisecond resolution). */
function timings(snapshots) {
  const log = entries(snapshots);
  const id = (m) => (m.match(/[0-9a-f]{64}/) ?? [])[0];
  const type = {}, start = {}, end = {}, mStart = {}, mEnd = {};
  const polls = [], stateBytes = [];
  for (const e of log) {
    const m = e.message;
    const size = m.match(/state size: (\d+)/);
    if (size) stateBytes.push(Number(size[1]));
    if (m.startsWith("Processing Process app request: ")) type[id(m)] = m.match(/\(type: (\w+)\)/)?.[1];
    if (m.startsWith("Processing deploy app request: ")) type[id(m)] = "deploy";
    if (m.startsWith("Executor: Processing request ") || m.startsWith("Executor: Deploying application for request ")) start[id(m)] ??= e.at;
    if ((e.caller.endsWith("executor.go:849") && m.startsWith("Executor: Successfully processed request ")) || m.startsWith("Executor: Returning signed error payload for request ")) end[id(m)] ??= e.at;
    if (m.startsWith("Executor: Successfully deployed application")) end[Object.keys(type).findLast((k) => type[k] === "deploy")] ??= e.at;
    if (m.startsWith("Manager: processing request ")) { mStart[id(m)] ??= e.at; polls.push(e.at); }
    if (m.startsWith("Manager: Processed request ") && !m.includes(" for application ")) mEnd[id(m)] ??= e.at;
  }
  const stats = (xs) => { xs = xs.filter(Number.isFinite).sort((a, b) => a - b); return xs.length ? { n: xs.length, min: xs[0], median: xs[xs.length >> 1], max: xs.at(-1) } : { n: 0 }; };
  const byType = {};
  for (const k of Object.keys(start)) (byType[type[k] ?? "unknown"] ??= []).push(end[k] - start[k]);
  const gaps = polls.slice(1).map((t, i) => t - polls[i]).filter((g) => g < 60_000);
  return {
    executorMsPerRequest: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, stats(v)])),
    managerMsPerRequest: stats(Object.keys(mStart).map((k) => mEnd[k] - mStart[k])),
    managerStartGapMs: stats(gaps),
    // The guest state size the host logs for each request: what the per-request times above were taken on.
    stateBytesLogged: stats(stateBytes),
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
  // clock tests its block time would go backwards and the guest would rightly refuse every tick.
  const restartResult = await restart(people, logSnapshots);
  const clockResult = await clock(people);
  const burstResult = await burst(people);
  const ledger = await engineLedger(people);
  const msResult = await millisecond(people);
  const recon2 = await reconcile("after restarts and clock tests");
  logSnapshots.push(stackLogs());
  const killed = await killDuringInclusion(people, logSnapshots);
  const lost = await managerVolumeLost(people, logSnapshots);
  const recon3 = await reconcile("at the end, after the destructive phases");
  const scan = leakScan(logSnapshots, [people.alice, people.bob, people.carol, people.dave]);
  const raw = scan.rawDepositResult;
  check("leak scan: v0.2.0 logs every deposit result at INFO: the whole guest state, salt included, and the receipt plaintext (expected)",
    raw.lines > 0 && raw.statesInClear > 0 && raw.stateFields.includes("salt") && raw.receiptPlaintextsInClear > 0, raw);
  check("leak scan: no command or receipt plaintext outside the raw deposit result", Object.keys(scan.guestPlaintextElsewhere).length === 0 && Object.keys(scan.guestPlaintextInOtherBase64).length === 0,
    { plain: scan.guestPlaintextElsewhere, base64: scan.guestPlaintextInOtherBase64 });
  check("leak scan: no user wallet key in any log", scan.userWalletKeysInLogs === 0);
  delete scan.salt; // the value itself is not kept in the evidence
  const lat = (f) => records.filter(f).map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const requestLatency = lat((r) => r.latencyMs !== undefined);
  const trustedLatency = records.map((r) => r.trusted?.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const measurements = {
    deployMs: deployment.deployMs,
    requestLatencyMs: { n: requestLatency.length, min: requestLatency[0], median: requestLatency[requestLatency.length >> 1], max: requestLatency.at(-1) },
    trustedAfterRequestMs: { n: trustedLatency.length, min: trustedLatency[0], median: trustedLatency[trustedLatency.length >> 1], max: trustedLatency.at(-1) },
    executor: timings(logSnapshots), burst: burstResult, restart: restartResult,
  };
  write("slice.json", { deployment, reconciliation: [recon1, recon2, recon3], engineLedger: ledger, clock: clockResult, millisecond: msResult, killDuringInclusion: killed, managerVolumeRemoved: lost, measurements,
    requests: records, checks });
  write("leak-scan.json", { note: "What the executor and manager logs of this run hold in clear: counts, source locations and field names only; no log text or value is stored.", scan });
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
