#!/usr/bin/env node
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { StreamsClient, requireCondition, validateBoundary } from './streams.mjs';
import { SolanaReports, withFallback } from './solana.mjs';
import { Journal, privateFile, encodeJSON, spent, FINAL, DAILY_MAXIMUM } from './journal.mjs';
import { createChainAccess, sendOnce, reconcile, held, heldUntil, defaultStateDirectory } from './chain.mjs';
import { MARKETS, schedules, chooseAction, orderedActions } from './lifecycle.mjs';
import { classify } from './errors.mjs';

const registry = 'StreamsRoundRegistry';
const source = 'BaseStreamsPublisher';
const destination = 'HorizenStreamsOracle';
const MAX_REVERTS = 5; // on-chain reverts of one intent per rolling day before it is left alone
const MAX_RESENDS = 4; // relays of one stored observation per rolling day
const RESEND_AFTER = 60; // seconds an observation may sit on Base undelivered before the first relay; doubles per relay
const LOOK = 2700, LOOK_EVERY = 15000; // a new state directory reads this many seconds of older boundaries (three BTC rounds) in one look, at most this often
const OPENING_RETRY = 15000; // longest wait between tries of an action an opening depends on (its window is 210 s)
const SETTLED = 180; // seconds a round's phase must have stood before reads of it are spared; until then a reorganisation could still undo it
const GIVE_UP = 120; // seconds after its void time, and of this process's own attempts, before the keeper voids an opened round (Voidable rounds)
const IN_FLIGHT = 90; // seconds a publication or relay may still be on its way to Horizen: no void before it is this old
const UNMINED = 600; // longest the keeper's own publications or relays of a price that are not yet settled hold its void, from the first signed
const LOOK_END = 7 * 86400 + 960; // how far back a new state directory looks for opened rounds still pending (lookBack)
// Publishing, relaying and recording an opening price race the opening window. Resolution and void have no deadline,
// and a round is created minutes ahead of its start.
const urgent = action => action.kind !== 'create' && action.deadline < Number.MAX_SAFE_INTEGER;
const present = o => o && o.reportHash !== `0x${'0'.repeat(64)}`;
const number = n => { const v = Number(n); requireCondition(Number.isSafeInteger(v) && v >= 0, 'KEEPER_INTEGER'); return v; };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const iso = ms => new Date(ms).toISOString();

export function options(argv) {
  const mode = argv[0] ?? '--plan';
  requireCondition(['--plan', '--check-public', '--run-once', '--watch'].includes(mode), 'KEEPER_MODE');
  const result = { mode, directory: defaultStateDirectory, rehearsal: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--rehearsal' && !result.rehearsal) { result.rehearsal = true; continue; }
    requireCondition(['--secrets', '--state-directory'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'KEEPER_ARGUMENT');
    const field = argv[i] === '--secrets' ? 'secrets' : 'directory'; requireCondition(field !== 'secrets' || !result.secrets, 'KEEPER_ARGUMENT');
    result[field] = resolve(argv[++i]);
  }
  // A rehearsal takes its fork endpoints from the same private file, so it needs one in every mode.
  requireCondition(!['--run-once', '--watch'].includes(mode) && !result.rehearsal || result.secrets, 'KEEPER_SECRETS_REQUIRED');
  return result;
}

export async function settings(option) {
  const bytes = await privateFile(option.secrets);
  try {
    const env = parseEnv(bytes.toString()), rpc = {};
    // Optional operator endpoints. They may embed an access key, so they live here and are never printed.
    for (const chain of ['base', 'horizen']) { const url = env[`KEEPER_${chain.toUpperCase()}_RPC_URL`]; if (url) rpc[chain] = url; }
    if (!['--run-once', '--watch'].includes(option.mode)) return { rpc }; // read-only modes never build a signer
    requireCondition(/^(?:0x)?[0-9a-fA-F]{64}$/.test(env.KEEPER_PRIVATE_KEY ?? ''), 'KEEPER_PRIVATE_KEY');
    const account = privateKeyToAccount(`0x${env.KEEPER_PRIVATE_KEY.replace(/^0x/i, '')}`);
    requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.KEEPER_ADDRESS ?? '') && same(account.address, env.KEEPER_ADDRESS), 'KEEPER_ADDRESS');
    const budgets = {};
    for (const chain of ['base', 'horizen']) {
      // The most this chain may cost in any rolling 24 hours. It refills as old spending leaves the window.
      const v = env[`KEEPER_${chain.toUpperCase()}_DAILY_BUDGET_WEI`]; requireCondition(/^[1-9][0-9]{0,18}$/.test(v ?? ''), 'KEEPER_BUDGET_CONFIG');
      budgets[chain] = BigInt(v); requireCondition(budgets[chain] <= DAILY_MAXIMUM[chain], 'KEEPER_BUDGET_CONFIG');
    }
    // Where signed reports come from: the paid Data Streams API (the default), or the copies of the same reports in
    // public Solana transactions (solana.mjs), which needs no credentials; with credentials as well, the paid API
    // stands behind the copies (withFallback). Either way each one is checked here and by the Base adapter before
    // anything is signed.
    const source = env.KEEPER_REPORT_SOURCE ?? 'chainlink';
    requireCondition(['chainlink', 'solana'].includes(source), 'KEEPER_REPORT_SOURCE');
    const origin = option.rehearsal && env.KEEPER_STREAMS_ORIGIN ? { origin: env.KEEPER_STREAMS_ORIGIN } : {};
    const paid = () => new StreamsClient({ username: env.CHAINLINK_STREAMS_USERNAME, secret: env.CHAINLINK_STREAMS_SECRET, ...origin });
    if (source === 'chainlink') return { rpc, account, budgets, streams: paid() };
    const free = new SolanaReports({ url: env.KEEPER_SOLANA_RPC_URL || undefined });
    return { rpc, account, budgets, streams: env.CHAINLINK_STREAMS_USERNAME || env.CHAINLINK_STREAMS_SECRET ? withFallback(free, paid()) : free };
  } finally { bytes.fill(0); }
}

