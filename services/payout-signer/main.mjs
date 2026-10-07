#!/usr/bin/env node
// ZEDGE payout signer (README.md). Watches the order book's public `payout` events on Horizen, checks each against the chain
// and the vault, signs it (EIP-712, domain "ZEDGE Vault") and sends the vault's withdraw on Base itself, one payout in
// flight at a time. Never prints the key. Restart-safe: what it signed and sent is journalled before it is broadcast.
//
//   node --experimental-strip-types services/payout-signer/main.mjs --settings ~/.config/zedge/payout-signer.env [--once]
//   rehearsal: add --rehearsal --manifest FILE (both RPCs in the settings must then be loopback Anvil forks)
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { privateFile } from "../keeper/journal.mjs";
import { parseOrderbookManifest } from "../../src/chain/orderbook-manifest.ts";
import { SUBTYPES, decodePayout, payoutTypedData, usdcAbi, vaultAbi } from "../../src/chain/vault.ts";

// GAS_CAP: a day's first payout to an emptied wallet measured 134,798 gas on a Base fork (new paid, day-total and balance slots).
export const POLL_MS = 2_000, GAS_CAP = 250_000n, BLOCKS_PER_READ = 1_000n, RESEND_MS = 30_000;
/** Base fee caps, wei per gas: the relayer's (server/relay.ts FEE_CAPS.base). */
export const FEES = { tip: 1_000_000n, max: 100_000_000n };
const ENDPOINT_EVENTS = parseAbi([
  "event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)",
  "event StateRootUpdate(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 oldStateRoot, bytes32 newStateRoot)",
  "event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)",
]);
const lower = (x) => String(x).toLowerCase();
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const fail = (message) => { throw Object.assign(new Error(message), { refused: true }); };

/** One payout event against the transaction that emitted it and the vault. `refuse` is final; `wait` is tried again later. */
export function checkPayout(log, ctx) {
  const p = decodePayout(log.data);
  if (!p) return { refuse: "malformed payout event" };
  if (p.applicationId !== ctx.applicationId || log.args.applicationId !== ctx.applicationId) return { refuse: "another application" };
  if (p.kind !== 1 && p.kind !== 2) return { refuse: "unknown payout kind" };
  const own = ctx.txLogs.filter((l) => l.args.applicationId === ctx.applicationId && l.args.requestId === log.args.requestId);
  if (!own.some((l) => l.eventName === "StateRootUpdate") || !own.some((l) => l.eventName === "RequestCompleted" && l.args.status === 0)) return { refuse: "not a completed state update" };
  if (/^0x0{40}$/.test(p.to) || lower(p.to) === lower(ctx.vault)) return { refuse: "invalid recipient" };
  if (p.amount === 0n) return { refuse: "zero amount" };
  if (ctx.paid) return { done: "already paid" };
  if (p.amount > ctx.maxPayout) return { wait: "above the vault's maximum payout" };
  if (ctx.paidToday + p.amount > ctx.dailyCap) return { wait: "today's payout cap reached" };
  if (ctx.vaultBalance < p.amount) return { wait: "vault balance below the amount" };
  return { payout: { applicationId: p.applicationId, ordinal: p.ordinal, account: p.account, to: p.to, amount: p.amount }, kind: p.kind };
}

