// ZEDGE: the private book as a NEW application on our existing Vela stack on Horizen (26514): the BookClockTrigger
// behind its UUPS proxy (owner the deployer), the guest into the manager's artifact store, and the deploy request
// with the custody of the Base vault and the pinned Chainlink DON (guest README sections 2, 6, 12). Same endpoint,
// authenticator, allowlist and manager as deploy-mainnet.mjs; the old application is left alone. Original code.
//
//   node deploy-book.mjs --fork http://127.0.0.1:PORT [--project NAME]     (rehearsal: deployer impersonated)
//     a fork with its own Vela contracts and house key adds --endpoint 0x… --house 0x… --evidence DIR (fork only)
//   node deploy-book.mjs --broadcast-mainnet                                (ONLY after the owner's go)
//
// The vault and the inbox come from contracts/deployment/custody.json; on mainnet it must say "deployed" and the inbox
// must have code. Rerun-safe: each transaction's hash goes into the checkpoint (evidence/vela-book[-fork]/) before it
// is broadcast, and a rerun checks it on the chain first. --project names the docker compose project whose manager
// gets the guest (default zedge-vela on mainnet; on a fork the copy is skipped unless a project is named).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const V = `${REPO}/adapters/vela`;
const { ethers } = await import(`${V}/crypto/node_modules/ethers/lib.esm/index.js`);
const sdk = await import(`${V}/crypto/node_modules/@horizen/vela-common-ts/dist/node.js`);

// Owner decisions (2026-10-06 and 2026-10-07). Reads of Horizen go to the public gateway, never to the operator's RPC.
const CHAIN_ID = 26514, RPC_URL = "https://26514.rpc.thirdweb.com";
const DEPLOYER = "0x279173ac297ad146bc92f877552c8c2b78334d07"; // also the trigger's owner
const REGISTRY = "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744";
const USDCE = "0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c"; // the engine's collateral label: the registry rules commit to it
const ORIGIN = "https://zedge-markets.vercel.app";
const MARKET = { asset: "BTC", duration: 900 };
const STAKE = { account: 50_000_000, boundary: 200_000_000, houseTotal: 2_000_000_000 };
const ENGINE_VERSION = 3, MIN_FEE = 1_000_000_000n;
const FEES = { maxFeePerGas: 2_000_504n, maxPriorityFeePerGas: 1_000_000n };
const RULES_VERSION = "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half";
// The DON every BTC report copy carries today (Base ConfigSet at block 30,184,132): f = 5 of 16.
const CHAINLINK = { feedId: "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8", configs: [{
  digest: "0x00094baebfda9b87680d8e59aa20a3e565126640ee7caeab3cd965e5568b17ee", f: 5, signers: [
    "0x0fc9e43f343be5190131e88bb1de15fab6a5c9cf", "0x26eb8dea43b66dd285642487d79067a0c8195a6e", "0x3aceb84a335051009baaa1dc1f1b0fc65caffc5e",
    "0x50a0ce1a108cc8cc36b2ca7d9cb1465aa10aad9e", "0x59337c5ea05e8902781131ff85cccbf3e62b8b99", "0x63d83d47bcf8dd20f80634e85125502846a9c759",
    "0x6a3e28b313913fd5aadded436ff7869fb80c29ed", "0x6f4e9279eeec80b6ca2872073897441065657eef", "0x77debb206b50a673c6b95bf7c8c2e9adacb0cbe1",
    "0x86e99c45cf23839b1d3d51ed7c91e046acb8a6f0", "0x9d0fb8544fba0a9e5890f831f896f79865d67bb5", "0xb80a3a6ddd40dc74b93e7a3cdd21c13b77c91d07",
    "0xd4bab8e32c564d83f60b663cb441ac1f35bb0000", "0xeb7118989c3d2b1055be3da28ddc386ff80d74d7", "0xf01e0f13255ae309370e2ab23da85ea5fc646691",
    "0xf98a9508cc79c6d18e6eab89af2c8218d81c14f1"] }] };

