#!/usr/bin/env node
/**
 * Public-only hybrid deployment planner. No environment variables, keys, wallet creation,
 * signing, state overrides or live sends. --simulate sends only to child Anvil processes
 * started here on loopback with zero generated accounts and the real deployer's fork state.
 * Run from any directory: node contracts/scripts/preflight-hybrid.mjs --simulate
 * Options: --config <public-json> --artifacts <Foundry-out-directory> --deployer <public-address>
 * Output: ignored repository evidence/hybrid-plan.json; stdout is a concise public summary.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import {
  createPublicClient, http, getAddress, getContractAddress, keccak256, toHex,
  encodeAbiParameters, encodeDeployData, parseAbi, serializeTransaction, formatEther,
  hexToString,
} from 'viem';

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(CONTRACTS, '..');
const OUTPUT = resolve(ROOT, 'evidence/hybrid-plan.json');
const BROADCAST_CHECKPOINT = resolve(ROOT, 'evidence/hybrid-broadcast.json');
const ZERO = '0x0000000000000000000000000000000000000000';
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const LEGACY_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const LEGACY_ADMIN_SLOT = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b';
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const NAMES = ['ChainlinkStreamsBoundaryOracle', 'BaseStreamsPublisher', 'HorizenStreamsOracle', 'StreamsRoundRegistry'];
const CEILINGS = { base: 250000000000000n, horizen: 120000000000000n };
const RPCS = { base: 'https://base-rpc.publicnode.com', horizen: 'https://horizen.calderachain.xyz/http' };
const children = [];
const json = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const address = (x) => getAddress(String(x).toLowerCase());
const norm = (x) => typeof x === 'string' ? x.toLowerCase() : String(x);
function requireTrue(value, message) { if (!value) throw new Error(message); }
async function broadcastCheckpointExists() {
  try { await access(BROADCAST_CHECKPOINT); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function equal(actual, expected, label) {
  requireTrue(norm(actual) === norm(expected), `${label}: unexpected public value (${String(actual)})`);
}
function parseOptions() {
  const options = { simulate: false, config: resolve(CONTRACTS, 'deployment/hybrid-mainnet.json'), artifacts: resolve(CONTRACTS, 'out') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--simulate') options.simulate = true;
    else if (['--config', '--artifacts', '--deployer'].includes(argv[i])) {
      const key = argv[i].slice(2); requireTrue(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing --${key} value`);
      options[key] = argv[++i];
    } else throw new Error('Unknown option; allowed: --simulate, --config, --artifacts, --deployer');
  }
  return options;
}
function publicClient(url) { return createPublicClient({ transport: http(url, {
  timeout: 20000, retryCount: 2, retryDelay: 1000, batch: { batchSize: 10, wait: 30 },
}) }); }
async function read(client, blockNumber, at, signature, args = []) {
  const abi = parseAbi([`function ${signature}`]);
  // Public endpoints are shared and rate limited; keep the dozens of preflight reads modest.
  await new Promise((ok) => setTimeout(ok, 200));
  try { return await client.readContract({ address: address(at), abi, functionName: abi[0].name, args, blockNumber }); }
  catch (error) { throw new Error(`Public read ${signature} at ${at} failed: ${error.shortMessage ?? 'RPC unavailable or contract reverted'}`, { cause: error }); }
}
async function loadArtifacts(directory) {
  const result = {};
  for (const name of NAMES) {
    const artifactPath = resolve(directory, `${name}.sol/${name}.json`);
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    requireTrue(artifact.metadata?.compiler?.version === '0.8.30+commit.73712a01', `${name}: unexpected compiler`);
    requireTrue(artifact.metadata.settings.evmVersion === 'paris', `${name}: unexpected EVM version`);
    requireTrue(artifact.metadata.settings.optimizer.enabled === true && artifact.metadata.settings.optimizer.runs === 200, `${name}: unexpected optimizer`);
    requireTrue(/^0x[0-9a-f]+$/i.test(artifact.bytecode?.object ?? ''), `${name}: absent or unlinked creation bytecode`);
    requireTrue(Object.keys(artifact.bytecode.linkReferences ?? {}).length === 0, `${name}: unreviewed library links`);
    for (const [source, metadata] of Object.entries(artifact.metadata.sources)) {
      const path = resolve(CONTRACTS, source);
      requireTrue(!relative(CONTRACTS, path).startsWith('..') && !isAbsolute(relative(CONTRACTS, path)), `${name}: source outside contracts`);
      const contents = await readFile(path);
      equal(keccak256(contents), metadata.keccak256, `${name}: stale artifact source ${source}`);
    }
    result[name] = { ...artifact, artifactPath: relative(ROOT, artifactPath), creationBytecodeHash: keccak256(artifact.bytecode.object) };
  }
  return result;
}
async function inspectDependencies(config, chains) {
  const snapshots = [];
  const codeReads = await Promise.allSettled(Object.entries(config.dependencies).map(async ([name, dependency]) => {
    const chain = chains[dependency.chain]; requireTrue(chain, `Unknown dependency chain ${name}`);
    const at = address(dependency.address);
    let code;
    try { code = await chain.client.getCode({ address: at, blockNumber: chain.block.number }); }
    catch { throw new Error(`${name}: public code read failed at block ${chain.block.number}`); }
    requireTrue(code && code !== '0x', `${name}: no deployed code`);
    equal(keccak256(code), dependency.codeHash, `${name}: runtime hash`);
    return { name, chainId: chain.chainId, address: at, blockNumber: chain.block.number, runtimeBytes: (code.length - 2) / 2, codeHash: keccak256(code) };
  }));
  for (const result of codeReads) {
    if (result.status === 'rejected') throw result.reason;
    snapshots.push(result.value);
  }
  const bindings = [];
  const dep = (name) => address(config.dependencies[name].address);
  async function call(name, signature, expected, args = []) {
    const d = config.dependencies[name]; const c = chains[d.chain];
    const actual = await read(c.client, c.block.number, d.address, signature, args);
    equal(actual, expected, `${name}.${signature}`);
    bindings.push({ name, signature, args, actual, blockNumber: c.block.number });
  }
  async function storage(name, slot, expected) {
    const d = config.dependencies[name]; const c = chains[d.chain];
    const word = await c.client.getStorageAt({ address: dep(name), slot, blockNumber: c.block.number });
    requireTrue(/^0x[0-9a-f]{64}$/i.test(word ?? ''), `${name}: missing storage word`);
    const actual = address(`0x${word.slice(-40)}`); equal(actual, expected, `${name} storage ${slot}`);
    bindings.push({ name, slot, word, actual, blockNumber: c.block.number });
  }
  const getterReads = await Promise.allSettled([
    call('verifier', 'typeAndVersion() view returns (string)', 'VerifierProxy 2.0.0'),
    call('verifier', 's_accessController() view returns (address)', ZERO),
    call('verifier', 's_feeManager() view returns (address)', dep('feeManager')),
    call('verifier', 'owner() view returns (address)', config.bindings.chainlinkOwner),
    call('verifier', 'getVerifier(bytes32) view returns (address)', dep('donVerifier'), [config.bindings.verifiedReportDigest]),
    call('feeManager', 'typeAndVersion() view returns (string)', 'NoOpFeeManager 0.5.1'),
    call('donVerifier', 'typeAndVersion() view returns (string)', 'Verifier 2.0.0'),
    call('donVerifier', 'owner() view returns (address)', config.bindings.chainlinkOwner),
    call('sourceMessenger', 'otherMessenger() view returns (address)', dep('destinationMessenger')),
    call('sourceMessenger', 'portal() view returns (address)', dep('portal')),
    call('sourceMessenger', 'version() view returns (string)', '2.6.0'),
    call('sourceMessenger', 'paused() view returns (bool)', false),
    call('destinationMessenger', 'otherMessenger() view returns (address)', dep('sourceMessenger')),
    call('destinationMessenger', 'version() view returns (string)', '2.2.0'),
    call('addressManager', 'getAddress(string) view returns (address)', dep('sourceMessengerImplementation'), [config.bindings.sourceMessengerName]),
    call('addressManager', 'owner() view returns (address)', dep('sourceProxyAdmin')),
    call('sourceProxyAdmin', 'owner() view returns (address)', config.bindings.sourceProxyAdminOwner),
    call('destinationProxyAdmin', 'owner() view returns (address)', config.bindings.destinationProxyAdminOwner),
    call('collateral', 'decimals() view returns (uint8)', 6),
    call('collateral', 'symbol() view returns (string)', 'USDC.e'),
    call('collateral', 'name() view returns (string)', 'Bridged USDC (Stargate)'),
    call('collateral', 'owner() view returns (address)', dep('collateralAdmin')),
  ]);
  for (const result of getterReads) if (result.status === "rejected") throw result.reason;
  await storage('portal', IMPLEMENTATION_SLOT, dep('portalImplementation'));
  await storage('portal', ADMIN_SLOT, dep('sourceProxyAdmin'));
  await storage('destinationMessenger', IMPLEMENTATION_SLOT, dep('destinationMessengerImplementation'));
  await storage('destinationMessenger', ADMIN_SLOT, dep('destinationProxyAdmin'));
  await storage('destinationProxyAdmin', IMPLEMENTATION_SLOT, dep('destinationProxyAdminImplementation'));
  await storage('collateral', LEGACY_IMPLEMENTATION_SLOT, dep('collateralImplementation'));
  await storage('collateral', LEGACY_ADMIN_SLOT, dep('collateralAdmin'));
  // ResolvedDelegateProxy has two mappings keyed by its own address, not EIP-1967 slots.
  const managerSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [dep('sourceMessenger'), 1n]));
  const nameSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [dep('sourceMessenger'), 0n]));
  await storage('sourceMessenger', managerSlot, dep('addressManager'));
  const rawName = await chains.base.client.getStorageAt({ address: dep('sourceMessenger'), slot: nameSlot, blockNumber: chains.base.block.number });
  const size = Number(BigInt(`0x${rawName.slice(-2)}`)) / 2;
  requireTrue(Number.isInteger(size) && size > 0 && size < 32, 'Unexpected resolved-proxy long string');
  const actualName = hexToString(`0x${rawName.slice(2, 2 + size * 2)}`);
  equal(actualName, config.bindings.sourceMessengerName, 'Resolved messenger implementation name');
  bindings.push({ name: 'sourceMessenger', slot: nameSlot, word: rawName, actual: actualName });
  return { code: snapshots, bindings };
}
/** Live read-only dependency recheck for the separate broadcaster; does not inspect/depend on EOA nonces. */
export async function recheckPublicDependencies(config) {
  const chains = {};
  for (const key of ['base', 'horizen']) {
    equal(config.chains[key].rpcUrl, RPCS[key], `${key}: reviewed public RPC required`);
    const client = publicClient(RPCS[key]);
    const chainId = key === 'base' ? 8453 : 26514;
    equal(config.chains[key].chainId, chainId, `${key}: configured chain ID`);
    equal(await client.getChainId(), chainId, `${key}: live chain ID`);
    chains[key] = { client, chainId, block: await client.getBlock() };
  }
  const inspected = await inspectDependencies(config, chains);
  for (const [key, chain] of Object.entries(chains)) {
    const anchored = await chain.client.getBlock({ blockNumber: chain.block.number });
    equal(anchored.hash, chain.block.hash, `${key}: dependency-snapshot reorg`);
  }
  return {
    ...inspected,
    chains: Object.fromEntries(Object.entries(chains).map(([key, chain]) => [key, {
      chainId: chain.chainId, blockNumber: chain.block.number, blockHash: chain.block.hash,
    }])),
  };
}
async function snapshot(config, deployer) {
  const chains = {};
  for (const key of ['base', 'horizen']) {
    const cfg = config.chains[key];
    equal(cfg.chainId, key === 'base' ? 8453 : 26514, `${key}: required chain id`);
    equal(cfg.rpcUrl, RPCS[key], `${key}: only reviewed public RPC endpoint allowed`);
    const client = publicClient(cfg.rpcUrl); equal(await client.getChainId(), cfg.chainId, `${key}: RPC chain id`);
    const block = await client.getBlock();
    const nonce = await client.getTransactionCount({ address: deployer, blockNumber: block.number });
    const pendingNonce = await client.getTransactionCount({ address: deployer, blockTag: 'pending' });
    requireTrue(Number.isSafeInteger(nonce) && pendingNonce === nonce, `${key}: pending or concurrently changing deployer nonce`);
    const accountCode = await client.getCode({ address: deployer, blockNumber: block.number });
    requireTrue(!accountCode || accountCode === '0x', `${key}: deployer must be an ordinary EOA (no delegated code)`);
    const balance = await client.getBalance({ address: deployer, blockNumber: block.number });
    const gasPrice = await client.getGasPrice();
    const priorityFee = await client.estimateMaxPriorityFeePerGas();
    requireTrue(block.baseFeePerGas !== null, `${key}: expected EIP-1559 block`);
    const maxFeePerGas = [gasPrice * 2n, block.baseFeePerGas * 2n + priorityFee].reduce((a, b) => a > b ? a : b);
    const maximumSpend = BigInt(config.maximumSpendWei[key]);
    requireTrue(maximumSpend > 0n && maximumSpend <= CEILINGS[key], `${key}: spend ceiling exceeds authorization`);
    chains[key] = { client, chainId: cfg.chainId, url: cfg.rpcUrl, block, nonce, balance, gasPrice, priorityFee, maxFeePerGas, maximumSpend };
  }
  return chains;
}
function construction(config, artifacts, chains, deployer) {
  const predicted = {
    baseAdapter: getContractAddress({ from: deployer, nonce: BigInt(chains.base.nonce) }),
    basePublisher: getContractAddress({ from: deployer, nonce: BigInt(chains.base.nonce + 1) }),
    horizenCache: getContractAddress({ from: deployer, nonce: BigInt(chains.horizen.nonce) }),
    horizenRegistry: getContractAddress({ from: deployer, nonce: BigInt(chains.horizen.nonce + 1) }),
  };
  const f = config.feeds; const r = config.rules;
  requireTrue(f.btcDecimals === 18 && f.ethDecimals === 18, 'This deployment profile requires exact 18-decimal streams');
  requireTrue(r.observationWindow === 60 && r.openingGrace === 150 && r.settlementGrace === 3600 && r.cutoffBuffer === 30 && r.minimumGasLimit === 600000, 'Unexpected immutable timing profile');
  const route = {
    sourceChainId: 8453n, destinationChainId: 26514n,
    sourceMessenger: address(config.dependencies.sourceMessenger.address),
    destinationMessenger: address(config.dependencies.destinationMessenger.address),
    sourceOracle: predicted.baseAdapter, publisher: predicted.basePublisher, destinationOracle: predicted.horizenCache,
    ...f, observationWindow: r.observationWindow, minimumGasLimit: r.minimumGasLimit,
  };
  const registryConfig = {
    oracle: predicted.horizenCache, collateral: address(config.dependencies.collateral.address), ...f,
    observationWindow: r.observationWindow, openingGrace: r.openingGrace, settlementGrace: r.settlementGrace, cutoffBuffer: r.cutoffBuffer,
  };
  const args = [
    [address(config.dependencies.verifier.address), f.btcFeedId, f.btcDecimals, f.ethFeedId, f.ethDecimals],
    [route], [route], [registryConfig],
  ];
  const definitions = [
    ['base', NAMES[0], chains.base.nonce, predicted.baseAdapter],
    ['base', NAMES[1], chains.base.nonce + 1, predicted.basePublisher],
    ['horizen', NAMES[2], chains.horizen.nonce, predicted.horizenCache],
    ['horizen', NAMES[3], chains.horizen.nonce + 1, predicted.horizenRegistry],
  ];
  const intents = definitions.map(([chain, name, nonce, predictedAddress], i) => {
    const artifact = artifacts[name]; const constructor = artifact.abi.find((x) => x.type === 'constructor');
    const constructorArgs = args[i];
    const initCode = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: constructorArgs });
    return { chain, chainId: chains[chain].chainId, name, nonce, from: deployer, predictedAddress, value: '0', constructorArgs,
      constructorArgsEncoded: encodeAbiParameters(constructor.inputs, constructorArgs),
      initCode, initCodeHash: keccak256(initCode), creationBytecodeHash: artifact.creationBytecodeHash, artifactPath: artifact.artifactPath,
      gasLimit: null, simulatedGas: null, simulatedRuntimeHash: null };
  });
  const tuple = artifacts.BaseStreamsPublisher.abi.find((x) => x.type === 'constructor').inputs[0];
  const routeHash = keccak256(encodeAbiParameters([{ type: 'string' }, tuple], ['zedge-native-streams-route-v1', route]));
  const registryTuple = artifacts.StreamsRoundRegistry.abi.find((x) => x.type === 'constructor').inputs[0];
  const rulesHash = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, registryTuple],
    ['zedge-streams-rounds-v1:schema3:boundary-window:exact-price:no-confidence:tie-up:void-half', 26514n, registryConfig]));
  return { predicted, route, routeHash, registryConfig, rulesHash, intents };
}
async function availablePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok)); return port;
}
async function fork(chain) {
  const port = await availablePort();
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chain.chainId),
    '--fork-url', chain.url, '--fork-block-number', chain.block.number.toString(), '--accounts', '0', '--silent'], { stdio: 'ignore' });
  const record = { child, port, error: false }; children.push(record);
  child.once('error', () => { record.error = true; });
  const client = publicClient(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 100; i++) {
    requireTrue(!record.error && child.exitCode === null, 'Owned Anvil process could not start');
    try {
      const version = await client.request({ method: 'web3_clientVersion' });
      requireTrue(String(version).toLowerCase().includes('anvil'), 'Loopback process is not Anvil');
      equal(await client.getChainId(), chain.chainId, 'Fork chain ID');
      const block = await client.getBlock(); equal(block.hash, chain.block.hash, 'Fork block hash');
      return client;
    } catch { await new Promise((ok) => setTimeout(ok, 100)); }
  }
  throw new Error('Owned Anvil startup timed out');
}
/** Read-only immutable/version validation, reusable after a live deployment at a pinned block. */
export async function verifyCreated(client, intent, plan, config, blockNumber) {
  const at = intent.predictedAddress;
  const versions = {
    ChainlinkStreamsBoundaryOracle: 'zedge-chainlink-streams-boundary-v1', BaseStreamsPublisher: 'zedge-base-streams-publisher-v1',
    HorizenStreamsOracle: 'zedge-horizen-streams-oracle-v1', StreamsRoundRegistry: 'zedge-streams-round-registry-v1',
  };
  async function check(sig, expected) { equal(await read(client, blockNumber, at, sig), expected, `${intent.name}.${sig}`); }
  await check('version() view returns (string)', versions[intent.name]);
  for (const key of ['btcFeedId', 'ethFeedId']) await check(`${key}() view returns (bytes32)`, config.feeds[key]);
  for (const key of ['btcDecimals', 'ethDecimals']) await check(`${key}() view returns (uint8)`, config.feeds[key]);
  if (intent.name === NAMES[0]) await check('verifierProxy() view returns (address)', config.dependencies.verifier.address);
  else if (intent.name === NAMES[3]) {
    await check('oracle() view returns (address)', plan.predicted.horizenCache);
    await check('collateral() view returns (address)', config.dependencies.collateral.address);
    await check('deploymentChainId() view returns (uint256)', 26514);
    await check('rulesHash() view returns (bytes32)', plan.rulesHash);
    for (const key of ['observationWindow', 'openingGrace', 'settlementGrace', 'cutoffBuffer']) await check(`${key}() view returns (uint32)`, config.rules[key]);
  } else {
    await check('routeHash() view returns (bytes32)', plan.routeHash);
    for (const key of ['sourceChainId', 'destinationChainId']) await check(`${key}() view returns (uint256)`, plan.route[key]);
    for (const key of ['observationWindow', 'minimumGasLimit']) await check(`${key}() view returns (uint32)`, config.rules[key]);
    await check('sourceOracle() view returns (address)', plan.predicted.baseAdapter);
    const keys = intent.chain === 'base' ? ['destinationOracle', 'destinationMessenger'] : ['publisher', 'sourceMessenger'];
    for (const key of keys) await check(`${key}() view returns (address)`, plan.route[key]);
    await check('nativeMessenger() view returns (address)', plan.route[intent.chain === 'base' ? 'sourceMessenger' : 'destinationMessenger']);
  }
}
async function simulate(plan, config, chains, deployer) {
  for (const key of ['base', 'horizen']) {
    const chain = chains[key]; const client = await fork(chain);
    await client.request({ method: 'anvil_impersonateAccount', params: [deployer] });
    for (const intent of plan.intents.filter((x) => x.chain === key)) {
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
      intent.gasLimit = gasLimit;
      intent.estimatedGas = estimate;
      intent.simulatedGas = receipt.gasUsed;
      intent.simulatedRuntimeHash = keccak256(runtime);
      intent.simulatedRuntimeBytes = (runtime.length - 2) / 2;
      intent.simulatedTransactionHash = hash;
      intent.maxFeePerGas = chain.maxFeePerGas;
      intent.maxPriorityFeePerGas = chain.priorityFee;
      await verifyCreated(client, intent, plan, config);
      intent.immutableChecksPassed = true;
    }
    await client.request({ method: 'anvil_stopImpersonatingAccount', params: [deployer] });
  }
}
async function costs(plan, chains) {
  const totals = {};
  for (const key of ['base', 'horizen']) {
    const chain = chains[key]; let maximumEstimatedWei = 0n;
    for (const intent of plan.intents.filter((x) => x.chain === key)) {
      requireTrue(intent.gasLimit && intent.simulatedGas, `${intent.name}: costs require actual fork execution`);
      // Exact transaction encoding size with maximal fixed-length signature words; no signing occurs.
      const encoded = serializeTransaction({ type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, data: intent.initCode,
        value: 0n, gas: intent.gasLimit, maxFeePerGas: chain.maxFeePerGas, maxPriorityFeePerGas: chain.priorityFee },
        { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
      const transactionBytesUpper = (encoded.length - 2) / 2;
      const l1FeeUpper = await read(chain.client, chain.block.number, GAS_ORACLE, 'getL1FeeUpperBound(uint256) view returns (uint256)', [BigInt(transactionBytesUpper)]);
      const operatorFee = await read(chain.client, chain.block.number, GAS_ORACLE, 'getOperatorFee(uint256) view returns (uint256)', [intent.gasLimit]);
      // Extra 2x for time-varying non-EVM fees; this is a snapshot estimate, not an enforceable L1 fee cap.
      const maximumEstimate = intent.gasLimit * chain.maxFeePerGas + 2n * l1FeeUpper + 2n * operatorFee;
      intent.fees = { transactionBytesUpper, executionFeeAtGasLimitWei: intent.gasLimit * chain.maxFeePerGas,
        l1DataFeeUpperWei: l1FeeUpper, operatorFeeAtGasLimitWei: operatorFee, nonExecutionFeeBufferMultiplier: 2,
        maximumEstimatedWei: maximumEstimate, maximumEstimatedETH: formatEther(maximumEstimate) };
      maximumEstimatedWei += maximumEstimate;
    }
    requireTrue(maximumEstimatedWei <= chain.maximumSpend, `${key}: estimated maximum cost exceeds approved ceiling`);
    requireTrue(maximumEstimatedWei <= chain.balance, `${key}: insufficient observed ETH for estimated maximum cost`);
    totals[key] = { maximumEstimatedWei, maximumEstimatedETH: formatEther(maximumEstimatedWei), approvedCeilingWei: chain.maximumSpend,
      balanceWei: chain.balance, sufficientObservedBalance: true, withinCeiling: true };
  }
  return totals;
}
async function unchanged(chains, deployer) {
  for (const [key, chain] of Object.entries(chains)) {
    const anchored = await chain.client.getBlock({ blockNumber: chain.block.number }); equal(anchored.hash, chain.block.hash, `${key}: snapshot reorg`);
    equal(await chain.client.getTransactionCount({ address: deployer, blockTag: 'latest' }), chain.nonce, `${key}: live nonce changed during plan`);
    equal(await chain.client.getTransactionCount({ address: deployer, blockTag: 'pending' }), chain.nonce, `${key}: pending nonce changed during plan`);
  }
}
async function cleanup() {
  for (const { child } of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((ok) => child.once('exit', ok)), new Promise((ok) => setTimeout(ok, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
async function main() {
  requireTrue(!await broadcastCheckpointExists(), 'A broadcast checkpoint exists; preserve its original exact plan and use check-hybrid-live.mjs');
  const options = parseOptions();
  requireTrue(String(options.config).endsWith('.json'), 'A public JSON configuration file is required');
  const configText = await readFile(resolve(options.config), 'utf8');
  let config;
  try { config = JSON.parse(configText); } catch { throw new Error('Invalid public configuration JSON'); }
  equal(config.schemaVersion, 1, 'Profile schema');
  const deployer = address(options.deployer ?? config.deployer);
  const artifacts = await loadArtifacts(resolve(options.artifacts));
  const chains = await snapshot(config, deployer);
  const dependencies = await inspectDependencies(config, chains);
  const plan = construction(config, artifacts, chains, deployer);
  for (const intent of plan.intents) {
    const code = await chains[intent.chain].client.getCode({ address: intent.predictedAddress, blockNumber: chains[intent.chain].block.number });
    requireTrue(!code || code === '0x', `${intent.name}: predicted address already has code`);
  }
  if (options.simulate) await simulate(plan, config, chains, deployer);
  const budgets = options.simulate ? await costs(plan, chains) : null;
  await unchanged(chains, deployer);
  const evidence = {
    schemaVersion: 1, status: options.simulate ? 'constructors-simulated-operational-gates-pending' : 'read-only-plan-simulation-required',
    createdAt: new Date().toISOString(), expiresAfterSeconds: 300, noLiveTransactions: true,
    deployer, configPath: relative(ROOT, resolve(options.config)), configHash: keccak256(toHex(configText)),
    chains: Object.fromEntries(Object.entries(chains).map(([key, c]) => [key, {
      chainId: c.chainId, publicRpcUrl: c.url, blockNumber: c.block.number, blockHash: c.block.hash, blockTimestamp: c.block.timestamp,
      nonce: c.nonce, balanceWei: c.balance, baseFeePerGas: c.block.baseFeePerGas, gasPrice: c.gasPrice, maxFeePerGas: c.maxFeePerGas, maxPriorityFeePerGas: c.priorityFee,
    }])), dependencies, ...plan, budgets,
    simulation: { performed: options.simulate, chainStateOverridden: false, balancesOverridden: false, generatedWalletAccounts: 0,
      kind: options.simulate ? 'Owned loopback Anvil forks; real deployer impersonation; constructor deployments and getter checks only' : 'not run',
      nativeCrossDomainDeliveryTested: false, authenticatedFreshReportsTested: false },
    operationalPrerequisites: config.operationalPrerequisites,
    broadcastRequirements: [
      'This file is an unsigned public plan, not authorization or a broadcaster. Never trust stale evidence.',
      'Immediately before each real transaction, recheck both chains, pinned dependency/proxy bindings, current fees, balances, and both expected EOA nonces. Account for only the already-confirmed intents.',
      'Any unexpected nonce, config, artifact or dependency change requires regenerating all predictions and route constructor arguments; never silently adjust a nonce.',
      'All four deployed runtimes and immutable getters must match the simulated plan. A source receipt does not prove native delivery.',
      'L1 data/operator fee bounds are current-snapshot estimates with a 2x buffer; EIP-1559 maxFeePerGas does not cap those separate fees.',
    ],
  };
  requireTrue(!await broadcastCheckpointExists(), 'A broadcast checkpoint appeared during preflight; refusing to replace its plan');
  await mkdir(dirname(OUTPUT), { recursive: true }); await writeFile(OUTPUT, `${json(evidence)}\n`, { mode: 0o600 });
  console.log(json({ status: evidence.status, output: relative(ROOT, OUTPUT), predicted: plan.predicted, budgets,
    operationalPrerequisites: evidence.operationalPrerequisites, liveTransactionsSent: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
try { await main(); }
catch (error) {
  // All inputs and endpoints are deliberately public. Avoid dumping provider internals/call payloads.
  const message = error instanceof Error ? error.shortMessage ?? error.message : 'Unknown public preflight failure';
  console.error(`Hybrid preflight failed: ${String(message).slice(0,500)}`);
  // Invalidate failed preflight evidence, but never destroy the exact plan bound by a broadcast checkpoint.
  if (!await broadcastCheckpointExists()) {
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${json({ schemaVersion: 1, status: 'failed', createdAt: new Date().toISOString(), noLiveTransactions: true, error: String(message).slice(0,500) })}\n`, { mode: 0o600 });
  }
  process.exitCode = 1;
} finally { await cleanup(); }
}