/** One poll. `deps` is all chain, signing and storage access; `state` is the journal (cursor and one entry per payout). */
export async function step(deps, state) {
  const { horizen, base, sign, book, log, save } = deps, app = BigInt(book.application.id), vault = book.custody.vault.address;
  const out = [];
  // 1. New payout events up to Horizen's latest head (caps bound what a sequencer reorganisation could cost).
  const head = await horizen.head();
  const from = BigInt(state.cursor) + 1n, to = head < from + BLOCKS_PER_READ - 1n ? head : from + BLOCKS_PER_READ - 1n;
  if (to >= from) {
    for (const ev of await horizen.payoutLogs(from, to)) {
      // The record is the event's `bytes data` argument; the log's raw data is its ABI encoding (offset and length first).
      const key = `${ev.args.applicationId}:${decodePayout(ev.args.data)?.ordinal ?? `bad-${ev.transactionHash}-${ev.logIndex}`}`;
      if (state.payouts[key]) continue;
      state.payouts[key] = { status: "seen", log: { data: ev.args.data, requestId: ev.args.requestId, applicationId: String(ev.args.applicationId), tx: ev.transactionHash, block: String(ev.blockNumber) } };
    }
    state.cursor = String(to);
    await save();
  }
  // 2. Settle what is in flight; send nothing new while something is.
  const day = BigInt(Math.floor(deps.now() / 86_400_000));
  for (const [key, e] of Object.entries(state.payouts)) {
    if (e.status !== "sent") continue;
    const r = await base.receipt(e.hash);
    if (r) {
      e.status = r.status === "success" ? "paid" : (await base.paid(app, BigInt(e.payout.ordinal))) ? "paid" : "reverted";
      out.push({ key, status: e.status, hash: e.hash, block: r.blockNumber });
    } else if (await base.paid(app, BigInt(e.payout.ordinal))) { e.status = "paid"; out.push({ key, status: "paid", note: "paid by another transaction" }); }
    else if (await base.nonce("latest") > e.nonce) { e.status = "approved"; out.push({ key, status: "dropped", hash: e.hash }); } // its nonce went to another hash
    else if (deps.now() - e.sentAt > RESEND_MS) { await base.send(e.raw).catch(() => {}); e.sentAt = deps.now(); out.push({ key, status: "rebroadcast", hash: e.hash }); }
    else { await save(); return out.concat({ waiting: key }); }
    await save();
  }
  // 3. Check new events and send the next approved payout.
  for (const [key, e] of Object.entries(state.payouts)) {
    if (!["seen", "waiting", "approved"].includes(e.status)) continue;
    if (e.status !== "approved") {
      const [txLogs, paid, paidToday, vaultBalance, limits] = await Promise.all([horizen.endpointLogs(e.log.tx), base.paid(app, ordinalOf(e)), base.paidOnDay(day), base.balance(), base.limits()]);
      const c = checkPayout({ data: e.log.data, args: { applicationId: BigInt(e.log.applicationId), requestId: e.log.requestId } },
        { applicationId: app, vault, txLogs, paid, paidToday, vaultBalance, maxPayout: limits.maxPayout, dailyCap: limits.dailyPayoutCap });
      if (c.refuse || c.done) { e.status = c.refuse ? "refused" : "paid"; e.reason = c.refuse ?? c.done; out.push({ key, status: e.status, reason: e.reason, alert: Boolean(c.refuse) }); await save(); continue; }
      if (c.wait) { if (e.reason !== c.wait) out.push({ key, status: "waiting", reason: c.wait, alert: true }); e.status = "waiting"; e.reason = c.wait; await save(); continue; }
      Object.assign(e, { status: "approved", payout: { ...c.payout, applicationId: String(c.payout.applicationId), ordinal: String(c.payout.ordinal), amount: String(c.payout.amount) }, kind: c.kind });
      await save();
    }
    const p = { ...e.payout, applicationId: BigInt(e.payout.applicationId), ordinal: BigInt(e.payout.ordinal), amount: BigInt(e.payout.amount) };
    const signature = await sign.typedData(payoutTypedData(book.custody, p));
    const data = encodeFunctionData({ abi: vaultAbi, functionName: "withdraw", args: [p, signature] });
    const gas = (await base.estimate(data)) * 12n / 10n;
    if (gas > GAS_CAP) { e.status = "waiting"; e.reason = "gas above the cap"; out.push({ key, status: "waiting", reason: e.reason, alert: true }); await save(); continue; }
    const baseFee = await base.baseFee();
    if (baseFee + FEES.tip > FEES.max) { out.push({ key, status: "waiting", reason: "Base fee above the cap" }); return out; }
    const maxFeePerGas = 2n * baseFee + FEES.tip < FEES.max ? 2n * baseFee + FEES.tip : FEES.max, nonce = await base.nonce("pending");
    const raw = await sign.transaction({ chainId: 8453, type: "eip1559", to: vault, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: FEES.tip, nonce });
    // Journalled before the broadcast: a restart finds this hash on chain, or sends these same bytes again.
    Object.assign(e, { status: "sent", raw, hash: keccak256(raw), nonce, sentAt: deps.now() });
    await save();
    await base.send(raw).catch((error) => log({ key, sendError: String(error?.shortMessage ?? error?.message).slice(0, 120) }));
    out.push({ key, status: "sent", hash: e.hash, to: p.to, amount: e.payout.amount, kind: e.kind });
    return out; // one in flight
  }
  return out;
}
const ordinalOf = (e) => decodePayout(e.log.data)?.ordinal ?? 0n;

// ---------------------------------------------------------------- process: settings, key, chain access, journal, loop

function lock(path) {
  try { const fd = openSync(path, "wx", 0o600); writeSync(fd, String(process.pid)); closeSync(fd); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    let alive; try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === "EPERM"; }
    if (alive) fail(`another payout signer (pid ${pid}) holds ${path}`);
    unlinkSync(path); return lock(path);
  }
  process.on("exit", () => { try { unlinkSync(path); } catch { /* gone */ } });
}