const { values: a } = parseArgs({ options: { fork: { type: "string" }, project: { type: "string" }, "broadcast-mainnet": { type: "boolean" },
  endpoint: { type: "string" }, house: { type: "string" }, evidence: { type: "string" } } });
function die(m) { console.error(`deploy-book: ${m}`); process.exit(1); }
const lower = (x) => String(x).toLowerCase();
// A fork rehearsal may run its own Vela contracts and house key (the live endpoint's manager is not ours): fork only.
if (!a.fork && (a.endpoint || a.house || a.evidence)) die("--endpoint, --house and --evidence are for --fork only");
const ENDPOINT = lower(a.endpoint ?? "0x0a2703d21b27757fdf27ab807eae9820788010f3");
const HOUSE = lower(a.house ?? "0xac8dfcbfbb5907634fe2bcea58e59e4c55441ab5");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failed = [];
const check = (name, pass) => { console.log(`    ${pass ? "PASS" : "FAIL"} ${name}`); if (!pass) failed.push(name); };
const passOrDie = () => { if (failed.length) die(`check failed: ${failed.join("; ")}`); };

const fork = a.fork;
if (!fork && !a["broadcast-mainnet"]) die("rehearse with --fork first; mainnet needs --broadcast-mainnet, after the owner's go");
if (fork && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(fork).hostname)) die("--fork takes a loopback URL");
const provider = new ethers.JsonRpcProvider(fork ?? RPC_URL, undefined, { pollingInterval: 1000, cacheTimeout: -1, staticNetwork: true });
const client = await provider.send("web3_clientVersion", []);
if (fork && !/anvil/i.test(client)) die(`--fork needs a local Anvil; this node is ${client}`);
if (Number(await provider.send("eth_chainId", [])) !== CHAIN_ID) die(`the node is not Horizen mainnet ${CHAIN_ID}`);

// ---- inputs: the guest, the custody plan, the artifacts
const WASM = readFileSync(`${V}/guest/build/zedge_guest.wasm`), WASM_SHA256 = createHash("sha256").update(WASM).digest("hex");
const custody = JSON.parse(readFileSync(`${REPO}/contracts/deployment/custody.json`, "utf8"));
const VAULT = lower(custody.base.vault.proxy), INBOX = lower(custody.horizen.inbox.proxy), USDC = lower(custody.base.usdc);
if (!fork && custody.status !== "deployed") die(`contracts/deployment/custody.json is "${custody.status}": deploy the vault and the inbox first`);
const out = (name) => JSON.parse(readFileSync(`${V}/stack/contracts/build/out/${name}.sol/${name}.json`, "utf8"));
const T = out("BookClockTrigger"), P = out("ERC1967Proxy");
console.log(`${fork ? `FORK ${fork} (Anvil, deployer impersonated)` : `Horizen mainnet ${RPC_URL}`}; guest ${WASM_SHA256} (${WASM.length} bytes); vault ${VAULT}, inbox ${INBOX}`);

const EP = JSON.parse(readFileSync(`${V}/stack/build/upstream/deployer-v0.2.1-snapshot1/artifacts/contracts/ProcessorEndpoint.sol/ProcessorEndpoint.json`, "utf8"));
const ep = new ethers.Contract(ENDPOINT, EP.abi, provider);
const AUTH = lower(await ep.teeAuthenticator());
check("the endpoint is ours: minimum fee 1 gwei, a deploy slot free", (await ep.minFeePerRequest()) === MIN_FEE && (await ep.availableDeploySlots()) > 0n);
// On mainnet the inbox is deployed first (contracts/, by its own script). A fork has only the plan: the inbox is
// created here, from contracts/out, at the deployer nonces the plan names, so that the trigger takes the next ones.
const inboxMissing = (await provider.getCode(INBOX)) === "0x";
if (inboxMissing && !fork) die(`the inbox ${INBOX} has no code: deploy the vault and the inbox first`);
passOrDie();

