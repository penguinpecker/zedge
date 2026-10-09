// ZEDGE: moving the private book to the combined BTC + event application without stopping BTC (docs/cutover-politics.md).
// The old application becomes withdraw-only when its trigger proxy is upgraded to WithdrawOnlyBookClockTrigger; the new one
// starts after N, the last inbox index the old one processed. Original code.
//
//   node adapters/vela/stack/cutover.mjs facts [--new APP_ID:DEPLOY_BLOCK] [--base-rpc URL]   read-only: every number the runbook checks
//   node adapters/vela/stack/cutover.mjs freeze [--trigger 0x…] [--implementation 0x…]         dry run: prints the transactions, sends nothing
//   node adapters/vela/stack/cutover.mjs freeze --fork http://127.0.0.1:PORT                   Anvil fork of Horizen mainnet, deployer impersonated
//   node adapters/vela/stack/cutover.mjs freeze --broadcast-mainnet                            ONLY the owner, after the go
//   node adapters/vela/stack/cutover.mjs thaw [--trigger 0x…] [--fork URL | --broadcast-mainnet]   rollback only (runbook)
//
// freeze deploys WithdrawOnlyBookClockTrigger (or reuses --implementation, already deployed) and upgrades the trigger proxy to it;
// thaw upgrades it back to the live BookClockTrigger implementation, and refuses while any other application on the same inbox is
// not withdraw-only, has credited a deposit, or has applied no tick asked after its freeze. Build the contracts first (forge build in contracts/). Horizen is read through the public gateway (1,000-block log windows), never the
// operator's RPC; Base logs through Tenderly's public gateway unless --base-rpc. deploy-book.mjs takes its checks from here.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { concat, createPublicClient, decodeFunctionResult, encodeFunctionData, getContractAddress, http, keccak256, padHex, parseAbi, sha256, stringToHex, toHex } from "viem";

export const HORIZEN_RPC = "https://26514.rpc.thirdweb.com", BASE_RPC = "https://base.gateway.tenderly.co";
export const DEPLOYER = "0x279173ac297ad146bc92f877552c8c2b78334d07"; // owner of every trigger proxy
export const ENDPOINT = "0x0a2703d21b27757fdf27ab807eae9820788010f3", REGISTRY = "0x4dd4aacdb7e8d2e6d06c5af38238f3deab836744";
export const HOUSE = "0xac8dfcbfbb5907634fe2bcea58e59e4c55441ab5", MANAGER = "0x3b2619b73840b58d5da81df62c7f1115f8d83861";
export const KEEPER_VELA = "0xa867fa48f8ec915c87e98507833d700dd97557d3", RELAYER = "0x9336887b575f11da697f53614d0f2a262dded024";
/** The application being retired, as public/deployments/26514-orderbook.json names it at b38ea4b. */
export const OLD = { app: 7408397676477227659n, trigger: "0x9ca46470b05350384c31c8b236af4df638cbb30d", implementation: "0x6f8500186ccb07e3c14ff7bbf1c9b5c05b8ca9a8", deployBlock: 27958309n };
const custody = JSON.parse(readFileSync(new URL("../../../contracts/deployment/custody.json", import.meta.url), "utf8"));
export const VAULT = custody.base.vault.proxy, INBOX = custody.horizen.inbox.proxy, USDC = custody.base.usdc, VAULT_FROM = BigInt(custody.plannedFrom.base.block);
export const FEES = { maxFeePerGas: 2_000_504n, maxPriorityFeePerGas: 1_000_000n }; // deploy-book.mjs's Horizen caps
/** Owner decisions (2026-10-09): Yes = Up, No = Down; trading cutoff 3 Nov 2026 22:00:00 UTC; the result accepted from one second
 * later, off the 900 s grid so the event never shares the all-accounts limit with a BTC round; void only by timeout after
 * 31 Jan 2027 23:59:59 UTC. */
export const EVENT = { cutoff: 1793743200, end: 1793743201, voidableAfter: 1801439999 };
/** The Vela manager's Railway service (in the owner's project zedge-vela, whose ID the owner passes) and its artifact store,
 * SHARED_DATA_FOLDER/artifacts/blobs. */