async function main(argv) {
  const { values: a } = parseArgs({ args: argv, options: { settings: { type: "string", default: `${homedir()}/.config/zedge/payout-signer.env` }, once: { type: "boolean" },
    rehearsal: { type: "boolean" }, manifest: { type: "string" } } });
  if (a.manifest && !a.rehearsal) fail("--manifest is for --rehearsal only; mainnet reads the committed manifest");
  const bytes = await privateFile(resolve(a.settings)).catch(() => fail(`${a.settings}: a private (0600) settings file is required`));
  const env = parseEnv(bytes.toString()); bytes.fill(0);
  const urls = { horizen: env.PAYOUT_SIGNER_HORIZEN_RPC_URL || "https://26514.rpc.thirdweb.com", base: env.PAYOUT_SIGNER_BASE_RPC_URL || "https://base-rpc.publicnode.com" };
  if (/calderachain/i.test(urls.horizen)) fail("use the thirdweb gateway or a private endpoint, never the operator's Caldera endpoint");
  const book = parseOrderbookManifest(JSON.parse(await readFile(a.manifest ?? new URL("../../public/deployments/26514-orderbook.json", import.meta.url), "utf8")));
  if (book.status !== "configured") fail("the order-book manifest is planned: nothing to pay yet");
  const clients = Object.fromEntries(Object.entries(urls).map(([k, u]) => [k, createPublicClient({ transport: http(u, { timeout: 10_000, retryCount: 1 }) })]));
  for (const [k, id] of [["horizen", 26514], ["base", 8453]]) {
    if (await clients[k].getChainId() !== id) fail(`${k}: wrong chain`);
    if (a.rehearsal && !(/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(urls[k]) && /anvil/i.test(await clients[k].request({ method: "web3_clientVersion" })))) fail(`--rehearsal: ${k} must be a loopback Anvil fork`);
  }
  const keyBytes = await privateFile(resolve(env.PAYOUT_SIGNER_KEY_FILE || `${homedir()}/.config/zedge/payout-signer.key`)).catch(() => fail("payout signer key: a private (0600) key file is required"));
  const key = keyBytes.toString().trim(); keyBytes.fill(0);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("payout signer key: expected 0x and 64 hex digits");
  const account = privateKeyToAccount(key);
  if (lower(account.address) !== book.custody.vault.signer) fail(`the key is not the vault's payout signer ${book.custody.vault.signer}`);
  const directory = resolve(env.PAYOUT_SIGNER_STATE_DIRECTORY || `${homedir()}/.config/zedge/payout-signer-state`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock(`${directory}/signer.lock`);
  const file = `${directory}/${a.rehearsal ? "rehearsal-" : ""}${book.application.id}.json`;
  const state = await readFile(file, "utf8").then(JSON.parse, () => null) ?? { cursor: String(BigInt(book.application.deployBlock) - 1n), payouts: {} };
  const save = async () => { await writeFile(`${file}.next`, json(state), { mode: 0o600 }); await rename(`${file}.next`, file); };

  const endpoint = book.endpoint.address, vault = book.custody.vault.address, usdc = book.custody.usdc.address, app = BigInt(book.application.id);
  const deps = {
    book, save, now: Date.now, log: (x) => console.log(json({ t: new Date().toISOString(), ...x })),
    horizen: {
      head: () => clients.horizen.getBlockNumber(),
      payoutLogs: (fromBlock, toBlock) => clients.horizen.getLogs({ address: endpoint, event: ENDPOINT_EVENTS[0], args: { applicationId: app, eventSubType: SUBTYPES.payout }, fromBlock, toBlock }),
      endpointLogs: async (hash) => parseEventLogs({ abi: ENDPOINT_EVENTS, logs: (await clients.horizen.getTransactionReceipt({ hash })).logs.filter((l) => lower(l.address) === endpoint) }),
    },
    base: {
      paid: (applicationId, ordinal) => clients.base.readContract({ address: vault, abi: vaultAbi, functionName: "paid", args: [applicationId, ordinal] }),
      paidOnDay: (day) => clients.base.readContract({ address: vault, abi: vaultAbi, functionName: "paidOnDay", args: [day] }),
      limits: () => clients.base.readContract({ address: vault, abi: vaultAbi, functionName: "limits" }),
      balance: () => clients.base.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [vault] }),
      estimate: (data) => clients.base.estimateGas({ account: account.address, to: vault, data }),
      baseFee: async () => (await clients.base.getBlock()).baseFeePerGas ?? 0n,
      nonce: (blockTag) => clients.base.getTransactionCount({ address: account.address, blockTag }),
      send: (raw) => clients.base.request({ method: "eth_sendRawTransaction", params: [raw] }),
      receipt: (hash) => clients.base.getTransactionReceipt({ hash }).catch(() => null),
    },
    sign: { typedData: (d) => account.signTypedData(d), transaction: (tx) => account.signTransaction(tx) },
  };
  deps.log({ status: "running", signer: lower(account.address), vault, application: book.application.id, cursor: state.cursor, rehearsal: Boolean(a.rehearsal) });
  let stopping = false;
  for (const s of ["SIGINT", "SIGTERM"]) process.once(s, () => { stopping = true; });
  for (let errors = 0; !stopping;) {
    try { for (const line of await step(deps, state)) deps.log(line); errors = 0; }
    catch (e) { if (e.refused || ++errors >= 30) throw e; deps.log({ status: "error", message: String(e?.shortMessage ?? e?.message).slice(0, 160) }); }
    if (a.once) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(`payout-signer: ${e.refused ? e.message : (e.stack ?? e.message)}`); process.exit(1); });
}