// The head of one chain and any number of views of it ([contract, function, arguments]). Through Multicall3 that is
// one eth_call and one block (chain.mjs, aggregate); on a chain without it, one batched request as before.
async function look(access, chain, calls) {
  const one = await access.aggregate?.(chain, calls);
  if (one) return one;
  const [block, ...results] = await Promise.all([access.clients[chain].getBlock(), ...calls.map(call => access.read(...call))]);
  return { number: block.number, timestamp: block.timestamp, results };
}

// The registry's own phase for every round in view, and what the Horizen cache holds for their boundaries, in one
// read. Round ids never change, so they are asked once. A phase is read again only while it can change:
//   Scheduled                                       not before its start
//   Trading or Closed                               not before its end (no decision here tells the two apart)
//   everything else                                 on every tick
// and, whatever it is, on every tick until it has stood for SETTLED seconds: until then a reorganisation could
// still take back the transaction that made it so. Resolved, Voided and Missing are in "everything else": a
// reorganisation of somebody else's transaction, however deep, shows only there (one of the keeper's own also
// shows as KEEPER_REORGANISED), and through Multicall3 those reads ride in the call made anyway. The host clock
// stands in for chain time with a minute to spare, because a view whose head is further than that from the host
// clock is refused below.
export async function discover(access, persisted = {}, lookBack = 4800) {
  const wall = Math.floor(Date.now() / 1000), name = s => `${s.asset}:${s.duration}:${s.start}`;
  const specs = new Map(schedules(wall, lookBack).map(s => [name(s), s]));
  for (const spec of Object.values(persisted)) {
    requireCondition([0, 1].includes(spec.asset) && [300, 900].includes(spec.duration) && Number.isSafeInteger(spec.start), 'KEEPER_PERSISTED_ROUND');
    // A round of another market (an earlier build worked all four) stays on record and is left alone.
    if (MARKETS.some(m => m.asset === spec.asset && m.duration === spec.duration)) specs.set(name(spec), spec);
  }
  requireCondition(specs.size <= 1024, 'KEEPER_ACTIVE_CAPACITY');
  const memo = access.rounds ??= new Map(), entries = [...specs.values()], unknown = entries.filter(s => !memo.has(name(s)));
  if (unknown.length) {
    const ids = (await look(access, 'horizen', unknown.map(s => [registry, 'roundIdFor', [s.asset, s.duration, BigInt(s.start)]]))).results;
    for (const [i, s] of unknown.entries()) memo.set(name(s), { roundId: ids[i] });
  }
  for (const key of memo.keys()) if (!specs.has(key)) memo.delete(key);
  const feedOf = s => access.config.feeds[s.asset === 0 ? 'btcFeedId' : 'ethFeedId'], known = s => memo.get(name(s));
  const due = entries.filter(s => !(wall + 60 < known(s).until && wall - 60 >= known(s).since + SETTLED));
  // With the phases, what the cache holds for the boundary each of those rounds will be waiting on if it has moved
  // on as expected (its start until it is opened; its end after that, and for a round never read before), so that
  // phase and cache are answers from the same block.
  const expected = s => [known(s).phase < 3 ? s.start : s.start + s.duration];
  const observation = key => [destination, 'getObservation', [key.slice(0, 66), BigInt(key.slice(67))]];
  const bounds = [...new Set(due.flatMap(s => expected(s).filter(b => b <= wall + 60).map(b => `${feedOf(s)}:${b}`)))];
  const head = await look(access, 'horizen', [...due.map(s => [registry, 'phase', [known(s).roundId]]), ...bounds.map(observation)]);
  const now = number(head.timestamp);
  // A head far from the host clock is a lagging endpoint, a paused sequencer or a wrong host clock: wait, do not act on it.
  requireCondition(Math.abs(wall - now) <= 60, 'KEEPER_CHAIN_CLOCK');
  for (const [i, s] of due.entries()) {
    const phase = head.results[i], m = known(s);
    requireCondition(Number.isInteger(phase) && phase >= 0 && phase <= 8, 'KEEPER_PHASE');
    if (phase !== m.phase) Object.assign(m, { phase, since: now, openedAt: undefined });
    m.until = phase === 1 ? s.start : phase === 3 || phase === 4 ? s.start + s.duration : 0;
  }
  // Voidable says one of two things: nobody recorded the opening in time, or an opened round's closing price is past
  // its void time. Only the round itself says which (openedAt), and for as long as it stays Voidable that cannot change.
  const unsure = due.filter(s => known(s).phase === 8 && known(s).openedAt === undefined);
  if (unsure.length) for (const [i, round] of (await look(access, 'horizen', unsure.map(s => [registry, 'getRound', [known(s).roundId]]))).results.entries()) known(unsure[i]).openedAt = number(round.openedAt);
  const cache = new Map(bounds.map((key, i) => [key, present(head.results[due.length + i])]));
  const rounds = entries.map(spec => ({ ...spec, end: spec.start + spec.duration, roundId: known(spec).roundId, phase: known(spec).phase, openedAt: known(spec).openedAt, feedId: feedOf(spec) }));
  // A round that is somewhere else than expected (a long gap between reads, a reorganisation) waits on a boundary not asked for above: ask now.
  const late = wanted({ rounds }).map(w => `${w.feedId}:${w.boundary}`).filter(key => !cache.has(key));
  if (late.length) for (const [i, o] of (await look(access, 'horizen', late.map(observation))).results.entries()) cache.set(late[i], present(o));
  return { now, block: Number(head.number), cache, rounds };
}