export const RAILWAY = { manager: "manager", blobs: "/vela/shared-data/artifacts/blobs" };
export const SUB = Object.fromEntries(["tick", "clock", "credit", "payout"].map((l) => [l, sha256(stringToHex(`zedge.vela.${l}.v1`))]));
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const ABI = parseAbi([
  "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
  "event Upgraded(address indexed implementation)",
  "event Deposited(uint64 indexed index, address indexed account, uint256 amount)",
  "event Paid(uint64 indexed applicationId, uint64 indexed ordinal, address indexed to, address account, uint256 amount)",
  "function highest() view returns (uint64)", "function deposits(uint64) view returns (address account, uint96 amount)",
  "function depositCount() view returns (uint64)", "function paid(uint64, uint64) view returns (bool)", "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)", "function pendingOwner() view returns (address)", "function processorEndpoint() view returns (address)",
  "function registry() view returns (address)", "function inbox() view returns (address)", "function asset() view returns (uint8)", "function duration() view returns (uint32)",
  "function availableDeploySlots() view returns (uint256)", "function maxNumOfApplications() view returns (uint256)", "function getDeployedAppIds() view returns (uint64[])",
  "function getPendingRequestsSize() view returns (uint256)", "function triggerContracts(uint64) view returns (address)",
  "function roundIdFor(uint8, uint32, uint64) view returns (bytes32)", "function upgradeToAndCall(address, bytes) payable",
  "function getTrustProcessPayload((bytes[] events, bytes32[] subTypes), bool, bool, (address token, uint256 amount)[], (address token, uint256 amount)[]) returns (bytes)",
]);
const lower = (x) => String(x).toLowerCase();
export const words = (data) => Array.from({ length: (data.length - 2) / 64 }, (_, i) => BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i)}`));

// ---------------------------------------------------------------- checks deploy-book.mjs shares (pure; cutover.test.mjs)

/** A forge artifact's runtime code as deployed at `at`. The triggers' only immutable is UUPSUpgradeable's `__self`, the
 * contract's own address, so every immutable slot is filled with `at`. */
export function runtimeOf(artifact, at) {
  const word = lower(at).slice(2).padStart(64, "0");
  let code = lower(artifact.deployedBytecode.object).slice(2);
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) code = code.slice(0, 2 * start) + word.slice(64 - 2 * length) + code.slice(2 * (start + length));
  }
  return `0x${code}`;
}

/** N, the inbox index after which the new application credits deposits: the old application's last processed index, final
 * once its trigger answers without deposits. Proven only if the trigger runs WithdrawOnlyBookClockTrigger since
 * `freezeBlock`, the old application has applied a tick asked in a later block (ticks apply in order, so no payload from
 * before the freeze can apply after it), and its credit records number 1…N exactly once, within the inbox. */
export function proveDepositsFrom({ frozen, freezeBlock, lastClockBlock, credits, highest }) {
  if (!frozen) throw new Error("the old trigger is not WithdrawOnlyBookClockTrigger yet: run cutover.mjs freeze first");
  if (freezeBlock === undefined) throw new Error("no Upgraded event dates the freeze: without its block no tick can be shown to come after it");
  if (lastClockBlock === undefined || lastClockBlock <= freezeBlock) throw new Error(`the old application has applied no tick asked after the freeze (block ${freezeBlock}): wait for one, or send it a sync`);
  [...credits].sort((x, y) => (x.index < y.index ? -1 : 1)).forEach((c, i) => {
    if (c.index !== BigInt(i + 1)) throw new Error(`the old application's credit records skip or repeat index ${i + 1}`);
  });
  const n = BigInt(credits.length);
  if (n > highest) throw new Error(`the old application processed index ${n}, above the inbox's highest ${highest}`);
  return n;
}

/** deploy-book's N: the proof, which the owner's --deposits-from must repeat on mainnet. Only a fork, where no operator serves the
 * old application, may take --deposits-from without one. */
export function chooseDepositsFrom({ fork, given, proven }) {
  if (proven instanceof Error) { if (fork && given !== undefined) return given; throw proven; }
  if (given === undefined && !fork) throw new Error(`--deposits-from is required on mainnet: repeat the proven ${proven}`);
  if (given !== undefined && given !== proven) throw new Error(`--deposits-from ${given} is not the proven ${proven}`);
  return proven;
}

/** Why the new application's first ticks do not show depositsFrom = n at work, or null. A guest reading the inbox from index 1
 * would credit indexes at or below n, and at n = 8 (one payload's worth) it would still ask for n + 1 next, so the deposit asked
 * for next is not enough: no credit record may be at or below n, and the next index must follow the ones above n it credited. */
export function depositsFromProblem(n, next, credits) {
  const low = credits.find((c) => c.index <= n);
  if (low) return `it credited inbox index ${low.index}, at or below depositsFrom ${n}`;
  const seen = new Set(credits.map((c) => c.index));
  for (let i = n + 1n; i < next; i++) if (!seen.has(i)) return `it asks for deposit ${next} but has no credit record for ${i}`;
  return next > n ? null : `it asks for deposit ${next}, not one above depositsFrom ${n}`;
}

