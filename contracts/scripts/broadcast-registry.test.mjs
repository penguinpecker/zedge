import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, pad, parseAbi, parseTransaction, recoverTransactionAddress, getContractAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RPCS, GAS_ORACLE, json } from './preflight-hybrid.mjs';
import {
  PLAN_STATUS, BROADCAST_STATUS, registryCreation, runtimeCode, expectedRegistry, buildIntents, roundId, runFiles,
} from './plan-registry.mjs';
import { parseOptions, validatePlan, makeSigner, broadcast } from './broadcast-registry.mjs';

// In-memory chain and a throwaway key generated per run. No RPC, no build output, no key file: every chain
// access and both signer dependencies are handed to broadcast(), which is what these tests rely on.
const FORK = 'http://127.0.0.1:8545';
const ZERO = `0x${'0'.repeat(40)}`;
const account = privateKeyToAccount(generatePrivateKey());
const config = { ...JSON.parse(readFileSync(new URL('../deployment/hybrid-mainnet.json', import.meta.url), 'utf8')), deployer: account.address };
const configText = JSON.stringify(config);
const abi = JSON.parse(readFileSync(new URL('../abi/StreamsRoundRegistry.json', import.meta.url), 'utf8'));
const artifacts = {
  StreamsRoundRegistry: { abi, bytecode: { object: `0x6080${'aa'.repeat(30)}` },
    deployedBytecode: { object: `0x${'11'.repeat(80)}`, immutableReferences: { 7: [{ start: 4, length: 32 }, { start: 44, length: 32 }] } } },
  ERC1967Proxy: { abi: parseAbi(['constructor(address implementation, bytes _data) payable']), bytecode: { object: `0x6080${'bb'.repeat(20)}` },
    deployedBytecode: { object: '0x363d3d373d3d3d' } },
};
const blockHash = number => keccak256(toHex(`block ${number}`));

// The committed release as write-release.mjs records it, reduced to what the broadcaster reads.
const releaseFor = (expected, text = configText) => ({ schemaVersion: 2, status: 'planned', configHash: keccak256(toHex(text)), rulesHash: expected.rulesHash,
  contracts: [{}, {}, {}, { name: 'StreamsRoundRegistry', address: expected.proxy, runtimeCodeHash: expected.proxyCodeHash,
    proxy: { implementation: expected.implementation, implementationCodeHash: expected.implementationCodeHash, owner: expected.owner } }] });

function fixture({ rehearsal, age = 0, nonce = 2, build = artifacts, profile = config } = {}) {
  const creation = registryCreation(profile, profile.deployer, nonce, abi);
  const expected = expectedRegistry(creation, build);
  const intents = buildIntents(creation, build, nonce).map((intent, i) => ({ ...intent, gasLimit: 3000000n, simulatedGas: 2400000n,
    simulatedRuntimeHash: i === 0 ? expected.implementationCodeHash : expected.proxyCodeHash, checksPassed: true,
    maxFeePerGas: 2000504n, maxPriorityFeePerGas: 1000000n, fees: { maximumEstimatedWei: 3000000n * 2000504n + 1000n } }));
  const planText = json({ schemaVersion: 1, status: PLAN_STATUS, createdAt: new Date(Date.now() - age).toISOString(), expiresAfterSeconds: 300,
    noLiveTransactions: true, rehearsal: rehearsal !== undefined, deployer: profile.deployer, configHash: keccak256(toHex(JSON.stringify(profile))),
    chains: { horizen: { chainId: 26514, publicRpcUrl: rehearsal ?? RPCS.horizen, blockNumber: 90n, blockHash: blockHash(90n), nonce } },
    predicted: { implementation: creation.implementation, proxy: creation.proxy }, owner: creation.owner, rulesHash: creation.rulesHash, intents,
    budgets: { horizen: { approvedCeilingWei: config.maximumSpendWei.horizen, maximumEstimatedWei: 2n * (3000000n * 2000504n + 1000n) } },
    simulation: { performed: true, chainStateOverridden: false, balancesOverridden: false, generatedWalletAccounts: 0 } });
  return { creation, expected, planText, plan: JSON.parse(planText), release: releaseFor(expected, JSON.stringify(profile)) };
}

