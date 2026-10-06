#!/usr/bin/env node
/**
 * Public-only planner for the StreamsRoundRegistry replacement on Horizen (26514): the UUPS implementation
 * and its ERC1967Proxy, created by the deployer's next two nonces. No environment variables, keys, wallet
 * creation, signing, state overrides or live sends. Both creations are executed on a child Anvil fork
 * started here on loopback with zero generated accounts and the real deployer's fork state, and every
 * registry getter is then checked on that fork.
 *   node contracts/scripts/plan-registry.mjs
 *   node contracts/scripts/plan-registry.mjs --acknowledge-new-addresses     (the deployer nonce has moved)
 *   node contracts/scripts/plan-registry.mjs --acknowledge-release-mismatch  (the profile or the build changed:
 *        plan what would replace the committed release, for review; the broadcaster still refuses it)
 *   node contracts/scripts/plan-registry.mjs --rehearsal http://127.0.0.1:8545 --evidence <directory>
 * Output: ignored evidence/registry-plan.json; stdout is a concise public summary.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getContractAddress, keccak256, toHex, pad, encodeAbiParameters, encodeDeployData, encodeFunctionData,
  parseAbiParameters, serializeTransaction, formatEther,
} from 'viem';
import {
  CONTRACTS, ROOT, ZERO, IMPLEMENTATION_SLOT, GAS_ORACLE, RPCS, json, address, shown, requireTrue, equal,
  parseArguments, publicClient, anvilFork, read, loadArtifacts, recheckPublicDependencies, fork, cleanup,
} from './preflight-hybrid.mjs';

// The kept Horizen price cache, and the addresses the deployer's Horizen nonces 2 and 3 create. The release,
// the keeper's round ids and the website manifest name these two; a moved nonce must be acknowledged.
export const CACHE = '0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B';
export const PLANNED = {
  implementation: '0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006', proxy: '0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744',
};
export const NAMES = ['StreamsRoundRegistry', 'ERC1967Proxy'];
export const PLAN_STATUS = 'registry-creations-simulated';
export const BROADCAST_STATUS = 'registry-confirmed-and-verified';
export const CONFIG = resolve(CONTRACTS, 'deployment/hybrid-mainnet.json');
export const RELEASE = resolve(CONTRACTS, 'deployment/mainnet-addresses.json');
const EVIDENCE = resolve(ROOT, 'evidence');
const CHAIN_ID = 26514;
const CEILING = 120000000000000n;
const VERSION = 'zedge-streams-round-registry-v2';
const RULES = 'zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half';
const SAMPLE = { asset: 0, duration: 300, start: 1791100800 };
const INVALID_INITIALIZATION = '0xf92ee8a9';

/** The files of one run. A rehearsal directory holds its own plan, checkpoint and release, so nothing a
 *  rehearsal writes can replace or be mistaken for the real record. */
export function runFiles(evidence) {
  const directory = evidence === undefined ? EVIDENCE : resolve(evidence);
  requireTrue(evidence === undefined || (directory !== EVIDENCE && resolve(directory, 'mainnet-addresses.json') !== RELEASE),
    'A rehearsal directory must not be evidence/ itself or hold the committed release');
  return { rehearsal: evidence !== undefined, directory, plan: resolve(directory, 'registry-plan.json'),
    checkpoint: resolve(directory, 'registry-broadcast.json'),
    release: evidence === undefined ? RELEASE : resolve(directory, 'mainnet-addresses.json') };
}
/** --rehearsal <url> and --evidence <directory> come together or not at all. */
export function rehearsalFiles(options) {
  requireTrue((options.rehearsal === undefined) === (options.evidence === undefined),
    'A rehearsal keeps its own files: pass --rehearsal <url> together with --evidence <directory>');
  return runFiles(options.evidence);
}

