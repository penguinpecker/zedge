#!/usr/bin/env node
/** Writes the schema-2 release contracts/deployment/mainnet-addresses.json from public records only: no RPC, no keys.
 *   node contracts/scripts/write-release.mjs               status "planned", from evidence/registry-plan.json
 *   node contracts/scripts/write-release.mjs --deployed    status "deployed", from that plan and its confirmed checkpoint
 *   ... --evidence <directory>                             a rehearsal: reads and writes inside that directory only
 * The three kept route contracts, the route and its hash are carried over unchanged from the committed release.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';
import { shown, requireTrue, equal, parseArguments } from './preflight-hybrid.mjs';
import { CACHE, NAMES, PLAN_STATUS, BROADCAST_STATUS, CONFIG, RELEASE, runFiles } from './plan-registry.mjs';

const KEPT = [['ChainlinkStreamsBoundaryOracle', 'base', 8453], ['BaseStreamsPublisher', 'base', 8453], ['HorizenStreamsOracle', 'horizen', 26514]];
export const LABEL = 'streams-mainnet-2026-10-05';
export const RETIRED = {
  name: 'StreamsRoundRegistry', chain: 'horizen', chainId: 26514, address: '0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91',
  reason: 'Replaced 2026-10-05: one-hour timeout void let anyone force a 50/50 refund by blocking price delivery. Never used (zero rounds).',
};
const hex = (value, bytes) => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);

/** previous: the existing release (schema 1 or 2). checkpoint: only for status "deployed". Key order is the file format. */
export function buildRelease({ previous, plan, planText, checkpoint, configText }) {
  requireTrue([1, 2].includes(previous.schemaVersion) && hex(previous.routeHash, 32) && Array.isArray(previous.contracts), 'Existing release is unreadable');
  const kept = KEPT.map(([name, chain, chainId]) => {
    const c = previous.contracts.find((x) => x.name === name);
    requireTrue(c && c.chain === chain && c.chainId === chainId && hex(c.address, 20) && hex(c.runtimeCodeHash, 32)
      && hex(c.creationTransaction, 32) && /^[1-9][0-9]*$/.test(c.creationBlock), `${name}: kept contract record is missing or malformed`);
    return { name, chain, chainId, address: c.address, runtimeCodeHash: c.runtimeCodeHash, creationTransaction: c.creationTransaction, creationBlock: c.creationBlock };
  });
  equal(kept[2].address, CACHE, 'The kept price cache is not the one the registry was planned against');
  equal(previous.route?.destinationOracle, CACHE, 'The route does not deliver to the kept price cache');
  requireTrue(plan.status === PLAN_STATUS && plan.intents?.length === 2 && plan.intents.every((x, i) => x.name === NAMES[i]
    && x.checksPassed === true && hex(x.predictedAddress, 20) && hex(x.simulatedRuntimeHash, 32)) && hex(plan.rulesHash, 32) && hex(plan.owner, 20),
    'Not a simulated registry plan');
  equal(plan.configHash, keccak256(toHex(configText)), 'The plan was made for a different profile');
  let created = [];
  if (checkpoint) {
    requireTrue(checkpoint.status === BROADCAST_STATUS && checkpoint.transactions?.length === 2 && checkpoint.rehearsal === plan.rehearsal,
      'The checkpoint is not a confirmed and verified registry broadcast');
    equal(checkpoint.planHash, keccak256(toHex(planText)), 'The checkpoint is bound to a different plan');
    created = checkpoint.transactions.map((entry, i) => {
      requireTrue(entry.status === 'confirmed' && entry.name === NAMES[i] && hex(entry.transactionHash, 32)
        && /^[1-9][0-9]*$/.test(String(entry.receipt?.blockNumber)), `${NAMES[i]}: unconfirmed checkpoint entry`);
      equal(entry.predictedAddress, plan.intents[i].predictedAddress, `${NAMES[i]}: checkpoint address`);
      equal(entry.runtimeCodeHash, plan.intents[i].simulatedRuntimeHash, `${NAMES[i]}: checkpoint runtime hash`);
      return { transaction: entry.transactionHash, block: String(entry.receipt.blockNumber) };
    });
  }
  const [implementation, proxy] = plan.intents;
  if (checkpoint && previous.schemaVersion === 2) {
    // Marking a release deployed only adds creation facts. What was reviewed as planned is what must have been created.
    const was = previous.contracts[3];
    for (const [name, made, planned] of [['profile hash', plan.configHash, previous.configHash], ['rules hash', plan.rulesHash, previous.rulesHash],
      ['proxy address', proxy.predictedAddress, was?.address], ['proxy runtime hash', proxy.simulatedRuntimeHash, was?.runtimeCodeHash],
      ['implementation address', implementation.predictedAddress, was?.proxy?.implementation],
      ['implementation runtime hash', implementation.simulatedRuntimeHash, was?.proxy?.implementationCodeHash], ['owner', plan.owner, was?.proxy?.owner]]) {
      equal(made, planned, `The broadcast is not the registry the committed release planned: ${name}`);
    }
  }
  return {
    schemaVersion: 2, release: LABEL, status: checkpoint ? 'deployed' : 'planned',
    configHash: plan.configHash, routeHash: previous.routeHash, rulesHash: plan.rulesHash, route: previous.route,
    contracts: [...kept, {
      name: 'StreamsRoundRegistry', chain: 'horizen', chainId: 26514, address: proxy.predictedAddress, runtimeCodeHash: proxy.simulatedRuntimeHash,
      creationTransaction: created[1]?.transaction ?? null, creationBlock: created[1]?.block ?? null,
      proxy: {
        implementation: implementation.predictedAddress, implementationCodeHash: implementation.simulatedRuntimeHash,
        implementationCreationTransaction: created[0]?.transaction ?? null, implementationCreationBlock: created[0]?.block ?? null,
        owner: plan.owner,
      },
    }],
    retired: [RETIRED],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2), ['--deployed'], ['--evidence']);
    const files = runFiles(options.evidence);
    const planText = await readFile(files.plan, 'utf8'); const plan = JSON.parse(planText);
    // A rehearsal plan describes a local fork: it may only ever produce a release inside its own directory.
    requireTrue(plan.rehearsal === files.rehearsal, 'A rehearsal plan needs --evidence <its directory>; a real plan must not use it');
    const previous = JSON.parse(await readFile(RELEASE, 'utf8'));
    requireTrue(files.rehearsal || options.deployed || previous.status !== 'deployed', 'The committed release is already deployed; refusing to mark it planned');
    const release = buildRelease({
      previous, plan, planText, configText: await readFile(CONFIG, 'utf8'),
      checkpoint: options.deployed ? JSON.parse(await readFile(files.checkpoint, 'utf8')) : undefined,
    });
    await writeFile(files.release, `${JSON.stringify(release, null, 2)}\n`);
    console.log(JSON.stringify({ status: release.status, release: release.release, output: shown(files.release),
      registry: release.contracts[3].address, implementation: release.contracts[3].proxy.implementation, rulesHash: release.rulesHash }, null, 2));
  } catch (error) {
    console.error(`Release not written: ${String(error?.message).slice(0, 400)}`);
    process.exitCode = 1;
  }
}