function chain(expected, nonce = 2) {
  const c = expected.registryConfig;
  const runtime = { [expected.implementation]: runtimeCode(artifacts.StreamsRoundRegistry, expected.implementation),
    [expected.proxy]: runtimeCode(artifacts.ERC1967Proxy, expected.proxy) };
  // lose: nonces whose send request fails before the node receives it. deaf: nonces the node mines without answering.
  const state = { chainId: 26514, nonce, pending: 0, head: 100n, balance: 10n ** 15n, estimate: 2400000n, fees: { maxFeePerGas: 1000302n, maxPriorityFeePerGas: 1000000n },
    code: new Map(), mined: new Map(), sent: [], requests: [], runtime, lose: [], deaf: [],
    getters: { version: 'zedge-streams-round-registry-v2', rulesHash: expected.rulesHash, owner: expected.owner, pendingOwner: ZERO, ...c,
      deploymentChainId: 26514n, roundIdFor: roundId(expected.proxy, expected.rulesHash, { asset: 0, duration: 300, start: 1791100800 }) } };
  function mine(tx, hash) {
    if (state.lose.includes(tx.nonce)) { state.lose.splice(state.lose.indexOf(tx.nonce), 1); throw new Error('HTTP 429 Too Many Requests'); }
    assert.equal(tx.nonce, state.nonce, 'the node rejects a wrong nonce');
    const created = getContractAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
    state.code.set(created, state.runtime[created]); state.nonce += 1;
    const blockNumber = state.head + 1n; state.head += 2n;
    const receipt = { transactionHash: hash, status: 'success', contractAddress: created, blockNumber, blockHash: blockHash(blockNumber) };
    state.mined.set(hash, { receipt, tx: { ...tx, hash, blockHash: receipt.blockHash, blockNumber, to: null, value: 0n, chainId: 26514, type: 'eip1559' } });
    state.sent.push(tx);
    if (state.deaf.includes(tx.nonce)) throw new Error('request timed out');
    return hash;
  }
  const client = {
    getChainId: async () => state.chainId,
    getTransactionCount: async ({ blockTag }) => state.nonce + (blockTag === 'pending' ? state.pending : 0),
    getCode: async ({ address }) => state.code.get(address),
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: blockHash(blockNumber) }),
    getBlockNumber: async () => state.head,
    estimateGas: async () => state.estimate,
    estimateFeesPerGas: async () => state.fees,
    getBalance: async () => state.balance,
    readContract: async ({ address, functionName }) => address === GAS_ORACLE ? (functionName === 'getL1FeeUpperBound' ? 500n : 0n) : state.getters[functionName],
    getStorageAt: async () => pad(expected.implementation),
    call: async () => { throw Object.assign(new Error('execution reverted'), { data: '0xf92ee8a9' }); },
    getTransactionReceipt: async ({ hash }) => { if (!state.mined.has(hash)) throw new Error('receipt not found'); return state.mined.get(hash).receipt; },
    waitForTransactionReceipt: async ({ hash }) => state.mined.get(hash).receipt,
    getTransaction: async ({ hash }) => state.mined.get(hash).tx,
    // Anvil only: an impersonated, unsigned send.
    request: async ({ method, params }) => {
      state.requests.push(method);
      if (method === 'anvil_impersonateAccount') return null;
      assert.equal(method, 'eth_sendTransaction');
      const [t] = params;
      return mine({ from: t.from, nonce: Number(t.nonce), input: t.data, gas: BigInt(t.gas), maxFeePerGas: BigInt(t.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) }, keccak256(toHex(`impersonated ${t.nonce}`)));
    },
  };
  // Mainnet only: the node recovers the sender from the signature.
  const sendRaw = async signed => {
    const t = parseTransaction(signed);
    assert.equal(t.chainId, 26514); assert.equal(t.to ?? null, null); assert.equal(t.value ?? 0n, 0n);
    return mine({ from: await recoverTransactionAddress({ serializedTransaction: signed }), nonce: t.nonce, input: t.data, gas: t.gas,
      maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas }, keccak256(signed));
  };
  return { state, client, sendRaw };
}

async function run({ rehearsal, resume = false, files, age, mutate } = {}) {
  const f = fixture({ rehearsal, age }); const net = chain(f.expected);
  const trace = [];
  const io = { files: files ?? runFiles(await mkdtemp(join(tmpdir(), 'zedge-registry-'))), ...net, trace,
    loadAccount: async expected => { trace.push('loadAccount'); assert.equal(expected, config.deployer); return account; } };
  mutate?.(net.state, f, io);
  const start = (again = resume) => broadcast({ options: { rehearsal, resume: again, files: io.files }, plan: f.plan, planText: f.planText, config, configText, artifacts,
    release: f.release, client: net.client, quotes: net.client, recheck: async () => { trace.push('recheck'); }, log: () => {},
    ...(rehearsal ? { loadAccount: () => assert.fail('a rehearsal reached the key loader'), sendRaw: () => assert.fail('a rehearsal reached the raw send') }
      : { loadAccount: io.loadAccount, sendRaw: net.sendRaw }) });
  return { ...f, ...io, start, resume: () => start(true), checkpoint: async () => JSON.parse(await readFile(io.files.checkpoint, 'utf8')) };
}