/** Everything the two creations are made of, rebuilt from the reviewed profile and the deployer nonce alone. */
export function registryCreation(config, deployer, nonce, abi) {
  requireTrue(Number.isSafeInteger(nonce) && nonce >= 0 && nonce < Number.MAX_SAFE_INTEGER - 1, 'Unusable deployer nonce');
  const f = config.feeds; const r = config.rules;
  requireTrue(f.btcDecimals === 18 && f.ethDecimals === 18 && r.observationWindow === 60 && r.openingGrace === 150
    && r.voidGrace === 300 && r.cutoffBuffer === 30, 'Unexpected registry rules profile');
  const owner = address(deployer);
  const implementation = getContractAddress({ from: owner, nonce: BigInt(nonce) });
  const proxy = getContractAddress({ from: owner, nonce: BigInt(nonce + 1) });
  const registryConfig = {
    oracle: CACHE, collateral: address(config.dependencies.collateral.address), btcFeedId: f.btcFeedId, ethFeedId: f.ethFeedId,
    btcDecimals: f.btcDecimals, ethDecimals: f.ethDecimals, observationWindow: r.observationWindow,
    openingGrace: r.openingGrace, voidGrace: r.voidGrace, cutoffBuffer: r.cutoffBuffer,
  };
  const initialize = abi.find((x) => x.type === 'function' && x.name === 'initialize');
  const initData = encodeFunctionData({ abi: [initialize], args: [registryConfig, owner] });
  const rulesHash = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, initialize.inputs[0]],
    [RULES, BigInt(CHAIN_ID), registryConfig]));
  return { implementation, proxy, owner, registryConfig, initData, rulesHash, constructorArgs: [[], [implementation, initData]] };
}
/** The runtime a build has at one address. The UUPS implementation embeds its own address in three 32-byte
 *  immutable words, so its code hash depends on where it is created; the proxy has no immutables. */
export function runtimeCode(artifact, self) {
  let code = artifact.deployedBytecode.object;
  const immutables = Object.values(artifact.deployedBytecode.immutableReferences ?? {});
  requireTrue(immutables.length <= 1, 'Unreviewed immutables in a registry artifact');
  for (const { start, length } of immutables.flat()) {
    code = code.slice(0, 2 + start * 2) + pad(self, { size: length }).slice(2) + code.slice(2 + (start + length) * 2);
  }
  return code;
}
export function expectedRegistry(creation, artifacts) {
  return { ...creation, implementationCodeHash: keccak256(runtimeCode(artifacts.StreamsRoundRegistry, creation.implementation)),
    proxyCodeHash: keccak256(runtimeCode(artifacts.ERC1967Proxy, creation.proxy)) };
}
export function roundId(proxy, rulesHash, { asset, duration, start }) {
  return keccak256(encodeAbiParameters(parseAbiParameters('uint256, address, bytes32, uint8, uint32, uint64'),
    [BigInt(CHAIN_ID), proxy, rulesHash, asset, duration, BigInt(start)]));
}
/** The committed release is the record of what was reviewed. Names what this profile and build would create
 *  differently from it. The implementation runtime is rebuilt at the address the release names, so a moved
 *  deployer nonce is reported as moved addresses only, never as changed code. */
export function differsFromRelease(release, expected, artifacts, configText) {
  const entry = release?.contracts?.[3]; const pin = entry?.proxy;
  if (release?.schemaVersion !== 2 || entry?.name !== 'StreamsRoundRegistry' || !/^0x[0-9a-f]{40}$/i.test(pin?.implementation)) {
    return { changed: ['release format'], moved: [] };
  }
  const differing = (pairs) => Object.keys(pairs).filter((name) => String(pairs[name][0]).toLowerCase() !== String(pairs[name][1]).toLowerCase());
  return {
    changed: differing({
      'profile hash': [release.configHash, keccak256(toHex(configText))], 'rules hash': [release.rulesHash, expected.rulesHash],
      'owner': [pin.owner, expected.owner], 'proxy runtime hash': [entry.runtimeCodeHash, expected.proxyCodeHash],
      'implementation runtime hash': [pin.implementationCodeHash, keccak256(runtimeCode(artifacts.StreamsRoundRegistry, address(pin.implementation)))],
    }),
    moved: differing({ 'proxy address': [entry.address, expected.proxy], 'implementation address': [pin.implementation, expected.implementation] }),
  };
}
export function demandPlannedAddresses(creation, acknowledged) {
  const asPlanned = creation.implementation === address(PLANNED.implementation) && creation.proxy === address(PLANNED.proxy);
  requireTrue(asPlanned || acknowledged, `The deployer nonce moved: the registry would be created at ${creation.implementation} (implementation) and ${creation.proxy} (proxy), not the planned ${PLANNED.implementation} and ${PLANNED.proxy}. `
    + 'Rerun with --acknowledge-new-addresses, then regenerate every record that names the planned addresses');
  return asPlanned;
}
export function buildIntents(creation, artifacts, nonce) {
  return NAMES.map((name, i) => {
    const artifact = artifacts[name]; const constructorArgs = creation.constructorArgs[i];
    const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: constructorArgs });
    return { chain: 'horizen', chainId: CHAIN_ID, name, nonce: nonce + i, from: creation.owner,
      predictedAddress: i === 0 ? creation.implementation : creation.proxy, value: '0', constructorArgs,
      constructorArgsEncoded: `0x${initCode.slice(artifact.bytecode.object.length)}`, initCode, initCodeHash: keccak256(initCode),
      creationBytecodeHash: keccak256(artifact.bytecode.object), artifactPath: `contracts/out/${name}.sol/${name}.json`,
      gasLimit: null, simulatedGas: null, simulatedRuntimeHash: null };
  });
}
/** Complete read-only identity of the registry at one block: both runtimes, the implementation slot, the owner,
 *  no pending owner, every stored rule, one sample round id, and an implementation that cannot be initialised.
 *  Used on the planning fork, after the broadcast and by the live checker. Returns the names of what it checked. */
