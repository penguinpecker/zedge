import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex, pad } from 'viem';
import { parseArguments, loadArtifacts } from './preflight-hybrid.mjs';
import {
  PLANNED, NAMES, registryCreation, runtimeCode, expectedRegistry, roundId, demandPlannedAddresses, differsFromRelease, verifyRegistry,
  runFiles, rehearsalFiles,
} from './plan-registry.mjs';

// Committed public files only: the reviewed profile and the exported ABI. No build output, RPC, keys or signing.
const configText = readFileSync(new URL('../deployment/hybrid-mainnet.json', import.meta.url), 'utf8');
const config = JSON.parse(configText);
const committed = JSON.parse(readFileSync(new URL('../deployment/mainnet-addresses.json', import.meta.url), 'utf8'));
const abi = JSON.parse(readFileSync(new URL('../abi/StreamsRoundRegistry.json', import.meta.url), 'utf8'));
const ZERO = `0x${'0'.repeat(40)}`;
const artifacts = {
  StreamsRoundRegistry: { deployedBytecode: { object: `0x${'11'.repeat(40)}`, immutableReferences: { 7: [{ start: 2, length: 32 }] } } },
  ERC1967Proxy: { deployedBytecode: { object: '0x363d3d37' } },
};

test('the committed profile yields the planned addresses, rules hash, initializer and sample round id', () => {
  // Known answers computed independently with cast for deployer nonce 2 on Horizen.
  const creation = registryCreation(config, config.deployer, 2, abi);
  assert.deepEqual({ implementation: creation.implementation, proxy: creation.proxy }, PLANNED);
  assert.equal(creation.rulesHash, '0x17258005a90dc55ca45ae167eb0310278363a2ca89d8204437e1d21cc79ac45d');
  assert.equal(creation.initData.slice(0, 10), '0xe63a558c');
  assert.equal(creation.owner, config.deployer);
  assert.deepEqual(creation.constructorArgs, [[], [creation.implementation, creation.initData]]);
  assert.equal(roundId(creation.proxy, creation.rulesHash, { asset: 0, duration: 300, start: 1791100800 }),
    '0xd6ddd89dd7e2fa4749102c193d25b9ef2c50e0f2ed44769b64f56bd0c1f62e52');
  assert.equal(roundId(creation.proxy, creation.rulesHash, { asset: 1, duration: 900, start: 1791100800 }),
    '0x7b8dc4d8b6de1dad0ad7cc9b63bb5d3b36746fae3da1a96114ead7e496b7c774');
});