test('no arguments, the old flag or a mixed request never start a broadcast', () => {
  const evidence = join(tmpdir(), 'zedge-rehearsal');
  for (const args of [
    [], ['--broadcast'], ['--resume'], ['--mainnet'], ['--broadcast-mainnet', '--resume-mainnet'], ['--broadcast-mainnet', '--resume'],
    ['--broadcast-mainnet', '--evidence', evidence], ['--rehearsal', FORK], ['--rehearsal', FORK, '--evidence', evidence, '--broadcast-mainnet'],
    ['--rehearsal', RPCS.horizen, '--evidence', evidence], ['--rehearsal', 'http://203.0.113.5:8545', '--evidence', evidence],
    ['--rehearsal', FORK, '--evidence', runFiles().directory], ['--evidence', evidence],
  ]) assert.throws(() => parseOptions(args), undefined, args.join(' '));
  assert.deepEqual(parseOptions(['--broadcast-mainnet']), { rehearsal: undefined, resume: false, files: runFiles() });
  assert.deepEqual(parseOptions(['--resume-mainnet']), { rehearsal: undefined, resume: true, files: runFiles() });
  assert.deepEqual(parseOptions(['--rehearsal', FORK, '--evidence', evidence, '--resume']), { rehearsal: FORK, resume: true, files: runFiles(evidence) });
});

test('a real broadcast refuses a plan older than five minutes before any chain access or key load', async () => {
  const r = await run({ age: 300001 });
  await assert.rejects(r.start(), /older than five minutes/);
  assert.deepEqual([r.trace, r.state.sent.length], [[], 0]);
  await assert.rejects(readFile(r.files.checkpoint), { code: 'ENOENT' });
  await assert.rejects((await run({ age: -60000 })).start(), /older than five minutes/);
  await assert.doesNotReject((await run({ age: 299000 })).start());
});

test('a real broadcast refuses a rehearsal plan, and a rehearsal refuses a mainnet plan or another fork', async () => {
  const real = fixture(); const rehearsed = fixture({ rehearsal: FORK });
  const input = { config, configText, artifacts, release: real.release, resume: false };
  assert.throws(() => validatePlan({ ...input, plan: rehearsed.plan }), /only a plan made against Horizen mainnet/);
  assert.throws(() => validatePlan({ ...input, plan: real.plan, rehearsal: FORK }), /same fork/);
  assert.throws(() => validatePlan({ ...input, plan: rehearsed.plan, rehearsal: 'http://127.0.0.1:9999' }), /same fork/);
  assert.throws(() => validatePlan({ ...input, plan: { ...real.plan, chains: { horizen: { ...real.plan.chains.horizen, publicRpcUrl: FORK } } } }));
  validatePlan({ ...input, plan: real.plan }); validatePlan({ ...input, plan: rehearsed.plan, rehearsal: FORK });
});

