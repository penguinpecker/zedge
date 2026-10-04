#!/usr/bin/env node
/** Explicit, single-use publishing of the reviewed public BTC report. Never retries or resumes. */
import { constants } from 'node:fs';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  createWalletClient, defineChain, http, keccak256, toHex, encodeFunctionData,
  decodeFunctionResult, serializeTransaction, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadAndCheck, fixture } from './check-hybrid-live.mjs';
import { recheckPublicDependencies } from './preflight-hybrid.mjs';
import { expectedConstructors, validateConstructorIntent, demandFreshPlan } from './broadcast-hybrid.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN = resolve(ROOT, 'evidence/hybrid-smoke-plan.json');
const CHECKPOINT = resolve(ROOT, 'evidence/hybrid-smoke-broadcast.json');
const RPC = 'https://base-rpc.publicnode.com';
const BASE_CEILING = 250000000000000n;
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const FIXTURE_HASH = '0x9f8b2e1e8114e38f2b52db9de9236373c294135c2207408c3244289926de17eb';
const FIXTURE_TX = '0xc9d24c37c8676210bc9d69c38dc11cf950d0bd6f9b0e7baa9ae682b25096aa33';
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const demand = condition => { if (!condition) throw new Error('Smoke preflight mismatch'); };
let phase = 'argument validation';
function integer(value) { demand(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)); return BigInt(value); }
function sameObservation(actual, expected) {
  for (const key of ['price', 'validFromTimestamp', 'observationsTimestamp', 'expiresAt', 'reportHash', 'decimals']) demand(eq(actual[key], expected[key]));
}

export function validatePublishReceipt(receipt, tx, block, head, hash, transaction, from) {
  const validHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
  demand(validHash(receipt.blockHash) && validHash(block.hash) && validHash(tx.blockHash));
  demand(eq(receipt.transactionHash, hash) && receipt.status === 'success');
  demand(eq(block.hash, receipt.blockHash) && eq(tx.blockHash, receipt.blockHash));
  demand(head >= receipt.blockNumber + 1n && tx.blockNumber === receipt.blockNumber && block.number === receipt.blockNumber);
  demand(eq(tx.hash, hash) && eq(tx.from, from) && eq(tx.to, transaction.to));
  demand(tx.nonce === transaction.nonce && tx.value === 0n && tx.chainId === 8453 && tx.type === 'eip1559');
  demand(eq(tx.input, transaction.data) && tx.gas === transaction.gas);
  demand(tx.maxFeePerGas === transaction.maxFeePerGas && tx.maxPriorityFeePerGas === transaction.maxPriorityFeePerGas);
}

async function canonicalReceipt(reader, hash, transaction, from) {
  const deadline = Date.now() + 180000;
  await reader.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180000, pollingInterval: 2000 });
  while (Date.now() < deadline) {
    // The provider has returned a zero blockHash from waitForTransactionReceipt; never accept it.
    const receipt = await reader.getTransactionReceipt({ hash });
    const [tx, block, head] = await Promise.all([
      reader.getTransaction({ hash }), reader.getBlock({ blockNumber: receipt.blockNumber }), reader.getBlockNumber({ cacheTime: 0 }),
    ]);
    const incomplete = [receipt.blockHash, tx.blockHash, block.hash].some(value => value === null || /^0x0{64}$/i.test(String(value)));
    if (!incomplete && head >= receipt.blockNumber + 1n) {
      validatePublishReceipt(receipt, tx, block, head, hash, transaction, from);
      return receipt;
    }
    await new Promise(ok => setTimeout(ok, Math.min(2000, Math.max(0, deadline - Date.now()))));
  }
  demand(false);
}