/** The `event` deploy parameter: the Keccak-256 of the exact rules text (the question hash) and the owner's times, with the guest's
 * key names in its key order (EventTerms), since the guest refuses constructor parameters that do not re-encode byte for byte. */
export function eventSpec(rules, start) {
  if (!rules?.length) throw new Error("the event's rules text is empty");
  if (!Number.isSafeInteger(start) || start <= 0 || start >= EVENT.cutoff) throw new Error(`the event must start before its cutoff ${EVENT.cutoff}`);
  return { question: keccak256(rules), start, cutoff: EVENT.cutoff, end: EVENT.end, voidableAfter: EVENT.voidableAfter };
}

/** Why `resolver` cannot be the event's resolver, or null. Owner decision: a new dedicated wallet, so a lowercase address (the
 * guest compares addresses as text) that is none of the deployment's roles and has never sent a Horizen transaction. */
export function resolverProblem(resolver, roles, nonce) {
  if (!/^0x[0-9a-f]{40}$/.test(resolver ?? "") || /^0x0{40}$/.test(resolver)) return "--resolver must be a lowercase 0x address";
  const role = Object.entries(roles).find(([, address]) => lower(address) === resolver);
  if (role) return `the resolver is the ${role[0]}: use a new dedicated wallet`;
  if (nonce !== 0) return `the resolver has sent ${nonce} Horizen transactions: use a new dedicated wallet`;
  return null;
}

/** The applications that would credit the inbox's deposits besides `self`: every trigger reading that inbox that is not withdraw-only.
 * At most one application may ever credit them (runbook, Rollback), so a thaw needs this empty. */
export function othersCrediting(triggers, self) {
  return triggers.filter((t) => lower(t.trigger) !== lower(self) && lower(t.inbox) === lower(INBOX) && !t.withdrawOnly).map((t) => `application ${t.app} (trigger ${t.trigger})`);
}

/** Why thawing `self` could credit a deposit twice, or []. Beyond othersCrediting: the thawed application credits again from the
 * index after its own last, so every other application on the inbox must never have credited a deposit (runbook, Rollback rule 3),
 * and must have applied a tick asked after its freeze, or a payload with deposits could still reach it. */
export function thawProblems(triggers, self) {
  const others = triggers.filter((t) => lower(t.trigger) !== lower(self) && lower(t.inbox) === lower(INBOX));
  return [...othersCrediting(triggers, self).map((x) => `${x} credits deposits: freeze it first`),
    ...others.filter((t) => t.credits > 0).map((t) => `application ${t.app} has credited ${t.credits} deposits: forward-fix only, never thaw`),
    ...others.filter((t) => t.withdrawOnly && !(t.lastClockBlock > t.freezeBlock)).map((t) => `application ${t.app} has applied no tick asked after its freeze: send it a sync`)];
}

/** What a trigger implementation runs, from whether its code is this source's BookClockTrigger and its WithdrawOnlyBookClockTrigger.
 * Both at once means the two were built to one code (a stale or edited build), and then a crediting trigger would read as frozen. */
export function codeName(book, frozen) {
  if (book && frozen) throw new Error("BookClockTrigger and WithdrawOnlyBookClockTrigger build to the same code: rebuild them (forge build in adapters/vela/stack/contracts)");
  return book ? "BookClockTrigger" : frozen ? "WithdrawOnlyBookClockTrigger" : "unknown";
}

/** The manager's copy of the guest, read over `railway ssh` with the owner's CLI: true only if sha256sum prints the guest's SHA-256
 * for exactly that path. */
export function blobInPlace(sha, { project, blobs = RAILWAY.blobs, run = (c, args) => spawnSync(c, args, { encoding: "utf8", timeout: 120_000 }) }) {
  if (!project) throw new Error("the Railway project of the manager is required (--railway-project)");
  const path = `${blobs}/${sha}.wasm`;
  const r = run("railway", ["ssh", "-p", project, "-s", RAILWAY.manager, "sha256sum", path]);
  return r.status === 0 && String(r.stdout).split("\n").some((line) => line.trim() === `${sha}  ${path}`);
}

// ---------------------------------------------------------------- chain reads