// ---- the checkpoint
const EVID = a.evidence ? resolve(a.evidence) : join(REPO, "evidence", fork ? "vela-book-fork" : "vela-book");
mkdirSync(EVID, { recursive: true });
const CK = join(EVID, "checkpoint.json");
let ck = existsSync(CK) ? JSON.parse(readFileSync(CK, "utf8")) : null;
const save = () => { writeFileSync(`${CK}.tmp`, JSON.stringify(ck, null, 2) + "\n"); renameSync(`${CK}.tmp`, CK); };
if (ck && (ck.wasm !== WASM_SHA256 || ck.inbox !== INBOX || ck.vault !== VAULT)) die(`${CK} belongs to another guest or custody; move it aside to start over`);
if (!ck) {
  const [nonce, pending] = await Promise.all([provider.getTransactionCount(DEPLOYER, "latest"), provider.getTransactionCount(DEPLOYER, "pending")]);
  if (pending !== nonce) die(`the deployer has a transaction waiting (nonce ${nonce}, pending ${pending})`);
  ck = { chainId: CHAIN_ID, wasm: WASM_SHA256, vault: VAULT, inbox: INBOX, nonce0: nonce, startBlock: await provider.getBlockNumber(), steps: {} };
  save();
}
ck.forkInbox ??= inboxMissing;
const STEPS = [...(ck.forkInbox ? ["inbox implementation (fork only)", "inbox proxy (fork only)"] : []),
  "BookClockTrigger implementation", "BookClockTrigger proxy", "submitDeployRequestWithTrigger"];
const CREATES = STEPS.length - 1;
const predicted = (i) => lower(ethers.getCreateAddress({ from: DEPLOYER, nonce: ck.nonce0 + i }));
STEPS.forEach((label, i) => console.log(`  nonce ${ck.nonce0 + i}  ${label}${i < CREATES ? ` -> ${predicted(i)}` : ""}`));
if (ck.forkInbox && predicted(1) !== INBOX) die(`the plan puts the inbox at ${INBOX}, but the deployer's nonce ${ck.nonce0 + 1} creates ${predicted(1)}`);
if (!ck.forkInbox && [0, 1].some((i) => predicted(i) === INBOX || predicted(i) === VAULT)) die("the trigger would take a custody contract's planned address");

let account;
const q = ethers.toQuantity;
const rpcTx = (t) => ({ from: DEPLOYER, ...(t.to && { to: t.to }), data: t.data ?? "0x", value: q(t.value ?? 0n), ...(t.gas && { gas: q(t.gas) }), nonce: q(t.nonce) });
if (fork) await provider.send("anvil_impersonateAccount", [DEPLOYER]);
async function step(i, build) {
  const label = STEPS[i], nonce = ck.nonce0 + i;
  let s = ck.steps[i];
  if (s?.gasUsed) {
    if ((await provider.getTransactionReceipt(s.hash))?.status !== 1) die(`${label}: ${s.hash} is recorded as done but has no successful receipt`);
    return s;
  }
  if (!s?.hash || !(await provider.getTransaction(s.hash))) {
    if ((await provider.getTransactionCount(DEPLOYER, "latest")) !== nonce) die(`${label} needs deployer nonce ${nonce}: something else was sent from it`);
    const tx = { ...(await build()), nonce };
    tx.gas = BigInt(await provider.send("eth_estimateGas", [rpcTx(tx)])) * 6n / 5n;
    s = ck.steps[i] = { label, nonce };
    if (fork) {
      s.hash = await provider.send("eth_sendTransaction", [{ ...rpcTx(tx), type: "0x2", maxFeePerGas: q(FEES.maxFeePerGas), maxPriorityFeePerGas: q(FEES.maxPriorityFeePerGas) }]);
      save();
    } else {
      account ??= await (await import(`${REPO}/contracts/scripts/broadcast-hybrid.mjs`)).loadAccount(DEPLOYER);
      const raw = await account.signTransaction({ chainId: CHAIN_ID, type: "eip1559", ...tx, ...FEES });
      s.hash = ethers.keccak256(raw);
      save();
      await provider.send("eth_sendRawTransaction", [raw]).catch(async (e) => { if (!(await provider.getTransaction(s.hash))) throw e; });
    }
  }
  const rc = await provider.waitForTransaction(s.hash, 1, 600_000);
  if (rc.status !== 1) die(`${label} reverted: ${s.hash}`);
  Object.assign(s, { block: rc.blockNumber, gasUsed: rc.gasUsed.toString() });
  if (i < CREATES) {
    s.address = lower(rc.contractAddress);
    if (s.address !== predicted(i)) die(`${label} landed at ${s.address}, expected ${predicted(i)}`);
  }
  save();
  console.log(`  ${label}: ${s.address ?? s.hash} gas ${s.gasUsed}`);
  return s;
}

