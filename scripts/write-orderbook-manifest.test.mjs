// The order-book manifest writer's pure parts: the engine configuration it pins and the events manifest of a deployment with an
// event (docs/cutover-politics.md). node --test scripts/write-orderbook-manifest.test.mjs
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { engineConfigJson, eventsManifest } from './write-orderbook-manifest.mjs';

const committed = JSON.parse(await readFile(new URL('../public/deployments/26514-orderbook.json', import.meta.url), 'utf8'));
const app = committed.application;
/** The 10-07 deploy request's constructor parameters, rebuilt from the committed manifest as the guest received them. */
const live = () => {
  const engine = JSON.parse(app.engineConfigJson);
  engine.domain.applicationId = '';
  return { engine, applicationFingerprint: app.wasmSha256, origin: app.origin, epoch: app.epoch, markets: app.markets,
    stakeLimits: { account: Number(app.stakeLimits.account), boundary: Number(app.stakeLimits.boundary), house: app.house, houseTotal: Number(app.stakeLimits.houseTotal) },
    chainlink: app.chainlink, custody: { chainId: 8453, vault: committed.custody.vault.address, inbox: committed.custody.inbox.address, usdc: committed.custody.usdc.address } };
};
const RULES = { path: '/events/us-house-2026.txt', bytes: Buffer.from('Resolves Yes if members elected as Democrats win at least 218 of the 435 voting seats.\n') };
const RESOLVER = '0x1111111111111111111111111111111111111111';
const EVENT = { question: keccak256(RULES.bytes), start: 1791534600, cutoff: 1793743200, end: 1793743201, voidableAfter: 1801439999 };
const next = (over = {}) => ({ ...live(), event: { ...EVENT }, resolver: RESOLVER, depositsFrom: 8, ...over });
const ctx = { release: 'orderbook-mainnet-2026-10-12', applicationId: '11932061812661987618', deployTx: `0x${'e1'.repeat(32)}`, rules: RULES };

test('the committed manifest pins the engine configuration the 10-07 deploy request carried, and that deployment has no events manifest', () => {
  const config = engineConfigJson(live().engine, app.id);
  assert.equal(config, app.engineConfigJson);
  assert.equal(createHash('sha256').update(config).digest('hex'), app.sessionRulesHash);
  assert.equal(eventsManifest(live(), ctx), null);
});

test('a deployment with the event: the events manifest, pinned', () => {
  assert.deepEqual(eventsManifest(next(), ctx), {
    schemaVersion: 1, kind: 'zedge-events', chainId: 26514, release: 'orderbook-mainnet-2026-10-12', application: '11932061812661987618',
    deployTx: `0x${'e1'.repeat(32)}`, resolver: RESOLVER, depositsFrom: 8,
    event: { rules: '/events/us-house-2026.txt', questionHash: '0x528c03a98d9d7ef6db2ee3d39609613aba38fbde0bd6d7d56c037baf93d35f7f',
      start: 1791534600, cutoff: 1793743200, end: 1793743201, voidableAfter: 1801439999 } });
  assert.equal(JSON.stringify(Object.keys(eventsManifest(next(), ctx))), '["schemaVersion","kind","chainId","release","application","deployTx","resolver","depositsFrom","event"]');
});

test('the writer refuses a deployment whose event, resolver, depositsFrom or rules do not hold together', () => {
  const refuses = (p, message, c = ctx) => assert.throws(() => eventsManifest(p, c), message);
  refuses({ ...live(), extra: 1 }, /unexpected deploy parameters: extra/);
  refuses({ ...live(), resolver: RESOLVER }, /exactly question,/);
  refuses(next({ event: undefined }), /exactly question,/);
  refuses(next({ event: { ...EVENT, label: 'x' } }), /exactly question,/);
  const { question, ...times } = EVENT;
  refuses(next({ event: { questionHash: question, ...times } }), /exactly question,/, ctx); // the events manifest's name is not the guest's
  refuses(next({ event: { ...EVENT, question: '0x12' } }), /start < cutoff < end < voidableAfter/);
  refuses(next({ event: { ...EVENT, start: EVENT.cutoff } }), /start < cutoff < end < voidableAfter/);
  refuses(next({ event: { ...EVENT, end: EVENT.cutoff } }), /start < cutoff < end < voidableAfter/);
  refuses(next({ event: { ...EVENT, voidableAfter: EVENT.end } }), /start < cutoff < end < voidableAfter/);
  refuses(next({ event: { ...EVENT, voidableAfter: 2 ** 32 } }), /start < cutoff < end < voidableAfter/);
  refuses(next({ event: { ...EVENT, end: 1793744100 } }), /off the 900 s grid/);
  refuses(next({ resolver: undefined }), /lowercase address/);
  refuses(next({ resolver: '0xAA11111111111111111111111111111111111111' }), /lowercase address/);
  refuses(next({ resolver: `0x${'0'.repeat(40)}` }), /lowercase address/);
  refuses(next({ resolver: app.house }), /own roles/);
  refuses(next({ resolver: committed.trigger.address }), /own roles/);
  refuses(next({ depositsFrom: undefined }), /needs depositsFrom/);
  refuses(next({ depositsFrom: 0 }), /needs depositsFrom/);
  refuses(next(), /hashes to the event's question hash/, { ...ctx, rules: undefined });
  refuses(next(), /hashes to the event's question hash/, { ...ctx, rules: { ...RULES, bytes: Buffer.from('other text') } });
  refuses(next(), /hashes to the event's question hash/, { ...ctx, rules: { ...RULES, path: '/../secrets.txt' } });
});