export function client(url, batch = true) {
  return createPublicClient({ transport: http(url, { batch, retryCount: 3, retryDelay: 1000, timeout: 30_000 }) });
}
export function artifact(name) {
  const at = new URL(`contracts/build/out/${name}.sol/${name}.json`, import.meta.url);
  try { return JSON.parse(readFileSync(at, "utf8")); } catch { throw new Error(`${at.pathname} is missing: run forge build in adapters/vela/stack/contracts`); }
}
export const implementationOf = async (c, proxy) => lower(`0x${(await c.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT })).slice(26)}`);
export const codeIs = async (c, at, art) => lower(await c.getCode({ address: at }) ?? "0x") === runtimeOf(art, at);
const read = (c, address, functionName, args = []) => c.readContract({ address, abi: ABI, functionName, args });

/** Every log of `event` at `address` in [from, to], in 1,000-block windows (the public gateways' limit), ten at a time. */
export async function scan(c, { address, event, args, from, to }) {
  const out = [];
  for (let a = from; a <= to; a += 10_000n) {
    const windows = [];
    for (let b = a; b <= to && b < a + 10_000n; b += 1000n) windows.push(c.getLogs({ address, event, args, fromBlock: b, toBlock: b + 999n < to ? b + 999n : to }));
    for (const logs of await Promise.all(windows)) out.push(...logs);
  }
  return out;
}
/** The newest such log in [from, to], searching back from `to`. */
export async function newest(c, { address, event, args, from, to }) {
  for (let b = to; b >= from; b -= 1000n) {
    const logs = await c.getLogs({ address, event, args, fromBlock: b - 999n > from ? b - 999n : from, toBlock: b });
    if (logs.length) return logs.at(-1);
  }
  return null;
}
const appEvents = (c, app, kind, from, to) => scan(c, { address: ENDPOINT, event: ABI[0], args: { applicationId: app, eventSubType: SUB[kind] }, from, to });

/** The trigger's answer to a tick asking for deposits from index 1 and about no round, simulated as the endpoint (eth_call). */
export async function answer(c, trigger) {
  const tick = concat([1n, 1n, 0n, 0n, 0n].map((x) => padHex(toHex(x), { size: 32 })));
  const data = encodeFunctionData({ abi: ABI, functionName: "getTrustProcessPayload", args: [{ events: [tick], subTypes: [SUB.tick] }, true, true, [], []] });
  const w = words(decodeFunctionResult({ abi: ABI, functionName: "getTrustProcessPayload", data: (await c.call({ account: ENDPOINT, to: trigger, data })).data }));
  return { records: w[6], deposits: w[7] };
}

/** What the old trigger runs, and since which block it is withdraw-only. */
export async function triggerState(c, trigger, head) {
  const implementation = await implementationOf(c, trigger);
  const code = codeName(...await Promise.all([codeIs(c, implementation, artifact("BookClockTrigger")), codeIs(c, implementation, artifact("WithdrawOnlyBookClockTrigger"))]));
  const frozen = code === "WithdrawOnlyBookClockTrigger";
  const upgraded = frozen ? await newest(c, { address: trigger, event: ABI[1], args: { implementation }, from: OLD.deployBlock, to: head }) : null;
  return { implementation, code, frozen, freezeBlock: upgraded?.blockNumber };
}

/** An application's public deposit and payout records, and its newest clock record (block word = the block that asked the tick). */
export async function appRecords(c, app, from, head) {
  const [credits, payouts, clock] = await Promise.all([appEvents(c, app, "credit", from, head), appEvents(c, app, "payout", from, head),
    newest(c, { address: ENDPOINT, event: ABI[0], args: { applicationId: app, eventSubType: SUB.clock }, from, to: head })]);
  const credit = (l) => { const w = words(l.args.data); return { index: w[0], account: lower(toHex(w[1], { size: 20 })), amount: w[2], status: Number(w[3]) }; };
  const payout = (l) => { const w = words(l.args.data); return { ordinal: w[1], kind: Number(w[2]), amount: w[5] }; };
  const cw = clock && words(clock.args.data);
  return { credits: credits.map(credit), payouts: payouts.map(payout), clock: cw && { tick: cw[0], block: cw[1], timestamp: cw[2] } };
}

/** N from the chain, or the reason it cannot be proven yet (deploy-book.mjs). */
export async function provenDepositsFrom(c) {
  const head = await c.getBlockNumber();
  const [t, r, highest] = await Promise.all([triggerState(c, OLD.trigger, head), appRecords(c, OLD.app, OLD.deployBlock, head), read(c, INBOX, "highest")]);
  return proveDepositsFrom({ frozen: t.frozen, freezeBlock: t.freezeBlock, lastClockBlock: r.clock?.block, credits: r.credits, highest });
}

// ---------------------------------------------------------------- facts

