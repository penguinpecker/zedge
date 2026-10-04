import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDeployData, keccak256 } from 'viem';
import {
  expectedConstructors,
  validateConstructorIntent,
  demandFreshPlan,
  demandSigningAge,
} from './broadcast-hybrid.mjs';

// Public address/ABI fixtures only. No artifact loading, accounts, secrets, filesystem reads or RPC.
const address = digit => `0x${digit.repeat(40)}`;
const BTC = `0x0003${'0'.repeat(59)}1`;
const ETH = `0x0003${'0'.repeat(59)}2`;
const NOW = 1_800_000_000_000;
const NAMES = ['adapter', 'publisher', 'receiver', 'registry'];
const inputs = definitions => definitions.map(([name, type]) => ({ name, type }));
const ROUTE_COMPONENTS = inputs([
  ['sourceChainId', 'uint256'], ['destinationChainId', 'uint256'],
  ['sourceMessenger', 'address'], ['destinationMessenger', 'address'], ['sourceOracle', 'address'],
  ['publisher', 'address'], ['destinationOracle', 'address'],
  ['btcFeedId', 'bytes32'], ['ethFeedId', 'bytes32'], ['btcDecimals', 'uint8'], ['ethDecimals', 'uint8'],
  ['observationWindow', 'uint32'], ['minimumGasLimit', 'uint32'],
]);
const REGISTRY_COMPONENTS = inputs([
  ['oracle', 'address'], ['collateral', 'address'], ['btcFeedId', 'bytes32'], ['ethFeedId', 'bytes32'],
  ['btcDecimals', 'uint8'], ['ethDecimals', 'uint8'], ['observationWindow', 'uint32'],
  ['openingGrace', 'uint32'], ['settlementGrace', 'uint32'], ['cutoffBuffer', 'uint32'],
]);
const constructorInputs = [
  inputs([['verifier', 'address'], ['btcFeedId', 'bytes32'], ['btcDecimals', 'uint8'], ['ethFeedId', 'bytes32'], ['ethDecimals', 'uint8']]),
  [{ name: 'config', type: 'tuple', components: ROUTE_COMPONENTS }],
  [{ name: 'config', type: 'tuple', components: ROUTE_COMPONENTS }],
  [{ name: 'config', type: 'tuple', components: REGISTRY_COMPONENTS }],
];
const ARTIFACTS = constructorInputs.map(constructor => ({
  abi: [{ type: 'constructor', inputs: constructor, stateMutability: 'nonpayable' }],
  bytecode: { object: '0x60006000f3' },
}));

function fixture() {
  const config = {
    dependencies: {
      verifier: { address: address('2') },
      sourceMessenger: { address: address('3') },
      destinationMessenger: { address: address('4') },
      collateral: { address: address('5') },
    },
    feeds: { btcFeedId: BTC, ethFeedId: ETH, btcDecimals: 18, ethDecimals: 18 },
    rules: { observationWindow: 60, openingGrace: 150, settlementGrace: 3600, cutoffBuffer: 30, minimumGasLimit: 600000 },
  };
  const plan = { deployer: address('1'), chains: { base: { nonce: 11 }, horizen: { nonce: 22 } } };
  return { config, plan, expected: expectedConstructors(config, plan) };
}

function intent(index, constructorArgs) {
  const artifact = ARTIFACTS[index];
  const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: constructorArgs });
  return { constructorArgs, initCode, initCodeHash: keccak256(initCode) };
}

for (const [index, name] of NAMES.entries()) {
  test(`${name}: accepts the reviewed constructor`, () => {
    const { expected } = fixture();
    validateConstructorIntent(intent(index, expected[index]), ARTIFACTS[index], expected[index]);
  });

  test(`${name}: rejects mutually consistent altered args, initcode and hash`, () => {
    const { expected } = fixture();
    const altered = structuredClone(expected[index]);
    if (index === 0) altered[0] = address('6');
    else altered[0][index === 3 ? 'collateral' : 'sourceMessenger'] = address('6');
    // Merely recomputing the stored initcode/hash must not authorize another endpoint.
    assert.throws(() => validateConstructorIntent(intent(index, altered), ARTIFACTS[index], expected[index]));
  });

  test(`${name}: rejects a changed initcode hash`, () => {
    const { expected } = fixture();
    assert.throws(() => validateConstructorIntent(
      { ...intent(index, expected[index]), initCodeHash: `0x${'00'.repeat(32)}` },
      ARTIFACTS[index], expected[index],
    ));
  });
}