export async function verifyRegistry(client, expected, blockNumber) {
  const { proxy, implementation, registryConfig: c } = expected;
  const [proxyCode, implementationCode, slot] = await Promise.all([
    client.getCode({ address: proxy, blockNumber }), client.getCode({ address: implementation, blockNumber }),
    client.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT, blockNumber }),
  ]);
  requireTrue(proxyCode && proxyCode !== '0x' && implementationCode && implementationCode !== '0x', 'Registry: missing runtime');
  equal(keccak256(proxyCode), expected.proxyCodeHash, 'Registry proxy runtime hash');
  equal(keccak256(implementationCode), expected.implementationCodeHash, 'Registry implementation runtime hash');
  equal(slot, pad(implementation), 'Registry implementation slot');
  const getters = {
    'version() view returns (string)': VERSION, 'rulesHash() view returns (bytes32)': expected.rulesHash,
    'owner() view returns (address)': expected.owner, 'pendingOwner() view returns (address)': ZERO,
    'oracle() view returns (address)': c.oracle, 'collateral() view returns (address)': c.collateral,
    'btcFeedId() view returns (bytes32)': c.btcFeedId, 'ethFeedId() view returns (bytes32)': c.ethFeedId,
    'btcDecimals() view returns (uint8)': c.btcDecimals, 'ethDecimals() view returns (uint8)': c.ethDecimals,
    'observationWindow() view returns (uint32)': c.observationWindow, 'openingGrace() view returns (uint32)': c.openingGrace,
    'voidGrace() view returns (uint32)': c.voidGrace, 'cutoffBuffer() view returns (uint32)': c.cutoffBuffer,
    'deploymentChainId() view returns (uint256)': CHAIN_ID,
  };
  await Promise.all(Object.entries(getters).map(async ([signature, value]) =>
    equal(await read(client, blockNumber, proxy, signature), value, `Registry ${signature}`)));
  equal(await read(client, blockNumber, proxy, 'roundIdFor(uint8,uint32,uint64) view returns (bytes32)',
    [SAMPLE.asset, SAMPLE.duration, BigInt(SAMPLE.start)]), roundId(proxy, expected.rulesHash, SAMPLE), 'Registry sample round id');
  // The implementation's constructor disabled initializers: nobody can configure or own the bare implementation.
  let refusal;
  try { await client.call({ to: implementation, data: expected.initData, blockNumber }); }
  catch (error) { const cause = error.walk?.() ?? error; refusal = typeof cause.data === 'object' ? cause.data?.data : cause.data; }
  requireTrue(String(refusal).startsWith(INVALID_INITIALIZATION), 'Registry implementation accepts initialize');
  return ['proxy runtime hash', 'implementation runtime hash', 'implementation slot', ...Object.keys(getters).map((x) => x.split('(')[0]),
    'roundIdFor (sample round)', 'implementation refuses initialize'];
}