const proxy = (implementation, data) => ({ data: ethers.concat([P.bytecode.object, new ethers.Interface(P.abi).encodeDeploy([implementation, data])]) });
let k = 0;
if (ck.forkInbox) {
  const I = JSON.parse(readFileSync(`${REPO}/contracts/out/HorizenDepositInbox.sol/HorizenDepositInbox.json`, "utf8"));
  const inboxImpl = (await step(k++, () => ({ data: I.bytecode.object }))).address;
  await step(k++, () => proxy(inboxImpl, new ethers.Interface(I.abi).encodeFunctionData("initialize", [DEPLOYER, VAULT])));
}

// ---- the trigger behind its proxy, initialized in the proxy's own creation
const impl = (await step(k++, () => ({ data: T.bytecode.object }))).address;
const TRIGGER = (await step(k++, () => proxy(impl, new ethers.Interface(T.abi).encodeFunctionData("initialize", [DEPLOYER, ENDPOINT, REGISTRY, INBOX, 0, MARKET.duration])))).address;
const trigger = new ethers.Contract(TRIGGER, T.abi, provider);
const slot = await provider.getStorage(TRIGGER, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
check("trigger: proxy to the implementation, owner the deployer, our endpoint, the live registry, the inbox, BTC 900",
  lower(ethers.dataSlice(slot, 12)) === impl && lower(await trigger.owner()) === DEPLOYER && lower(await trigger.processorEndpoint()) === ENDPOINT &&
  lower(await trigger.registry()) === REGISTRY && lower(await trigger.inbox()) === INBOX && (await trigger.asset()) === 0n && (await trigger.duration()) === 900n);
passOrDie();

// ---- the guest into the manager's artifact store, under its SHA-256
const project = a.project ?? (fork ? null : "zedge-vela");
if (project) {
  const dc = (...args) => { const r = spawnSync("docker", ["compose", "-p", project, "-f", join(here, "compose.yml"), ...args], { encoding: "utf8" });
    if (r.status !== 0) die(`docker compose ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`); return r.stdout; };
  const blob = `/shared-data/artifacts/blobs/${WASM_SHA256}.wasm`;
  dc("exec", "-T", "manager", "mkdir", "-p", "/shared-data/artifacts/blobs");
  dc("cp", `${V}/guest/build/zedge_guest.wasm`, `manager:${blob}`);
  dc("exec", "-T", "manager", "chmod", "644", blob);
  check(`guest ${WASM_SHA256} in ${project}'s artifact store`, dc("exec", "-T", "manager", "sha256sum", blob).startsWith(WASM_SHA256));
  passOrDie();
} else console.log("  (fork without --project: no manager gets the guest; the deploy request stays queued)");

// ---- 3. the deploy request: engine configuration from the live registry, custody and the pinned DON
const reg = new ethers.Contract(REGISTRY, ["oracle", "collateral", "btcFeedId", "ethFeedId", "btcDecimals", "ethDecimals", "observationWindow", "openingGrace",
  "voidGrace", "cutoffBuffer", "rulesHash"].map((k) => `function ${k}() view returns (${/Feed|rulesHash/.test(k) ? "bytes32" : /oracle|collateral/.test(k) ? "address" : /Decimals/.test(k) ? "uint8" : "uint32"})`), provider);
const cfg = {};
for (const k of ["oracle", "collateral", "btcFeedId", "ethFeedId", "btcDecimals", "ethDecimals", "observationWindow", "openingGrace", "voidGrace", "cutoffBuffer", "rulesHash"]) cfg[k] = await reg[k]();
const rulesHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256", "tuple(address,address,bytes32,bytes32,uint8,uint8,uint32,uint32,uint32,uint32)"],
  [RULES_VERSION, CHAIN_ID, [cfg.oracle, cfg.collateral, cfg.btcFeedId, cfg.ethFeedId, cfg.btcDecimals, cfg.ethDecimals, cfg.observationWindow, cfg.openingGrace, cfg.voidGrace, cfg.cutoffBuffer]]));