async function facts(a) {
  const hz = client(HORIZEN_RPC), base = client(a["base-rpc"] ?? BASE_RPC, false);
  const [hzHead, baseHead] = await Promise.all([hz.getBlockNumber(), base.getBlockNumber()]);
  if (await hz.getChainId() !== 26514 || await base.getChainId() !== 8453) throw new Error("wrong chains");
  const failed = [];
  const check = (name, pass) => { console.log(`  ${pass ? "PASS" : "FAIL"} ${name}`); if (!pass) failed.push(name); };
  const usdc = (x) => `${(Number(x) / 1e6).toFixed(6)} USDC`, eth = (x) => `${(Number(x) / 1e18).toFixed(6)} ETH`;
  const sum = (xs) => xs.reduce((s, x) => s + x, 0n);

  console.log(`Horizen block ${hzHead}, Base block ${baseHead} (${new Date().toISOString()})`);
  const [slots, cap, apps, queue, bound, t, owner, pending, admin, highest] = await Promise.all([read(hz, ENDPOINT, "availableDeploySlots"), read(hz, ENDPOINT, "maxNumOfApplications"),
    read(hz, ENDPOINT, "getDeployedAppIds"), read(hz, ENDPOINT, "getPendingRequestsSize"), read(hz, ENDPOINT, "triggerContracts", [OLD.app]), triggerState(hz, OLD.trigger, hzHead),
    read(hz, OLD.trigger, "owner"), read(hz, OLD.trigger, "pendingOwner"), hz.getStorageAt({ address: OLD.trigger, slot: ADMIN_SLOT }), read(hz, INBOX, "highest")]);
  console.log(`endpoint: ${slots} of ${cap} deploy slots free; applications ${apps.join(", ")}; ${queue} requests pending`);
  console.log(`old trigger ${OLD.trigger}: implementation ${t.implementation} (${t.code}${t.frozen ? `, since block ${t.freezeBlock}` : ""}); owner ${lower(owner)}, pending owner ${lower(pending)}, ERC-1967 admin slot ${BigInt(admin) === 0n ? "empty (UUPS)" : admin}`);
  check("the endpoint binds the old application to the old trigger", lower(bound) === OLD.trigger);
  check("the old trigger's owner is the deployer, no handover pending", lower(owner) === DEPLOYER && BigInt(pending) === 0n);

  const inbox = await Promise.all(Array.from({ length: Number(highest) }, (_, i) => read(hz, INBOX, "deposits", [BigInt(i + 1)])));
  const [count, deposited, paid, vaultUsdc] = await Promise.all([read(base, VAULT, "depositCount"), scan(base, { address: VAULT, event: ABI[2], from: VAULT_FROM, to: baseHead }),
    scan(base, { address: VAULT, event: ABI[3], from: VAULT_FROM, to: baseHead }), read(base, USDC, "balanceOf", [VAULT])]);
  console.log(`vault: depositCount ${count}, ${deposited.length} Deposited (${usdc(sum(deposited.map((l) => l.args.amount)))}), ${paid.length} Paid (${usdc(sum(paid.map((l) => l.args.amount)))}), USDC held ${usdc(vaultUsdc)}`);
  console.log(`inbox: highest ${highest}; deliveries in flight from Base: ${count - highest}`);
  check("vault Deposited events number 1…depositCount", deposited.length === Number(count) && deposited.every((l) => l.args.index >= 1n && l.args.index <= count) && new Set(deposited.map((l) => l.args.index)).size === Number(count));
  const event = new Map(deposited.map((l) => [l.args.index, l.args]));
  check("every inbox record 1…highest is present and equals its Deposited event",
    inbox.every(([account, amount], i) => BigInt(account) !== 0n && lower(event.get(BigInt(i + 1))?.account) === lower(account) && event.get(BigInt(i + 1)).amount === amount));
  check("vault USDC ≥ Σ Deposited − Σ Paid (any surplus came in without a deposit and is credited to nobody)", vaultUsdc >= sum(deposited.map((l) => l.args.amount)) - sum(paid.map((l) => l.args.amount)));

  /** One application's books against the vault's: Σ Deposited(range) − Σ Paid(app) = credited − withdrawn + unpaid + not yet processed. */
  function books(name, app, r, low, high) {
    const paidHere = paid.filter((l) => l.args.applicationId === app);
    const paidSet = new Set(paidHere.map((l) => l.args.ordinal));
    const credited = sum(r.credits.filter((x) => x.status === 1).map((x) => x.amount)), refunded = sum(r.credits.filter((x) => x.status === 2).map((x) => x.amount));
    const withdrawn = sum(r.payouts.filter((x) => x.kind === 1).map((x) => x.amount)), unpaid = r.payouts.filter((x) => !paidSet.has(x.ordinal));
    const last = r.credits.reduce((m, x) => (x.index > m ? x.index : m), low);
    const range = deposited.filter((l) => l.args.index > low && l.args.index <= high), waiting = sum(range.filter((l) => l.args.index > last).map((l) => l.args.amount));
    console.log(`${name} application ${app}: ${r.credits.length} credit records (indexes ${r.credits.length ? `${r.credits[0].index}…${last}` : "none"}; credited ${usdc(credited)}, refunded ${usdc(refunded)}), ` +
      `${r.payouts.length} payout records (withdrawn ${usdc(withdrawn)}; ${unpaid.length} not yet paid, ${usdc(sum(unpaid.map((x) => x.amount)))}), newest clock record: ` +
      (r.clock ? `tick ${r.clock.tick} asked at block ${r.clock.block}, time ${r.clock.timestamp}` : "none"));
    console.log(`  private balances (credited − withdrawn): ${usdc(credited - withdrawn)}`);
    check(`${name}: every credit record is an index in (${low}, ${high}]`, r.credits.every((x) => x.index > low && x.index <= high));
    check(`${name}: the credit records number ${low + 1n}…${last} once each`, new Set(r.credits.map((x) => x.index)).size === r.credits.length && BigInt(r.credits.length) === last - low);
    check(`${name}: Σ Deposited(${low}, ${high}] − Σ Paid = credited − withdrawn + unpaid + not yet credited`,
      sum(range.map((l) => l.args.amount)) - sum(paidHere.map((l) => l.args.amount)) === credited - withdrawn + sum(unpaid.map((x) => x.amount)) + waiting);
  }
  const old = await appRecords(hz, OLD.app, OLD.deployBlock, hzHead);
  let n;
  try {
    n = proveDepositsFrom({ frozen: t.frozen, freezeBlock: t.freezeBlock, lastClockBlock: old.clock?.block, credits: old.credits, highest });
    console.log(`N = ${n}: depositsFrom for the new application (proven)`);
  } catch (e) { console.log(`N not proven yet: ${e.message}. The old application has processed ${old.credits.length} deposits so far.`); }
  // Once N is proven the old application's books end at N: a credit record above it would be a deposit credited twice.
  books("old", OLD.app, old, 0n, n ?? count);
  if (a.new) {
    const [id, block] = a.new.split(":").map(BigInt);
    if (n === undefined) throw new Error("--new needs the proven N");
    books("new", id, await appRecords(hz, id, block, hzHead), n, count);
  }
  const [hzEth, baseEth, baseUsdc] = [(x) => hz.getBalance({ address: x }), (x) => base.getBalance({ address: x }), (x) => read(base, USDC, "balanceOf", [x])];
  const signer = custody.signer;
  const b = await Promise.all([hzEth(DEPLOYER), baseEth(DEPLOYER), baseUsdc(DEPLOYER), hzEth(MANAGER), hzEth(HOUSE), baseEth(HOUSE), baseUsdc(HOUSE), hzEth(KEEPER_VELA), baseEth(signer), hzEth(RELAYER)]);
  console.log(`balances: deployer ${eth(b[0])} Horizen, ${eth(b[1])} + ${usdc(b[2])} Base; operator (manager) ${eth(b[3])} Horizen; house ${eth(b[4])} Horizen, ${eth(b[5])} + ${usdc(b[6])} Base; ` +
    `keeper-vela ${eth(b[7])} Horizen; payout signer ${eth(b[8])} Base; relayer ${eth(b[9])} Horizen`);
  if (failed.length) { console.error(`cutover: ${failed.length} check(s) failed`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- freeze

/** Every application's trigger that a deploy request on the endpoint ever registered (deployed or still pending; a failed deploy
 * clears its own), with the inbox it reads, whether it is withdraw-only, and the block its deploy request was submitted in. */
export async function triggersOnTheEndpoint(c, head) {
  const W = artifact("WithdrawOnlyBookClockTrigger"), B = artifact("BookClockTrigger");
  const submitted = await scan(c, { address: ENDPOINT, event: parseAbi(["event DeployRequestSubmitted(uint64 indexed applicationId, bytes32 requestId, address indexed sender)"])[0], from: OLD.deployBlock, to: head });
  const from = new Map(submitted.map((l) => [l.args.applicationId, l.blockNumber]));
  const apps = [...new Set([...(await read(c, ENDPOINT, "getDeployedAppIds")), ...submitted.map((l) => l.args.applicationId)])];
  return Promise.all(apps.map(async (app) => {
    const trigger = lower(await read(c, ENDPOINT, "triggerContracts", [app]));
    if (/^0x0{40}$/.test(trigger)) return { app, trigger, inbox: null, withdrawOnly: false };
    const inbox = await read(c, trigger, "inbox").then(lower, () => null);
    const implementation = await implementationOf(c, trigger);
    const withdrawOnly = inbox !== null && codeName(await codeIs(c, implementation, B), await codeIs(c, implementation, W)) === "WithdrawOnlyBookClockTrigger";
    return { app, trigger, inbox, withdrawOnly, from: from.get(app) ?? OLD.deployBlock };
  }));
}

async function freeze(a) { return upgrade(a, false); }
async function thaw(a) { return upgrade(a, true); }

async function upgrade(a, thawing) {
  if (a.fork && a["broadcast-mainnet"]) throw new Error("--fork or --broadcast-mainnet, not both");
  if (a.fork && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(a.fork).hostname)) throw new Error("--fork takes a loopback URL");
  const c = client(a.fork ?? HORIZEN_RPC);
  if (await c.getChainId() !== 26514) throw new Error("the node is not Horizen mainnet 26514");
  if (a.fork && !/anvil/i.test(await c.request({ method: "web3_clientVersion" }))) throw new Error("--fork needs a local Anvil");
  const mode = a.fork ? `FORK ${a.fork} (Anvil, deployer impersonated)` : a["broadcast-mainnet"] ? "Horizen mainnet: BROADCAST" : "Horizen mainnet: DRY RUN, nothing is sent";
  const trigger = lower(a.trigger ?? OLD.trigger), W = artifact("WithdrawOnlyBookClockTrigger"), B = artifact("BookClockTrigger");
  const bindings = async () => Promise.all(["owner", "pendingOwner", "processorEndpoint", "registry", "inbox", "asset", "duration"].map((f) => read(c, trigger, f).then(String).then(lower)));
  const head = await c.getBlockNumber();
  const [state, before, was] = await Promise.all([triggerState(c, trigger, head), bindings(), answer(c, trigger)]);
  console.log(`${mode}\ntrigger ${trigger}: implementation ${state.implementation} (${state.code}), owner ${before[0]}; a tick asking from deposit 1 gets ${was.records} registry records and ${was.deposits} deposit records`);
  if (!thawing && state.frozen) { console.log(`already withdraw-only since block ${state.freezeBlock}: nothing to send`); return; }
  if (thawing && state.code === "BookClockTrigger") { console.log("already BookClockTrigger: nothing to send"); return; }
  if (state.code !== (thawing ? "WithdrawOnlyBookClockTrigger" : "BookClockTrigger")) throw new Error(`the proxy does not run ${thawing ? "WithdrawOnlyBookClockTrigger" : "BookClockTrigger"}: refusing`);
  if (thawing) {
    const triggers = await triggersOnTheEndpoint(c, head);
    await Promise.all(triggers.filter((t) => t.trigger !== trigger && t.inbox === lower(INBOX)).map(async (t) => {
      const [s, r] = await Promise.all([triggerState(c, t.trigger, head), appRecords(c, t.app, t.from, head)]);
      Object.assign(t, { freezeBlock: s.freezeBlock, credits: r.credits.length, lastClockBlock: r.clock?.block });
    }));
    const problems = thawProblems(triggers, trigger);
    if (problems.length) throw new Error(`a thaw could credit a deposit twice: ${problems.join("; ")}`);
  }
  if (before[0] !== DEPLOYER || BigInt(before[1]) !== 0n) throw new Error("the trigger's owner is not the deployer, or a handover is pending");
  const [nonce, pendingNonce] = await Promise.all([c.getTransactionCount({ address: DEPLOYER, blockTag: "latest" }), c.getTransactionCount({ address: DEPLOYER, blockTag: "pending" })]);
  if (nonce !== pendingNonce) throw new Error(`the deployer has a transaction waiting (nonce ${nonce}, pending ${pendingNonce})`);

  let implementation = (a.implementation ?? (thawing ? OLD.implementation : undefined)) && lower(a.implementation ?? OLD.implementation);
  const txs = [];
  if (thawing) {
    if (!(await codeIs(c, implementation, B))) throw new Error(`${implementation} is not this source's BookClockTrigger`);
  } else if (implementation) {
    if (!(await codeIs(c, implementation, W))) throw new Error(`${implementation} is not this source's WithdrawOnlyBookClockTrigger`);
  } else {
    implementation = lower(getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce) }));
    txs.push({ label: "deploy WithdrawOnlyBookClockTrigger", data: W.bytecode.object, creates: implementation });
  }
  txs.push({ label: `upgradeToAndCall(${implementation}, 0x) on the trigger proxy`, to: trigger, data: encodeFunctionData({ abi: ABI, functionName: "upgradeToAndCall", args: [implementation, "0x"] }) });
  txs.forEach((tx, i) => { tx.nonce = nonce + i; });

  if (!a.fork && !a["broadcast-mainnet"]) {
    for (const tx of txs) {
      const gas = tx.to && txs.length > 1 ? null : await c.estimateGas({ account: DEPLOYER, to: tx.to, data: tx.data });
      console.log(`\n${tx.label}\n  from ${DEPLOYER}  nonce ${tx.nonce}  to ${tx.to ?? "(create)"}  value 0` +
        `  gas ${gas ?? "(estimated once the implementation exists)"}  maxFeePerGas ${FEES.maxFeePerGas}  maxPriorityFeePerGas ${FEES.maxPriorityFeePerGas}`);
      console.log(tx.creates ? `  data: the creation code of WithdrawOnlyBookClockTrigger in contracts/build/out (${(tx.data.length - 2) / 2} bytes, keccak256 ${keccak256(tx.data)}); creates ${tx.creates}` : `  data ${tx.data}`);
    }
    console.log("\nDry run: nothing was sent. Rehearse with --fork, then --broadcast-mainnet after the owner's go.");
    return;
  }
  let account;
  if (a.fork) await c.request({ method: "anvil_impersonateAccount", params: [DEPLOYER] });
  else account = await (await import("../../../contracts/scripts/broadcast-hybrid.mjs")).loadAccount(DEPLOYER);
  let upgradeBlock;
  for (const tx of txs) {
    const gas = (await c.estimateGas({ account: DEPLOYER, to: tx.to, data: tx.data })) * 6n / 5n;
    const hash = a.fork
      ? await c.request({ method: "eth_sendTransaction", params: [{ from: DEPLOYER, to: tx.to, data: tx.data, gas: toHex(gas), nonce: toHex(tx.nonce), type: "0x2", maxFeePerGas: toHex(FEES.maxFeePerGas), maxPriorityFeePerGas: toHex(FEES.maxPriorityFeePerGas) }] })
      : await c.request({ method: "eth_sendRawTransaction", params: [await account.signTransaction({ chainId: 26514, type: "eip1559", to: tx.to, data: tx.data, value: 0n, gas, nonce: tx.nonce, ...FEES })] });
    const rc = await c.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (rc.status !== "success") throw new Error(`${tx.label} reverted: ${hash}`);
    if (tx.creates && lower(rc.contractAddress) !== tx.creates) throw new Error(`${tx.label} landed at ${rc.contractAddress}, expected ${tx.creates}`);
    console.log(`  ${tx.label}: ${hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
    upgradeBlock = rc.blockNumber;
  }
  const [after, now, impl] = await Promise.all([bindings(), answer(c, trigger), implementationOf(c, trigger)]);
  const ok = impl === implementation && await codeIs(c, impl, thawing ? B : W) && JSON.stringify(after) === JSON.stringify(before) && (thawing || now.deposits === 0n);
  console.log(`  ${ok ? "PASS" : "FAIL"} the proxy runs ${thawing ? "BookClockTrigger" : "WithdrawOnlyBookClockTrigger"} at ${impl}, its state is unchanged, and a tick gets ${now.records} registry records and ${now.deposits} deposit records`);
  if (!ok) throw new Error("the upgrade did not verify");
  console.log(thawing ? `\n${a.fork ? "FORK" : "LIVE"}: thawed at block ${upgradeBlock}; this application credits deposits again.`
    : `\n${a.fork ? "FORK" : "LIVE"}: deposits frozen at block ${upgradeBlock}. Next (runbook step 4): wait for the old application to apply a tick asked after it, then cutover.mjs facts reads N.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: a, positionals: [command] } = parseArgs({ allowPositionals: true, options: { fork: { type: "string" }, "broadcast-mainnet": { type: "boolean" },
    trigger: { type: "string" }, implementation: { type: "string" }, new: { type: "string" }, "base-rpc": { type: "string" } } });
  const run = { facts, freeze, thaw }[command];
  if (!run) { console.error("usage: cutover.mjs facts | freeze | thaw (see the header)"); process.exit(2); }
  await run(a).catch((e) => { console.error(`cutover: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
