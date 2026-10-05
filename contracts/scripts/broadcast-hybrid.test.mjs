import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDeployData, keccak256 } from 'viem';
import {
  expectedConstructors,
  validateConstructorIntent,
  demandFreshPlan,
  demandSigningAge,
  validateRecoveryCheckpoint,
  verifyRecordedTransaction,
} from './broadcast-hybrid.mjs';

function recoveryFixture() {
  const intent = { name: 'adapter', chainId: 8453, nonce: 11, predictedAddress: `0x${'2'.repeat(40)}`,
    initCodeHash: `0x${'a'.repeat(64)}` };
  // One creation is recorded, a second one is still to be signed.
  const plan = { createdAt: new Date(NOW - 601000).toISOString(), deployer: `0x${'1'.repeat(40)}`, intents: [intent, { ...intent, name: 'publisher', nonce: 12 }] };
  const planHash = `0x${'b'.repeat(64)}`;
  const checkpoint = { schemaVersion: 1, status: 'prepared', planHash, deployer: plan.deployer,
    startedAt: new Date(NOW - 600000).toISOString(), transactions: [{ ...intent, transactionHash: `0x${'c'.repeat(64)}`, status: 'submitted' }] };
  return { plan, planHash, checkpoint };
}

test('recovery accepts an aged original plan while preserving its original run start', t => {
  t.mock.method(Date, 'now', () => NOW);
  const { plan, planHash, checkpoint } = recoveryFixture();
  assert.equal(validateRecoveryCheckpoint(checkpoint, plan, planHash), NOW - 600000);
});

test('recovery rejects changed plan hash, deployer, intent identity, nonce or transaction hash', t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const mutate of [
    c => { c.planHash = `0x${'0'.repeat(64)}`; }, c => { c.deployer = `0x${'0'.repeat(40)}`; },
    c => { c.transactions[0].name = 'registry'; }, c => { c.transactions[0].nonce++; },
    c => { c.transactions[0].predictedAddress = `0x${'0'.repeat(40)}`; },
    c => { c.transactions[0].transactionHash = '0x'; },
  ]) {
    const { plan, planHash, checkpoint } = recoveryFixture(); mutate(checkpoint);
    assert.throws(() => validateRecoveryCheckpoint(checkpoint, plan, planHash));
  }
});

test('only a rehearsal entry still awaiting submission may lack a transaction hash', t => {
  t.mock.method(Date, 'now', () => NOW);
  const hashless = (rehearsal, status) => {
    const { plan, planHash, checkpoint } = recoveryFixture();
    Object.assign(checkpoint, { rehearsal }); Object.assign(checkpoint.transactions[0], { transactionHash: undefined, status });
    return () => validateRecoveryCheckpoint(checkpoint, plan, planHash);
  };
  assert.doesNotThrow(hashless(true, 'signed-awaiting-submission'));
  for (const [rehearsal, status] of [[false, 'signed-awaiting-submission'], [undefined, 'signed-awaiting-submission'], [true, 'submitted'], [true, 'confirmed']]) {
    assert.throws(hashless(rehearsal, status));
  }
});

test('recovery rejects empty/non-prefix checkpoints and changing the original start to now', t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const mutate of [
    c => { c.transactions = []; }, c => { c.transactions.push({ ...c.transactions[0] }); },
    c => { c.startedAt = new Date(NOW).toISOString(); },
  ]) {
    const { plan, planHash, checkpoint } = recoveryFixture(); mutate(checkpoint);
    assert.throws(() => validateRecoveryCheckpoint(checkpoint, plan, planHash));
  }
});

test('recovery cannot reset an expired fifteen-minute run', t => {
  const { plan, planHash, checkpoint } = recoveryFixture();
  t.mock.method(Date, 'now', () => NOW + 300000);
  assert.doesNotThrow(() => validateRecoveryCheckpoint(checkpoint, plan, planHash));
  t.mock.method(Date, 'now', () => NOW + 300001);
  assert.throws(() => validateRecoveryCheckpoint(checkpoint, plan, planHash));
});

test('a run with every transaction recorded can still be verified after the signing window', t => {
  const { plan, planHash, checkpoint } = recoveryFixture();
  plan.intents.pop();
  t.mock.method(Date, 'now', () => NOW + 86400000);
  assert.equal(validateRecoveryCheckpoint(checkpoint, plan, planHash), NOW - 600000);
});