check("registry: collateral USDC.e, the pinned BTC feed, cutoff buffer 30, and the engine's rules hash is its own",
  lower(cfg.collateral) === USDCE && cfg.btcFeedId === CHAINLINK.feedId && cfg.cutoffBuffer === 30n && rulesHash === cfg.rulesHash);
passOrDie();
const params = { engine: { domain: { chainId: CHAIN_ID, endpoint: ENDPOINT, applicationId: "", rulesVersion: ENGINE_VERSION }, authority: TRIGGER, collateral: USDCE, feeBps: 0,
  oracle: { chainId: CHAIN_ID, registry: REGISTRY, oracle: lower(cfg.oracle), rulesHash, btcFeedId: cfg.btcFeedId, ethFeedId: cfg.ethFeedId, decimals: Number(cfg.btcDecimals),
    observationWindow: Number(cfg.observationWindow), openingGrace: Number(cfg.openingGrace), voidGrace: Number(cfg.voidGrace), cutoffBuffer: Number(cfg.cutoffBuffer) } },
  applicationFingerprint: WASM_SHA256, origin: ORIGIN, epoch: "1", markets: [MARKET],
  stakeLimits: { account: STAKE.account, boundary: STAKE.boundary, house: HOUSE, houseTotal: STAKE.houseTotal },
  chainlink: CHAINLINK, custody: { chainId: 8453, vault: VAULT, inbox: INBOX, usdc: USDC } };
writeFileSync(join(EVID, "deploy-params.json"), JSON.stringify(params, null, 2) + "\n");
const s = await step(k, () => ({ to: ENDPOINT, value: MIN_FEE,
  data: ep.interface.encodeFunctionData("submitDeployRequestWithTrigger", [0, new sdk.VelaClient(provider, false, AUTH, ENDPOINT).buildDeployPayload(ethers.getBytes(`0x${WASM_SHA256}`), params), TRIGGER]) }));
if (!s.requestId) {
  const ev = (await provider.getTransactionReceipt(s.hash)).logs.filter((l) => lower(l.address) === ENDPOINT).map((l) => { try { return ep.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "DeployRequestSubmitted");
  if (!ev) die("no DeployRequestSubmitted event in the deploy request's receipt");
  Object.assign(s, { requestId: ev.args.requestId, applicationId: ev.args.applicationId.toString() });
  save();
}
console.log(`  deploy request ${s.requestId}: application ${s.applicationId}`);
if (project) {
  for (const t0 = Date.now(); !s.completed; await sleep(1000)) {
    const [e] = await ep.queryFilter(ep.filters.DeployRequestCompleted(BigInt(s.applicationId), s.requestId), s.block);
    if (e) {
      if (Number(e.args.status) !== 0) die(`the guest refused the deployment: ${e.args.errorMessage} (code ${e.args.errorCode})`);
      s.completed = { tx: e.transactionHash, block: e.blockNumber };
      save();
    } else if (Date.now() - t0 > 600_000) die("the deploy request is not completed after 10 min; run again to keep waiting");
  }
  check(`application ${s.applicationId} deployed: its state root is set`, (await ep.applicationStateRoots(BigInt(s.applicationId))) !== ethers.ZeroHash);
  passOrDie();
}
console.log(`\n${fork ? "FORK" : "LIVE"}: book application ${s.applicationId}, trigger ${TRIGGER} (implementation ${impl}), guest ${WASM_SHA256}`);
console.log(`  next: set the vault signer, publish the order-book manifest (schema 3) with application ${s.applicationId} and trigger ${TRIGGER}`);