// A new state directory knows only the rounds of the last 80 minutes. An opened round that was never resolved can
// still hold funds however old it is: awaiting resolution with its closing price cached, or Voidable. So a new
// directory also walks back seven days (LOOK_END, a fixed recovery depth; it was the void grace until 2026-10-06),
// newest first, and tracks every such round. That is 672 rounds, read three at a time and never more often than
// every 15 seconds (about an hour in all), so a rate-limited endpoint sees no burst on top of a boundary. The
// position, and where the walk ends (fixed by its first look, so that the hours it takes do not move the end past
// rounds that were pending when it began), are kept in the journal: a restart carries on where the walk was.
async function lookBack(access, journal, world, now) {
  const data = journal.data;
  if (Date.now() - (world.looked ?? 0) < LOOK_EVERY || Object.keys(data.activeRounds).length >= 512) return;
  world.looked = Date.now();
  data.catchUpEnd ??= now - LOOK_END;
  const top = Math.min(data.catchUp, Math.ceil((now - 4800) / 900) * 900), specs = [];
  for (const { asset, duration } of MARKETS) for (let start = top - duration; start >= top - LOOK && start > 0; start -= duration) specs.push({ asset, duration, start });
  const ids = (await look(access, 'horizen', specs.map(s => [registry, 'roundIdFor', [s.asset, s.duration, BigInt(s.start)]]))).results;
  const phases = (await look(access, 'horizen', ids.map(id => [registry, 'phase', [id]]))).results;
  // An opened Voidable one is still worked (Voidable rounds); one nobody opened holds nothing and is left alone.
  // Only the round itself says which.
  const voidable = ids.filter((id, i) => phases[i] === 8);
  const opened = new Set(voidable.length ? (await look(access, 'horizen', voidable.map(id => [registry, 'getRound', [id]]))).results.flatMap((round, i) => number(round.openedAt) ? [voidable[i]] : []) : []);
  for (const [i, spec] of specs.entries()) if (phases[i] === 5 || opened.has(ids[i])) data.activeRounds[ids[i]] = spec;
  data.catchUp = top - LOOK;
  if (data.catchUp <= data.catchUpEnd) { delete data.catchUp; delete data.catchUpEnd; }
  await journal.save();
}

// The boundary a round is waiting on: its start while the opening is pending, its end once it awaits resolution,
// also when that is past its void time and the registry calls the opened round Voidable.
const boundaryOf = round => round.phase === 2 ? round.start : round.phase === 5 || round.phase === 8 && round.openedAt !== 0 ? round.end : 0;
function wanted(view) {
  const list = new Map();
  for (const round of view.rounds) { const boundary = boundaryOf(round); if (boundary) list.set(`${round.feedId}:${boundary}`, { feedId: round.feedId, boundary }); }
  return [...list.values()];
}
// The Base head and which of the wanted observations are stored on Base.
async function published(access, list) {
  const head = await look(access, 'base', list.map(w => [source, 'getObservation', [w.feedId, BigInt(w.boundary)]]));
  return { head, source: new Map(list.map((w, i) => [`${w.feedId}:${w.boundary}`, present(head.results[i])])) };
}

