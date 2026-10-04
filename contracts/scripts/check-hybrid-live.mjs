#!/usr/bin/env node
/**
 * PUBLIC-ONLY, read-only postdeployment verifier and native-message smoke planner.
 * Requires the original evidence/hybrid-plan.json and confirmed hybrid-broadcast.json.
 *   node contracts/scripts/check-hybrid-live.mjs
 *   node contracts/scripts/check-hybrid-live.mjs --prepare-smoke
 *   node contracts/scripts/check-hybrid-live.mjs --observe 0xPUBLIC_SOURCE_TX_HASH
 * No environment access, wallet, key, signing, account impersonation, or send RPC exists here.
 * The smoke uses a historical, already-public signed BTC report at its exact (unaligned)
 * second. It proves an oracle/message path only, never a funded prediction-market lifecycle.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, http, getAddress, keccak256, toHex, parseAbi,
  encodeFunctionData, decodeFunctionData, decodeFunctionResult, decodeAbiParameters,
  decodeEventLog, serializeTransaction, formatEther,
} from 'viem';
import { recheckPublicDependencies, verifyCreated } from './preflight-hybrid.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = {
  plan: resolve(ROOT, 'evidence/hybrid-plan.json'),
  checkpoint: resolve(ROOT, 'evidence/hybrid-broadcast.json'),
  config: resolve(ROOT, 'contracts/deployment/hybrid-mainnet.json'),
  fixtures: resolve(ROOT, 'research/chainlink-streams-base.md'),
  live: resolve(ROOT, 'evidence/hybrid-live-check.json'),
  smoke: resolve(ROOT, 'evidence/hybrid-smoke-plan.json'),
  observed: resolve(ROOT, 'evidence/hybrid-smoke-result.json'),
};
const NAMES = ['ChainlinkStreamsBoundaryOracle', 'BaseStreamsPublisher', 'HorizenStreamsOracle', 'StreamsRoundRegistry'];
const RPCS = { base: 'https://base-rpc.publicnode.com', horizen: 'https://horizen.calderachain.xyz/http' };
// PublicNode restricts older indexed transactions. Keep these few historical reads on Base's official RPC.
const BASE_HISTORY_RPC = 'https://mainnet.base.org';
const IDS = { base: 8453, horizen: 26514 };
const BASE_CEILING = 250000000000000n;
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
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
  const args = process.argv.slice(2);
  if (args.length === 0) return { mode: 'live' };
  if (args.length === 1 && args[0] === '--prepare-smoke') return { mode: 'prepare' };
  if (args.length === 2 && args[0] === '--observe' && /^0x[0-9a-f]{64}$/i.test(args[1])) return { mode: 'observe', transactionHash: args[1] };
  throw new Error('Allowed: no arguments, --prepare-smoke, or --observe <public transaction hash>');
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
export async function loadAndCheck() {
  const planText = await readFile(FILES.plan, 'utf8');
  const configText = await readFile(FILES.config, 'utf8');
  const plan = JSON.parse(planText); const config = JSON.parse(configText);
  const checkpoint = await publicJSON(FILES.checkpoint);
  demand(checkpoint.status === 'four-contracts-confirmed-runtime-matched', 'All four deployments must be confirmed first');
  same(checkpoint.planHash, keccak256(toHex(planText)), 'Checkpoint must bind the original exact plan');
  same(plan.configHash, keccak256(toHex(configText)), 'Public configuration changed since deployment plan');
  demand(plan.status === 'constructors-simulated-operational-gates-pending' && plan.intents?.length === 4 && checkpoint.transactions?.length === 4, 'Unexpected plan/checkpoint shape');
  same(checkpoint.deployer, plan.deployer, 'Checkpoint deployer mismatch'); same(plan.deployer, config.deployer, 'Configuration deployer mismatch');
  const clients = {}; const history = {}; const blocks = {}; const artifacts = {}; const checked = [];
  const dependencies = await recheckPublicDependencies(config);
  for (const chain of ['base', 'horizen']) {
    same(config.chains[chain].rpcUrl, RPCS[chain], 'Unreviewed public RPC');
    same(plan.chains[chain].chainId, IDS[chain], 'Unexpected planned chain');
    clients[chain] = client(RPCS[chain]); same(await clients[chain].getChainId(), IDS[chain], 'RPC chain mismatch');
    history[chain] = chain === 'base' ? client(BASE_HISTORY_RPC) : clients[chain];
    same(await history[chain].getChainId(), IDS[chain], 'Historical RPC chain mismatch');
    blocks[chain] = await clients[chain].getBlock();
  }
  for (let i = 0; i < NAMES.length; i++) {
    const intent = plan.intents[i]; const record = checkpoint.transactions[i]; const chain = i < 2 ? 'base' : 'horizen'; const c = clients[chain];
    demand(intent.name === NAMES[i] && record.name === intent.name && record.status === 'confirmed', 'Deployment ordering or confirmation mismatch');
    same(record.chainId, IDS[chain], 'Checkpoint chain mismatch'); same(intent.chainId, IDS[chain], 'Intent chain mismatch');
    same(record.predictedAddress, intent.predictedAddress, 'Checkpoint address mismatch');
    same(record.initCodeHash, intent.initCodeHash, 'Checkpoint initcode mismatch');
    const { receipt, block } = await anchoredReceipt(history[chain], record.transactionHash);
    same(receipt.contractAddress, intent.predictedAddress, 'Live creation address mismatch');
    const tx = await history[chain].getTransaction({ hash: record.transactionHash });
    demand(tx.to === null && tx.value === 0n, 'Expected a zero-value CREATE transaction');
    same(tx.from, plan.deployer, 'Live creation sender mismatch'); same(tx.nonce, intent.nonce, 'Live creation nonce mismatch');
    same(keccak256(tx.input), intent.initCodeHash, 'Live creation data differs from simulated plan');
    const runtime = await c.getCode({ address: addr(intent.predictedAddress), blockNumber: blocks[chain].number });
    demand(runtime && runtime !== '0x', 'Missing live runtime');
    same(keccak256(runtime), intent.simulatedRuntimeHash, 'Live runtime differs from simulation');
    same(record.runtimeCodeHash, intent.simulatedRuntimeHash, 'Checkpoint runtime hash mismatch');
    await verifyCreated(c, intent, plan, config, blocks[chain].number);
    const path = `contracts/out/${intent.name}.sol/${intent.name}.json`;
    same(intent.artifactPath, path, 'Unexpected artifact path');
    artifacts[intent.name] = await publicJSON(resolve(ROOT, path));
    same(keccak256(artifacts[intent.name].bytecode.object), intent.creationBytecodeHash, 'Current artifact differs from deployed creation template');
    checked.push({ name: intent.name, chainId: IDS[chain], address: intent.predictedAddress, transactionHash: record.transactionHash,
      creationBlock: receipt.blockNumber, creationTimestamp: block.timestamp, runtimeCodeHash: keccak256(runtime), immutableChecksPassed: true });
  }
  for (const chain of ['base', 'horizen']) same((await clients[chain].getBlock({ blockNumber: blocks[chain].number })).hash, blocks[chain].hash, 'Live-check snapshot reorg');
  const result = { schemaVersion: 1, status: 'four-live-runtimes-and-immutables-verified', checkedAt: new Date().toISOString(),
    checkpointPlanHash: checkpoint.planHash, contracts: checked, dependencies, routeHash: plan.routeHash, rulesHash: plan.rulesHash,
    snapshotBlocks: Object.fromEntries(Object.entries(blocks).map(([key, block]) => [key, { number: block.number, hash: block.hash, timestamp: block.timestamp }])),
    noTransactionsSent: true, privateTradingOrCustodyVerified: false, nativeDeliveryVerified: false };
  await write(FILES.live, result);
  return { plan, config, checkpoint, clients, history, blocks, artifacts, live: result };
}
export async function fixture(context) {
  const text = await readFile(FILES.fixtures, 'utf8'); const block = text.match(/```json\n([\s\S]*?)\n```/);
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
async function prepare(context) {
  const { plan, config, checkpoint, clients, artifacts } = context; const base = clients.base;
  const { fixture: source, boundary, expectedObservation } = await fixture(context);
  const block = await base.getBlock();
  const deployerCode = await base.getCode({ address: addr(plan.deployer), blockNumber: block.number });
  demand(!deployerCode || deployerCode === '0x', 'Smoke sender must remain an ordinary EOA without delegated code');
  demand(block.timestamp >= boundary && block.timestamp <= BigInt(expectedObservation.expiresAt), 'Historical smoke report is not currently usable; no fresh report was fetched');
  const adapterAbi = artifacts.ChainlinkStreamsBoundaryOracle.abi;
  const adapterData = encodeFunctionData({ abi: adapterAbi, functionName: 'verifyBoundary', args: [source.feedId, boundary, boundary + BigInt(config.rules.observationWindow), source.payload] });
  const verified = await base.call({ account: addr(plan.deployer), to: addr(plan.predicted.baseAdapter), data: adapterData, blockNumber: block.number });
  const actual = decodeFunctionResult({ abi: adapterAbi, functionName: 'verifyBoundary', data: verified.data }); observationMatches(actual, expectedObservation);
  const publisherAbi = artifacts.BaseStreamsPublisher.abi;
  const args = [source.feedId, boundary, source.payload];
  const data = encodeFunctionData({ abi: publisherAbi, functionName: 'publishBoundary', args });
  const publisherCheck = await base.call({ account: addr(plan.deployer), to: addr(plan.predicted.basePublisher), data, value: 0n, blockNumber: block.number });
  observationMatches(decodeFunctionResult({ abi: publisherAbi, functionName: 'publishBoundary', data: publisherCheck.data }), expectedObservation);
  const nonce = await base.getTransactionCount({ address: addr(plan.deployer), blockTag: 'latest' });
  demand(nonce === plan.chains.base.nonce + 2, 'One-time smoke requires the first Base nonce after the two deployments; do not silently prepare a repeat or skip another transaction');
  same(await base.getTransactionCount({ address: addr(plan.deployer), blockTag: 'pending' }), nonce, 'Pending deployer transaction blocks smoke preparation');
  const gas = await base.estimateGas({ account: addr(plan.deployer), to: addr(plan.predicted.basePublisher), data, value: 0n });
  const gasLimit = (gas * 125n + 99n) / 100n;
  demand(gasLimit <= 2000000n, 'Unexpectedly large smoke transaction gas');
  const gasPrice = await base.getGasPrice(); const priority = await base.estimateMaxPriorityFeePerGas();
  demand(block.baseFeePerGas !== null, 'Expected EIP-1559 block');
  const maxFee = [2n * gasPrice, 2n * block.baseFeePerGas + priority].reduce((a, b) => a > b ? a : b);
  const encoded = serializeTransaction({ type: 'eip1559', chainId: 8453, nonce, to: addr(plan.predicted.basePublisher), data, value: 0n, gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority },
    { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
  const transactionBytesUpper = (encoded.length - 2) / 2;
  const l1 = await view(base, block.number, GAS_ORACLE, 'getL1FeeUpperBound(uint256) view returns(uint256)', [BigInt(transactionBytesUpper)]);
  const operator = await view(base, block.number, GAS_ORACLE, 'getOperatorFee(uint256) view returns(uint256)', [gasLimit]);
  const maximumEstimatedWei = gasLimit * maxFee + 2n * l1 + 2n * operator;
  const prior = BigInt(checkpoint.costUpperBoundsWei?.base ?? '-1'); const ceiling = BigInt(config.maximumSpendWei.base);
  demand(prior >= 0n && ceiling > 0n && ceiling <= BASE_CEILING, 'Missing or invalid confirmed deployment cost accounting');
  demand(prior + maximumEstimatedWei <= ceiling, 'Smoke estimate exceeds remaining approved Base budget');
  const balance = await base.getBalance({ address: addr(plan.deployer) }); demand(balance >= maximumEstimatedWei, 'Insufficient observed Base ETH for smoke estimate');
  same(await base.getTransactionCount({ address: addr(plan.deployer), blockTag: 'latest' }), nonce, 'Nonce changed while preparing smoke');
  same(await base.getTransactionCount({ address: addr(plan.deployer), blockTag: 'pending' }), nonce, 'Pending nonce changed while preparing smoke');
  same((await base.getBlock({ blockNumber: block.number })).hash, block.hash, 'Smoke preparation snapshot reorg');
  const result = { schemaVersion: 1, status: 'unsigned-genuine-public-report-smoke-ready', createdAt: new Date().toISOString(), expiresAfterSeconds: 300,
    noTransactionsSent: true, checkpointPlanHash: checkpoint.planHash, chainId: 8453, publicRpcUrl: RPCS.base, from: plan.deployer,
    to: plan.predicted.basePublisher, nonce, value: '0', functionName: 'publishBoundary', args, data, dataHash: keccak256(data),
    gasLimit, estimatedGas: gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority,
    routeHash: plan.routeHash, destinationChainId: 26514, destinationCache: plan.predicted.horizenCache,
    sourceMessenger: config.dependencies.sourceMessenger.address, destinationMessenger: config.dependencies.destinationMessenger.address,
    boundary, expectedObservation, fixtureSourceTransaction: source.sourceTransaction, fixturePayloadHash: source.payloadHash, fixtureProvenanceRpcUrl: BASE_HISTORY_RPC,
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, realAdapterEthCallPassed: true, realPublisherEthCallPassed: true,
    fees: { maximumEstimatedWei, maximumEstimatedETH: formatEther(maximumEstimatedWei), gasLimitExecutionWei: gasLimit * maxFee,
      l1DataFeeUpperWei: l1, operatorFeeAtGasLimitWei: operator, nonExecutionFeeBufferMultiplier: 2, transactionBytesUpper,
      priorDeploymentCostUpperWei: prior, combinedBaseCostUpperWei: prior + maximumEstimatedWei, approvedBaseCeilingWei: ceiling, observedBalanceWei: balance },
    scope: 'One historical public BTC report at its exact signed second; deliberately not a 5m/15m round boundary. No market creation, orders, custody, or settlement.',
    signingPrerequisites: ['Recheck this 300-second plan, live dependency/code/route pins, unexpired report, deployer nonce, fees and remaining total budget immediately before any independently authorized send.', 'This helper never signs or sends. A Base receipt must be followed by authenticated Horizen receipt and matching cached observation.'],
  };
  await write(FILES.smoke, result); return result;
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
  const { plan, config, clients, artifacts } = context; const destination = clients.horizen;
  const { fixture: source, boundary, expectedObservation } = await fixture(context);
  const { receipt, block: sourceBlock } = await anchoredReceipt(context.history.base, hash);
  const tx = await context.history.base.getTransaction({ hash });
  same(tx.to, plan.predicted.basePublisher, 'Source smoke transaction target mismatch'); same(tx.from, plan.deployer, 'Unexpected smoke sender'); demand(tx.value === 0n, 'Smoke must carry zero ETH value');
  const decoded = decodeFunctionData({ abi: artifacts.BaseStreamsPublisher.abi, data: tx.input });
  demand(decoded.functionName === 'publishBoundary', 'Expected publishBoundary smoke call');
  same(decoded.args[0], source.feedId, 'Smoke feed mismatch'); same(decoded.args[1], boundary, 'Smoke boundary mismatch'); same(keccak256(decoded.args[2]), source.payloadHash, 'Smoke report payload mismatch');
  const messenger = config.dependencies.sourceMessenger.address;
  const sent = events(receipt, messenger, MSG_ABI, 'SentMessage').filter((x) => eq(x.args.sender, plan.predicted.basePublisher) && eq(x.args.target, plan.predicted.horizenCache));
  const extensions = events(receipt, messenger, MSG_ABI, 'SentMessageExtension1').filter((x) => eq(x.args.sender, plan.predicted.basePublisher));
  demand(sent.length === 1 && extensions.length === 1, 'Expected exactly one native smoke message');
  const message = sent[0].args; const value = extensions[0].args.value;
  demand(value === 0n && message.messageNonce >> 240n === 1n, 'Expected zero-value version-1 OP message');
  same(message.gasLimit, config.rules.minimumGasLimit, 'Destination gas policy mismatch');
  const receiverCall = decodeFunctionData({ abi: artifacts.HorizenStreamsOracle.abi, data: message.message });
  demand(receiverCall.functionName === 'receiveObservation', 'Unexpected native destination call');
  same(receiverCall.args[0], plan.routeHash, 'Message route mismatch'); same(receiverCall.args[1], source.feedId, 'Message feed mismatch'); same(receiverCall.args[2], boundary, 'Message boundary mismatch');
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
      const received = events(destinationReceipt, plan.predicted.horizenCache, observationAbi, 'ObservationReceived')
        .filter((x) => eq(x.args.feedId, source.feedId) && eq(x.args.boundary, boundary) && eq(x.args.reportHash, expectedObservation.reportHash));
      demand(received.length <= 1, 'Ambiguous cache-receipt event');
      const observation = await destination.readContract({ address: addr(plan.predicted.horizenCache), abi: observationAbi, functionName: 'getObservation', args: [source.feedId, boundary], blockNumber: latest.number });
      observationMatches(observation, expectedObservation);
      same((await context.history.base.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash, 'Source receipt reorg');
      same((await destination.getBlock({ blockNumber: destinationReceipt.blockNumber })).hash, destinationReceipt.blockHash, 'Destination receipt reorg');
      return { schemaVersion: 1, status: 'native-delivery-and-authenticated-cache-observed', checkedAt: new Date().toISOString(), noTransactionsSent: true,
        checkpointPlanHash: context.checkpoint.planHash, messageHash, messageNonce: message.messageNonce, routeHash: plan.routeHash,
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
  const option = options(); const context = await loadAndCheck();
  let result = context.live;
  if (option.mode === 'prepare') result = await prepare(context);
  if (option.mode === 'observe') { result = await observe(context, option.transactionHash); await write(FILES.observed, result); }
  console.log(json({ status: result.status, output: option.mode === 'prepare' ? 'evidence/hybrid-smoke-plan.json' : option.mode === 'observe' ? 'evidence/hybrid-smoke-result.json' : 'evidence/hybrid-live-check.json',
    noTransactionsSent: true, maximumEstimatedETH: result.fees?.maximumEstimatedETH, messageHash: result.messageHash,
    destinationTransactionHash: result.destinationTransactionHash }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    const message = String(error.shortMessage ?? error.message ?? 'Public verification failed').slice(0, 400);
    const output = process.argv.includes('--prepare-smoke') ? FILES.smoke : process.argv.includes('--observe') ? FILES.observed : FILES.live;
    await write(output, { schemaVersion: 1, status: 'failed', checkedAt: new Date().toISOString(), noTransactionsSent: true, error: message });
    console.error(`Public hybrid check failed: ${message}`); process.exitCode = 1;
  }
}