test('a plan that differs from the reviewed profile is refused even when its own hashes are recomputed', () => {
  const input = { config, configText, artifacts, release: fixture().release, resume: false };
  // The same plan built for another owner, cache or nonce is internally consistent and must still be refused.
  const rebuilt = change => {
    const f = fixture(); const creation = { ...f.creation, ...change(f.creation) };
    const intents = buildIntents(creation, artifacts, 2);
    return { ...f.plan, intents: f.plan.intents.map((intent, i) => ({ ...intent, constructorArgs: intents[i].constructorArgs,
      initCode: intents[i].initCode, initCodeHash: intents[i].initCodeHash })) };
  };
  const foreign = registryCreation({ ...config, deployer: `0x${'7'.repeat(40)}` }, `0x${'7'.repeat(40)}`, 2, abi);
  for (const [name, plan] of Object.entries({
    'other owner': rebuilt(c => ({ constructorArgs: [[], [c.implementation, foreign.initData]] })),
    'other implementation': rebuilt(() => ({ constructorArgs: [[], [`0x${'9'.repeat(40)}`, fixture().creation.initData]] })),
    'nonce without addresses': (p => ({ ...p, chains: { horizen: { ...p.chains.horizen, nonce: 3 } } }))(fixture().plan),
    'rules hash': { ...fixture().plan, rulesHash: `0x${'0'.repeat(64)}` },
    'owner field': { ...fixture().plan, owner: `0x${'7'.repeat(40)}` },
    'status': { ...fixture().plan, status: 'failed' },
    'not simulated': { ...fixture().plan, simulation: { performed: false } },
    'config hash': { ...fixture().plan, configHash: `0x${'0'.repeat(64)}` },
    'third creation': (p => ({ ...p, intents: [...p.intents, p.intents[1]] }))(fixture().plan),
    'runtime hash': (p => ({ ...p, intents: [{ ...p.intents[0], simulatedRuntimeHash: p.intents[1].simulatedRuntimeHash }, p.intents[1]] }))(fixture().plan),
    'unchecked': (p => ({ ...p, intents: [p.intents[0], { ...p.intents[1], checksPassed: false }] }))(fixture().plan),
    'gas limit': (p => ({ ...p, intents: [{ ...p.intents[0], gasLimit: '8000001' }, p.intents[1]] }))(fixture().plan),
    'value': (p => ({ ...p, intents: [{ ...p.intents[0], value: '1' }, p.intents[1]] }))(fixture().plan),
    'signing chain': (p => ({ ...p, intents: [{ ...p.intents[0], chainId: 8453 }, p.intents[1]] }))(fixture().plan),
    'sender': (p => ({ ...p, intents: [p.intents[0], { ...p.intents[1], from: `0x${'7'.repeat(40)}` }] }))(fixture().plan),
    'signed nonce': (p => ({ ...p, intents: [p.intents[0], { ...p.intents[1], nonce: 4 }] }))(fixture().plan),
    'plan chain': (p => ({ ...p, chains: { horizen: { ...p.chains.horizen, chainId: 8453 } } }))(fixture().plan),
    'budget': (p => ({ ...p, budgets: { horizen: { ...p.budgets.horizen, maximumEstimatedWei: '120000000000001' } } }))(fixture().plan),
    'ceiling': (p => ({ ...p, budgets: { horizen: { ...p.budgets.horizen, approvedCeilingWei: '130000000000000' } } }))(fixture().plan),
  })) assert.throws(() => validatePlan({ ...input, plan }), undefined, name);
  // A plan honestly built at another nonce is internally valid. It is accepted only once the committed release names its addresses.
  const moved = fixture({ nonce: 3 });
  assert.throws(() => validatePlan({ ...input, plan: moved.plan }), /does not name what this plan creates \(proxy address, implementation address\)/);
  validatePlan({ ...input, plan: moved.plan, release: moved.release });
  assert.throws(() => validatePlan({ ...input, plan: fixture().plan, artifacts: { ...artifacts, ERC1967Proxy: { ...artifacts.ERC1967Proxy, bytecode: { object: '0x6081' } } } }));
  assert.throws(() => validatePlan({ ...input, plan: fixture().plan, configText: `${configText} ` }));
  assert.throws(() => validatePlan({ ...input, plan: fixture().plan, config: { ...config, chains: { ...config.chains, horizen: { chainId: 26514, rpcUrl: FORK } } } }), /another chain/);
});

test('a rehearsal completes by impersonation and never reaches the key loader or the raw send', async () => {
  const r = await run({ rehearsal: FORK });
  const checkpoint = await r.start();
  assert.deepEqual(r.state.requests, ['anvil_impersonateAccount', 'eth_sendTransaction', 'eth_sendTransaction']);
  assert.ok(!r.trace.includes('loadAccount'));
  assert.equal(checkpoint.status, BROADCAST_STATUS);
  const saved = await r.checkpoint();
  assert.deepEqual(saved.transactions.map(t => [t.name, t.status, t.predictedAddress, t.runtimeCodeHash]), [
    ['StreamsRoundRegistry', 'confirmed', r.expected.implementation, r.expected.implementationCodeHash],
    ['ERC1967Proxy', 'confirmed', r.expected.proxy, r.expected.proxyCodeHash]]);
  assert.ok(saved.rehearsal && saved.transactions[1].registryChecked.includes('implementation slot'));
  // The same plan cannot be broadcast twice: a second start is refused, with the reason, before any chain access.
  r.trace.length = 0;
  await assert.rejects(r.start(), /a checkpoint exists .*continue with --resume$/);
  assert.deepEqual([r.state.sent.length, r.trace], [2, []]);
});

