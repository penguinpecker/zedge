#!/usr/bin/env node
/**
 * PUBLIC-ONLY, read-only verifier of the schema-2 release in contracts/deployment/mainnet-addresses.json.
 *   node contracts/scripts/check-hybrid-live.mjs
 *   node contracts/scripts/check-hybrid-live.mjs --observe 0xPUBLIC_SOURCE_TX_HASH
 *   node contracts/scripts/check-hybrid-live.mjs --rehearsal <url> --evidence <directory>
 * The three kept route contracts are always checked against the live chains: creation data against the
 * current build and reviewed constructors, runtime hashes, immutable getters, route hash and upstream
 * bindings. The registry is checked as the release describes it: "planned" means nothing may exist at the
 * planned addresses yet; "deployed" means proxy, implementation slot, implementation, owner and every rule.
 * No environment access, wallet, key, signing, account impersonation, or send RPC exists here.
 * --observe follows the historical public BTC smoke report at its exact (unaligned) second through the
 * native route. It proves an oracle/message path only, never a funded prediction-market lifecycle.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, http, getAddress, keccak256, toHex, parseAbi,
  encodeFunctionData, decodeFunctionData, decodeAbiParameters, encodeAbiParameters, decodeEventLog,
} from 'viem';
import { CONTRACTS, RPCS, shown, parseArguments, anvilFork, loadArtifacts, recheckPublicDependencies, verifyRoute } from './preflight-hybrid.mjs';
import { expectedConstructors, validateConstructorIntent } from './broadcast-hybrid.mjs';
import { NAMES, CONFIG, rehearsalFiles, registryCreation, expectedRegistry, verifyRegistry } from './plan-registry.mjs';
// The writer's entrypoint is guarded and is never invoked here.
import { LABEL, RETIRED } from './write-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = resolve(ROOT, 'research/chainlink-streams-base.md');
const ROUTE = ['ChainlinkStreamsBoundaryOracle', 'BaseStreamsPublisher', 'HorizenStreamsOracle'];
// PublicNode refuses receipts and older indexed transactions. The profile names Base's own endpoint for them.
const BASE_RECEIPT_RPC = 'https://mainnet.base.org';
const IDS = { base: 8453, horizen: 26514 };
const MSG_ABI = parseAbi([
  'event SentMessage(address indexed target,address sender,bytes message,uint256 messageNonce,uint256 gasLimit)',
  'event SentMessageExtension1(address indexed sender,uint256 value)',
  'event RelayedMessage(bytes32 indexed msgHash)',
  'event FailedRelayedMessage(bytes32 indexed msgHash)',
  'function relayMessage(uint256 nonce,address sender,address target,uint256 value,uint256 minGasLimit,bytes message)',
  'function successfulMessages(bytes32) view returns (bool)',
  'function failedMessages(bytes32) view returns (bool)',
]);
const json = (x) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function demand(condition, message) { if (!condition) throw new Error(message); }
function same(actual, expected, message) { demand(eq(actual, expected), message); }
const addr = (a) => getAddress(String(a).toLowerCase());
function client(url) { return createPublicClient({ transport: http(url, { timeout: 12000, retryCount: 1, batch: { batchSize: 10, wait: 30 } }) }); }
async function write(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${json(value)}\n`, { mode: 0o600 }); }
async function publicJSON(path) { let result; try { result = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`Missing or invalid public JSON: ${path.slice(ROOT.length + 1)}`); } return result; }
function options() {
  const parsed = parseArguments(process.argv.slice(2), [], ['--observe', '--rehearsal', '--evidence']);
  demand(parsed.observe === undefined || /^0x[0-9a-f]{64}$/i.test(parsed.observe), '--observe takes a public transaction hash');
  return parsed;
}
async function view(c, blockNumber, address, signature, args = []) {
  const abi = parseAbi([`function ${signature}`]);
  return c.readContract({ address: addr(address), abi, functionName: abi[0].name, args, blockNumber });
}
async function anchoredReceipt(c, hash) {
  const receipt = await c.getTransactionReceipt({ hash });
  demand(receipt.status === 'success', 'Public transaction is not successful');
  const block = await c.getBlock({ blockNumber: receipt.blockNumber });
  same(block.hash, receipt.blockHash, 'Receipt block is no longer canonical at this RPC');
  return { receipt, block };
}
function observationValues(observation) {
  return ['price', 'validFromTimestamp', 'observationsTimestamp', 'expiresAt', 'reportHash', 'decimals'].map((key) => String(observation[key]).toLowerCase());
}
function observationMatches(actual, expected) {
  demand(JSON.stringify(observationValues(actual)) === JSON.stringify(observationValues(expected)), 'Authenticated observation differs from expected report');
}
/** Binds one creation transaction to its address, sender, CREATE shape and the exact reviewed creation data. */
async function creation(reader, hash, at, block, deployer) {
  const { receipt, block: header } = await anchoredReceipt(reader, hash);
  same(receipt.contractAddress, at, 'Live creation address mismatch'); same(receipt.blockNumber, block, 'Creation block differs from the release');
  const tx = await reader.getTransaction({ hash });
  demand(tx.to === null && tx.value === 0n, 'Expected a zero-value CREATE transaction'); same(tx.from, deployer, 'Live creation sender mismatch');
  return { tx, receipt, header };
}
function demandCreationData(name, tx, artifact, args) {
  // Reuses the broadcaster's check: current artifact + independently rebuilt arguments must be the exact input.
  try { validateConstructorIntent({ constructorArgs: args, initCode: tx.input, initCodeHash: keccak256(tx.input) }, artifact, args); }
  catch { throw new Error(`${name}: live creation data differs from the current build and the reviewed arguments`); }
}
/** Everything about the release file that needs no chain: its format, its binding to the profile, the retired
 *  registry record, and that a planned release records no creation. */