export function validateSmokePlan(smoke, context, report) {
  const { plan, checkpoint, config, artifacts } = context;
  demand(smoke.schemaVersion === 1 && smoke.status === 'unsigned-genuine-public-report-smoke-ready');
  demand(smoke.noTransactionsSent === true && smoke.expiresAfterSeconds === 300);
  demandFreshPlan(smoke);
  demand(smoke.chainId === 8453 && smoke.publicRpcUrl === RPC && integer(smoke.value) === 0n);
  demand(eq(smoke.checkpointPlanHash, checkpoint.planHash) && eq(smoke.from, plan.deployer));
  demand(eq(smoke.to, plan.predicted.basePublisher) && smoke.functionName === 'publishBoundary');
  demand(Number.isSafeInteger(smoke.nonce) && smoke.nonce === plan.chains.base.nonce + 2);
  demand(smoke.destinationChainId === 26514 && eq(smoke.destinationCache, plan.predicted.horizenCache));
  demand(eq(smoke.routeHash, plan.routeHash));
  demand(eq(smoke.sourceMessenger, config.dependencies.sourceMessenger.address)
    && eq(smoke.destinationMessenger, config.dependencies.destinationMessenger.address));
  demand(eq(report.fixture.payloadHash, FIXTURE_HASH) && eq(report.fixture.sourceTransaction, FIXTURE_TX));
  demand(eq(keccak256(report.fixture.payload), FIXTURE_HASH) && eq(smoke.fixturePayloadHash, FIXTURE_HASH));
  demand(eq(smoke.fixtureSourceTransaction, FIXTURE_TX) && smoke.fixtureProvenanceRpcUrl === 'https://mainnet.base.org');
  demand(integer(smoke.boundary) === report.boundary && report.boundary === 1791100805n);
  sameObservation(smoke.expectedObservation, report.expectedObservation);
  const abi = artifacts.BaseStreamsPublisher.abi;
  const expectedData = encodeFunctionData({ abi, functionName: 'publishBoundary', args: [report.fixture.feedId, report.boundary, report.fixture.payload] });
  demand(eq(smoke.data, expectedData) && eq(smoke.dataHash, keccak256(expectedData)));
  demand(eq(encodeFunctionData({ abi, functionName: 'publishBoundary', args: smoke.args }), expectedData));
  demand(smoke.realAdapterEthCallPassed === true && smoke.realPublisherEthCallPassed === true);
  const gas = integer(smoke.gasLimit); const estimatedGas = integer(smoke.estimatedGas);
  const maxFeePerGas = integer(smoke.maxFeePerGas); const maxPriorityFeePerGas = integer(smoke.maxPriorityFeePerGas);
  demand(estimatedGas >= 21000n && gas >= estimatedGas && gas <= 2000000n);
  demand(maxFeePerGas > 0n && maxPriorityFeePerGas <= maxFeePerGas);
  const ceiling = BigInt(config.maximumSpendWei.base);
  demand(ceiling > 0n && ceiling <= BASE_CEILING);
  const prior = integer(String(checkpoint.costUpperBoundsWei.base));
  demand(integer(smoke.fees.priorDeploymentCostUpperWei) === prior && integer(smoke.fees.approvedBaseCeilingWei) === ceiling);
  demand(integer(smoke.fees.gasLimitExecutionWei) === gas * maxFeePerGas);
  demand(smoke.fees.nonExecutionFeeBufferMultiplier === 2);
  const maximum = gas * maxFeePerGas + 2n * (integer(smoke.fees.l1DataFeeUpperWei) + integer(smoke.fees.operatorFeeAtGasLimitWei));
  demand(integer(smoke.fees.maximumEstimatedWei) === maximum);
  demand(integer(smoke.fees.combinedBaseCostUpperWei) === prior + maximum && prior + maximum <= ceiling);
  return { type: 'eip1559', chainId: 8453, to: plan.predicted.basePublisher, nonce: smoke.nonce,
    data: expectedData, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas };
}