test('the signer alone separates the modes: rehearsal opens no key, mainnet loads it once', async () => {
  const requests = [];
  const client = { request: async request => { requests.push(request); return `0x${'c'.repeat(64)}`; } };
  const spy = t => { const calls = []; return Object.assign(async (...args) => { calls.push(args); return t; }, { calls }); };
  const loadAccount = spy(account); const sendRaw = spy(`0x${'d'.repeat(64)}`);
  const transaction = { type: 'eip1559', chainId: 26514, nonce: 2, data: '0x6080', value: 0n, gas: 3000000n, maxFeePerGas: 2000504n, maxPriorityFeePerGas: 1000000n };
  const rehearse = await makeSigner({ rehearsal: FORK, client, deployer: account.address, loadAccount, sendRaw });
  const impersonated = await rehearse(transaction);
  assert.equal(impersonated.hash, undefined);
  await impersonated.send();
  assert.deepEqual([loadAccount.calls.length, sendRaw.calls.length], [0, 0]);
  assert.deepEqual(requests.map(x => x.method), ['anvil_impersonateAccount', 'eth_sendTransaction']);
  assert.deepEqual(requests[1].params, [{ from: account.address, data: '0x6080', value: '0x0', nonce: '0x2', gas: '0x2dc6c0', maxFeePerGas: '0x1e8678', maxPriorityFeePerGas: '0xf4240', type: '0x2' }]);
  const sign = await makeSigner({ rehearsal: undefined, client, deployer: account.address, loadAccount, sendRaw });
  const signed = await sign(transaction); await signed.send();
  assert.deepEqual([loadAccount.calls, sendRaw.calls.length, requests.length], [[[account.address]], 1, 2]);
  assert.equal(signed.hash, keccak256(sendRaw.calls[0][0]));
  assert.equal(await recoverTransactionAddress({ serializedTransaction: sendRaw.calls[0][0] }), account.address);
});

test('mainnet mode runs the same steps and sends the same two transactions as the rehearsal', async () => {
  const real = await run(); const rehearsed = await run({ rehearsal: FORK });
  assert.equal((await real.start()).status, BROADCAST_STATUS);
  await rehearsed.start();
  // Public validation and the dependency recheck come before the key; the key is loaded exactly once.
  assert.deepEqual(real.trace, ['recheck', 'loadAccount', 'recheck', 'recheck']);
  assert.deepEqual(rehearsed.trace, ['recheck', 'recheck', 'recheck']);
  assert.deepEqual(real.state.requests, []);
  assert.deepEqual(real.state.sent, rehearsed.state.sent);
  assert.deepEqual(real.state.sent.map(t => [t.from, t.nonce, t.input, t.gas, t.maxFeePerGas, t.maxPriorityFeePerGas]),
    real.plan.intents.map(i => [config.deployer, i.nonce, i.initCode, 3000000n, 2000504n, 1000000n]));
  const strip = c => c.transactions.map(({ transactionHash, receipt, ...rest }) => rest);
  assert.deepEqual(strip(await real.checkpoint()), strip(await rehearsed.checkpoint()));
});

test('nothing is signed when the live chain no longer matches the plan', async () => {
  for (const [name, mutate] of Object.entries({
    'nonce moved': s => { s.nonce = 3; },
    'a pending transaction from the deployer': s => { s.pending = 1; },
    'another chain answers': s => { s.chainId = 8453; },
    'address occupied': (s, f) => { s.code.set(f.expected.implementation, '0x00'); },
    'deployer has code': s => { s.code.set(config.deployer, '0xef0100'); },
    'gas estimate above the limit': s => { s.estimate = 3000001n; },
    'fee above the cap': s => { s.fees = { maxFeePerGas: 2000505n, maxPriorityFeePerGas: 1000000n }; },
    'tip above the cap': s => { s.fees = { maxFeePerGas: 1000302n, maxPriorityFeePerGas: 1000001n }; },
    'balance too low': s => { s.balance = 2n * 3000000n * 2000504n; },
    'planned block reorganised': (s, f) => { f.plan.chains.horizen.blockHash = blockHash(91n); },
  })) {
    for (const rehearsal of [undefined, FORK]) {
      const r = await run({ rehearsal, mutate });
      await assert.rejects(r.start(), undefined, name);
      assert.equal(r.state.sent.length, 0, name);
      // Nothing was signed, so nothing is recorded: no checkpoint stands in the way of planning and starting again.
      await assert.rejects(readFile(r.files.checkpoint), { code: 'ENOENT' }, name);
    }
  }
});

test('the hard spend ceiling stops the run before a signature', async () => {
  const r = await run({ mutate: (s, f) => { f.plan.intents[1].fees.maximumEstimatedWei = '119999999999000'; } });
  await assert.rejects(r.start(), /hard spend ceiling/);
  assert.equal(r.state.sent.length, 0);
});

test('a wrong runtime after the first receipt stops before the proxy is sent', async () => {
  for (const rehearsal of [undefined, FORK]) {
    const r = await run({ rehearsal, mutate: (s, f) => { s.runtime[f.expected.implementation] = '0x00'; } });
    await assert.rejects(r.start());
    assert.equal(r.state.sent.length, 1);
    const saved = await r.checkpoint();
    assert.deepEqual([saved.status, saved.transactions.length, saved.transactions[0].status], ['prepared', 1, 'submitted']);
  }
});

