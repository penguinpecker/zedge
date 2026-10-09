// ZEDGE: the combined BTC + event application on our Vela stack on Horizen (26514), which replaces application
// 7408397676477227659 without stopping BTC (docs/cutover-politics.md): a new BookClockTrigger proxy (owner the deployer) on the
// live implementation, and the deploy request with the custody of the Base vault, the pinned Chainlink DON (guest README
// sections 2, 6, 12), the event "Will Democrats win control of the US House in the 3 November 2026 midterms?" (Yes = Up),
// its resolver, and depositsFrom = N, the last inbox index the old application processed before its trigger was made
// withdraw-only (cutover.mjs freeze). Same endpoint, authenticator, allowlist and manager as deploy-mainnet.mjs. Original code.
//
//   node adapters/vela/stack/deploy-book.mjs --fork http://127.0.0.1:PORT --resolver 0x… [--deposits-from N] [--wait]
//     a fork with its own Vela contracts and house key adds --endpoint 0x… --house 0x… --evidence DIR (fork only);
//     --wait only if a manager serves the fork: the completion and the first syncs then run as on mainnet
//   node adapters/vela/stack/deploy-book.mjs --broadcast-mainnet --resolver 0x… --deposits-from N --railway-project ID
//     (ONLY after the owner's go)
//
// The vault and the inbox come from contracts/deployment/custody.json; on mainnet it must say "deployed" and the inbox
// must have code. N is proven from the chain (cutover.mjs facts prints it) and on mainnet --deposits-from must repeat it;
// a fork, where no operator serves the old application, may take --deposits-from alone. The event's question hash is the
// Keccak-256 of --rules (default public/events/us-house-2026.txt). On mainnet the guest must already be in the Railway
// manager's artifact store (runbook step 1), which is read over `railway ssh` in the zedge-vela project (--railway-project its
// ID; --blobs if SHARED_DATA_FOLDER is elsewhere); after the request the script always waits for DeployRequestCompleted and the
// state root, then registers the deployer's key with the new application and sends the first syncs, which start its clock and
// create the next BTC rounds. Rerun-safe: each transaction's hash goes into the checkpoint (evidence/vela-book-politics[-fork]/)
// before it is broadcast, and a rerun checks it on the chain first.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { padHex, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ABI, KEEPER_VELA, MANAGER, OLD, RAILWAY, RELAYER, SUB, appRecords, artifact, blobInPlace, chooseDepositsFrom, client as reader, codeIs, depositsFromProblem, eventSpec, newest,
  othersCrediting, provenDepositsFrom, resolverProblem, triggersOnTheEndpoint, words } from "./cutover.mjs";
import { engineConfigJson } from "../../../scripts/write-orderbook-manifest.mjs";
import { connectVela } from "../../../services/keeper/vela.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const V = `${REPO}/adapters/vela`;
const { ethers } = await import(`${V}/crypto/node_modules/ethers/lib.esm/index.js`);
const sdk = await import(`${V}/crypto/node_modules/@horizen/vela-common-ts/dist/node.js`);

// Owner decisions (2026-10-06, 2026-10-07 and, for the event, 2026-10-09: stake limits and the DON unchanged). Reads of Horizen go to the public gateway, never to the operator's RPC.
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

const { values: a } = parseArgs({ options: { fork: { type: "string" }, "broadcast-mainnet": { type: "boolean" }, endpoint: { type: "string" }, house: { type: "string" },
  evidence: { type: "string" }, resolver: { type: "string" }, "deposits-from": { type: "string" }, rules: { type: "string" }, "event-start": { type: "string" },
  wait: { type: "boolean" }, blobs: { type: "string" }, "railway-project": { type: "string" } } });
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
if (!fork && a.wait) die("--wait is for --fork: mainnet always waits");
if (!fork && !a["railway-project"]) die("--railway-project (the zedge-vela project's ID) is required on mainnet: the guest is checked in its manager's artifact store");
if (a["deposits-from"] !== undefined && !/^[0-9]+$/.test(a["deposits-from"])) die("--deposits-from takes the index N");
if (a["event-start"] !== undefined && !/^[0-9]+$/.test(a["event-start"])) die("--event-start takes a unix time");
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

