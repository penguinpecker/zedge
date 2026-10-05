import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
import { PLANNED, PLAN_STATUS, BROADCAST_STATUS, registryCreation } from './plan-registry.mjs';
import { buildRelease } from './write-release.mjs';

// Public records only. The three kept entries are the 2026-10-04 creation facts of the schema-1 release.
const configText = readFileSync(new URL('../deployment/hybrid-mainnet.json', import.meta.url), 'utf8');
const config = JSON.parse(configText);
const abi = JSON.parse(readFileSync(new URL('../abi/StreamsRoundRegistry.json', import.meta.url), 'utf8'));
const committed = JSON.parse(readFileSync(new URL('../deployment/mainnet-addresses.json', import.meta.url), 'utf8'));
const hash = digit => `0x${digit.repeat(64)}`;
const KEPT = [
  { name: 'ChainlinkStreamsBoundaryOracle', chain: 'base', chainId: 8453, address: '0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91',
    runtimeCodeHash: '0x106db1660240d4c3536f1f62e273b0559db4066af69bbc80db985b57f6d653f8',
    creationTransaction: '0x8d2fbf2d87150233914cd0dc30927ce3c3c26db2d799193b9887ada3bf8f53ac', creationBlock: '52157229' },
  { name: 'BaseStreamsPublisher', chain: 'base', chainId: 8453, address: '0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006',
    runtimeCodeHash: '0x28d74cd48c995b7c396bb75642c3d82d8c3f6b20fe217e09bd2763c38b112d62',
    creationTransaction: '0x203f72b2900bbf586923708a4dd94eba37864e2ac0a4c3a47c19cfdd76be6b1b', creationBlock: '52157512' },
  { name: 'HorizenStreamsOracle', chain: 'horizen', chainId: 26514, address: '0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B',
    runtimeCodeHash: '0x3996abf69236d59a30795bc2c4262771bf342cd47d76c99c15e4e48d4c50c459',
    creationTransaction: '0x4c2c4d101fcf8cb871a30dc3a867f5f54b7ee6ba0de941af36b54b10cd09f6c4', creationBlock: '27707106' },
];
const RETIRED = '0xdD3bEAA92E5819333A5D5ccD185704427fAB0e91';

function fixture() {
  const route = { sourceChainId: '8453', destinationChainId: '26514', sourceOracle: KEPT[0].address, publisher: KEPT[1].address, destinationOracle: KEPT[2].address };
  const previous = { schemaVersion: 1, release: 'streams-mainnet-2026-10-04', configHash: hash('7'), routeHash: hash('d'), rulesHash: hash('5'), route,
    predicted: { horizenRegistry: RETIRED }, contracts: [...structuredClone(KEPT), { name: 'StreamsRoundRegistry', chain: 'horizen', chainId: 26514,
      address: RETIRED, runtimeCodeHash: hash('9'), creationTransaction: hash('1'), creationBlock: '27707121' }] };
  const plan = { status: PLAN_STATUS, rehearsal: false, configHash: keccak256(toHex(configText)), rulesHash: hash('a'), owner: config.deployer,
    intents: [{ name: 'StreamsRoundRegistry', predictedAddress: PLANNED.implementation, simulatedRuntimeHash: hash('b'), checksPassed: true },
      { name: 'ERC1967Proxy', predictedAddress: PLANNED.proxy, simulatedRuntimeHash: hash('c'), checksPassed: true }] };
  const planText = JSON.stringify(plan);
  const checkpoint = { status: BROADCAST_STATUS, rehearsal: false, planHash: keccak256(toHex(planText)), transactions: plan.intents.map((intent, i) => ({
    name: intent.name, status: 'confirmed', predictedAddress: intent.predictedAddress, runtimeCodeHash: intent.simulatedRuntimeHash,
    transactionHash: hash(String(i + 1)), receipt: { blockNumber: String(27900000 + i) } })) };
  return { previous, plan, planText, checkpoint, configText };
}

test('planned release: schema 2 in the specified key order, kept contracts carried over unchanged', () => {
  const f = fixture(); const release = buildRelease({ ...f, checkpoint: undefined });
  assert.deepEqual(Object.keys(release), ['schemaVersion', 'release', 'status', 'configHash', 'routeHash', 'rulesHash', 'route', 'contracts', 'retired']);
  assert.deepEqual([release.schemaVersion, release.release, release.status], [2, 'streams-mainnet-2026-10-05', 'planned']);
  assert.deepEqual([release.configHash, release.routeHash, release.rulesHash, release.route], [f.plan.configHash, hash('d'), hash('a'), f.previous.route]);
  assert.equal(JSON.stringify(release.contracts.slice(0, 3)), JSON.stringify(KEPT));
  assert.equal(JSON.stringify(release.contracts[3]), JSON.stringify({ name: 'StreamsRoundRegistry', chain: 'horizen', chainId: 26514, address: PLANNED.proxy,
    runtimeCodeHash: hash('c'), creationTransaction: null, creationBlock: null,
    proxy: { implementation: PLANNED.implementation, implementationCodeHash: hash('b'), implementationCreationTransaction: null,
      implementationCreationBlock: null, owner: config.deployer } }));
  assert.deepEqual(release.retired.map(x => [x.name, x.chain, x.chainId, x.address]), [['StreamsRoundRegistry', 'horizen', 26514, RETIRED]]);
});