// cache / source: which wanted observations Horizen / Base hold, or undefined when that chain could not be read.
// Registry calls need a current view and, to open or resolve, the cache answer. Publishing needs only Base to say
// that nobody has published; relaying also needs Horizen to say the observation is still missing there.
// gone: closing boundaries of opened Voidable rounds the keeper gives up on this tick (step, Voidable rounds).
export function plan(view, cache, source, gone) {
  const horizen = [], base = new Map();
  for (const round of view.rounds) {
    const key = `${round.feedId}:${boundaryOf(round)}`;
    const action = chooseAction(round, view.now, cache?.get(key) === true, source?.get(key) === true, gone?.has(key) === true);
    if (!action) continue;
    if (['publish', 'await-delivery'].includes(action.kind)) {
      // One action per boundary, however many rounds want it; it is as urgent as the most urgent of them.
      if (source && (cache || action.kind === 'publish')) base.set(key, { ...action, deadline: Math.min(action.deadline, base.get(key)?.deadline ?? Infinity),
        feedId: round.feedId, id: `${action.kind === 'publish' ? 'publish' : 'resend'}:${key}` });
    } else if (!view.stale) horizen.push({ ...round, ...action, id: `${action.kind}:${round.asset}:${round.duration}:${round.start}` });
  }
  // Newest boundary first on Base: it opens a round inside a short window; older ones only settle, without a deadline.
  return { horizen: orderedActions(horizen), base: [...base.values()].sort((a, b) => b.boundary - a.boundary) };
}

export async function nextActions(access, snapshot) {
  const { horizen, base } = plan(snapshot, snapshot.cache, (await published(access, wanted(snapshot))).source);
  return [...base, ...horizen];
}