// The ProcessorEndpoint (Vela v0.2.1-snapshot1) calls this script makes, as its ABI declares them.
const ep = new ethers.Contract(ENDPOINT, ["function teeAuthenticator() view returns (address)", "function minFeePerRequest() view returns (uint256)",
  "function availableDeploySlots() view returns (uint256)", "function applicationStateRoots(uint64) view returns (bytes32)",
  "function submitDeployRequestWithTrigger(uint8 protocolVersion, bytes payload, address trigger) payable returns (bytes32)",
  "event DeployRequestSubmitted(uint64 indexed applicationId, bytes32 requestId, address indexed sender)"], provider);
const AUTH = lower(await ep.teeAuthenticator());
check("the endpoint is ours: minimum fee 1 gwei, a deploy slot free", (await ep.minFeePerRequest()) === MIN_FEE && (await ep.availableDeploySlots()) > 0n);
// On mainnet the inbox is deployed first (contracts/, by its own script). A fork has only the plan: the inbox is
// created here, from contracts/out, at the deployer nonces the plan names, so that the trigger takes the next ones.
const inboxMissing = (await provider.getCode(INBOX)) === "0x";
if (inboxMissing && !fork) die(`the inbox ${INBOX} has no code: deploy the vault and the inbox first`);
// The new trigger proxy runs the live BookClockTrigger implementation (no new implementation transaction): its code must be
// this source's, so the trigger is the one the old application ran.
const pub = reader(fork ?? RPC_URL);
const impl = OLD.implementation;
check(`the trigger implementation ${impl} is this source's BookClockTrigger`, await codeIs(pub, impl, artifact("BookClockTrigger")));
passOrDie();

// ---- depositsFrom = N: no inbox index at or below it is ever credited here (cutover.mjs; the old application keeps those)
const proven = await provenDepositsFrom(pub).catch((e) => e);
if (proven instanceof Error) console.log(`  depositsFrom is not proven: ${proven.message}`);
let N;
try { N = chooseDepositsFrom({ fork: Boolean(fork), given: a["deposits-from"] === undefined ? undefined : BigInt(a["deposits-from"]), proven }); } catch (e) { die(e.message); }
console.log(`  depositsFrom ${N}${proven instanceof Error ? " (fork: from --deposits-from)" : " (proven)"}`);
const RULES = readFileSync(resolve(a.rules ?? `${REPO}/public/events/us-house-2026.txt`)), QUESTION = ethers.keccak256(RULES);
const RESOLVER = lower(a.resolver ?? "");
const problem = resolverProblem(RESOLVER, { deployer: DEPLOYER, house: HOUSE, endpoint: ENDPOINT, "old trigger": OLD.trigger, vault: VAULT, inbox: INBOX, manager: MANAGER,
  "keeper-vela": KEEPER_VELA, relayer: RELAYER, "payout signer": custody.signer }, /^0x[0-9a-f]{40}$/.test(RESOLVER) ? await provider.getTransactionCount(RESOLVER, "latest") : 0);
if (problem) die(problem);

// ---- the checkpoint
const EVID = a.evidence ? resolve(a.evidence) : join(REPO, "evidence", fork ? "vela-book-politics-fork" : "vela-book-politics");
mkdirSync(EVID, { recursive: true });
const CK = join(EVID, "checkpoint.json");
let ck = existsSync(CK) ? JSON.parse(readFileSync(CK, "utf8")) : null;
const save = () => { writeFileSync(`${CK}.tmp`, JSON.stringify(ck, null, 2) + "\n"); renameSync(`${CK}.tmp`, CK); };
if (ck && (ck.wasm !== WASM_SHA256 || ck.inbox !== INBOX || ck.vault !== VAULT || ck.depositsFrom !== String(N) || ck.resolver !== RESOLVER || ck.question !== QUESTION ||
  (a["event-start"] !== undefined && ck.eventStart !== Number(a["event-start"])))) die(`${CK} belongs to another guest, custody, depositsFrom, resolver or event; move it aside to start over`);