async function loadAccount(expected) {
  const handle = await open(resolve(ROOT, 'contracts/.env.deploy.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    demand(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size < 16384);
    bytes = await handle.readFile();
    const value = parseEnv(bytes.toString()).DEPLOYER_PRIVATE_KEY;
    demand(typeof value === 'string' && /^(?:0x)?[0-9a-f]{64}$/i.test(value));
    const account = privateKeyToAccount(`0x${value.replace(/^0x/i, '')}`);
    demand(eq(account.address, expected)); return account;
  } finally { bytes?.fill(0); await handle.close(); }
}

async function checkSignerState(context, smoke) {
  const base = context.clients.base;
  const [chainId, latest, pending, code] = await Promise.all([
    base.getChainId(), base.getTransactionCount({ address: smoke.from, blockTag: 'latest' }),
    base.getTransactionCount({ address: smoke.from, blockTag: 'pending' }), base.getCode({ address: smoke.from }),
  ]);
  demand(chainId === 8453 && latest === smoke.nonce && pending === smoke.nonce);
  demand(code === undefined || code === '0x');
}

async function main() {
  demand(process.argv.length === 3 && process.argv[2] === '--broadcast');
  phase = 'public smoke plan validation';
  const planText = await readFile(PLAN, 'utf8'); const smoke = JSON.parse(planText);
  demandFreshPlan(smoke);
  const context = await loadAndCheck(); const report = await fixture(context);
  // Bind the deployed bytecode back to the independently reconstructed reviewed constructor profile.
  const expected = expectedConstructors(context.config, context.plan);
  for (const [i, intent] of context.plan.intents.entries()) {
    validateConstructorIntent(intent, context.artifacts[intent.name], expected[i]);
    demand(BigInt(context.blocks[intent.chain].number) >= BigInt(context.checkpoint.transactions[i].receipt.blockNumber) + 1n);
  }
  const transaction = validateSmokePlan(smoke, context, report);
  const base = context.clients.base; const reader = context.history.base;
  demand(await reader.getChainId() === 8453);
  // Never trust a copied aggregate that understates the already committed Base deployment budget.
  const recordedPrior = context.checkpoint.transactions.slice(0, 2)
    .reduce((sum, entry) => sum + integer(String(entry.feeUpperBoundWei)), 0n);
  demand(recordedPrior === BigInt(context.checkpoint.costUpperBoundsWei.base));
  const plannedPrior = context.plan.intents.slice(0, 2).reduce((sum, intent) => sum + BigInt(intent.fees.maximumEstimatedWei), 0n);
  const prior = recordedPrior > plannedPrior ? recordedPrior : plannedPrior;
  phase = 'current report and publisher simulation';
  await checkSignerState(context, smoke);
  const block = await base.getBlock();
  demand(block.timestamp >= report.boundary && block.timestamp <= BigInt(report.expectedObservation.expiresAt));
  demand(eq((await reader.getBlock({ blockNumber: integer(smoke.block.number) })).hash, smoke.block.hash));
  const adapterAbi = context.artifacts.ChainlinkStreamsBoundaryOracle.abi;
  const adapterData = encodeFunctionData({ abi: adapterAbi, functionName: 'verifyBoundary', args: [report.fixture.feedId,
    report.boundary, report.boundary + BigInt(context.config.rules.observationWindow), report.fixture.payload] });
  const verified = await base.call({ account: smoke.from, to: context.plan.predicted.baseAdapter, data: adapterData });
  sameObservation(decodeFunctionResult({ abi: adapterAbi, functionName: 'verifyBoundary', data: verified.data }), report.expectedObservation);
  const called = await base.call({ account: smoke.from, to: transaction.to, data: transaction.data, value: 0n });
  sameObservation(decodeFunctionResult({ abi: context.artifacts.BaseStreamsPublisher.abi, functionName: 'publishBoundary', data: called.data }), report.expectedObservation);
  const estimated = await base.estimateGas({ account: smoke.from, to: transaction.to, data: transaction.data, value: 0n, nonce: transaction.nonce });
  demand(estimated <= transaction.gas);
  phase = 'current dependency and fee validation';
  await recheckPublicDependencies(context.config);
  const fees = await base.estimateFeesPerGas();
  demand(fees.maxFeePerGas <= transaction.maxFeePerGas && fees.maxPriorityFeePerGas <= transaction.maxPriorityFeePerGas);
  const wire = serializeTransaction(transaction, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
  const size = BigInt((wire.length - 2) / 2);
  demand(Number(size) === smoke.fees.transactionBytesUpper);
  const l1 = await base.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)']), functionName: 'getL1FeeUpperBound', args: [size] });
  const operator = await base.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getOperatorFee(uint256) view returns(uint256)']), functionName: 'getOperatorFee', args: [transaction.gas] });
  const maximum = transaction.gas * transaction.maxFeePerGas + 2n * (l1 + operator);
  demand(prior + maximum <= BigInt(context.config.maximumSpendWei.base));
  demand(await base.getBalance({ address: smoke.from }) >= maximum);
  await checkSignerState(context, smoke);
  demandFreshPlan(smoke);
  phase = 'exclusive single-use checkpoint creation';
  const checkpoint = { schemaVersion: 1, status: 'prepared', startedAt: new Date().toISOString(), smokePlanHash: keccak256(toHex(planText)),
    deploymentPlanHash: context.checkpoint.planHash, from: smoke.from, chainId: 8453, nonce: transaction.nonce, to: transaction.to,
    dataHash: keccak256(transaction.data), feeUpperBoundWei: maximum, priorDeploymentFeeUpperBoundWei: prior,
    combinedBaseFeeUpperBoundWei: prior + maximum, nativeDeliveryVerified: false };
  await mkdir(dirname(CHECKPOINT), { recursive: true });
  const handle = await open(CHECKPOINT, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${json(checkpoint)}\n`); await handle.sync(); } finally { await handle.close(); }
  const save = async () => {
    const temporary = `${CHECKPOINT}.${process.pid}.next`;
    const update = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await update.writeFile(`${json(checkpoint)}\n`); await update.sync(); } finally { await update.close(); }
    await rename(temporary, CHECKPOINT);
  };
  phase = 'local signer validation';
  const account = await loadAccount(smoke.from);
  await checkSignerState(context, smoke);
  const finalBlock = await base.getBlock();
  demand(finalBlock.timestamp <= BigInt(report.expectedObservation.expiresAt));
  demandFreshPlan(smoke);
  phase = 'local signing';
  const signed = await account.signTransaction(transaction);
  checkpoint.transactionHash = keccak256(signed); checkpoint.status = 'signed-awaiting-submission'; await save();
  // Recheck wall-clock expiry after local signing and durable hash persistence, before the sole send.
  demandFreshPlan(smoke);
  phase = 'single transaction submission';
  const chain = defineChain({ id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 20000, retryCount: 0 }) });
  const hash = await wallet.sendRawTransaction({ serializedTransaction: signed });
  demand(eq(hash, checkpoint.transactionHash)); checkpoint.status = 'submitted'; await save();
  console.log(json({ status: checkpoint.status, transactionHash: hash }));
  phase = 'official Base receipt confirmation';
  const receipt = await canonicalReceipt(reader, hash, transaction, smoke.from);
  checkpoint.receipt = receipt; checkpoint.status = 'base-publish-confirmed-native-delivery-unchecked';
  checkpoint.confirmedAt = new Date().toISOString(); await save();
  console.log(json({ status: checkpoint.status, transactionHash: hash, checkpoint: 'evidence/hybrid-smoke-broadcast.json' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch {
    console.error(`Smoke publishing stopped during ${phase}. Inspect the public checkpoint and receipts; no automatic retry or resend was attempted.`);
    process.exitCode = 1;
  }
}