// One tick. Each chain has its own lane: its own verification, reconciliation, backoff and at most one new
// transaction, and neither lane waits for the other. `world` is what survives between ticks in memory only.
export async function step(access, journal, auth, world = {}) {
  const chains = world.chains ??= { base: { until: 0, failures: 0 }, horizen: { until: 0, failures: 0 } };
  const defer = world.defer ??= new Map(), undelivered = world.undelivered ??= new Map(), reports = world.reports ??= new Map(), feeds = world.feeds ??= new Map();
  const heads = world.heads ??= { base: null, horizen: null }, stored = world.stored ??= new Map(), skipped = world.skipped ??= new Set(), working = world.working ??= new Map();
  const dropped = world.dropped ??= new Map();
  const data = journal.data, out = { sent: [], settled: [], done: [], waiting: [], chains: {} }, seen = new Set();
  // What reconciliation closed on this tick: a transaction's final status and what it cost.
  const settle = async chain => {
    const open = data.transactions.filter(t => !FINAL.includes(t.status) && /^(publish|resend):/.test(t.key));
    for (const r of await reconcile(access, journal, chain)) {
      out.settled.push({ key: r.key, chain, hash: r.hash, status: r.status, feeWei: r.receipt.feeWei });
      // A confirmed publication or relay proves the observation is stored on Base (see the Base read below).
      if (r.status === 'confirmed' && /^(publish|resend):/.test(r.key)) stored.set(r.key.split(':').slice(1, 3).join(':'), Date.now());
    }
    // One whose nonce another hash took (a newer boundary's publication, say) was on its way until now (lastSent, below).
    for (const t of open) if (t.status === 'dropped') dropped.set(t.key.split(':').slice(1, 3).join(':'), Date.now());
  };
  let fatal;
  // Run work for one chain. A provider failure backs off that chain only (honouring Retry-After); a must-stop is
  // carried out of the tick once both lanes have come to rest.
  const on = async (chain, work) => {
    const state = chains[chain];
    if (!out.chains[chain] && Date.now() < state.until) out.chains[chain] = { wait: state.code, retryAt: iso(state.until) };
    if (out.chains[chain]) return undefined;
    try { return await work(); }
    catch (error) {
      const c = classify(error);
      if (c.class === 'stop') { fatal ??= error; out.chains[chain] = { wait: c.code }; return undefined; }
      state.failures += 1; state.code = c.code;
      state.until = Date.now() + Math.min(c.retryAfter ?? Math.min(2 ** state.failures * 500, 60000), 900000);
      out.chains[chain] = { wait: c.code, retryAt: iso(state.until) };
      return undefined;
    }
  };

  const [fresh] = await Promise.all([
    on('horizen', async () => {
      await access.identify('horizen'); await settle('horizen');
      const snapshot = await discover(access, data.activeRounds, world.view ? 900 : 4800);
      heads.horizen = { block: snapshot.block, time: snapshot.now };
      let changed = false;
      for (const round of snapshot.rounds) {
        const tracked = round.roundId in data.activeRounds;
        if ((round.phase > 0 && round.phase < 6 || round.phase === 8) && !tracked) { data.activeRounds[round.roundId] = { asset: round.asset, duration: round.duration, start: round.start }; changed = true; }
        else if ((round.phase === 6 || round.phase === 7 || round.phase === 0 && round.start <= snapshot.now) && tracked) { delete data.activeRounds[round.roundId]; changed = true; }
      }
      if (changed) await journal.save();
      return snapshot;
    }),
    on('base', async () => { await access.identify('base'); await settle('base'); }),
  ]);
  if (fatal) throw fatal;
  if (fresh) world.view = fresh;
  // While Horizen cannot be read, the last view still says which boundaries exist, and time alone moves a round
  // to its next one, so Base publication carries on. Nothing is sent to Horizen from such a view.
  const wall = Math.floor(Date.now() / 1000);
  const view = fresh ?? (world.view && { now: wall, stale: true, rounds: world.view.rounds.map(r => ({ ...r,
    phase: r.phase === 1 && wall >= r.start ? 2 : (r.phase === 3 || r.phase === 4) && wall >= r.end ? 5 : r.phase })) });
  const list = view ? wanted(view) : [];
  // The Base head is read on every tick, also with no boundary to work on: each status line carries both heads.
  const [base] = await Promise.all([
    on('base', async () => {
      const { head, source: there } = await published(access, list);
      // For a minute, what this process saw confirmed is stored, whatever an answer from a backend a few blocks
      // behind says: publishBoundary does not reject a repeat, it pays for a second bridge message. After that
      // the chain's answer stands again, so a publication lost to a reorganisation is not taken for stored.
      for (const [key, at] of stored) if (Date.now() - at < 60000 && there.has(key)) there.set(key, true);
      const now = number(head.timestamp); heads.base = { block: Number(head.number), time: now };
      requireCondition(Math.abs(wall - now) <= 60, 'KEEPER_CHAIN_CLOCK');
      return { now, source: there };
    }),
    fresh && data.catchUp !== undefined && on('horizen', () => lookBack(access, journal, world, fresh.now)),
  ]);
  if (fatal) throw fatal;
  if (base) world.baseAt = Date.now();
  // Given up (see Voidable rounds): an opened round the registry calls Voidable on this tick, with nothing cached for
  // its closing boundary in the same read, once no publication or relay of that price can still be on its way (the
  // keeper's own sent, settled or dropped less than IN_FLIGHT seconds ago or not yet settled (unmined, below), or one first
  // seen on Base undelivered less than IN_FLIGHT seconds ago), and either a signed report proves the window was
  // skipped (witness, below) while Base says, on this tick, that it does not hold the price, or it is GIVE_UP
  // seconds past its void time and this process has worked its closing price for GIVE_UP seconds without a gap of
  // that length between two ticks (a paused host does not count).
  // That last needs Base's answer on this tick too, unless Base has not answered for GIVE_UP seconds: then nothing
  // could be published or relayed for the whole period either. Kept in memory: a restart starts over.
  const sends = key => data.transactions.filter(r => ['publish', 'resend'].some(kind => r.key.startsWith(`${kind}:${key}:`)));
  const lastSent = key => Math.max(stored.get(key) ?? 0, dropped.get(key) ?? 0, ...['publish', 'resend'].map(kind => (data.attempts[`${kind}:${key}`]?.last ?? 0) * 1000),
    ...sends(key).map(r => Date.parse(r.preparedAt)));
  // Base may take minutes to include a transaction (congestion), and the IN_FLIGHT count starts at its settlement. An
  // open one holds the void for at most UNMINED seconds after the first of them was signed, so a hash that is never
  // mined cannot hold it for good.
  const unmined = key => { const open = sends(key).filter(r => !FINAL.includes(r.status)).map(r => Date.parse(r.preparedAt));
    return open.length > 0 && Date.now() - Math.min(...open) < UNMINED * 1000; };
  const gone = new Set(), rules = access.config.rules;
  for (const round of fresh?.rounds ?? []) {
    const key = `${round.feedId}:${round.end}`;
    if (!(round.phase === 5 || round.phase === 8 && round.openedAt) || fresh.cache.get(key) !== false) continue;
    const work = working.get(key);
    if (!work || Date.now() - work.seen > GIVE_UP * 1000) working.set(key, { since: Date.now(), seen: Date.now() }); else work.seen = Date.now();
    if (round.phase !== 8) continue;
    if (base?.source.get(key) && !undelivered.has(key)) undelivered.set(key, wall);
    if (Date.now() - lastSent(key) < IN_FLIGHT * 1000 || unmined(key) || wall - (undelivered.get(key) ?? 0) < IN_FLIGHT) continue;
    const late = fresh.now > round.end + rules.observationWindow + rules.voidGrace + GIVE_UP && Date.now() - working.get(key).since >= GIVE_UP * 1000;
    if (skipped.has(key) && base?.source.get(key) === false || late && (base || !world.baseAt || Date.now() - world.baseAt >= GIVE_UP * 1000)) gone.add(key);
  }
  const actions = view ? plan(view, fresh?.cache, base?.source, gone) : { horizen: [], base: [] };
  // Everything planned is still wanted, whether or not its lane gets as far as it on this tick (a lane stops at
  // its first send, and while a hash is pending). Only what has left the plan loses its backoff and relay timers.
  for (const action of [...actions.base, ...actions.horizen]) seen.add(action.id).add(`${action.feedId}:${action.boundary}`);

  const window = access.config.rules.observationWindow;
  const fetchReport = async (feedId, boundary) => {
    try {
      const report = await auth.streams.report(feedId, boundary, window);
      if (boundary === undefined) requireCondition(report.observation.observationsTimestamp >= Date.now() / 1000 - (auth.streams.latestWithin ?? 60), 'KEEPER_STREAMS_STALE');
      feeds.set(feedId, { ok: true, at: Date.now(), okAt: Date.now(), observed: report.observation.observationsTimestamp }); return report;
    } catch (error) {
      // A miss for one boundary is an answer, not an outage: the service is up and accepted this account.
      feeds.set(feedId, { ...feeds.get(feedId), ok: /^STREAMS_(HTTP_404|NO_COVERING_REPORT)$/.test(error?.message), code: classify(error).code, at: Date.now() });
      throw error;
    }
  };
  // A signed proof that no report can ever cover this boundary: the first report the service has at or after it
  // (STREAMS_NO_COVERING_REPORT, `next`) starts its window at or before the boundary and closes more than the
  // observation window after it, so the DON produced none in between, and the Base adapter itself rejects it in a
  // simulation (InvalidOracleResponse). Gathered on any failed publication, so that it is in hand when the round turns
  // Voidable; acted on only then (gone, above). Kept in memory: a restart starts over.
  const witness = async ({ feedId, boundary }, { next }) => {
    const key = `${feedId}:${boundary}`;
    if (skipped.has(key) || !(next?.observation.validFromTimestamp <= boundary && next.observation.observationsTimestamp > boundary + window)) return;
    const { to, data } = access.call(source, 'publishBoundary', [feedId, BigInt(boundary), next.payload]);
    await access.clients.base.call({ account: auth.account.address, to, data }).then(() => {}, refusal => {
      if (classify(refusal).code !== 'REVERT_INVALID_ORACLE_RESPONSE') throw refusal;
      skipped.add(key);
    });
  };
  // Per feed, and only for scheduling new rounds: is the report service answering for this feed right now?
  const ready = async feedId => {
    if (!(Date.now() - feeds.get(feedId)?.at < 60000)) await fetchReport(feedId).catch(() => {});
    requireCondition(feeds.get(feedId).ok, feeds.get(feedId).code);
  };
  const send = (intent, call, expect) => {
    // A reverted idempotent action is attempted again under the next attempt number: spaced out, and at most
    // MAX_REVERTS times a rolling day. Every attempt and its cost stays in the journal history.
    const tried = data.attempts[intent];
    // An attempt already in a block is two blocks from being settled: its result decides whether another is needed.
    requireCondition(!data.transactions.some(t => t.status === 'mined' && t.key.startsWith(`${intent}:`)), 'KEEPER_ATTEMPT_SETTLING');
    requireCondition(!tried || tried.reverts < MAX_REVERTS, 'KEEPER_ATTEMPTS_EXHAUSTED');
    requireCondition(!tried?.reverts || wall - tried.last >= 2 ** tried.reverts * 5, 'KEEPER_RETRY_SPACING');
    return sendOnce(access, journal, auth.account, call, intent, auth.budgets, expect);
  };
  const attempt = async action => {
    const { kind, feedId, boundary } = action, key = `${feedId}:${boundary}`;
    if (kind === 'publish') {
      // Publication is timed on the Base clock: Base verifies the report, and its blocks trail Horizen's by a second or two.
      requireCondition(boundary <= base.now, 'KEEPER_BASE_BEHIND_BOUNDARY');
      let report;
      try {
        report = reports.get(key) ?? await fetchReport(feedId, boundary); reports.set(key, report);
        requireCondition(report.observation.observationsTimestamp <= base.now, 'STREAMS_REPORT_AHEAD_OF_BASE');
        validateBoundary(report.observation, boundary, base.now, window);
      } catch (error) { if (error.next) await witness(action, error); throw error; }
      try { return await send(action.id, access.call(source, 'publishBoundary', [feedId, BigInt(boundary), report.payload]), report.observation.reportHash); }
      catch (error) {
        // The Base adapter refused this report in simulation, or verified a different one: it is not tried again. The
        // next try asks the source afresh, and the Solana source then offers its next copy (solana.mjs).
        if (/^REVERT_|^KEEPER_STREAMS_AUTHENTICATION$/.test(classify(error).code)) reports.delete(key);
        throw error;
      }
    }
    if (kind === 'await-delivery') {
      // Stored on Base, by this keeper or anyone else, and not yet on Horizen. Delivery is normally well under a minute.
      const relays = data.attempts[action.id]?.count ?? 0;
      if (!undelivered.has(key)) undelivered.set(key, wall);
      requireCondition(relays < MAX_RESENDS, 'KEEPER_RESENDS_EXHAUSTED');
      // While an opening waits for this delivery the keeper looks every second; otherwise not before the next relay is due.
      const due = Math.max(undelivered.get(key), data.attempts[action.id]?.last ?? 0) + RESEND_AFTER * 2 ** relays;
      if (wall < due) return { wait: 'AWAITING_DELIVERY', ...(urgent(action) ? {} : { retryAt: iso(due * 1000) }) };
      return send(action.id, access.call(source, 'resendBoundary', [feedId, BigInt(boundary)]));
    }
    if (kind === 'create') {
      await ready(feedId);
      // Track BEFORE signing so a crash after inclusion cannot orphan a round beyond the discovery window.
      if (!(action.roundId in data.activeRounds)) { data.activeRounds[action.roundId] = { asset: action.asset, duration: action.duration, start: action.start }; await journal.save(); }
    }
    const functionName = { create: 'createRound', open: 'recordOpening', resolve: 'resolveRound', void: 'voidRound' }[kind];
    const args = kind === 'create' ? [action.asset, action.duration, BigInt(action.start)] : kind === 'void' ? [action.roundId] : [action.roundId, '0x'];
    return send(action.id, access.call(registry, functionName, args));
  };
  const lane = async (chain, todo) => {
    for (const action of todo) {
      const hold = defer.get(action.id);
      if (hold && Date.now() < hold.until) { out.waiting.push({ action: action.id, wait: hold.code, retryAt: iso(hold.until) }); continue; }
      if (held(data, chain)) { out.waiting.push({ chain, wait: 'KEEPER_TX_PENDING', retryAt: iso(heldUntil(data, chain)) }); return; }
      try {
        const result = await attempt(action);
        if (result.wait) { out.waiting.push({ action: action.id, ...result }); continue; }
        defer.delete(action.id);
        out.sent.push({ action: action.id, chain, hash: result.hash, nonce: result.transaction.nonce, maximumFeeWei: result.maximumFeeWei });
        return; // one new transaction per chain per tick: the next is chosen from state read after this one
      } catch (error) {
        const c = classify(error);
        // A reorganisation took back a settled transaction: phases read before it may be gone as well. Read every round again.
        if (c.code === 'KEEPER_REORGANISED') access.rounds?.clear();
        if (c.class === 'stop' || c.rpc) throw error;
        if (c.class === 'done') { out.done.push({ action: action.id, already: c.code }); continue; }
        // retry: 1 s, 2 s, 4 s ... up to 5 min, or up to 15 s for an action an opening depends on: a cause that
        // clears inside the opening window must find another try inside it. The same for publishing a closing price
        // until the keeper would give its round up (Voidable rounds): one found after the opening window still
        // resolves the round. skip: 5 min. Only this intent waits.
        const closing = action.kind === 'publish' && wall <= action.boundary + rules.observationWindow + rules.voidGrace + GIVE_UP;
        const tries = (hold?.tries ?? 0) + 1, until = Date.now() + (c.class === 'skip' ? 300000 : Math.min(2 ** tries * 500, urgent(action) || closing ? OPENING_RETRY : 300000));
        defer.set(action.id, { tries, code: c.code, until }); out.waiting.push({ action: action.id, wait: c.code, retryAt: iso(until) });
      }
    }
  };
  await Promise.all([on('horizen', () => lane('horizen', actions.horizen)), on('base', () => lane('base', actions.base))]);
  if (fatal) throw fatal;

  for (const chain of ['base', 'horizen']) if (!out.chains[chain]) chains[chain].failures = 0;
  if (fresh && !Object.keys(out.chains).length) for (const map of [defer, undelivered, reports, stored, skipped, working, dropped]) for (const key of map.keys()) if (!seen.has(key)) map.delete(key);
  const flying = data.transactions.some(t => !FINAL.includes(t.status) && Date.now() - Date.parse(t.preparedAt) < 30000);
  const soonest = Math.min(...[...out.waiting, ...Object.values(out.chains)].map(w => w.retryAt ? Date.parse(w.retryAt) - Date.now() : 1000));
  // Poll fast while a transaction is in flight, and at the pace of whatever is being waited for otherwise. With
  // nothing to do, nothing can become due before the next boundary of a market worked (every 15 minutes): look once
  // every 30 s, be there one second after the boundary, and look every second for the first 15 s after it in case a
  // chain head is late.
  const every = Math.min(...MARKETS.map(m => m.duration));
  const next = flying ? 500 : Math.max(250, Math.min(soonest, wall % every < 15 ? 1000 : 30000, (every - wall % every) * 1000 + 1000));
  const wei = amount => Object.fromEntries(['base', 'horizen'].map(chain => [chain, amount(chain, spent(data, chain))]));
  return { status: out.sent.length ? 'sent' : out.waiting.length || Object.keys(out.chains).length ? 'waiting' : 'idle',
    rounds: view ? view.rounds.filter(r => r.phase > 0 && r.phase < 6 || r.phase === 8).length : null, ...out,
    // The rolling 24-hour budget per chain: charged so far (settled cost plus open reservations) and what is left of it.
    spentWei: wei((chain, used) => used.toString()),
    remainingWei: wei((chain, used) => auth.budgets ? (auth.budgets[chain] > used ? auth.budgets[chain] - used : 0n).toString() : null),
    // The head each chain's endpoint returned on this tick (the previous one while that chain is backing off), and
    // per feed the last time the report service returned a usable report, with the reason while it is not answering,
    // and with the free source when each of its sources last supplied it.
    heads: { ...heads },
    reports: Object.fromEntries([['BTC', access.config.feeds.btcFeedId, 0], ['ETH', access.config.feeds.ethFeedId, 1]].filter(([, , asset]) => MARKETS.some(m => m.asset === asset)).map(([name, feedId]) => [name, {
      lastOkAt: feeds.get(feedId)?.okAt ? iso(feeds.get(feedId).okAt) : null, observed: feeds.get(feedId)?.observed ?? null,
      ...(auth.streams?.served ? { sources: Object.fromEntries(Object.entries(auth.streams.served(feedId)).map(([source, at]) => [source, at && iso(at)])) } : {}),
      ...(feeds.get(feedId)?.ok === false ? { failing: feeds.get(feedId).code } : {}) }])),
    next };
}