// The event starts when this deployment is first prepared (the 900 s slot it falls in); the checkpoint keeps it for every rerun.
const eventStart = ck?.eventStart ?? (a["event-start"] !== undefined ? Number(a["event-start"]) : Math.floor((await provider.getBlock("latest")).timestamp / 900) * 900);
const EVENT = (() => { try { return eventSpec(RULES, eventStart); } catch (e) { return die(e.message); } })();
if (!ck) {
  const [nonce, pending] = await Promise.all([provider.getTransactionCount(DEPLOYER, "latest"), provider.getTransactionCount(DEPLOYER, "pending")]);
  if (pending !== nonce) die(`the deployer has a transaction waiting (nonce ${nonce}, pending ${pending})`);
  ck = { chainId: CHAIN_ID, wasm: WASM_SHA256, vault: VAULT, inbox: INBOX, depositsFrom: String(N), resolver: RESOLVER, question: QUESTION, eventStart,
    nonce0: nonce, startBlock: await provider.getBlockNumber(), steps: {} };
  save();
}
ck.forkInbox ??= inboxMissing;
const STEPS = [...(ck.forkInbox ? ["inbox implementation (fork only)", "inbox proxy (fork only)"] : []), "BookClockTrigger proxy", "submitDeployRequestWithTrigger"];
const CREATES = STEPS.length - 1;
const predicted = (i) => lower(ethers.getCreateAddress({ from: DEPLOYER, nonce: ck.nonce0 + i }));
STEPS.forEach((label, i) => console.log(`  nonce ${ck.nonce0 + i}  ${label}${i < CREATES ? ` -> ${predicted(i)}` : ""}`));
if (ck.forkInbox && predicted(1) !== INBOX) die(`the plan puts the inbox at ${INBOX}, but the deployer's nonce ${ck.nonce0 + 1} creates ${predicted(1)}`);
if (!ck.forkInbox && [predicted(0), predicted(1)].some((x) => x === INBOX || x === VAULT)) die("the trigger would take a custody contract's planned address");
console.log(`  event: question ${EVENT.question} (${RULES.length} bytes of rules), start ${EVENT.start}, cutoff ${EVENT.cutoff}, end ${EVENT.end}, voidable after ${EVENT.voidableAfter}; resolver ${RESOLVER}`);

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

// ---- the trigger behind its proxy on the live implementation, initialized in the proxy's own creation
const TRIGGER = (await step(k++, () => proxy(impl, new ethers.Interface(T.abi).encodeFunctionData("initialize", [DEPLOYER, ENDPOINT, REGISTRY, INBOX, 0, MARKET.duration])))).address;
const trigger = new ethers.Contract(TRIGGER, T.abi, provider);
const slot = await provider.getStorage(TRIGGER, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
check("trigger: proxy to the implementation, owner the deployer, our endpoint, the live registry, the inbox, BTC 900",
  lower(ethers.dataSlice(slot, 12)) === impl && lower(await trigger.owner()) === DEPLOYER && lower(await trigger.processorEndpoint()) === ENDPOINT &&
  lower(await trigger.registry()) === REGISTRY && lower(await trigger.inbox()) === INBOX && (await trigger.asset()) === 0n && (await trigger.duration()) === 900n);
passOrDie();

// ---- the guest must already be in the manager's artifact store (runbook step 1): without it the request fails and is wasted
if (!fork && !ck.steps[k]?.gasUsed) {
  check(`guest ${WASM_SHA256} in the Railway manager's artifact store (${a.blobs ?? RAILWAY.blobs})`, blobInPlace(WASM_SHA256, { project: a["railway-project"], blobs: a.blobs }));
  passOrDie();
} else if (fork) console.log("  (fork: no artifact check; a fork's own manager is given the guest by its own stack)");

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
  chainlink: CHAINLINK, custody: { chainId: 8453, vault: VAULT, inbox: INBOX, usdc: USDC }, event: EVENT, resolver: RESOLVER,
  ...(N > 0n && { depositsFrom: Number(N) }) }; // the guest encodes depositsFrom 0 by leaving it out, and refuses parameters it would encode otherwise
