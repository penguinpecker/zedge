/**
 * Public read-only helpers shared by the registry planner, broadcaster, live checker and source verifier:
 * the upstream dependency recheck, the three route contracts' getter checks, artifact loading and an
 * owned loopback Anvil fork. No environment variables, keys, wallet creation or signing.
 * The four-contract planner that lived here deployed the route on 2026-10-04 and cannot run again
 * (deployment/MAINNET.md). The registry is planned by plan-registry.mjs.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import {
  createPublicClient, http, getAddress, keccak256, encodeAbiParameters, parseAbi, hexToString,
} from 'viem';

export const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(CONTRACTS, '..');
export const ZERO = '0x0000000000000000000000000000000000000000';
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const LEGACY_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const LEGACY_ADMIN_SLOT = '0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b';
export const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
export const RPCS = { base: 'https://base-rpc.publicnode.com', horizen: 'https://horizen.calderachain.xyz/http' };
const children = [];
export const json = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const address = (x) => getAddress(String(x).toLowerCase());
/** A path as printed: repository-relative inside the repository, absolute outside it (a rehearsal directory). */
export const shown = (path) => relative(ROOT, path).startsWith('..') ? path : relative(ROOT, path);
const norm = (x) => typeof x === 'string' ? x.toLowerCase() : String(x);
export function requireTrue(value, message) { if (!value) throw new Error(message); }
export function equal(actual, expected, label) {
  requireTrue(norm(actual) === norm(expected), `${label}: unexpected public value (${String(actual)})`);
}
/** --flag and --name <value> arguments only. A rehearsal target is a loopback URL: a local Anvil fork, never a live chain. */
export function parseArguments(args, flags, values = []) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) options[args[i].slice(2)] = true;
    else if (values.includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`Allowed options: ${[...flags, ...values.map((value) => `${value} <value>`)].join(', ')}`);
  }
  requireTrue(options.rehearsal === undefined || /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(options.rehearsal),
    '--rehearsal takes the loopback URL of a local Anvil fork, e.g. http://127.0.0.1:8545');
  return options;
}
export function publicClient(url) { return createPublicClient({ transport: http(url, {
  timeout: 20000, retryCount: 2, retryDelay: 1000, batch: { batchSize: 10, wait: 30 },
}) }); }
/** The only endpoint a rehearsal may send to: a loopback Anvil fork of Horizen. */
export async function anvilFork(url) {
  const client = publicClient(url);
  requireTrue(String(await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil'), 'Rehearsal endpoint is not Anvil');
  equal(await client.getChainId(), 26514, 'Rehearsal fork chain ID');
  return client;
}
export async function read(client, blockNumber, at, signature, args = []) {
  const abi = parseAbi([`function ${signature}`]);
  // Public endpoints are shared and rate limited; keep the dozens of preflight reads modest.
  await new Promise((ok) => setTimeout(ok, 200));
  try { return await client.readContract({ address: address(at), abi, functionName: abi[0].name, args, blockNumber }); }
  catch (error) { throw new Error(`Public read ${signature} at ${at} failed: ${error.shortMessage ?? 'RPC unavailable or contract reverted'}`, { cause: error }); }
}
export async function loadArtifacts(directory, names) {
  const result = {};
  for (const name of names) {
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
/** Live read-only dependency recheck; does not inspect/depend on EOA nonces. rpc.horizen may name a rehearsal fork. */
export async function recheckPublicDependencies(config, rpc = {}) {
  const chains = {};
  for (const key of ['base', 'horizen']) {
    equal(config.chains[key].rpcUrl, RPCS[key], `${key}: reviewed public RPC required`);
    const client = publicClient(rpc[key] ?? RPCS[key]);
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
async function availablePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok)); return port;
}
/** An Anvil child owned by this process: loopback, zero generated accounts, forked at chain.block. */
export async function fork(chain) {
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
/** Read-only immutable/version validation of one of the three deployed route contracts at a pinned block. */
export async function verifyRoute(client, contract, release, config, blockNumber) {
  const at = contract.address; const route = release.route;
  const versions = {
    ChainlinkStreamsBoundaryOracle: 'zedge-chainlink-streams-boundary-v1', BaseStreamsPublisher: 'zedge-base-streams-publisher-v1',
    HorizenStreamsOracle: 'zedge-horizen-streams-oracle-v1',
  };
  async function check(sig, expected) { equal(await read(client, blockNumber, at, sig), expected, `${contract.name}.${sig}`); }
  await check('version() view returns (string)', versions[contract.name]);
  for (const key of ['btcFeedId', 'ethFeedId']) await check(`${key}() view returns (bytes32)`, config.feeds[key]);
  for (const key of ['btcDecimals', 'ethDecimals']) await check(`${key}() view returns (uint8)`, config.feeds[key]);
  if (contract.name === 'ChainlinkStreamsBoundaryOracle') await check('verifierProxy() view returns (address)', config.dependencies.verifier.address);
  else {
    await check('routeHash() view returns (bytes32)', release.routeHash);
    for (const key of ['sourceChainId', 'destinationChainId']) await check(`${key}() view returns (uint256)`, route[key]);
    for (const key of ['observationWindow', 'minimumGasLimit']) await check(`${key}() view returns (uint32)`, config.rules[key]);
    await check('sourceOracle() view returns (address)', route.sourceOracle);
    const keys = contract.chain === 'base' ? ['destinationOracle', 'destinationMessenger'] : ['publisher', 'sourceMessenger'];
    for (const key of keys) await check(`${key}() view returns (address)`, route[key]);
    await check('nativeMessenger() view returns (address)', route[contract.chain === 'base' ? 'sourceMessenger' : 'destinationMessenger']);
  }
}
export async function cleanup() {
  for (const { child } of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((ok) => child.once('exit', ok)), new Promise((ok) => setTimeout(ok, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