test('a registry that is not the simulated one is never recorded as broadcast', async () => {
  for (const mutate of [s => { s.getters.owner = `0x${'9'.repeat(40)}`; }, s => { s.getters.pendingOwner = `0x${'9'.repeat(40)}`; },
    s => { s.getters.rulesHash = `0x${'0'.repeat(64)}`; }]) {
    const r = await run({ mutate });
    await assert.rejects(r.start(), /Registry/);
    assert.equal((await r.checkpoint()).status, 'prepared');
  }
});

test('resume verifies the recorded creation on chain and sends only what is missing', async () => {
  for (const rehearsal of [undefined, FORK]) {
    // First run: the implementation confirms, then the endpoint fails before the proxy is signed.
    const r = await run({ rehearsal });
    const estimate = r.client.estimateGas; let calls = 0;
    r.client.estimateGas = async () => { if (++calls === 2) throw new Error('endpoint down'); return estimate(); };
    await assert.rejects(r.start(), /endpoint down/);
    assert.deepEqual([r.state.sent.length, (await r.checkpoint()).transactions.map(t => t.status)], [1, ['confirmed']]);
    r.client.estimateGas = estimate;
    const resumed = await r.resume();
    assert.equal(resumed.status, BROADCAST_STATUS);
    assert.deepEqual(r.state.sent.map(t => t.nonce), [2, 3]);
    assert.deepEqual(resumed.transactions.map(t => t.status), ['confirmed', 'confirmed']);
  }
});

test('resume stops on a confirmed creation whose receipt is gone and sends nothing; modes do not mix', async () => {
  const r = await run();
  const estimate = r.client.estimateGas; let calls = 0;
  r.client.estimateGas = async () => { if (++calls === 2) throw new Error('endpoint down'); return estimate(); };
  await assert.rejects(r.start());
  const resume = (rehearsal, client = r.client) => broadcast({ options: { rehearsal, resume: true, files: r.files }, plan: r.plan, planText: r.planText,
    config, configText, artifacts, release: r.release, client, quotes: client, recheck: async () => {}, log: () => {}, loadAccount: r.loadAccount, sendRaw: r.sendRaw });
  await assert.rejects(resume(undefined, { ...r.client, getTransactionReceipt: async () => { throw new Error('receipt not found'); } }));
  await assert.rejects(resume(FORK));
  assert.equal(r.state.sent.length, 1);
  // A reorganisation that takes a confirmed creation away and frees its nonce is not a lost send: a creation
  // that was verified and then vanished is left to a person, never signed again.
  r.state.nonce = 2; r.state.mined.clear(); r.state.code.clear();
  await assert.rejects(resume(undefined), /receipt not found/);
  assert.equal(r.state.sent.length, 1);
});

test('after the signing window a resume only verifies: it finishes a fully sent run and refuses to sign the rest', async t => {
  const later = Date.now() + 16 * 60000;
  // Both creations mined, then the registry check failed on an endpoint error: nothing is left to sign.
  const sent = await run();
  const storage = sent.client.getStorageAt; sent.client.getStorageAt = async () => { throw new Error('endpoint down'); };
  await assert.rejects(sent.start());
  assert.deepEqual([(await sent.checkpoint()).status, sent.state.sent.length], ['prepared', 2]);
  sent.client.getStorageAt = storage;
  // Only the implementation mined: the proxy would still have to be signed.
  const half = await run();
  const estimate = half.client.estimateGas; let calls = 0;
  half.client.estimateGas = async () => { if (++calls === 2) throw new Error('endpoint down'); return estimate(); };
  await assert.rejects(half.start());
  half.client.estimateGas = estimate;
  t.mock.method(Date, 'now', () => later);
  const resume = r => broadcast({ options: { rehearsal: undefined, resume: true, files: r.files }, plan: r.plan, planText: r.planText, config, configText,
    artifacts, release: r.release, client: r.client, quotes: r.client, recheck: async () => {}, log: () => {},
    loadAccount: () => assert.fail('nothing is left to sign'), sendRaw: () => assert.fail('nothing is left to send') });
  assert.equal((await resume(sent)).status, BROADCAST_STATUS);
  await assert.rejects(resume(half), /signing window has passed/);
  assert.deepEqual([sent.state.sent.length, half.state.sent.length], [2, 1]);
});

