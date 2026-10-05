/** Real local EVM execution + native/WASI ledger conformance.
 * Test-only unsigned oracle and identity-only collateral; no real funding,
 * no public-chain transactions, no Vela attestation or custody integration.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, http, keccak256, stringToHex } from 'viem';

const root = resolve(import.meta.dirname, '..');
const work = await mkdtemp(join(tmpdir(), 'zedge-conformance-'));
const freePort = await new Promise((done, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); server.close(() => done(address.port));
  });
});
const rpc = `http://127.0.0.1:${freePort}`;
const localChain = defineChain({ id: 31337, name: 'ZEDGE local conformance only', nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const processErrors = [];
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(freePort), '--chain-id', '31337', '--timestamp', '2000000000', '--silent'], { stdio: 'ignore' });
anvil.on('error', error => processErrors.push(error));

function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
    child.stdin.end(options.input ?? '');
  });
}

try {
  const client = createPublicClient({ chain: localChain, transport: http(rpc, { timeout: 2000, retryCount: 0 }), pollingInterval: 20 });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (processErrors.length) throw processErrors[0];
    try { assert.equal(await client.getChainId(), 31337); ready = true; break; } catch { await delay(100); }
  }
  if (!ready) throw new Error('Local Anvil did not start.');
  const [account] = await client.request({ method: 'eth_accounts' });
  const wallet = createWalletClient({ account, chain: localChain, transport: http(rpc) });
  const artifact = async name => JSON.parse(await readFile(join(root, 'contracts/out', `${name.file}.sol`, `${name.contract}.json`), 'utf8'));
  const deploy = async (build, args = []) => {
    const hash = await wallet.deployContract({ abi: build.abi, bytecode: build.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress);
    return receipt.contractAddress;
  };
  const mockOracle = await artifact({ file: 'MockStreamsBoundaryOracle', contract: 'MockStreamsBoundaryOracle' });
  const mockToken = await artifact({ file: 'MockBoundaryOracle', contract: 'MockCollateral' });
  const registryBuild = await artifact({ file: 'StreamsRoundRegistry', contract: 'StreamsRoundRegistry' });
  const proxyBuild = await artifact({ file: 'ERC1967Proxy', contract: 'ERC1967Proxy' });
  const oracle = await deploy(mockOracle);
  const collateral = await deploy(mockToken);
  const btcFeedId = '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8';
  const ethFeedId = '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9';
  const config = { oracle, collateral, btcFeedId, ethFeedId, btcDecimals: 18, ethDecimals: 18,
    observationWindow: 10, openingGrace: 20, voidGrace: 86400, cutoffBuffer: 5 };
  const send = async (address, abi, functionName, args) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt;
  };
  // initialize cross-checks the price cache, so the fixture oracle must report the same feeds, units, window and chain.
  await send(oracle, mockOracle.abi, 'configure', [btcFeedId, ethFeedId, 18, 18, config.observationWindow, 31337n]);
  // Deployed the way the release is planned: the implementation, then an ERC1967Proxy that runs initialize.
  const registry = await deploy(proxyBuild, [await deploy(registryBuild), encodeFunctionData({ abi: registryBuild.abi, functionName: 'initialize', args: [config, account] })]);
  const read = (functionName, args = []) => client.readContract({ address: registry, abi: registryBuild.abi, functionName, args });
  const write = (functionName, args) => send(registry, registryBuild.abi, functionName, args);
  const registryVersion = await read('version'); assert.equal(registryVersion, 'zedge-streams-round-registry-v2');
  const rulesHash = await read('rulesHash');
  const nextBlockAt = timestamp => client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(timestamp)] });
  const nativeBinary = join(work, 'scenario');
  await run('go', ['build', '-o', nativeBinary, './cmd/scenario'], { cwd: join(root, 'engine') });
  const summaries = [];
  // late: opening mined at its inclusive deadline, closing price first submitted six hours after the end.
  // void: opened, no closing price ever delivered, voided one second after voidableAfter.
  for (const [asset, duration, scenario = 'on-time'] of [[0, 900], [1, 300], [0, 300], [1, 900], [1, 300, 'late'], [0, 900, 'void']]) {
    const latest = await client.getBlock();
    const start = (latest.timestamp / BigInt(duration) + 1n) * BigInt(duration);
    await write('createRound', [asset, duration, start]);
    const registryRoundId = await read('roundIdFor', [asset, duration, start]);
    const scheduled = await read('getRound', [registryRoundId]);
    const opening = asset === 0 ? 97_000n * 10n ** 18n : 3_500n * 10n ** 18n;
    const closing = asset === 0 ? opening : opening - 1n;
    const observation = (price, timestamp) => encodeAbiParameters([
      { type: 'tuple', components: [{ name: 'price', type: 'int192' }, { name: 'validFromTimestamp', type: 'uint32' }, { name: 'observationsTimestamp', type: 'uint32' }, { name: 'expiresAt', type: 'uint32' }, { name: 'reportHash', type: 'bytes32' }, { name: 'decimals', type: 'uint8' }] },
    ], [{ price, validFromTimestamp: Number(timestamp), observationsTimestamp: Number(timestamp), expiresAt: Number(timestamp + 3600n), reportHash: keccak256(stringToHex(`UNSIGNED_LOCAL_FIXTURE:${asset}:${price}:${timestamp}`)), decimals: 18 }]);
    await nextBlockAt(scenario === 'late' ? scheduled.openingDeadline : start);
    await write('recordOpening', [registryRoundId, observation(opening, start)]);
    assert.equal(await read('canTrade', [registryRoundId]), true);
    await nextBlockAt(scheduled.cutoff);
    await client.request({ method: 'evm_mine', params: [] });
    assert.equal(await read('canTrade', [registryRoundId]), false);
    let expectedOutcome = closing >= opening ? 'up' : 'down';
    if (scenario === 'void') {
      expectedOutcome = 'void';
      await nextBlockAt(scheduled.voidableAfter);
      await client.request({ method: 'evm_mine', params: [] });
      assert.equal(await read('phase', [registryRoundId]), 5, 'ResolutionPending at voidableAfter');
      await assert.rejects(client.simulateContract({ account, address: registry, abi: registryBuild.abi, functionName: 'voidRound', args: [registryRoundId] }), /TimeoutNotReached/);
      await nextBlockAt(scheduled.voidableAfter + 1n);
      await write('voidRound', [registryRoundId]);
    } else {
      await nextBlockAt(scheduled.end + (scenario === 'late' ? 6n * 3600n : 0n));
      await write('resolveRound', [registryRoundId, observation(closing, scheduled.end)]);
    }
    const round = await read('getRound', [registryRoundId]);
    assert.equal(round.outcome, { up: 1, down: 2, void: 3 }[expectedOutcome]);
    const fixture = {
      source: 'local-evm-test-fixture', chainId: 31337, registry: registry.toLowerCase(), collateral: collateral.toLowerCase(), registryRoundId,
      oracle: { chainId: 31337, registry: registry.toLowerCase(), oracle: oracle.toLowerCase(), rulesHash, btcFeedId, ethFeedId, decimals: 18,
        observationWindow: config.observationWindow, openingGrace: config.openingGrace, voidGrace: config.voidGrace, cutoffBuffer: config.cutoffBuffer },
      spec: { asset: asset === 0 ? 'BTC' : 'ETH', feed: asset === 0 ? btcFeedId : ethFeedId, registryRoundId, start: Number(start), end: Number(round.end), cutoff: Number(round.cutoff), observationWindow: config.observationWindow,
        openingDeadline: Number(round.openingDeadline), voidableAfter: Number(round.voidableAfter) },
      opening: { feedId: asset === 0 ? btcFeedId : ethFeedId, ...round.opening, price: round.opening.price.toString() },
      ...(scenario === 'void' ? {} : { closing: { feedId: asset === 0 ? btcFeedId : ethFeedId, ...round.closing, price: round.closing.price.toString() } }),
      openedAt: Number(round.openedAt), resolvedAt: Number(round.resolvedAt), expectedOutcome,
    };
    const input = JSON.stringify(fixture);
    const native = JSON.parse(await run(nativeBinary, [], { input }));
    assert.equal(native.evaluationOnly, true); assert.equal(native.outcome, expectedOutcome);
    // The engine computes both identities itself; they must equal what the compiled registry returned.
    assert.equal(native.rulesHash, rulesHash); assert.equal(native.registryRoundId, registryRoundId);
    assert.equal(native.deposited, native.custody + native.paidOut);
    assert.equal(native.fees, 120_000);
    // Bob withdraws 200 - 6.06 paid for 10 Up shares + their payout, which must follow the registry's ratio.
    const [up, , denominator] = await read('payoutNumerators', [registryRoundId]);
    assert.equal(native.paidOut, 193_940_000 + 10_000_000 * up / denominator);
    if (process.env.ZEDGE_SCENARIO_WASM) {
      const wasm = JSON.parse(await run(process.execPath, ['scripts/run-wasi.mjs', process.env.ZEDGE_SCENARIO_WASM], { input }));
      assert.deepEqual(wasm, native, 'Native and TinyGo WASI state hashes must match.');
    }
    await writeFile(join(work, `fixture-${asset}-${duration}-${scenario}.json`), input + '\n');
    summaries.push({ asset: fixture.spec.asset, duration, scenario, openedAfterStart: fixture.openedAt - fixture.spec.start, settledAfterEnd: fixture.resolvedAt - fixture.spec.end, expectedOutcome, ...native });
  }
  const evidenceDirectory = join(root, 'evidence'); await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(join(evidenceDirectory, 'protocol-conformance.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), localOnly: true, mockedOracle: true, noTokenTransfers: true, registryVersion,
    nativeWasmCompared: Boolean(process.env.ZEDGE_SCENARIO_WASM), summaries,
  }, null, 2) + '\n');
  console.log(`PASS: ${summaries.length} local EVM rounds (one resolved six hours late, one voided after voidableAfter) → collateralized ledger → settlement → withdrawal accounting; engine rules hash and round ids equal the registry's${process.env.ZEDGE_SCENARIO_WASM ? '; identical native/TinyGo WASI hashes' : ''}.`);
  console.log('Oracle inputs and collateral identity are test fixtures. This does not verify live custody, oracle signatures or Vela integration.');
} finally {
  anvil.kill('SIGTERM');
}
