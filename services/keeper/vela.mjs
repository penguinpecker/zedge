// The keeper's order-book lane (guest v4, README "Order-book lane"). At each 15-minute boundary B it sends the exact
// Chainlink BTC report (observationsTimestamp == B) to the order book as an encrypted PROCESS request: the guest checks
// the DON signatures itself and, in one transition, resolves the round ending at B, pays its winners, opens the round
// starting at B and creates the next slots. Then one sync at B + 45 s (the registry's record confirms the round) and one
// a few seconds after the Horizen inbox records a new Base deposit (the trigger carries it to the engine).
// Its own Horizen wallet (KEEPER_VELA_KEY_FILE): it never shares a nonce with the registry lane. Anyone may submit a
// report; a copy of the exact-second report is byte-identical whoever relays it, so the submitter has no choice of price.
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEventLogs, toHex } from 'viem';

const D = 900, FIRST = 1, LAST = 60, CONFIRM = 45, DEBOUNCE = 5, INBOX_EVERY = 2;
const PROCESS = 1, ASSOCIATEKEY = 3, PUB_KEY_NOT_REGISTERED = 9;
const FEES = { tip: 1_000_000n, max: 3_000_000n }, GAS_CAP = 2_400_000n; // Horizen, as the relayer's (server/relay.ts)
export const ENDPOINT_ABI = parseAbi([
  'function submitRequest(uint8 protocolVersion, uint64 applicationId, uint8 requestType, bytes payload, address tokenAddress, uint256 assetAmount, uint256 maxFeeValue) payable returns (bytes32)',
  'function minFeePerRequest() view returns (uint256)',
  'event RequestSubmitted(uint64 indexed applicationId, bytes32 indexed requestId, address indexed sender, address facilitator)',
  'event RequestCompleted(uint64 indexed applicationId, bytes32 indexed requestId, uint256 applicationFees, uint8 status, uint8 errorCode, string errorMessage)',
  'event UserEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes encryptedData)',
  'event AppEvent(uint64 indexed applicationId, bytes32 indexed requestId, bytes32 indexed eventSubType, bytes data)',
]);
const INBOX_ABI = parseAbi(['function highest() view returns (uint64)']);
const SETTLE = '0x9724dc1f896290cab5003edb2c481613b0c459f9303c263ec7329d4cb9a96b8a'; // SHA-256("zedge.vela.settle.v1")
// A refusal that sending the same report again cannot change.
const FINAL_REFUSAL = /already applied|nothing to apply/;

/** The schedule, with every chain access passed in (tests run it on fakes). Call tick() about once a second; it sends at
 * most one request per call and returns status lines. `send(kind, copy)` returns once the request is in a block:
 * { hash, requestId, block }. `completion(sent)` returns null until the endpoint completed it, then
 * { status, errorMessage, receipt: { status, reason } | null, settles }. */