function recordedFixture() {
  const code = '0x6000'; const initCode = '0x60006000f3'; const transactionHash = `0x${'c'.repeat(64)}`;
  const blockHash = `0x${'d'.repeat(64)}`; const predictedAddress = `0x${'2'.repeat(40)}`;
  const intent = { from: `0x${'1'.repeat(40)}`, chainId: 8453, nonce: 11, predictedAddress, initCode,
    initCodeHash: keccak256(initCode), simulatedRuntimeHash: keccak256(code), gasLimit: '100000',
    maxFeePerGas: '2', maxPriorityFeePerGas: '1', fees: { maximumEstimatedWei: '200050' } };
  const receipt = { transactionHash, status: 'success', contractAddress: predictedAddress, blockNumber: 90n, blockHash };
  const transaction = { hash: transactionHash, blockHash, blockNumber: 90n, to: null, value: 0n, from: intent.from,
    nonce: 11, chainId: 8453, type: 'eip1559', input: initCode, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  const reader = { getTransactionReceipt: async () => receipt, getTransaction: async () => transaction,
    getBlock: async () => ({ hash: blockHash, number: 90n }), getBlockNumber: async () => 91n,
    readContract: async ({ blockNumber }) => { assert.equal(blockNumber, 90n); return 20n; } };
  const client = { getCode: async () => code };
  return { intent, receipt, transaction, reader, client, entry: { transactionHash } };
}

test('recorded deployment recovery verifies public facts and conservatively rebuilds old fee bounds', async () => {
  const f = recordedFixture();
  const result = await verifyRecordedTransaction(f.reader, f.client, f.intent, f.entry);
  assert.equal(result.maximum, 200080n);
  assert.equal(result.runtimeCodeHash, f.intent.simulatedRuntimeHash);
  const higher = await verifyRecordedTransaction(f.reader, f.client, f.intent, { ...f.entry, feeUpperBoundWei: '200100' });
  assert.equal(higher.maximum, 200100n);
});

test('recorded deployment recovery stops on pending, one-confirmation or noncanonical receipts', async () => {
  for (const mutate of [
    f => { f.reader.getTransactionReceipt = async () => { throw new Error('not found'); }; },
    f => { f.reader.getBlockNumber = async () => 90n; },
    f => { f.reader.getBlock = async () => ({ hash: `0x${'0'.repeat(64)}` }); },
    f => { f.receipt.blockHash = `0x${'0'.repeat(64)}`; },
    f => { f.receipt.blockHash = undefined; },
    f => { f.reader.getBlock = async () => ({ hash: f.receipt.blockHash, number: 89n }); },
    f => { f.transaction.blockHash = `0x${'0'.repeat(64)}`; },
    f => { f.receipt.status = 'reverted'; },
  ]) {
    const f = recordedFixture(); mutate(f);
    await assert.rejects(verifyRecordedTransaction(f.reader, f.client, f.intent, f.entry));
  }
});

test('recorded deployment recovery rejects changed transaction identity, create data or runtime', async () => {
  for (const mutate of [
    f => { f.transaction.from = `0x${'0'.repeat(40)}`; }, f => { f.transaction.nonce++; },
    f => { f.transaction.value = 1n; }, f => { f.transaction.to = f.intent.predictedAddress; },
    f => { f.transaction.input = '0x'; }, f => { f.transaction.chainId = 26514; },
    f => { f.receipt.contractAddress = `0x${'0'.repeat(40)}`; }, f => { f.transaction.gas++; },
    f => { f.client.getCode = async () => '0x'; },
  ]) {
    const f = recordedFixture(); mutate(f);
    await assert.rejects(verifyRecordedTransaction(f.reader, f.client, f.intent, f.entry));
  }
});

// Public address/ABI fixtures only. No artifact loading, accounts, secrets, filesystem reads or RPC.
const address = digit => `0x${digit.repeat(40)}`;
const BTC = `0x0003${'0'.repeat(59)}1`;
const ETH = `0x0003${'0'.repeat(59)}2`;
const NOW = 1_800_000_000_000;
const NAMES = ['adapter', 'publisher', 'receiver'];
const inputs = definitions => definitions.map(([name, type]) => ({ name, type }));
const ROUTE_COMPONENTS = inputs([
  ['sourceChainId', 'uint256'], ['destinationChainId', 'uint256'],
  ['sourceMessenger', 'address'], ['destinationMessenger', 'address'], ['sourceOracle', 'address'],
  ['publisher', 'address'], ['destinationOracle', 'address'],
  ['btcFeedId', 'bytes32'], ['ethFeedId', 'bytes32'], ['btcDecimals', 'uint8'], ['ethDecimals', 'uint8'],
  ['observationWindow', 'uint32'], ['minimumGasLimit', 'uint32'],
]);
const constructorInputs = [
  inputs([['verifier', 'address'], ['btcFeedId', 'bytes32'], ['btcDecimals', 'uint8'], ['ethFeedId', 'bytes32'], ['ethDecimals', 'uint8']]),
  [{ name: 'config', type: 'tuple', components: ROUTE_COMPONENTS }],
  [{ name: 'config', type: 'tuple', components: ROUTE_COMPONENTS }],
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
    rules: { observationWindow: 60, openingGrace: 150, voidGrace: 604800, cutoffBuffer: 30, minimumGasLimit: 600000 },
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
    else altered[0].sourceMessenger = address('6');
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

test('changed Horizen nonce cannot retain the original cache binding', () => {
  const { config, plan, expected } = fixture();
  plan.chains.horizen.nonce += 1;
  const moved = expectedConstructors(config, plan);
  for (const index of [1, 2]) {
    assert.throws(() => validateConstructorIntent(intent(index, expected[index]), ARTIFACTS[index], moved[index]));
  }
});

test('changed deployer cannot retain the original CREATE addresses', () => {
  const { config, plan, expected } = fixture();
  plan.deployer = address('7');
  const moved = expectedConstructors(config, plan);
  for (const index of [1, 2]) {
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
