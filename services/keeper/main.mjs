#!/usr/bin/env node
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import { StreamsClient, requireCondition, validateBoundary } from './streams.mjs';
import { Journal, privateFile, encodeJSON } from './journal.mjs';
import { createChainAccess, sendOnce, confirmTransaction, defaultStateDirectory } from './chain.mjs';
import { schedules, chooseAction, orderedActions } from './lifecycle.mjs';

const registry = 'StreamsRoundRegistry';
const source = 'BaseStreamsPublisher';
const destination = 'HorizenStreamsOracle';
const present = o => o && o.reportHash !== `0x${'0'.repeat(64)}`;
const number = n => { const v = Number(n); requireCondition(Number.isSafeInteger(v) && v >= 0, 'KEEPER_INTEGER'); return v; };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export const reportUnavailable = error => /^STREAMS_HTTP_(401|403|404|429|5[0-9]{2})$/.test(error?.message ?? '')
  || ['STREAMS_TRANSPORT', 'KEEPER_STREAMS_STALE', 'KEEPER_STREAMS_AHEAD'].includes(error?.message);

export function options(argv) {
  const mode = argv[0] ?? '--plan';
  requireCondition(['--plan', '--check-public', '--run-once', '--watch'].includes(mode), 'KEEPER_MODE');
  const result = { mode, directory: defaultStateDirectory };
  for (let i = 1; i < argv.length; i += 2) {
    requireCondition(['--secrets', '--state-directory'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'KEEPER_ARGUMENT');
    const field = argv[i] === '--secrets' ? 'secrets' : 'directory'; requireCondition(field !== 'secrets' || !result.secrets, 'KEEPER_ARGUMENT');
    result[field] = resolve(argv[i + 1]);
  }
  requireCondition(!['--run-once', '--watch'].includes(mode) || result.secrets, 'KEEPER_SECRETS_REQUIRED');
  return result;
}

async function credentials(path) {
  const bytes = await privateFile(path);
  try {
    const env = parseEnv(bytes.toString());
    requireCondition(/^(?:0x)?[0-9a-fA-F]{64}$/.test(env.KEEPER_PRIVATE_KEY ?? ''), 'KEEPER_PRIVATE_KEY');
    const account = privateKeyToAccount(`0x${env.KEEPER_PRIVATE_KEY.replace(/^0x/i, '')}`);
    requireCondition(/^0x[0-9a-fA-F]{40}$/.test(env.KEEPER_ADDRESS ?? '') && same(account.address, env.KEEPER_ADDRESS), 'KEEPER_ADDRESS');
    const budgets = {};
    for (const [chain, maximum] of [['base', 250000000000000n], ['horizen', 120000000000000n]]) {
      const v = env[`KEEPER_${chain.toUpperCase()}_BUDGET_WEI`]; requireCondition(/^[1-9][0-9]{0,18}$/.test(v ?? ''), 'KEEPER_BUDGET_CONFIG');
      budgets[chain] = BigInt(v); requireCondition(budgets[chain] <= maximum, 'KEEPER_BUDGET_CONFIG');
    }
    return { account, budgets, streams: new StreamsClient({ username: env.CHAINLINK_STREAMS_USERNAME, secret: env.CHAINLINK_STREAMS_SECRET }) };
  } finally { bytes.fill(0); }
}

export async function discover(access, persisted = {}) {
  const block = await access.clients.horizen.getBlock(); const now = number(block.timestamp);
  requireCondition(Math.abs(Date.now() / 1000 - now) <= 60, 'KEEPER_CHAIN_CLOCK');
  const specs = new Map(schedules(now).map(s => [`${s.asset}:${s.duration}:${s.start}`, s]));
  for (const spec of Object.values(persisted)) {
    requireCondition([0, 1].includes(spec.asset) && [300, 900].includes(spec.duration) && Number.isSafeInteger(spec.start), 'KEEPER_PERSISTED_ROUND');
    specs.set(`${spec.asset}:${spec.duration}:${spec.start}`, spec);
  }
  requireCondition(specs.size <= 1024, 'KEEPER_ACTIVE_CAPACITY');
  const rounds = [];
  // Bounded batches avoid saturating shared public RPCs.
  const entries = [...specs.values()];
  for (let i = 0; i < entries.length; i += 8) {
    const group = await Promise.all(entries.slice(i, i + 8).map(async spec => {
      const args = [spec.asset, spec.duration, BigInt(spec.start)];
      const roundId = await access.read(registry, 'roundIdFor', args, block.number);
      const phase = await access.read(registry, 'phase', [roundId], block.number);
      requireCondition(Number.isInteger(phase) && phase >= 0 && phase <= 8, 'KEEPER_PHASE');
      const base = { ...spec, roundId, phase, feedId: access.config.feeds[spec.asset === 0 ? 'btcFeedId' : 'ethFeedId'] };
      if (phase === 0 || phase === 6 || phase === 7) return base;
      const round = await access.read(registry, 'getRound', [roundId], block.number);
      requireCondition(round.asset === spec.asset && round.duration === spec.duration && number(round.start) === spec.start, 'KEEPER_ROUND_IDENTITY');
      return { ...base, end: number(round.end), openedAt: number(round.openedAt), openingDeadline: number(round.openingDeadline), resolutionDeadline: number(round.resolutionDeadline) };
    }));
    rounds.push(...group);
  }
  requireCondition(same((await access.clients.horizen.getBlock({ blockNumber: block.number })).hash, block.hash), 'KEEPER_REORG');
  return { now, rounds };
}

export async function nextActions(access, snapshot) {
  const actions = [];
  for (const round of snapshot.rounds) {
    let action = chooseAction(round, snapshot.now, false, false);
    if (!action) continue;
    if (action.kind === 'publish') {
      const boundary = BigInt(action.boundary);
      const cached = await access.read(destination, 'getObservation', [round.feedId, boundary]);
      const published = present(cached) ? null : await access.read(source, 'getObservation', [round.feedId, boundary]);
      action = chooseAction(round, snapshot.now, present(cached), present(published));
    }
    actions.push({ ...round, ...action });
  }
  return orderedActions(actions);
}

export async function preflightStreams(access, streams) {
  for (const feed of [access.config.feeds.btcFeedId, access.config.feeds.ethFeedId]) {
    const report = await streams.report(feed);
    // Reports can advance during HTTP retrieval. Compare each with a fresh source-chain head.
    const block = await access.clients.base.getBlock();
    requireCondition(report.observation.observationsTimestamp >= number(block.timestamp) - 60, 'KEEPER_STREAMS_STALE');
    requireCondition(report.observation.observationsTimestamp <= number(block.timestamp), 'KEEPER_STREAMS_AHEAD');
    validateBoundary(report.observation, report.observation.observationsTimestamp, number(block.timestamp));
    const verified = await access.authenticateReport(feed, report.observation.observationsTimestamp, report.payload);
    requireCondition(same(verified.reportHash, report.observation.reportHash), 'KEEPER_STREAMS_AUTHENTICATION');
  }
}

export async function reconcileTransactions(access, journal) {
  for (const record of journal.data.transactions) {
    requireCondition(['base', 'horizen'].includes(record.chain) && ['signed', 'submitted', 'confirmed', 'reverted'].includes(record.status), 'KEEPER_JOURNAL_RECORD');
    const reader = access.readers[record.chain];
    if (!['confirmed', 'reverted'].includes(record.status)) {
      // A signed hash missing on chain stays uncertain. It is never replaced, discarded or resent here.
      record.receipt = await confirmTransaction(reader, record);
      record.status = record.receipt.status === 'success' ? 'confirmed' : 'reverted'; await journal.save();
    } else {
      const block = await reader.getBlock({ blockNumber: BigInt(record.receipt.blockNumber) });
      requireCondition(same(block.hash, record.receipt.blockHash), 'KEEPER_REORG');
    }
  }
}

export async function step(access, journal, auth) {
  await reconcileTransactions(access, journal);
  const snapshot = await discover(access, journal.data.activeRounds);
  for (const round of snapshot.rounds) {
    if (round.phase > 0 && round.phase < 6 || round.phase === 8) journal.data.activeRounds[round.roundId] = { asset: round.asset, duration: round.duration, start: round.start };
    else if (round.phase === 6 || round.phase === 7 || round.phase === 0 && round.start <= snapshot.now) delete journal.data.activeRounds[round.roundId];
  }
  await journal.save();
  const actions = await nextActions(access, snapshot);
  for (const action of actions) {
    if (!auth.freshReports && ['create', 'publish'].includes(action.kind)) continue;
    let call, key;
    const roundKey = `${action.asset}:${action.duration}:${action.start}`;
    if (action.kind === 'await-delivery') {
      const prefix = `publish:${action.feedId}:${action.boundary}`;
      const records = journal.data.transactions.filter(t => t.key === prefix || t.key.startsWith(`resend:${action.feedId}:${action.boundary}:`));
      // At most two deliberate resends, spaced by 60 seconds.
      if (!records.length || records.length >= 3 || snapshot.now - number(records.at(-1).receipt.timestamp) < 60) continue;
      key = `resend:${action.feedId}:${action.boundary}:${records.length}`;
      call = access.call(source, 'resendBoundary', [action.feedId, BigInt(action.boundary)]);
    } else if (action.kind === 'publish') {
      key = `publish:${action.feedId}:${action.boundary}`;
      let report;
      try { report = await auth.streams.report(action.feedId, action.boundary); }
      catch (error) {
        if (!reportUnavailable(error)) throw error;
        auth.freshReports = false;
        continue;
      }
      const sourceBlock = await access.clients.base.getBlock();
      validateBoundary(report.observation, action.boundary, number(sourceBlock.timestamp), access.config.rules.observationWindow);
      const verified = await access.authenticateReport(action.feedId, action.boundary, report.payload);
      requireCondition(same(verified.reportHash, report.observation.reportHash), 'KEEPER_STREAMS_AUTHENTICATION');
      call = access.call(source, 'publishBoundary', [action.feedId, BigInt(action.boundary), report.payload]);
    } else {
      key = `${action.kind}:${roundKey}`;
      const functionName = { create: 'createRound', open: 'recordOpening', resolve: 'resolveRound', void: 'voidRound' }[action.kind];
      const args = action.kind === 'create' ? [action.asset, action.duration, BigInt(action.start)]
        : action.kind === 'void' ? [action.roundId] : [action.roundId, '0x'];
      call = access.call(registry, functionName, args);
    }
    const previous = journal.data.transactions.find(t => t.key === key);
    if (previous?.status === 'reverted') continue; // Gas/nonce remain consumed. Never automatically repeat a failed intent.
    requireCondition(!previous, 'KEEPER_ACTION_REORG');
    if (action.kind === 'create') {
      // Track BEFORE signing so a crash after inclusion cannot orphan a round beyond the discovery window.
      journal.data.activeRounds[action.roundId] = { asset: action.asset, duration: action.duration, start: action.start };
      await journal.save();
    }
    const record = await sendOnce(access, journal, auth.account, call, key, auth.budgets, action.deadline);
    return { status: record.status, action: action.kind, chain: call.chain, roundId: action.roundId };
  }
  return { status: 'waiting', rounds: snapshot.rounds.filter(r => r.phase > 0).length };
}

async function main() {
  const option = options(process.argv.slice(2)); const access = await createChainAccess(); await access.verify();
  if (option.mode === '--check-public') { console.log(encodeJSON({ status: 'public-deployment-verified', chains: [8453, 26514], signing: false })); return; }
  if (option.mode === '--plan') {
    const snapshot = await discover(access); const actions = await nextActions(access, snapshot);
    console.log(encodeJSON({ status: 'read-only-plan', timestamp: snapshot.now, signing: false, actions: actions.map(a => ({ kind: a.kind, asset: a.asset, duration: a.duration, start: a.start, deadline: a.deadline, roundId: a.roundId })) })); return;
  }
  const auth = await credentials(option.secrets);
  async function feedReadiness() {
    try { await preflightStreams(access, auth.streams); return true; }
    catch (error) {
      if (reportUnavailable(error)) return false;
      throw error;
    }
  }
  // An outage blocks new markets/publications; already cached settlement and permissionless void remain available.
  auth.freshReports = await feedReadiness();
  const identity = keccak256(toHex(`${access.release.routeHash}:${access.release.rulesHash}:${auth.account.address.toLowerCase()}`));
  const journal = await Journal.acquire(option.directory, identity);
  let stopping = false; const stop = () => { stopping = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      console.log(encodeJSON(await step(access, journal, auth)));
      if (option.mode !== '--watch' || stopping) break;
      // Revalidate fresh entitlement before every iteration; don't schedule new markets during a feed outage.
      await new Promise(ok => setTimeout(ok, 10000));
      if (!stopping) auth.freshReports = await feedReadiness();
    } while (!stopping);
  } finally { await journal.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    const code = /^(KEEPER|STREAMS)_[A-Z0-9_]{1,70}$/.test(error.message ?? '') ? error.message : 'KEEPER_PROVIDER_OR_STORAGE_FAILURE';
    console.error(encodeJSON({ status: 'stopped', code, note: 'No automatic transaction retry. Inspect the journal and canonical receipt before restarting.' }));
    process.exitCode = 1;
  }
}