export function demandReleaseFormat(release, configText) {
  demand(release.schemaVersion === 2 && ['planned', 'deployed'].includes(release.status) && release.contracts?.length === 4, 'A schema-2 release with four contracts is required');
  same(release.configHash, keccak256(toHex(configText)), 'Public configuration changed since the release was written');
  same(release.release, LABEL, 'Unexpected release label');
  demand(JSON.stringify(release.retired) === JSON.stringify([RETIRED]), 'The retired registry record is missing or altered');
  const entry = release.contracts[3];
  demand(entry.name === 'StreamsRoundRegistry' && entry.chain === 'horizen' && entry.chainId === IDS.horizen && entry.proxy, 'Release registry entry mismatch');
  demand(release.status !== 'planned' || [entry.creationTransaction, entry.creationBlock, entry.proxy.implementationCreationTransaction,
    entry.proxy.implementationCreationBlock].every((fact) => fact === null), 'A planned release must not record a creation transaction or block');
}
export async function loadAndCheck(options = {}) {
  const files = rehearsalFiles(options);
  const configText = await readFile(CONFIG, 'utf8'); const config = JSON.parse(configText);
  const release = await publicJSON(files.release);
  demandReleaseFormat(release, configText);
  same(config.chains.base.receiptRpcUrl, BASE_RECEIPT_RPC, 'Unreviewed Base receipt RPC');
  const deployer = config.deployer;
  const clients = {}; const history = {}; const blocks = {}; const checked = [];
  const dependencies = await recheckPublicDependencies(config, { horizen: options.rehearsal });
  for (const chain of ['base', 'horizen']) {
    same(config.chains[chain].rpcUrl, RPCS[chain], 'Unreviewed public RPC');
    clients[chain] = chain === 'horizen' && options.rehearsal ? await anvilFork(options.rehearsal) : client(RPCS[chain]);
    same(await clients[chain].getChainId(), IDS[chain], 'RPC chain mismatch');
    history[chain] = chain === 'base' ? client(BASE_RECEIPT_RPC) : clients[chain];
    same(await history[chain].getChainId(), IDS[chain], 'Historical RPC chain mismatch');
    blocks[chain] = await clients[chain].getBlock();
  }
  const artifacts = await loadArtifacts(resolve(CONTRACTS, 'out'), [...ROUTE, ...NAMES]);

  // Three kept route contracts: fixed code, already deployed, never replanned.
  const created = [];
  for (const [i, contract] of release.contracts.slice(0, 3).entries()) {
    demand(contract.name === ROUTE[i] && contract.chain === (i < 2 ? 'base' : 'horizen') && contract.chainId === IDS[contract.chain], 'Release ordering mismatch');
    created.push(await creation(history[contract.chain], contract.creationTransaction, contract.address, contract.creationBlock, deployer));
  }
  const expectedArgs = expectedConstructors(config, { deployer, chains: { base: { nonce: created[0].tx.nonce }, horizen: { nonce: created[2].tx.nonce } } });
  const tuple = artifacts.BaseStreamsPublisher.abi.find((x) => x.type === 'constructor').inputs[0];
  const encodeRoute = (route) => encodeAbiParameters([{ type: 'string' }, tuple], ['zedge-native-streams-route-v1', route]);
  same(encodeRoute(release.route), encodeRoute(expectedArgs[1][0]), 'Release route differs from the reviewed constructor profile');
  same(keccak256(encodeRoute(release.route)), release.routeHash, 'Release route hash mismatch');
  for (const [i, contract] of release.contracts.slice(0, 3).entries()) {
    const c = clients[contract.chain]; const at = blocks[contract.chain].number;
    same(contract.address, release.route[['sourceOracle', 'publisher', 'destinationOracle'][i]], 'Release address differs from its route');
    demandCreationData(contract.name, created[i].tx, artifacts[contract.name], expectedArgs[i]);
    const runtime = await c.getCode({ address: addr(contract.address), blockNumber: at });
    demand(runtime && runtime !== '0x', 'Missing live runtime');
    same(keccak256(runtime), contract.runtimeCodeHash, `${contract.name}: live runtime differs from the release`);
    await verifyRoute(c, contract, release, config, at);
    checked.push({ name: contract.name, chainId: contract.chainId, address: contract.address, transactionHash: contract.creationTransaction,
      creationBlock: created[i].receipt.blockNumber, creationTimestamp: created[i].header.timestamp, runtimeCodeHash: keccak256(runtime), immutableChecksPassed: true });
  }

  // The registry proxy, as the release describes it.
  const entry = release.contracts[3]; const horizen = clients.horizen; const at = blocks.horizen.number;
  const describes = (expected) => {
    same(entry.address, expected.proxy, 'Registry proxy address does not follow from the deployer nonce');
    same(entry.proxy.implementation, expected.implementation, 'Registry implementation address does not follow from the deployer nonce');
    same(entry.runtimeCodeHash, expected.proxyCodeHash, 'Release proxy runtime hash differs from the current build');
    same(entry.proxy.implementationCodeHash, expected.implementationCodeHash, 'Release implementation runtime hash differs from the current build');
    same(entry.proxy.owner, expected.owner, 'Release registry owner mismatch'); same(release.rulesHash, expected.rulesHash, 'Release rules hash differs from the reviewed profile');
  };
  const abi = artifacts.StreamsRoundRegistry.abi; let registry;
  if (release.status === 'planned') {
    // Nothing is deployed yet. The plan is still valid only while the deployer's next two nonces create these addresses.
    const nonce = await horizen.getTransactionCount({ address: addr(deployer), blockNumber: at });
    describes(expectedRegistry(registryCreation(config, deployer, nonce, abi), artifacts));
    for (const planned of [entry.proxy.implementation, entry.address]) {
      const code = await horizen.getCode({ address: addr(planned), blockNumber: at });
      demand(!code || code === '0x', 'The release says planned but a planned registry address has code: write the deployed release');
    }
    registry = { status: 'planned-not-deployed', address: entry.address, implementation: entry.proxy.implementation, deployerNonce: nonce };
  } else {
    const made = [
      await creation(horizen, entry.proxy.implementationCreationTransaction, entry.proxy.implementation, entry.proxy.implementationCreationBlock, deployer),
      await creation(horizen, entry.creationTransaction, entry.address, entry.creationBlock, deployer),
    ];
    const nonce = made[0].tx.nonce; same(made[1].tx.nonce, nonce + 1, 'Registry proxy creation nonce');
    const plan = registryCreation(config, deployer, nonce, abi); const expected = expectedRegistry(plan, artifacts);
    describes(expected);
    for (const [i, name] of NAMES.entries()) demandCreationData(name, made[i].tx, artifacts[name], plan.constructorArgs[i]);
    registry = { status: 'deployed-verified', address: entry.address, implementation: entry.proxy.implementation, owner: entry.proxy.owner,
      deployerNonce: nonce, constructorArgs: plan.constructorArgs, checked: await verifyRegistry(horizen, expected, at),
      creations: NAMES.map((name, i) => ({ name, address: i === 0 ? plan.implementation : plan.proxy, transactionHash: made[i].receipt.transactionHash,
        blockNumber: made[i].receipt.blockNumber, blockHash: made[i].receipt.blockHash, runtimeCodeHash: i === 0 ? expected.implementationCodeHash : expected.proxyCodeHash })) };
  }
  for (const chain of ['base', 'horizen']) same((await clients[chain].getBlock({ blockNumber: blocks[chain].number })).hash, blocks[chain].hash, 'Live-check snapshot reorg');
  const result = { schemaVersion: 2, status: release.status === 'deployed' ? 'route-and-registry-verified' : 'route-verified-registry-planned-not-deployed',
    checkedAt: new Date().toISOString(), release: release.release, releaseStatus: release.status, rehearsal: files.rehearsal,
    contracts: checked, registry, dependencies, routeHash: release.routeHash, rulesHash: release.rulesHash,
    snapshotBlocks: Object.fromEntries(Object.entries(blocks).map(([key, block]) => [key, { number: block.number, hash: block.hash, timestamp: block.timestamp }])),
    noTransactionsSent: true, privateTradingOrCustodyVerified: false, nativeDeliveryVerified: false };
  await write(resolve(files.directory, 'streams-live-check.json'), result);
  return { config, release, clients, history, blocks, artifacts, files, live: result };
}
export async function fixture(context) {
  const text = await readFile(FIXTURES, 'utf8'); const block = text.match(/```json\n([\s\S]*?)\n```/);
  demand(block, 'Public report fixture JSON is missing');
  const matches = JSON.parse(block[1]).filter((x) => eq(x.feedId, context.config.feeds.btcFeedId));
  demand(matches.length === 1, 'Expected one canonical BTC public fixture'); const fixture = matches[0];
  same(keccak256(fixture.payload), fixture.payloadHash, 'Public fixture payload hash mismatch');
  const [, body] = decodeAbiParameters([{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }], fixture.payload);
  demand((body.length - 2) / 2 === 288, 'Expected the exact V3 report size');
  const report = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint192' }, { type: 'uint192' }, { type: 'uint32' }, { type: 'int192' }, { type: 'int192' }, { type: 'int192' }], body);
  same(report[0], context.config.feeds.btcFeedId, 'Decoded fixture feed mismatch'); same(report[2], fixture.observationsTimestamp, 'Fixture timestamp metadata mismatch');
  const boundary = BigInt(report[2]);
  demand(boundary % 300n !== 0n && report[1] === report[2], 'This helper expects its explicitly unaligned single-second smoke fixture');
  const expectedObservation = { price: report[6], validFromTimestamp: report[1], observationsTimestamp: report[2], expiresAt: report[5], reportHash: keccak256(body), decimals: 18 };
  demand(expectedObservation.price > 0n, 'Fixture price must be positive');
  // Corroborate provenance from existing public transaction calldata, never an authenticated report API.
  const source = await context.history.base.getTransaction({ hash: fixture.sourceTransaction });
  const [publishedPayload] = decodeAbiParameters([{ type: 'bytes' }], `0x${source.input.slice(10)}`);
  same(keccak256(publishedPayload), fixture.payloadHash, 'Fixture no longer matches its public source transaction');
  return { fixture, boundary, expectedObservation };
}
function events(receipt, address, abi, name) {
  const results = [];
  for (const log of receipt.logs) {
    if (!eq(log.address, address)) continue;
    try { const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); if (decoded.eventName === name) results.push({ ...decoded, log }); } catch { /* other events from this contract */ }
  }
  return results;
}
async function observe(context, hash) {
  const { release, config, clients, artifacts } = context; const destination = clients.horizen; const route = release.route;
  const { fixture: source, boundary, expectedObservation } = await fixture(context);
  const { receipt, block: sourceBlock } = await anchoredReceipt(context.history.base, hash);
  const tx = await context.history.base.getTransaction({ hash });
  same(tx.to, route.publisher, 'Source smoke transaction target mismatch'); same(tx.from, config.deployer, 'Unexpected smoke sender'); demand(tx.value === 0n, 'Smoke must carry zero ETH value');
  const decoded = decodeFunctionData({ abi: artifacts.BaseStreamsPublisher.abi, data: tx.input });
  demand(decoded.functionName === 'publishBoundary', 'Expected publishBoundary smoke call');
  same(decoded.args[0], source.feedId, 'Smoke feed mismatch'); same(decoded.args[1], boundary, 'Smoke boundary mismatch'); same(keccak256(decoded.args[2]), source.payloadHash, 'Smoke report payload mismatch');
  const messenger = config.dependencies.sourceMessenger.address;
  const sent = events(receipt, messenger, MSG_ABI, 'SentMessage').filter((x) => eq(x.args.sender, route.publisher) && eq(x.args.target, route.destinationOracle));
  const extensions = events(receipt, messenger, MSG_ABI, 'SentMessageExtension1').filter((x) => eq(x.args.sender, route.publisher));
  demand(sent.length === 1 && extensions.length === 1, 'Expected exactly one native smoke message');
  const message = sent[0].args; const value = extensions[0].args.value;
  demand(value === 0n && message.messageNonce >> 240n === 1n, 'Expected zero-value version-1 OP message');
  same(message.gasLimit, config.rules.minimumGasLimit, 'Destination gas policy mismatch');
  const receiverCall = decodeFunctionData({ abi: artifacts.HorizenStreamsOracle.abi, data: message.message });
  demand(receiverCall.functionName === 'receiveObservation', 'Unexpected native destination call');
  same(receiverCall.args[0], release.routeHash, 'Message route mismatch'); same(receiverCall.args[1], source.feedId, 'Message feed mismatch'); same(receiverCall.args[2], boundary, 'Message boundary mismatch');
  observationMatches(receiverCall.args[3], expectedObservation);
  const relayData = encodeFunctionData({ abi: MSG_ABI, functionName: 'relayMessage', args: [message.messageNonce, message.sender, message.target, value, message.gasLimit, message.message] });
  const messageHash = keccak256(relayData);
  const childMessenger = addr(config.dependencies.destinationMessenger.address);
  const firstBlock = await destination.getBlockNumber(); let fromBlock = firstBlock > 10000n ? firstBlock - 10000n + 1n : 0n;
  const deadline = Date.now() + 180000; let failedRelaySeen = false; let polledThrough = fromBlock;
  const observationAbi = artifacts.HorizenStreamsOracle.abi;
  while (Date.now() < deadline) {
    const latest = await destination.getBlock();
    const successes = [];
    // Bounded 1,000-block queries also handle a head that has not advanced since the last poll.
    for (let start = fromBlock; start <= latest.number; start += 1000n) {
      const end = start + 999n < latest.number ? start + 999n : latest.number;
      successes.push(...await destination.getLogs({ address: childMessenger, event: MSG_ABI.find((x) => x.type === 'event' && x.name === 'RelayedMessage'), args: { msgHash: messageHash }, fromBlock: start, toBlock: end }));
    }
    const [succeeded, failed] = await Promise.all([
      view(destination, latest.number, childMessenger, 'successfulMessages(bytes32) view returns(bool)', [messageHash]),
      view(destination, latest.number, childMessenger, 'failedMessages(bytes32) view returns(bool)', [messageHash]),
    ]);
    failedRelaySeen ||= failed; polledThrough = latest.number;
    if (succeeded) {
      demand(successes.length === 1, 'Messenger reports success but its unique receipt is outside the bounded scan; inspect the explorer');
      const { receipt: destinationReceipt, block: destinationBlock } = await anchoredReceipt(destination, successes[0].transactionHash);
      const received = events(destinationReceipt, route.destinationOracle, observationAbi, 'ObservationReceived')
        .filter((x) => eq(x.args.feedId, source.feedId) && eq(x.args.boundary, boundary) && eq(x.args.reportHash, expectedObservation.reportHash));
      demand(received.length <= 1, 'Ambiguous cache-receipt event');
      const observation = await destination.readContract({ address: addr(route.destinationOracle), abi: observationAbi, functionName: 'getObservation', args: [source.feedId, boundary], blockNumber: latest.number });
      observationMatches(observation, expectedObservation);
      same((await context.history.base.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, 'Source receipt reorg');
      same((await destination.getBlock({ blockNumber: destinationReceipt.blockNumber })).hash, destinationReceipt.blockHash, 'Destination receipt reorg');
      return { schemaVersion: 1, status: 'native-delivery-and-authenticated-cache-observed', checkedAt: new Date().toISOString(), noTransactionsSent: true,
        release: release.release, messageHash, messageNonce: message.messageNonce, routeHash: release.routeHash,
        feedId: source.feedId, boundary, expectedObservation, sourceTransactionHash: hash, sourceBlock: receipt.blockNumber, sourceBlockHash: receipt.blockHash, sourceTimestamp: sourceBlock.timestamp,
        destinationTransactionHash: destinationReceipt.transactionHash, destinationBlock: destinationReceipt.blockNumber, destinationBlockHash: destinationReceipt.blockHash, destinationTimestamp: destinationBlock.timestamp,
        inclusionDelaySeconds: destinationBlock.timestamp - sourceBlock.timestamp, destinationConfirmationsObserved: latest.number - destinationReceipt.blockNumber + 1n,
        failedRelaySeen, cacheObservationNewlyRecorded: received.length === 1, finality: 'Observed canonical RPC receipts; not a finalized-chain or availability guarantee',
        scope: 'One historical unaligned BTC observation crossed the native route. No live round, funded order, private fill, custody, or keeper was tested.' };
    }
    fromBlock = latest.number > 2n ? latest.number - 2n : 0n;
    await new Promise((ok) => setTimeout(ok, Math.min(5000, Math.max(0, deadline - Date.now()))));
  }
  return { schemaVersion: 1, status: 'native-delivery-not-observed-within-180-seconds', checkedAt: new Date().toISOString(), noTransactionsSent: true,
    sourceTransactionHash: hash, sourceBlock: receipt.blockNumber, messageHash, failedRelaySeen, destinationPolledThrough: polledThrough,
    nextStep: 'Inspect or rerun observation later. This timeout is not proof that delivery can never occur; no retry transaction was sent.' };
}
async function main() {
  const option = options(); const context = await loadAndCheck(option);
  let result = context.live; let output = 'streams-live-check.json';
  if (option.observe) { result = await observe(context, option.observe); output = 'streams-smoke-observation.json'; await write(resolve(context.files.directory, output), result); }
  console.log(json({ status: result.status, registry: context.live.registry.status, rehearsal: context.files.rehearsal,
    output: shown(resolve(context.files.directory, output)), noTransactionsSent: true,
    messageHash: result.messageHash, destinationTransactionHash: result.destinationTransactionHash }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    const message = String(error.shortMessage ?? error.message ?? 'Public verification failed').slice(0, 400);
    // A failed run must not leave an earlier pass in place. Refused arguments have nothing to invalidate.
    try {
      const option = options();
      await write(resolve(rehearsalFiles(option).directory, option.observe ? 'streams-smoke-observation.json' : 'streams-live-check.json'),
        { schemaVersion: 2, status: 'failed', checkedAt: new Date().toISOString(), noTransactionsSent: true, error: message });
    } catch { /* nothing written */ }
    console.error(`Public hybrid check failed: ${message}`); process.exitCode = 1;
  }
}