export function createSchedule({ now, feedId, report, send, completion, highest }) {
  const boundaries = new Map(), open = [];
  let seen, syncDue = 0, polled = 0;
  const at = (b) => { if (!boundaries.has(b)) { boundaries.set(b, {}); if (boundaries.size > 8) boundaries.delete(boundaries.keys().next().value); } return boundaries.get(b); };
  const sent = async (kind, b, copy) => {
    const s = await send(kind, copy);
    open.push({ kind, boundary: b, ...s, sentAt: now() });
    return { vela: kind, boundary: b, tx: s.hash, requestId: s.requestId, block: s.block, afterBoundary: Math.round(now() / 1000 - b) };
  };
  return async function tick() {
    const t = now() / 1000, b = Math.floor(t / D) * D, r = at(b), lines = [];
    // Completions of what was sent: status lines, and one more try of a refused report while its window is open.
    for (const o of [...open]) {
      const c = await completion(o);
      if (!c) { if (now() - o.sentAt > 300_000) open.splice(open.indexOf(o), 1); continue; }
      open.splice(open.indexOf(o), 1);
      lines.push({ vela: `${o.kind} completed`, boundary: o.boundary, requestId: o.requestId, status: c.status === 0 ? 'completed' : `failed: ${c.errorMessage}`,
        receipt: c.receipt && `${c.receipt.status}${c.receipt.reason ? `: ${c.receipt.reason}` : ''}`, settles: c.settles, afterBoundary: Math.round(t - o.boundary) });
      const refused = c.status !== 0 || c.receipt?.status === 'rejected' && !FINAL_REFUSAL.test(c.receipt.reason ?? '');
      if (o.kind === 'report' && refused) { const q = at(o.boundary); if (!q.retried) { q.retried = true; q.report = undefined; } }
    }
    if (!r.report && t >= b + FIRST && t <= b + LAST) {
      // window 0: only a report observed at the boundary second itself. Not posted yet is a wait, not an error.
      const copy = await report(feedId, b, 0).catch(() => null);
      if (copy && copy.observation.observationsTimestamp === b) {
        r.report = true;
        lines.push({ ...(await sent('report', b, copy)), seenAfter: Math.round(t - b) });
        return lines;
      }
    }
    if (!r.sync && t >= b + CONFIRM) { r.sync = true; lines.push(await sent('sync', b)); return lines; }
    if (t - polled >= INBOX_EVERY) {
      polled = t;
      const h = await highest();
      if (seen !== undefined && h > seen) syncDue = t + DEBOUNCE;
      seen = h;
    }
    if (syncDue && t >= syncDue) { syncDue = 0; lines.push({ ...(await sent('sync', b)), reason: 'deposit' }); }
    return lines;
  };
}

/** The lane's chain side: its session (unlocked from one signature of its wallet), submission and completion reads. */
export async function connectVela({ book, account, url, rehearsal = false }) {
  const crypto = new URL('../../adapters/vela/crypto/', import.meta.url);
  const [{ EvaluationSession }, codec, { padBody }] = await Promise.all([import(new URL('session.ts', crypto)), import(new URL('guest.ts', crypto)), import(new URL('pad.ts', crypto))]);
  const client = createPublicClient({ transport: http(url, { timeout: 30_000, retryCount: 1 }) });
  if (await client.getChainId() !== 26514) throw new Error('KEEPER_VELA_CHAIN');
  if (rehearsal && !/anvil/i.test(await client.request({ method: 'web3_clientVersion' }))) throw new Error('KEEPER_VELA_REHEARSAL');
  const endpoint = book.endpoint.address, app = BigInt(book.application.id), me = account.address.toLowerCase();
  const fee = await client.readContract({ address: endpoint, abi: ENDPOINT_ABI, functionName: 'minFeePerRequest' });
  if (fee > 1_000_000_000n) throw new Error('KEEPER_VELA_FEE');
  const domain = { chainId: 26514, endpoint, applicationId: book.application.id, applicationFingerprint: book.application.wasmSha256, rulesHash: book.application.sessionRulesHash, origin: book.application.origin };
  const session = new EvaluationSession(domain, me, { id: book.application.epoch, enclavePublicKey: book.authenticator.enclavePublicKey });
  // The P-521 data key is derived from one signature of this wallet: nothing more to store.
  await session.unlock({ getAddress: async () => account.address, signMessage: (m) => account.signMessage({ message: typeof m === 'string' ? m : { raw: m } }) });
  const idOf = (kind, copy) => kind === 'report' ? codec.reportRequestId(me, copy.observation.observationsTimestamp) : codec.syncRequestId(me);

  async function submit(type, payload) {
    const data = encodeFunctionData({ abi: ENDPOINT_ABI, functionName: 'submitRequest', args: [0, app, type, toHex(payload), '0x0000000000000000000000000000000000000000', 0n, fee] });
    const [estimate, block, nonce] = await Promise.all([client.estimateGas({ account: account.address, to: endpoint, data, value: fee }), client.getBlock(),
      client.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
    const gas = estimate * 12n / 10n, base = block.baseFeePerGas ?? 0n;
    if (gas > GAS_CAP || base + FEES.tip > FEES.max) throw new Error('KEEPER_VELA_FEE_CAP');
    const maxFeePerGas = 2n * base + FEES.tip < FEES.max ? 2n * base + FEES.tip : FEES.max;
    const raw = await account.signTransaction({ chainId: 26514, type: 'eip1559', to: endpoint, data, value: fee, gas, maxFeePerGas, maxPriorityFeePerGas: FEES.tip, nonce });
    const hash = await client.request({ method: 'eth_sendRawTransaction', params: [raw] });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 60_000 });
    const [submitted] = parseEventLogs({ abi: ENDPOINT_ABI, logs: receipt.logs.filter((l) => l.address.toLowerCase() === endpoint), eventName: 'RequestSubmitted' });
    if (receipt.status !== 'success' || !submitted) throw new Error('KEEPER_VELA_SUBMIT');
    return { hash, requestId: submitted.args.requestId, block: Number(receipt.blockNumber) };
  }
  const send = async (kind, copy) => {
    const id = idOf(kind, copy), body = kind === 'report' ? codec.reportBody(copy.payload) : codec.syncBody();
    return { ...(await submit(PROCESS, await session.encryptCommand(id, padBody(session, id, body)))), id };
  };
  async function completion(o) {
    const [done] = await client.getLogs({ address: endpoint, event: ENDPOINT_ABI[3], args: { applicationId: app, requestId: o.requestId }, fromBlock: BigInt(o.block) });
    if (!done) return null;
    const logs = parseEventLogs({ abi: ENDPOINT_ABI, logs: (await client.getTransactionReceipt({ hash: done.transactionHash })).logs.filter((l) => l.address.toLowerCase() === endpoint) });
    let receipt = null;
    for (const e of logs.filter((l) => l.eventName === 'UserEvent' && l.args.requestId === o.requestId)) {
      const r = await session.decryptReceipt(Buffer.from(e.args.encryptedData.slice(2), 'hex'), o.id);
      if (r.status === 'readable') receipt = { status: r.envelope.body.status, reason: r.envelope.body.reason };
    }
    return { status: done.args.status, errorCode: done.args.errorCode, errorMessage: done.args.errorMessage, receipt,
      settles: logs.filter((l) => l.eventName === 'AppEvent' && l.args.eventSubType === SETTLE).length };
  }
  return { codec, client, me, submit, send, completion, register: async () => submit(ASSOCIATEKEY, await session.associationPayload()) };
}