test('only the registry the committed release names is broadcast: a changed build, profile or nonce is refused before anything else', async () => {
  const reviewed = fixture();
  // The audit's drift case: the source changed after review and was rebuilt. The plan is honest about the new build.
  const rebuilt = { ...artifacts, StreamsRoundRegistry: { ...artifacts.StreamsRoundRegistry, bytecode: { object: `0x6080${'ac'.repeat(30)}` },
    deployedBytecode: { ...artifacts.StreamsRoundRegistry.deployedBytecode, object: `0x${'12'.repeat(80)}` } } };
  const drifted = fixture({ build: rebuilt });
  const input = { plan: drifted.plan, config, configText, artifacts: rebuilt, resume: false };
  assert.throws(() => validatePlan({ ...input, release: reviewed.release }), /does not name what this plan creates \(implementation runtime hash\)/);
  validatePlan({ ...input, release: drifted.release });   // accepted only after the release was regenerated and reviewed
  // An edited profile (another collateral token) with a plan honestly made for it.
  const edited = { ...config, dependencies: { ...config.dependencies, collateral: { ...config.dependencies.collateral, address: `0x${'5'.repeat(40)}` } } };
  const other = fixture({ profile: edited });
  assert.throws(() => validatePlan({ plan: other.plan, config: edited, configText: JSON.stringify(edited), artifacts, release: reviewed.release, resume: false }),
    /\(profile hash, rules hash\)/);
  // Each pinned field on its own, a release that is not schema 2, and one that is already recorded as deployed.
  const registry = change => ({ ...reviewed.release, contracts: [{}, {}, {}, change(reviewed.release.contracts[3])] });
  for (const [name, release] of Object.entries({
    'owner': registry(c => ({ ...c, proxy: { ...c.proxy, owner: `0x${'9'.repeat(40)}` } })),
    'proxy runtime hash': registry(c => ({ ...c, runtimeCodeHash: `0x${'0'.repeat(64)}` })),
    'implementation runtime hash': registry(c => ({ ...c, proxy: { ...c.proxy, implementationCodeHash: `0x${'0'.repeat(64)}` } })),
    'proxy address': registry(c => ({ ...c, address: `0x${'9'.repeat(40)}` })),
    'rules hash': { ...reviewed.release, rulesHash: `0x${'0'.repeat(64)}` },
    'profile hash': { ...reviewed.release, configHash: `0x${'0'.repeat(64)}` },
    'release format': { ...reviewed.release, schemaVersion: 1 },
  })) assert.throws(() => validatePlan({ plan: reviewed.plan, config, configText, artifacts, release, resume: false }), new RegExp(`\\(${name}\\)`), name);
  const deployed = { ...reviewed.release, status: 'deployed' };
  assert.throws(() => validatePlan({ plan: reviewed.plan, config, configText, artifacts, release: deployed, resume: false }), /not planned any more/);
  validatePlan({ plan: reviewed.plan, config, configText, artifacts, release: deployed, resume: true });
  // The whole flow, both modes: refused before any chain access, key load, signature or file.
  for (const rehearsal of [undefined, FORK]) {
    const r = await run({ rehearsal, mutate: (s, f) => { f.release.contracts[3].proxy.implementationCodeHash = `0x${'0'.repeat(64)}`; } });
    await assert.rejects(r.start(), /implementation runtime hash/);
    assert.deepEqual([r.trace, r.state.sent.length, r.state.requests], [[], 0, []]);
    await assert.rejects(readFile(r.files.checkpoint), { code: 'ENOENT' });
  }
});

test('a run refused before its first signature leaves nothing behind and is simply started again', async () => {
  // What the key loader throws for a 0644 key file, a missing file or a key for another address.
  const r = await run(); const loadAccount = r.loadAccount; let refuse = true;
  const start = () => broadcast({ options: { rehearsal: undefined, resume: false, files: r.files }, plan: r.plan, planText: r.planText, config, configText, artifacts,
    release: r.release, client: r.client, quotes: r.client, recheck: async () => {}, log: () => {}, sendRaw: r.sendRaw,
    loadAccount: async expected => { if (refuse) throw new Error('Preflight mismatch'); return loadAccount(expected); } });
  await assert.rejects(start(), /Preflight mismatch/);
  await assert.rejects(readFile(r.files.checkpoint), { code: 'ENOENT' });
  refuse = false;
  assert.equal((await start()).status, BROADCAST_STATUS);
  // A live refusal (here the balance), in both modes: the same command works once the cause is gone.
  for (const rehearsal of [undefined, FORK]) {
    const low = await run({ rehearsal, mutate: s => { s.balance = 0n; } });
    await assert.rejects(low.start(), /balance does not cover/);
    await assert.rejects(readFile(low.files.checkpoint), { code: 'ENOENT' });
    low.state.balance = 10n ** 15n;
    assert.equal((await low.start()).status, BROADCAST_STATUS);
    assert.deepEqual(low.state.sent.map(t => t.nonce), [2, 3]);
  }
});