test('rejects string, negative, fractional and unsafe starting nonces', () => {
  for (const nonce of ['11', -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    const { config, plan } = fixture();
    plan.chains.base.nonce = nonce;
    assert.throws(() => expectedConstructors(config, plan));
    plan.chains.base.nonce = 11;
    plan.chains.horizen.nonce = nonce;
    assert.throws(() => expectedConstructors(config, plan));
  }
});

test('changed Base nonce cannot retain the original route addresses', () => {
  const { config, plan, expected } = fixture();
  plan.chains.base.nonce += 1;
  const moved = expectedConstructors(config, plan);
  for (const index of [1, 2]) {
    assert.throws(() => validateConstructorIntent(intent(index, expected[index]), ARTIFACTS[index], moved[index]));
  }
});

test('changed Horizen nonce cannot retain the original cache/registry bindings', () => {
  const { config, plan, expected } = fixture();
  plan.chains.horizen.nonce += 1;
  const moved = expectedConstructors(config, plan);
  for (const index of [1, 2, 3]) {
    assert.throws(() => validateConstructorIntent(intent(index, expected[index]), ARTIFACTS[index], moved[index]));
  }
});

test('changed deployer cannot retain the original CREATE addresses', () => {
  const { config, plan, expected } = fixture();
  plan.deployer = address('7');
  const moved = expectedConstructors(config, plan);
  for (const index of [1, 2, 3]) {
    assert.throws(() => validateConstructorIntent(intent(index, expected[index]), ARTIFACTS[index], moved[index]));
  }
});

test('route peer address tampering is rejected despite recomputed initcode', () => {
  const { expected } = fixture();
  for (const field of ['sourceOracle', 'publisher', 'destinationOracle']) {
    const altered = structuredClone(expected[1]);
    altered[0][field] = address('8');
    assert.throws(() => validateConstructorIntent(intent(1, altered), ARTIFACTS[1], expected[1]));
  }
});

test('JSON decimal strings remain compatible with independently rebuilt integer arguments', () => {
  const { expected } = fixture();
  const fromJson = JSON.parse(JSON.stringify(expected, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  for (const index of NAMES.keys()) {
    validateConstructorIntent(intent(index, fromJson[index]), ARTIFACTS[index], expected[index]);
  }
});

test('freshness accepts now and exactly five minutes, rejecting older, future or invalid dates', t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const age of [0, 300000]) demandFreshPlan({ createdAt: new Date(NOW - age).toISOString() });
  for (const age of [300001, -1]) {
    assert.throws(() => demandFreshPlan({ createdAt: new Date(NOW - age).toISOString() }));
  }
  assert.throws(() => demandFreshPlan({ createdAt: 'invalid' }));
});

test('first signing enforces the five-minute plan boundary', t => {
  t.mock.method(Date, 'now', () => NOW);
  demandSigningAge({ createdAt: new Date(NOW - 300000).toISOString() }, NOW - 1000, 0);
  assert.throws(() => demandSigningAge({ createdAt: new Date(NOW - 300001).toISOString() }, NOW - 1000, 0));
});

test('subsequent signing accepts a previously fresh plan through exactly fifteen minutes of the run', t => {
  t.mock.method(Date, 'now', () => NOW);
  const earlierPlan = { createdAt: new Date(NOW - 1000000).toISOString() };
  for (const signedCount of [1, 2, 3]) demandSigningAge(earlierPlan, NOW - 900000, signedCount);
});

test('subsequent signing stops immediately beyond the fifteen-minute run boundary', t => {
  t.mock.method(Date, 'now', () => NOW);
  const plan = { createdAt: new Date(NOW - 1000).toISOString() };
  for (const signedCount of [1, 2, 3]) {
    assert.throws(() => demandSigningAge(plan, NOW - 900001, signedCount));
  }
});

test('first and subsequent signing reject a clock moving before the run start', t => {
  t.mock.method(Date, 'now', () => NOW);
  const plan = { createdAt: new Date(NOW - 1000).toISOString() };
  for (const signedCount of [0, 1, 2, 3]) {
    assert.throws(() => demandSigningAge(plan, NOW + 1, signedCount));
  }
});