export async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function snapshot(config, deployer, client, quotes, url) {
  const cfg = config.chains.horizen;
  equal(cfg.chainId, CHAIN_ID, 'horizen: required chain id');
  equal(cfg.rpcUrl, RPCS.horizen, 'horizen: only reviewed public RPC endpoint allowed');
  equal(await client.getChainId(), CHAIN_ID, 'horizen: RPC chain id');
  const block = await client.getBlock();
  const nonce = await client.getTransactionCount({ address: deployer, blockNumber: block.number });
  const pendingNonce = await client.getTransactionCount({ address: deployer, blockTag: 'pending' });
  requireTrue(Number.isSafeInteger(nonce) && pendingNonce === nonce, 'horizen: pending or concurrently changing deployer nonce');
  const accountCode = await client.getCode({ address: deployer, blockNumber: block.number });
  requireTrue(!accountCode || accountCode === '0x', 'horizen: deployer must be an ordinary EOA (no delegated code)');
  const balance = await client.getBalance({ address: deployer, blockNumber: block.number });
  const gasPrice = await quotes.getGasPrice();
  const priorityFee = await quotes.estimateMaxPriorityFeePerGas();
  requireTrue(block.baseFeePerGas !== null, 'horizen: expected EIP-1559 block');
  const maxFeePerGas = [gasPrice * 2n, block.baseFeePerGas * 2n + priorityFee].reduce((a, b) => a > b ? a : b);
  const maximumSpend = BigInt(config.maximumSpendWei.horizen);
  requireTrue(maximumSpend > 0n && maximumSpend <= CEILING, 'horizen: spend ceiling exceeds authorization');
  return { client, chainId: CHAIN_ID, url, block, nonce, balance, gasPrice, priorityFee, maxFeePerGas, maximumSpend };
}
async function simulate(intents, expected, chain, deployer) {
  const client = await fork(chain);
  await client.request({ method: 'anvil_impersonateAccount', params: [deployer] });
  for (const [i, intent] of intents.entries()) {
    equal(await client.getTransactionCount({ address: deployer }), intent.nonce, 'Fork deployment nonce');
    const estimate = await client.estimateGas({ account: deployer, data: intent.initCode, value: 0n, nonce: intent.nonce });
    const gasLimit = (estimate * 125n + 99n) / 100n;
    requireTrue(gasLimit < chain.block.gasLimit, `${intent.name}: deployment gas exceeds block capacity`);
    const tx = { from: deployer, data: intent.initCode, value: '0x0', nonce: toHex(intent.nonce), gas: toHex(gasLimit),
      maxFeePerGas: toHex(chain.maxFeePerGas), maxPriorityFeePerGas: toHex(chain.priorityFee), type: '0x2' };
    // This client is constructed inside fork(), never from configuration or a live RPC URL.
    const hash = await client.request({ method: 'eth_sendTransaction', params: [tx] });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30000 });
    requireTrue(receipt.status === 'success', `${intent.name}: fork deployment reverted`);
    equal(receipt.contractAddress, intent.predictedAddress, `${intent.name}: fork CREATE address`);
    const runtime = await client.getCode({ address: intent.predictedAddress });
    requireTrue(runtime && runtime !== '0x', `${intent.name}: missing deployed runtime`);
    equal(keccak256(runtime), i === 0 ? expected.implementationCodeHash : expected.proxyCodeHash, `${intent.name}: fork runtime differs from the build artifact`);
    intent.gasLimit = gasLimit;
    intent.estimatedGas = estimate;
    intent.simulatedGas = receipt.gasUsed;
    intent.simulatedRuntimeHash = keccak256(runtime);
    intent.simulatedRuntimeBytes = (runtime.length - 2) / 2;
    intent.simulatedTransactionHash = hash;
    intent.maxFeePerGas = chain.maxFeePerGas;
    intent.maxPriorityFeePerGas = chain.priorityFee;
  }
  const checked = await verifyRegistry(client, expected);
  for (const intent of intents) intent.checksPassed = true;
  await client.request({ method: 'anvil_stopImpersonatingAccount', params: [deployer] });
  return checked;
}
async function costs(intents, chain) {
  let maximumEstimatedWei = 0n; let expectedWei = 0n;
  for (const intent of intents) {
    // Exact transaction encoding size with maximal fixed-length signature words; no signing occurs.
    const encoded = serializeTransaction({ type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, data: intent.initCode,
      value: 0n, gas: intent.gasLimit, maxFeePerGas: chain.maxFeePerGas, maxPriorityFeePerGas: chain.priorityFee },
      { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
    const transactionBytesUpper = (encoded.length - 2) / 2;
    const l1FeeUpper = await read(chain.client, chain.block.number, GAS_ORACLE, 'getL1FeeUpperBound(uint256) view returns (uint256)', [BigInt(transactionBytesUpper)]);
    const operatorFee = await read(chain.client, chain.block.number, GAS_ORACLE, 'getOperatorFee(uint256) view returns (uint256)', [intent.gasLimit]);
    // Extra 2x for time-varying non-EVM fees; this is a snapshot estimate, not an enforceable L1 fee cap.
    const maximumEstimate = intent.gasLimit * chain.maxFeePerGas + 2n * l1FeeUpper + 2n * operatorFee;
    const expected = intent.simulatedGas * chain.gasPrice + l1FeeUpper + operatorFee;
    intent.fees = { transactionBytesUpper, executionFeeAtGasLimitWei: intent.gasLimit * chain.maxFeePerGas,
      l1DataFeeUpperWei: l1FeeUpper, operatorFeeAtGasLimitWei: operatorFee, nonExecutionFeeBufferMultiplier: 2,
      maximumEstimatedWei: maximumEstimate, maximumEstimatedETH: formatEther(maximumEstimate),
      expectedAtObservedGasPriceWei: expected, expectedAtObservedGasPriceETH: formatEther(expected) };
    maximumEstimatedWei += maximumEstimate; expectedWei += expected;
  }
  requireTrue(maximumEstimatedWei <= chain.maximumSpend, 'horizen: estimated maximum cost exceeds approved ceiling');
  requireTrue(maximumEstimatedWei <= chain.balance, 'horizen: insufficient observed ETH for estimated maximum cost');
  return { maximumEstimatedWei, maximumEstimatedETH: formatEther(maximumEstimatedWei), expectedAtObservedGasPriceWei: expectedWei,
    expectedAtObservedGasPriceETH: formatEther(expectedWei), approvedCeilingWei: chain.maximumSpend,
    balanceWei: chain.balance, sufficientObservedBalance: true, withinCeiling: true };
}
async function main(files, options) {
  requireTrue(!await exists(files.checkpoint), 'A broadcast checkpoint exists: this plan was signed for. Continue with broadcast-registry.mjs '
    + '--resume-mainnet (--resume in a rehearsal); deployment/MAINNET.md says when the plan and the checkpoint may be set aside');
  const configText = await readFile(CONFIG, 'utf8');
  let config;
  try { config = JSON.parse(configText); } catch { throw new Error('Invalid public configuration JSON'); }
  equal(config.schemaVersion, 1, 'Profile schema');
  const deployer = address(config.deployer);
  const artifacts = await loadArtifacts(resolve(CONTRACTS, 'out'), NAMES);
  const url = options.rehearsal ?? RPCS.horizen;
  const client = options.rehearsal ? await anvilFork(url) : publicClient(url);
  // Anvil quotes a 1 gwei tip floor that Horizen does not have, so a rehearsal reads fee quotes (only) from
  // the live chain: the rehearsed fee caps and spend ceiling are then the real ones.
  const quotes = options.rehearsal ? publicClient(RPCS.horizen) : client;
  const chain = await snapshot(config, deployer, client, quotes, url);
  const dependencies = await recheckPublicDependencies(config, { horizen: url });
  const creation = registryCreation(config, deployer, chain.nonce, artifacts.StreamsRoundRegistry.abi);
  const addressesAsPlanned = demandPlannedAddresses(creation, options['acknowledge-new-addresses']);
  const expected = expectedRegistry(creation, artifacts);
  // The broadcaster creates only what the committed release names. Fail here, before simulating, when the
  // profile or the build is no longer the reviewed one; moved addresses were acknowledged above.
  const release = differsFromRelease(JSON.parse(await readFile(RELEASE, 'utf8')), expected, artifacts, configText);
  requireTrue(release.changed.length === 0 || options['acknowledge-release-mismatch'], `Not the reviewed registry: ${release.changed.join(', ')} `
    + `differ${release.changed.length === 1 ? 's' : ''} from the committed release ${shown(RELEASE)}. If the change is intended, rerun with `
    + '--acknowledge-release-mismatch, regenerate the release with write-release.mjs, have it reviewed, then plan again');
  const intents = buildIntents(creation, artifacts, chain.nonce);
  const cacheCode = await client.getCode({ address: CACHE, blockNumber: chain.block.number });
  requireTrue(cacheCode && cacheCode !== '0x', 'The price cache has no code');
  for (const intent of intents) {
    const code = await client.getCode({ address: intent.predictedAddress, blockNumber: chain.block.number });
    requireTrue(!code || code === '0x', `${intent.name}: predicted address already has code`);
  }
  const gettersChecked = await simulate(intents, expected, chain, deployer);
  const budget = await costs(intents, chain);
  const anchored = await client.getBlock({ blockNumber: chain.block.number }); equal(anchored.hash, chain.block.hash, 'horizen: snapshot reorg');
  equal(await client.getTransactionCount({ address: deployer, blockTag: 'latest' }), chain.nonce, 'horizen: live nonce changed during plan');
  equal(await client.getTransactionCount({ address: deployer, blockTag: 'pending' }), chain.nonce, 'horizen: pending nonce changed during plan');
  const evidence = {
    schemaVersion: 1, status: PLAN_STATUS, createdAt: new Date().toISOString(), expiresAfterSeconds: 300, noLiveTransactions: true,
    rehearsal: files.rehearsal, deployer, configPath: relative(ROOT, CONFIG), configHash: keccak256(toHex(configText)),
    chains: { horizen: { chainId: CHAIN_ID, publicRpcUrl: url, blockNumber: chain.block.number, blockHash: chain.block.hash,
      blockTimestamp: chain.block.timestamp, nonce: chain.nonce, balanceWei: chain.balance, baseFeePerGas: chain.block.baseFeePerGas,
      gasPrice: chain.gasPrice, maxFeePerGas: chain.maxFeePerGas, maxPriorityFeePerGas: chain.priorityFee } },
    dependencies, predicted: { implementation: creation.implementation, proxy: creation.proxy }, addressesAsPlanned,
    differsFromCommittedRelease: [...release.changed, ...release.moved],
    cache: CACHE, owner: creation.owner, registryConfig: creation.registryConfig, rulesHash: creation.rulesHash,
    sampleRound: { ...SAMPLE, roundId: roundId(creation.proxy, creation.rulesHash, SAMPLE) },
    intents, budgets: { horizen: budget },
    simulation: { performed: true, chainStateOverridden: false, balancesOverridden: false, generatedWalletAccounts: 0,
      kind: 'Owned loopback Anvil fork; real deployer impersonation; implementation and proxy creations, then read-only checks',
      checked: gettersChecked, roundLifecycleTested: false },
    broadcastRequirements: [
      'This file is an unsigned public plan, not authorization or a broadcaster. Never trust stale evidence.',
      'The broadcaster signs only when the committed release names exactly these addresses, code hashes, rules, owner and profile.',
      'Immediately before each real transaction, recheck the chain, pinned dependency/proxy bindings, current fees, balance and the expected deployer nonce. Account for only the already-confirmed intent.',
      'Any unexpected nonce, config, artifact or dependency change requires a new plan; never silently adjust a nonce. A moved nonce moves both addresses and the implementation runtime hash.',
      'Both deployed runtimes, the implementation slot, the owner and every getter must match this simulation before the release is marked deployed.',
      'L1 data/operator fee bounds are current-snapshot estimates with a 2x buffer; EIP-1559 maxFeePerGas does not cap those separate fees.',
    ],
  };
  requireTrue(!await exists(files.checkpoint), 'A broadcast checkpoint appeared during planning; refusing to replace its plan');
  await mkdir(files.directory, { recursive: true }); await writeFile(files.plan, `${json(evidence)}\n`, { mode: 0o600 });
  console.log(json({ status: evidence.status, rehearsal: files.rehearsal, output: shown(files.plan), deployerNonce: chain.nonce,
    predicted: evidence.predicted, addressesAsPlanned, differsFromCommittedRelease: evidence.differsFromCommittedRelease, rulesHash: creation.rulesHash,
    runtimeCodeHashes: { implementation: expected.implementationCodeHash, proxy: expected.proxyCodeHash },
    gas: Object.fromEntries(intents.map((x) => [x.name, { simulated: x.simulatedGas, limit: x.gasLimit }])),
    maxFeePerGas: chain.maxFeePerGas, budget, liveTransactionsSent: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let files;
  try {
    const options = parseArguments(process.argv.slice(2), ['--acknowledge-new-addresses', '--acknowledge-release-mismatch'], ['--rehearsal', '--evidence']);
    files = rehearsalFiles(options);
    await main(files, options);
  } catch (error) {
    // All inputs and endpoints are deliberately public. Avoid dumping provider internals/call payloads.
    const message = error instanceof Error ? error.shortMessage ?? error.message : 'Unknown public planning failure';
    console.error(`Registry planning failed: ${String(message).slice(0, 700)}`);
    // Invalidate failed planning evidence, but never destroy the exact plan bound by a broadcast checkpoint.
    if (files && !await exists(files.checkpoint)) {
      await mkdir(files.directory, { recursive: true });
      await writeFile(files.plan, `${json({ schemaVersion: 1, status: 'failed', createdAt: new Date().toISOString(), noLiveTransactions: true, error: String(message).slice(0, 700) })}\n`, { mode: 0o600 });
    }
    process.exitCode = 1;
  } finally { await cleanup(); }
}