writeFileSync(join(EVID, "deploy-params.json"), JSON.stringify(params, null, 2) + "\n");
// Two applications crediting from N + 1 would both pay those deposits: refuse while another one on the inbox, deployed or pending
// (an earlier run whose checkpoint was moved aside), is not withdraw-only.
if (!ck.steps[k]?.gasUsed) {
  const others = othersCrediting(await triggersOnTheEndpoint(pub, await pub.getBlockNumber()), TRIGGER);
  if (others.length) die(`another application credits this inbox's deposits: ${others.join(", ")}; freeze it (cutover.mjs freeze --trigger) or forward-fix it`);
}
const s = await step(k, () => ({ to: ENDPOINT, value: MIN_FEE,
  data: ep.interface.encodeFunctionData("submitDeployRequestWithTrigger", [0, new sdk.VelaClient(provider, false, AUTH, ENDPOINT).buildDeployPayload(ethers.getBytes(`0x${WASM_SHA256}`), params), TRIGGER]) }));
if (!s.requestId) {
  const ev = (await provider.getTransactionReceipt(s.hash)).logs.filter((l) => lower(l.address) === ENDPOINT).map((l) => { try { return ep.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "DeployRequestSubmitted");
  if (!ev) die("no DeployRequestSubmitted event in the deploy request's receipt");
  Object.assign(s, { requestId: ev.args.requestId, applicationId: ev.args.applicationId.toString() });
  save();
}
console.log(`  deploy request ${s.requestId}: application ${s.applicationId} (tx ${s.hash})`);
if (!fork || a.wait) {
  // Searched back from the head in the public gateway's 1,000-block windows, so a rerun hours later still finds it.
  const COMPLETED = parseAbi(["event DeployRequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)"])[0];
  for (const t0 = Date.now(); !s.completed; await sleep(1000)) {
    const e = await newest(pub, { address: ENDPOINT, event: COMPLETED, args: { applicationId: BigInt(s.applicationId), requestId: s.requestId }, from: BigInt(s.block), to: await pub.getBlockNumber() });
    if (e) {
      if (Number(e.args.status) !== 0) die(`the guest refused the deployment: ${e.args.errorMessage} (code ${e.args.errorCode})`);
      s.completed = { tx: e.transactionHash, block: Number(e.blockNumber) };
      save();
    } else if (Date.now() - t0 > 600_000) die("the deploy request is not completed after 10 min; run again to keep waiting");
  }
  check(`application ${s.applicationId} deployed: its state root is set`, (await ep.applicationStateRoots(BigInt(s.applicationId))) !== ethers.ZeroHash);
  passOrDie();
  await firstSyncs();
} else console.log("  (fork without --wait: no manager, so the request stays queued; nothing more to check)");
console.log(`\n${fork ? "FORK" : "LIVE"}: book application ${s.applicationId}, trigger ${TRIGGER} (implementation ${impl}), guest ${WASM_SHA256}, depositsFrom ${N}`);
console.log(`  next (runbook step 7): scripts/write-orderbook-manifest.mjs --deploy-tx ${s.hash} --rules ${a.rules ?? "public/events/us-house-2026.txt"} …`);

/** A new application has no clock until a tick is applied, and rounds are only created by ticks (guest README section 8,
 * Bootstrap): the deployer registers its key with it and sends one sync, whose tick starts the clock and creates the next two
 * BTC rounds; a second sync's tick request then shows them, and with the credit records, that nothing at or below N was credited. */
async function firstSyncs() {
  const app = BigInt(s.applicationId);
  let sender = account;
  if (fork) {
    sender = privateKeyToAccount(generatePrivateKey());
    await provider.send("anvil_setBalance", [sender.address, "0x2386f26fc10000"]);
  } else sender ??= account = await (await import(`${REPO}/contracts/scripts/broadcast-hybrid.mjs`)).loadAccount(DEPLOYER);
  const enclavePublicKey = lower(await pub.readContract({ address: AUTH, abi: parseAbi(["function getPubSecp521r1() view returns (bytes)"]), functionName: "getPubSecp521r1" }));
  const book = { endpoint: { address: ENDPOINT }, authenticator: { enclavePublicKey }, application: { id: s.applicationId, wasmSha256: WASM_SHA256, origin: ORIGIN, epoch: "1",
    sessionRulesHash: createHash("sha256").update(engineConfigJson(params.engine, s.applicationId)).digest("hex") } };
  const vela = await connectVela({ book, account: sender, url: fork ?? RPC_URL, rehearsal: Boolean(fork) });
  const completed = async (sent, what) => {
    for (const t0 = Date.now(); ; await sleep(2000)) {
      const c = await vela.completion(sent);
      if (c) return c;
      if (Date.now() - t0 > 300_000) die(`${what} is not completed after 5 min; run again`);
    }
  };
  const appEvent = (kind, fromBlock, requestId) => pub.getLogs({ address: ENDPOINT, event: ABI[0], args: { applicationId: app, eventSubType: SUB[kind], ...(requestId && { requestId }) }, fromBlock: BigInt(fromBlock) });
  const clockOf = (l) => { const w = words(l.args.data); return { tick: w[0], block: w[1], timestamp: Number(w[2]) }; };
  const clockSince = async (fromBlock) => {
    for (const t0 = Date.now(); ; await sleep(2000)) {
      const logs = await appEvent("clock", fromBlock);
      if (logs.length) return clockOf(logs.at(-1));
      if (Date.now() - t0 > 300_000) die("no clock record 5 min after the sync; run again");
    }
  };
  // A rerun: the newest clock record since the deploy, searched back from the head in 1,000-block windows.
  const last = await newest(pub, { address: ENDPOINT, event: ABI[0], args: { applicationId: app, eventSubType: SUB.clock }, from: BigInt(s.block), to: await pub.getBlockNumber() });
  let clock = last && clockOf(last);
  if (!clock) {
    let sent = await vela.send("sync"), c = await completed(sent, "the first sync");
    if (c.errorCode === 9) { // PUB_KEY_NOT_REGISTERED: a new application knows no key yet
      const r = await vela.register();
      const done = await completed(r, "the key registration");
      if (done.status !== 0) die(`the key registration failed: ${done.errorMessage}`);
      console.log(`  ${sender.address} registered its key with application ${app}: ${r.hash}`);
      sent = await vela.send("sync"); c = await completed(sent, "the first sync");
    }
    if (c.status !== 0) die(`the first sync failed: ${c.errorMessage}`);
    clock = await clockSince(sent.block);
  }
  console.log(`  clock started: tick ${clock.tick}, time ${clock.timestamp} (${new Date(clock.timestamp * 1000).toISOString()}), asked at block ${clock.block}`);
  const second = await vela.send("sync"), c2 = await completed(second, "the second sync");
  if (c2.status !== 0) die(`the second sync failed: ${c2.errorMessage}`);
  const [request] = await appEvent("tick", second.block, second.requestId);
  if (!request) die("the second sync published no tick request");
  const w = words(request.args.data), held = w.slice(5, 5 + Number(w[2] + w[3])).map((x) => padHex(toHex(x), { size: 32 }));
  const t1 = (Math.floor(clock.timestamp / 900) + 1) * 900;
  const ids = await Promise.all([t1, t1 + 900].map((t) => pub.readContract({ address: REGISTRY, abi: ABI, functionName: "roundIdFor", args: [0, 900, BigInt(t)] })));
  const fromProblem = depositsFromProblem(N, w[1], (await appRecords(pub, app, BigInt(s.block), await pub.getBlockNumber())).credits);
  if (fromProblem) console.log(`    the new application's deposits: ${fromProblem}`);
  check(`depositsFrom ${N} holds: no inbox index at or below it is credited, and the deposit asked for next (${w[1]}) follows the credits above it`, !fromProblem);
  check(`BTC rounds ${t1} and ${t1 + 900} (${new Date(t1 * 1000).toISOString()}) exist in the new application`, ids.every((id) => held.includes(id)));
  passOrDie();
  console.log("  the event round is not in the tick request (the guest never asks the trigger about it): confirm it with the event house (runbook step 10e)");
}