test('deployed release: creation transactions and blocks come from the verified checkpoint', () => {
  const release = buildRelease(fixture()); const registry = release.contracts[3];
  assert.equal(release.status, 'deployed');
  assert.deepEqual([registry.creationTransaction, registry.creationBlock], [hash('2'), '27900001']);
  assert.deepEqual([registry.proxy.implementationCreationTransaction, registry.proxy.implementationCreationBlock], [hash('1'), '27900000']);
});

test('rewriting from an existing schema-2 release changes nothing', () => {
  const f = fixture(); const first = buildRelease({ ...f, checkpoint: undefined });
  assert.equal(JSON.stringify(buildRelease({ ...f, checkpoint: undefined, previous: first })), JSON.stringify(first));
  assert.equal(JSON.stringify(buildRelease({ ...f, previous: first }).contracts.slice(0, 3)), JSON.stringify(KEPT));
});

test('marking a release deployed only adds creation facts: a broadcast of anything but the planned registry is refused', () => {
  const f = fixture(); const planned = buildRelease({ ...f, checkpoint: undefined });
  const registry = planned.contracts[3];
  for (const [name, previous] of Object.entries({
    'implementation code': { ...planned, contracts: [...KEPT, { ...registry, proxy: { ...registry.proxy, implementationCodeHash: hash('e') } }] },
    'proxy code': { ...planned, contracts: [...KEPT, { ...registry, runtimeCodeHash: hash('e') }] },
    'proxy address': { ...planned, contracts: [...KEPT, { ...registry, address: RETIRED }] },
    'implementation address': { ...planned, contracts: [...KEPT, { ...registry, proxy: { ...registry.proxy, implementation: RETIRED } }] },
    'owner': { ...planned, contracts: [...KEPT, { ...registry, proxy: { ...registry.proxy, owner: RETIRED } }] },
    'rules': { ...planned, rulesHash: hash('e') },
    'profile': { ...planned, configHash: hash('e') },
  })) {
    assert.throws(() => buildRelease({ ...f, previous }), /not the registry the committed release planned/, name);
    // Replanning is how the planned release is replaced: the same difference is accepted there, for review.
    assert.equal(buildRelease({ ...f, previous, checkpoint: undefined }).status, 'planned', name);
  }
});

test('refuses unsimulated plans, other profiles, unconfirmed or foreign checkpoints and damaged kept records', () => {
  for (const [name, mutate] of Object.entries({
    'failed plan': f => { f.plan.status = 'failed'; },
    'unchecked plan': f => { f.plan.intents[1].checksPassed = false; },
    'other profile': f => { f.configText += ' '; },
    'unfinished checkpoint': f => { f.checkpoint.status = 'prepared'; },
    'other plan': f => { f.checkpoint.planHash = hash('0'); },
    'rehearsal checkpoint': f => { f.checkpoint.rehearsal = true; },
    'unconfirmed entry': f => { f.checkpoint.transactions[1].status = 'submitted'; },
    'other address': f => { f.checkpoint.transactions[1].predictedAddress = RETIRED; },
    'other runtime': f => { f.checkpoint.transactions[0].runtimeCodeHash = hash('0'); },
    'missing kept contract': f => { f.previous.contracts.splice(1, 1); },
    'kept contract on another chain': f => { f.previous.contracts[2].chainId = 8453; },
    'kept creation fact lost': f => { f.previous.contracts[0].creationTransaction = null; },
    'another cache': f => { f.previous.contracts[2].address = RETIRED; },
    'route to another cache': f => { f.previous.route.destinationOracle = RETIRED; },
  })) {
    const f = fixture(); mutate(f);
    assert.throws(() => buildRelease(f), undefined, name);
  }
});

test('the committed release matches the committed profile, the reviewed registry rules and the 2026-10-04 route', () => {
  assert.deepEqual([committed.schemaVersion, committed.configHash], [2, keccak256(toHex(configText))]);
  assert.ok(['planned', 'deployed'].includes(committed.status));
  assert.equal(JSON.stringify(committed.contracts.slice(0, 3)), JSON.stringify(KEPT));
  assert.deepEqual([committed.route.sourceOracle, committed.route.publisher, committed.route.destinationOracle], KEPT.map(x => x.address));
  const registry = committed.contracts[3];
  assert.equal(committed.rulesHash, registryCreation(config, config.deployer, 2, abi).rulesHash);
  assert.equal(registry.proxy.owner, config.deployer);
  assert.deepEqual(committed.retired.map(x => [x.chainId, x.address]), [[26514, RETIRED]]);
  // Nothing is deployed while the status is planned: no creation fact may be recorded yet.
  const facts = [registry.creationTransaction, registry.creationBlock, registry.proxy.implementationCreationTransaction, registry.proxy.implementationCreationBlock];
  assert.ok(committed.status === 'planned' ? facts.every(x => x === null) : facts.every(x => typeof x === 'string'));
});