/** The real lane: the order-book manifest, the lane's own wallet (a viem account), Horizen, and the keeper's report source. */
export async function startVela({ book, account, url, streams, rehearsal = false, print, now = Date.now }) {
  const { codec, client, me, send, completion, register } = await connectVela({ book, account, url, rehearsal });
  if (typeof codec.reportBody !== 'function' || typeof codec.reportRequestId !== 'function') throw new Error('KEEPER_VELA_CODEC');
  // First start: register the lane's key with the operator when a sync says it has none.
  const probe = await send('sync');
  let first;
  for (const end = now() + 180_000; !(first = await completion(probe)) && now() < end;) await new Promise((r) => setTimeout(r, 2000));
  if (first?.errorCode === PUB_KEY_NOT_REGISTERED) {
    print({ vela: 'key registered', tx: (await register()).hash });
  }
  print({ vela: 'running', sender: me, application: book.application.id, firstSync: first ? (first.status === 0 ? 'completed' : `failed: ${first.errorMessage}`) : 'pending' });
  return createSchedule({ now, feedId: book.application.chainlink.feedId, report: (f, b, w) => streams.report(f, b, w), send, completion,
    highest: () => client.readContract({ address: book.custody.inbox.address, abi: INBOX_ABI, functionName: 'highest' }) });
}

/** Runs the lane until stopped: one tick a second, a failed tick logged by code and tried again. */
export async function runVela(tick, { stopped, sleep, print }) {
  while (!stopped()) {
    try { for (const line of await tick()) print(line); }
    catch (error) { print({ vela: 'waiting', code: /^[A-Z_]+$/.test(error?.message) ? error.message : 'KEEPER_VELA_RPC' }); }
    await sleep(1000);
  }
}