test('a changed rule, nonce or deployer changes what would be created', () => {
  const base = registryCreation(config, config.deployer, 2, abi);
  const moved = registryCreation(config, config.deployer, 3, abi);
  assert.equal(moved.implementation, base.proxy);
  assert.equal(moved.rulesHash, base.rulesHash);
  assert.notEqual(registryCreation(config, `0x${'7'.repeat(40)}`, 2, abi).proxy, base.proxy);
  for (const [key, value] of [['voidGrace', 3600], ['observationWindow', 30], ['openingGrace', 151], ['cutoffBuffer', 31]]) {
    assert.throws(() => registryCreation({ ...config, rules: { ...config.rules, [key]: value } }, config.deployer, 2, abi));
  }
  for (const nonce of ['2', -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => registryCreation(config, config.deployer, nonce, abi));
});

test('moved addresses fail closed unless acknowledged', () => {
  assert.equal(demandPlannedAddresses(registryCreation(config, config.deployer, 2, abi)), true);
  const moved = registryCreation(config, config.deployer, 3, abi);
  assert.throws(() => demandPlannedAddresses(moved), /--acknowledge-new-addresses/);
  assert.equal(demandPlannedAddresses(moved, true), false);
});

test('the implementation runtime embeds its own address; the proxy runtime is fixed', () => {
  const self = `0x${'ab'.repeat(20)}`;
  assert.equal(runtimeCode(artifacts.StreamsRoundRegistry, self), `0x1111${pad(self).slice(2)}${'11'.repeat(6)}`);
  assert.equal(runtimeCode(artifacts.ERC1967Proxy, self), '0x363d3d37');
  assert.notEqual(keccak256(runtimeCode(artifacts.StreamsRoundRegistry, self)), keccak256(runtimeCode(artifacts.StreamsRoundRegistry, ZERO)));
  assert.throws(() => runtimeCode({ deployedBytecode: { object: '0x00', immutableReferences: { 1: [], 2: [] } } }, self));
});

test('a rehearsal keeps its own files and takes only a loopback fork', () => {
  const real = runFiles();
  assert.match(real.plan, /\/evidence\/registry-plan\.json$/);
  assert.match(real.release, /\/contracts\/deployment\/mainnet-addresses\.json$/);
  const rehearsal = rehearsalFiles({ rehearsal: 'http://127.0.0.1:8545', evidence: '/tmp/zedge-rehearsal' });
  assert.deepEqual([rehearsal.rehearsal, rehearsal.plan, rehearsal.release],
    [true, '/tmp/zedge-rehearsal/registry-plan.json', '/tmp/zedge-rehearsal/mainnet-addresses.json']);
  assert.throws(() => rehearsalFiles({ rehearsal: 'http://127.0.0.1:8545' }));
  assert.throws(() => rehearsalFiles({ evidence: '/tmp/zedge-rehearsal' }));
  assert.throws(() => runFiles(real.directory));
  // Nor the directory of the committed release: a rehearsal would write fork-only creations into it.
  assert.throws(() => runFiles(dirname(real.release)), /committed release/);
  for (const url of ['https://horizen.calderachain.xyz/http', 'http://example.org:8545', 'http://127.0.0.1', 'http://127.0.0.1:8545/x']) {
    assert.throws(() => parseArguments(['--rehearsal', url], [], ['--rehearsal']));
  }
  assert.throws(() => parseArguments(['--rehearsal'], [], ['--rehearsal']));
  assert.throws(() => parseArguments(['--unknown'], ['--known'], []));
});

test('what would be created is compared with the committed release field by field; a moved nonce is not a changed build', () => {
  const expected = expectedRegistry(registryCreation(config, config.deployer, 2, abi), artifacts);
  const release = { schemaVersion: 2, configHash: keccak256(toHex(configText)), rulesHash: expected.rulesHash, contracts: [{}, {}, {},
    { name: 'StreamsRoundRegistry', address: expected.proxy, runtimeCodeHash: expected.proxyCodeHash,
      proxy: { implementation: expected.implementation, implementationCodeHash: expected.implementationCodeHash, owner: expected.owner } }] };
  const differs = (r = release, e = expected, build = artifacts, text = configText) => differsFromRelease(r, e, build, text);
  assert.deepEqual(differs(), { changed: [], moved: [] });
  // One changed byte of implementation code, one changed byte of the profile, another owner or proxy build.
  const rebuilt = { ...artifacts, StreamsRoundRegistry: { deployedBytecode: { ...artifacts.StreamsRoundRegistry.deployedBytecode, object: `0x${'11'.repeat(39)}12` } } };
  assert.deepEqual(differs(release, expectedRegistry(expected, rebuilt), rebuilt), { changed: ['implementation runtime hash'], moved: [] });
  assert.deepEqual(differs(release, expected, artifacts, `${configText} `), { changed: ['profile hash'], moved: [] });
  assert.deepEqual(differs(release, { ...expected, owner: `0x${'7'.repeat(40)}`, rulesHash: `0x${'0'.repeat(64)}`, proxyCodeHash: `0x${'0'.repeat(64)}` }),
    { changed: ['rules hash', 'owner', 'proxy runtime hash'], moved: [] });
  // The same build one nonce later: both addresses move, and the implementation hash at its new address differs
  // from the pinned one, yet the code is unchanged and is reported as such.
  const later = expectedRegistry(registryCreation(config, config.deployer, 3, abi), artifacts);
  assert.notEqual(later.implementationCodeHash, expected.implementationCodeHash);
  assert.deepEqual(differs(release, later), { changed: [], moved: ['proxy address', 'implementation address'] });
  for (const broken of [undefined, {}, { ...release, schemaVersion: 1 }, { ...release, contracts: [] },
    { ...release, contracts: [{}, {}, {}, { ...release.contracts[3], proxy: { implementation: '0x12' } }] }]) {
    assert.deepEqual(differsFromRelease(broken, expected, artifacts, configText), { changed: ['release format'], moved: [] });
  }
});

// The pin can only go stale silently if nothing compares it with a real build. The frontend CI job has no
// build output, so this runs where one exists (locally, and in the CI job that sets ZEDGE_REQUIRE_BUILD).
const out = fileURLToPath(new URL('../out', import.meta.url));
test('the committed release pins the current build of the registry and its proxy', { skip: !existsSync(out) && !process.env.ZEDGE_REQUIRE_BUILD && 'no forge build output' }, async () => {
  const built = await loadArtifacts(out, NAMES);
  // Address-independent: holds for a release regenerated after the deployer nonce moved, and once deployed.
  const expected = expectedRegistry(registryCreation(config, config.deployer, 2, built.StreamsRoundRegistry.abi), built);
  assert.deepEqual(differsFromRelease(committed, expected, built, configText).changed, []);
});

// A read-only stand-in for a chain on which the registry exists exactly as planned.
function deployed() {
  const expected = expectedRegistry(registryCreation(config, config.deployer, 2, abi), artifacts);
  const c = expected.registryConfig;
  const state = {
    code: { [expected.proxy]: runtimeCode(artifacts.ERC1967Proxy, expected.proxy), [expected.implementation]: runtimeCode(artifacts.StreamsRoundRegistry, expected.implementation) },
    slot: pad(expected.implementation),
    getters: { version: 'zedge-streams-round-registry-v2', rulesHash: expected.rulesHash, owner: expected.owner, pendingOwner: ZERO, ...c,
      deploymentChainId: 26514n, roundIdFor: roundId(expected.proxy, expected.rulesHash, { asset: 0, duration: 300, start: 1791100800 }) },
    initialize: async () => { throw Object.assign(new Error('execution reverted'), { data: '0xf92ee8a9' }); },
  };
  const client = {
    getCode: async ({ address }) => state.code[address],
    getStorageAt: async () => state.slot,
    readContract: async ({ address, functionName }) => { assert.equal(address, expected.proxy); return state.getters[functionName]; },
    call: async ({ to }) => { assert.equal(to, expected.implementation); return state.initialize(); },
  };
  return { expected, state, client };
}

test('registry verification passes on the planned deployment and names what it checked', async () => {
  const { expected, client } = deployed();
  const checked = await verifyRegistry(client, expected);
  for (const name of ['implementation slot', 'owner', 'pendingOwner', 'rulesHash', 'voidGrace', 'roundIdFor (sample round)', 'implementation refuses initialize']) {
    assert.ok(checked.includes(name), name);
  }
});

test('registry verification rejects any other code, implementation, owner, rule or an open implementation', async () => {
  for (const mutate of [
    (s, e) => { s.code[e.proxy] = '0x00'; }, (s, e) => { s.code[e.implementation] = '0x00'; }, (s, e) => { s.code[e.proxy] = undefined; },
    (s) => { s.slot = pad(`0x${'9'.repeat(40)}`); }, (s, e) => { s.slot = `0x01${pad(e.implementation).slice(4)}`; },
    (s) => { s.getters.owner = `0x${'9'.repeat(40)}`; }, (s) => { s.getters.pendingOwner = `0x${'9'.repeat(40)}`; },
    (s) => { s.getters.rulesHash = `0x${'0'.repeat(64)}`; }, (s) => { s.getters.version = 'zedge-streams-round-registry-v1'; },
    (s) => { s.getters.voidGrace = 3600; }, (s) => { s.getters.oracle = `0x${'9'.repeat(40)}`; }, (s) => { s.getters.cutoffBuffer = 31; },
    (s) => { s.getters.deploymentChainId = 8453n; }, (s) => { s.getters.roundIdFor = `0x${'0'.repeat(64)}`; },
    // An implementation that accepts initialize, or an endpoint failure that proves nothing, is not "locked".
    (s) => { s.initialize = async () => ({ data: '0x' }); }, (s) => { s.initialize = async () => { throw new Error('HTTP 429'); }; },
    (s) => { s.initialize = async () => { throw Object.assign(new Error('execution reverted'), { data: '0x4b3fc6c3' }); }; },
  ]) {
    const { expected, state, client } = deployed(); mutate(state, expected);
    await assert.rejects(verifyRegistry(client, expected));
  }
});