// The run loop: one status line per tick (at least every 30 s, see `next` above). Only a must-stop leaves it.
export async function watch(access, journal, auth, { once = false, stopped = () => false, sleep, print }) {
  const world = {};
  do {
    const { next, ...status } = await step(access, journal, auth, world);
    print(status);
    if (once || stopped()) break;
    await sleep(next);
  } while (!stopped());
}

async function main() {
  const option = options(process.argv.slice(2));
  const auth = option.secrets ? await settings(option) : { rpc: {} };
  const access = await createChainAccess({ rpc: auth.rpc, rehearsal: option.rehearsal });
  if (['--plan', '--check-public'].includes(option.mode)) {
    await Promise.all([access.identify('base', true), access.identify('horizen', true)]);
    if (option.mode === '--check-public') { console.log(encodeJSON({ status: 'public-deployment-verified', chains: [8453, 26514], signing: false })); return; }
    const snapshot = await discover(access); const actions = await nextActions(access, snapshot);
    console.log(encodeJSON({ status: 'read-only-plan', timestamp: snapshot.now, signing: false, actions: actions.map(a => ({ kind: a.kind, id: a.id, boundary: a.boundary })) })); return;
  }
  // A rehearsal journal can never be mistaken for, or continue, a mainnet one.
  const identity = keccak256(toHex(`${access.release.routeHash}:${access.release.rulesHash}:${auth.account.address.toLowerCase()}${option.rehearsal ? ':rehearsal' : ''}`));
  const journal = await Journal.acquire(option.directory, identity);
  let stopping = false, wake = () => {}; const stop = () => { stopping = true; wake(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await watch(access, journal, auth, { once: option.mode !== '--watch', stopped: () => stopping,
      sleep: ms => new Promise(ok => { const timer = setTimeout(ok, ms); wake = () => { clearTimeout(timer); ok(); }; }),
      print: status => console.log(JSON.stringify({ at: iso(Date.now()), ...(option.rehearsal ? { rehearsal: true } : {}), ...status })) });
  } finally { await journal.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Nothing is left un-awaited on purpose; if a library ever does, name it without printing provider text and carry on.
  process.on('unhandledRejection', error => console.error(JSON.stringify({ at: iso(Date.now()), status: 'defect', code: classify(error).code })));
  try { await main(); }
  catch (error) {
    // Reached only by a must-stop (see errors.mjs), a start-up configuration error, or a failed one-shot read.
    console.error(JSON.stringify({ at: iso(Date.now()), status: 'stopped', code: classify(error).code, note: 'See the README section "Reason codes". Nothing was retried or replaced on the way out.' }));
    process.exitCode = 1;
  }
}