test('the first checkpoint write is exclusive: a run that meets another run\'s checkpoint at signing time sends nothing', async () => {
  for (const rehearsal of [undefined, FORK]) {
    const r = await run({ rehearsal });
    // Another run of the same plan got to its first signature while this one was still in its live preflight.
    const balance = r.client.getBalance;
    r.client.getBalance = async request => { await writeFile(r.files.checkpoint, '{"status":"prepared"}\n', { flag: 'wx' }); return balance(request); };
    await assert.rejects(r.start(), { code: 'EEXIST' });
    assert.equal(r.state.sent.length, 0);
    assert.equal(await readFile(r.files.checkpoint, 'utf8'), '{"status":"prepared"}\n');
  }
});

test('a send request that never reached the chain is not lost: resume signs the same transaction again and finishes', async () => {
  for (const rehearsal of [undefined, FORK]) {
    for (const lost of [2, 3]) {
      const r = await run({ rehearsal, mutate: s => { s.lose = [lost]; } });
      await assert.rejects(r.start(), /429/);
      const before = await r.checkpoint();
      assert.deepEqual(before.transactions.map(t => t.status), lost === 2 ? ['signed-awaiting-submission'] : ['confirmed', 'signed-awaiting-submission']);
      assert.deepEqual([r.state.nonce, r.state.sent.length], [lost, lost - 2]);
      // A real entry records the hash its signature fixed; a rehearsal learns one only from the fork.
      const recorded = before.transactions.at(-1).transactionHash;
      assert.equal(recorded === undefined, rehearsal !== undefined);
      const resumed = await r.resume();
      assert.equal(resumed.status, BROADCAST_STATUS);
      assert.deepEqual(resumed.transactions.map(t => [t.status, t.nonce]), [['confirmed', 2], ['confirmed', 3]]);
      assert.deepEqual(r.state.sent.map(t => [t.nonce, t.input]), r.plan.intents.map(i => [i.nonce, i.initCode]));
      if (!rehearsal) assert.equal(resumed.transactions[lost - 2].transactionHash, recorded);
    }
  }
});

test('resume sends nothing for a recorded transaction the chain already holds or still has pending', async () => {
  // The node mined the proxy but its answer was lost: the entry still says "awaiting submission".
  const mined = await run({ mutate: s => { s.deaf = [3]; } });
  await assert.rejects(mined.start(), /timed out/);
  assert.deepEqual([(await mined.checkpoint()).transactions.map(t => t.status), mined.state.sent.length], [['confirmed', 'signed-awaiting-submission'], 2]);
  const finished = await broadcast({ options: { rehearsal: undefined, resume: true, files: mined.files }, plan: mined.plan, planText: mined.planText, config, configText,
    artifacts, release: mined.release, client: mined.client, quotes: mined.client, recheck: async () => {}, log: () => {},
    loadAccount: () => assert.fail('nothing is left to sign'), sendRaw: () => assert.fail('nothing is left to send') });
  assert.deepEqual([finished.status, mined.state.sent.length], [BROADCAST_STATUS, 2]);
  // The node holds the transaction as pending: the nonce is taken, so it is neither signed again nor sent.
  const pending = await run({ mutate: s => { s.lose = [3]; } });
  await assert.rejects(pending.start());
  pending.state.pending = 1;
  await assert.rejects(pending.resume(), /receipt not found/);
  assert.deepEqual([pending.state.sent.length, pending.trace.filter(x => x === 'loadAccount').length], [1, 1]);
});

test('signing a lost transaction again obeys the signing window and must reproduce the recorded hash', async t => {
  const tampered = await run({ mutate: s => { s.lose = [3]; } });
  await assert.rejects(tampered.start());
  const saved = await tampered.checkpoint(); saved.transactions[1].transactionHash = keccak256('0x00');
  await writeFile(tampered.files.checkpoint, json(saved));
  await assert.rejects(tampered.resume(), /gave another hash/);
  const late = await run({ mutate: s => { s.lose = [3]; } });
  await assert.rejects(late.start());
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 16 * 60000);
  await assert.rejects(late.resume(), /signing window has passed/);
  assert.deepEqual([tampered.state.sent.length, late.state.sent.length], [1, 1]);
});

test('a node that answers with another transaction hash stops the run before the proxy', async () => {
  const r = await run(); const sendRaw = r.sendRaw;
  const start = () => broadcast({ options: { rehearsal: undefined, resume: false, files: r.files }, plan: r.plan, planText: r.planText, config, configText, artifacts,
    release: r.release, client: r.client, quotes: r.client, recheck: async () => {}, log: () => {}, loadAccount: r.loadAccount,
    sendRaw: async signed => { await sendRaw(signed); return keccak256('0x00'); } });
  await assert.rejects(start(), /different transaction hash/);
  assert.deepEqual([r.state.sent.length, (await r.checkpoint()).transactions.map(t => t.status)], [1, ['signed-awaiting-submission']]);
});
