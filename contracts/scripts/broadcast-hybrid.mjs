#!/usr/bin/env node
/** Broadcast only an exact, recently simulated four-contract public plan.
 * Keys are read from the local ignored 0600 file, never arguments, output or artifacts.
 * Requires the user's deployment authorization separately from this mechanical flag.
 */
import { constants } from 'node:fs';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256,
  toHex, getContractAddress, encodeDeployData, serializeTransaction, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recheckPublicDependencies } from './preflight-hybrid.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLAN = resolve(ROOT, 'evidence/hybrid-plan.json');
const CONFIG = resolve(ROOT, 'contracts/deployment/hybrid-mainnet.json');
const CHECKPOINT = resolve(ROOT, 'evidence/hybrid-broadcast.json');
const PROFILE = {
  base: { id: 8453, rpc: 'https://base-rpc.publicnode.com', ceiling: 250000000000000n },
  horizen: { id: 26514, rpc: 'https://horizen.calderachain.xyz/http', ceiling: 120000000000000n },
};
const NAMES = ['ChainlinkStreamsBoundaryOracle', 'BaseStreamsPublisher', 'HorizenStreamsOracle', 'StreamsRoundRegistry'];
const GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const demand = condition => { if (!condition) throw new Error('Preflight mismatch'); };
let phase = 'argument validation';

// Rebuild constructors from the reviewed profile and CREATE predictions, independently of plan args.
export function expectedConstructors(config, plan) {
  const nonce = key => {
    const value = plan.chains[key].nonce;
    demand(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER);
    return value;
  };
  const baseNonce = nonce('base');
  const horizenNonce = nonce('horizen');
  const predicted = {
    baseAdapter: getContractAddress({ from: plan.deployer, nonce: BigInt(baseNonce) }),
    basePublisher: getContractAddress({ from: plan.deployer, nonce: BigInt(baseNonce + 1) }),
    horizenCache: getContractAddress({ from: plan.deployer, nonce: BigInt(horizenNonce) }),
    horizenRegistry: getContractAddress({ from: plan.deployer, nonce: BigInt(horizenNonce + 1) }),
  };
  const feeds = config.feeds;
  const rules = config.rules;
  demand(feeds.btcDecimals === 18 && feeds.ethDecimals === 18);
  demand(rules.observationWindow === 60 && rules.openingGrace === 150
    && rules.settlementGrace === 3600 && rules.cutoffBuffer === 30 && rules.minimumGasLimit === 600000);
  const route = {
    sourceChainId: 8453n,
    destinationChainId: 26514n,
    sourceMessenger: config.dependencies.sourceMessenger.address,
    destinationMessenger: config.dependencies.destinationMessenger.address,
    sourceOracle: predicted.baseAdapter,
    publisher: predicted.basePublisher,
    destinationOracle: predicted.horizenCache,
    btcFeedId: feeds.btcFeedId,
    ethFeedId: feeds.ethFeedId,
    btcDecimals: feeds.btcDecimals,
    ethDecimals: feeds.ethDecimals,
    observationWindow: rules.observationWindow,
    minimumGasLimit: rules.minimumGasLimit,
  };
  return [
    [config.dependencies.verifier.address, feeds.btcFeedId, feeds.btcDecimals, feeds.ethFeedId, feeds.ethDecimals],
    [route],
    [route],
    [{
      oracle: predicted.horizenCache,
      collateral: config.dependencies.collateral.address,
      btcFeedId: feeds.btcFeedId,
      ethFeedId: feeds.ethFeedId,
      btcDecimals: feeds.btcDecimals,
      ethDecimals: feeds.ethDecimals,
      observationWindow: rules.observationWindow,
      openingGrace: rules.openingGrace,
      settlementGrace: rules.settlementGrace,
      cutoffBuffer: rules.cutoffBuffer,
    }],
  ];
}

export function validateConstructorIntent(intent, artifact, expectedArgs) {
  const encoded = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: intent.constructorArgs });
  const expectedEncoded = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: expectedArgs });
  demand(eq(encoded, expectedEncoded));
  demand(eq(encoded, intent.initCode) && eq(keccak256(encoded), intent.initCodeHash));
}

export function demandFreshPlan(plan) {
  const age = Date.now() - Date.parse(plan.createdAt);
  demand(Number.isFinite(age) && age >= 0 && age <= 300000);
}

async function loadAccount(expected) {
  const handle = await open(resolve(ROOT, 'contracts/.env.deploy.local'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat();
    demand(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size < 16384);
    bytes = await handle.readFile();
    const value = parseEnv(bytes.toString()).DEPLOYER_PRIVATE_KEY;
    demand(typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value));
    const account = privateKeyToAccount(value);
    demand(eq(account.address, expected));
    return account;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

async function main() {
  demand(process.argv.length === 3 && process.argv[2] === '--broadcast');
  phase = 'public plan validation';
  const planText = await readFile(PLAN, 'utf8');
  const plan = JSON.parse(planText);
  const configText = await readFile(CONFIG, 'utf8');
  const config = JSON.parse(configText);
  demand(plan.schemaVersion === 1 && plan.status === 'constructors-simulated-operational-gates-pending');
  demand(plan.noLiveTransactions === true && plan.simulation?.performed === true);
  demand(plan.simulation.chainStateOverridden === false && plan.simulation.balancesOverridden === false);
  demand(plan.simulation.generatedWalletAccounts === 0 && eq(plan.configHash, keccak256(toHex(configText))));
  demand(eq(plan.deployer, config.deployer) && plan.expiresAfterSeconds === 300);
  demandFreshPlan(plan);
  demand(Array.isArray(plan.intents) && plan.intents.length === 4);
  const expectedArgs = expectedConstructors(config, plan);

  const clients = {};
  for (const [key, profile] of Object.entries(PROFILE)) {
    demand(plan.chains[key].chainId === profile.id && config.chains[key].chainId === profile.id);
    demand(eq(config.chains[key].rpcUrl, profile.rpc));
    const chain = defineChain({ id: profile.id, name: key, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [profile.rpc] } } });
    clients[key] = createPublicClient({ chain, transport: http(profile.rpc, { timeout: 20000, retryCount: 2 }) });
    demand(BigInt(plan.budgets[key].approvedCeilingWei) === BigInt(config.maximumSpendWei[key]));
    demand(BigInt(plan.budgets[key].approvedCeilingWei) > 0n
      && BigInt(plan.budgets[key].approvedCeilingWei) <= profile.ceiling);
    demand(BigInt(plan.budgets[key].maximumEstimatedWei) > 0n
      && BigInt(plan.budgets[key].maximumEstimatedWei) <= BigInt(config.maximumSpendWei[key]));
  }

  for (let i = 0; i < NAMES.length; i++) {
    const intent = plan.intents[i];
    demand(intent.name === NAMES[i] && intent.chain === (i < 2 ? 'base' : 'horizen'));
    const profile = PROFILE[intent.chain];
    demand(intent.chainId === profile.id && eq(intent.from, plan.deployer) && BigInt(intent.value) === 0n);
    demand(Number.isSafeInteger(intent.nonce) && intent.nonce >= 0);
    demand(intent.nonce === plan.chains[intent.chain].nonce + i % 2);
    demand(eq(getContractAddress({ from: plan.deployer, nonce: BigInt(intent.nonce) }), intent.predictedAddress));
    demand(intent.artifactPath === `contracts/out/${intent.name}.sol/${intent.name}.json`);
    const artifact = JSON.parse(await readFile(resolve(ROOT, intent.artifactPath), 'utf8'));
    demand(artifact.metadata.compiler.version === '0.8.30+commit.73712a01');
    demand(artifact.metadata.settings.evmVersion === 'paris');
    demand(artifact.metadata.settings.optimizer.enabled && artifact.metadata.settings.optimizer.runs === 200);
    for (const [source, entry] of Object.entries(artifact.metadata.sources)) {
      demand(!source.startsWith('/') && !source.split('/').includes('..'));
      demand(eq(keccak256(await readFile(resolve(ROOT, 'contracts', source))), entry.keccak256));
    }
    demand(eq(keccak256(artifact.bytecode.object), intent.creationBytecodeHash));
    // Integer constructor fields survive JSON as decimal strings; viem validates their ABI ranges.
    validateConstructorIntent(intent, artifact, expectedArgs[i]);
    demand(/^0x[0-9a-f]{64}$/i.test(intent.simulatedRuntimeHash));
    demand(intent.immutableChecksPassed === true && BigInt(intent.simulatedGas) > 0n);
    demand(BigInt(intent.gasLimit) >= BigInt(intent.simulatedGas) && BigInt(intent.gasLimit) <= 8000000n);
    demand(BigInt(intent.maxFeePerGas) > 0n && BigInt(intent.maxPriorityFeePerGas) >= 0n
      && BigInt(intent.maxPriorityFeePerGas) <= BigInt(intent.maxFeePerGas));
    demand(BigInt(intent.fees.maximumEstimatedWei) >= BigInt(intent.gasLimit) * BigInt(intent.maxFeePerGas));
  }

  phase = 'public dependency validation';
  await recheckPublicDependencies(config);
  const confirmed = { base: 0, horizen: 0 };
  const spent = { base: 0n, horizen: 0n };
  phase = 'local signer validation';
  const account = await loadAccount(plan.deployer);
  const runStartedAt = Date.now();
  const checkpoint = { schemaVersion: 1, status: 'prepared', startedAt: new Date(runStartedAt).toISOString(), planHash: keccak256(toHex(planText)), deployer: plan.deployer, transactions: [] };
  await mkdir(dirname(CHECKPOINT), { recursive: true });
  phase = 'exclusive recovery checkpoint creation';
  // An existing checkpoint always requires manual inspection, including one from an uncertain send.
  const handle = await open(CHECKPOINT, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${json(checkpoint)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const save = async () => {
    const temporary = `${CHECKPOINT}.${process.pid}.next`;
    const update = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await update.writeFile(`${json(checkpoint)}\n`); await update.sync(); }
    finally { await update.close(); }
    await rename(temporary, CHECKPOINT);
  };

  for (const intent of plan.intents) {
    phase = `${intent.name}: live preflight`;
    await recheckPublicDependencies(config);
    // Never update the route or nonce silently if another wallet action intervenes.
    for (const [key, client] of Object.entries(clients)) {
      demand(await client.getChainId() === PROFILE[key].id);
      const expected = plan.chains[key].nonce + confirmed[key];
      demand(await client.getTransactionCount({ address: account.address, blockTag: 'latest' }) === expected);
      demand(await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) === expected);
      const accountCode = await client.getCode({ address: account.address });
      demand(accountCode === undefined || accountCode === '0x');
      const anchor = await client.getBlock({ blockNumber: BigInt(plan.chains[key].blockNumber) });
      demand(eq(anchor.hash, plan.chains[key].blockHash));
    }
    const client = clients[intent.chain];
    const existingCode = await client.getCode({ address: intent.predictedAddress });
    demand(existingCode === undefined || existingCode === '0x');
    const gas = BigInt(intent.gasLimit);
    const estimated = await client.estimateGas({ account, data: intent.initCode, value: 0n, nonce: intent.nonce });
    demand(estimated <= gas);
    const maxFeePerGas = BigInt(intent.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(intent.maxPriorityFeePerGas);
    const feesNow = await client.estimateFeesPerGas();
    demand(feesNow.maxFeePerGas <= maxFeePerGas && feesNow.maxPriorityFeePerGas <= maxPriorityFeePerGas);
    const transaction = { type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, data: intent.initCode, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas };
    const wire = serializeTransaction(transaction, { r: `0x${'ff'.repeat(32)}`, s: `0x${'ff'.repeat(32)}`, yParity: 1 });
    const l1Fee = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']), functionName: 'getL1FeeUpperBound', args: [BigInt((wire.length - 2) / 2)] });
    const operatorFee = await client.readContract({ address: GAS_ORACLE, abi: parseAbi(['function getOperatorFee(uint256) view returns (uint256)']), functionName: 'getOperatorFee', args: [gas] });
    const maximum = gas * maxFeePerGas + 2n * (l1Fee + operatorFee);
    const future = plan.intents.filter(x => x.chain === intent.chain && x.nonce > intent.nonce)
      .reduce((sum, x) => sum + BigInt(x.fees.maximumEstimatedWei), 0n);
    demand(spent[intent.chain] + maximum + future <= BigInt(config.maximumSpendWei[intent.chain]));
    demand(await client.getBalance({ address: account.address }) >= maximum + future);
    // Fee estimation can involve several RPC round trips; recheck signer state immediately before signing.
    for (const [key, current] of Object.entries(clients)) {
      const expectedNonce = plan.chains[key].nonce + confirmed[key];
      const [latestNonce, pendingNonce, accountCode] = await Promise.all([
        current.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        current.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        current.getCode({ address: account.address }),
      ]);
      demand(latestNonce === expectedNonce && pendingNonce === expectedNonce);
      demand(accountCode === undefined || accountCode === '0x');
    }
    // First signing requires a <=5-minute plan. Subsequent steps require all live checks above and a
    // <=15-minute run. Do not silently regenerate routes/nonces or retry after a partial deployment.
    if (checkpoint.transactions.length === 0) demandFreshPlan(plan);
    demand(Date.now() >= runStartedAt && Date.now() - runStartedAt <= 900000);
    phase = `${intent.name}: local signing`;
    const signed = await account.signTransaction(transaction);
    const expectedHash = keccak256(signed);
    const entry = { name: intent.name, chainId: intent.chainId, nonce: intent.nonce, predictedAddress: intent.predictedAddress, initCodeHash: intent.initCodeHash, transactionHash: expectedHash, status: 'signed-awaiting-submission' };
    checkpoint.transactions.push(entry); await save();
    phase = `${intent.name}: transaction submission`;
    const wallet = createWalletClient({ chain: client.chain, transport: http(PROFILE[intent.chain].rpc, { timeout: 20000, retryCount: 0 }) });
    // Only the deterministic public hash is persisted. Signed bytes and signing material stay in memory.
    const hash = await wallet.sendRawTransaction({ serializedTransaction: signed });
    demand(eq(hash, expectedHash));
    entry.status = 'submitted'; await save();
    console.log(json({ name: intent.name, chainId: intent.chainId, transactionHash: hash, status: 'submitted' }));
    phase = `${intent.name}: receipt confirmation`;
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180000, pollingInterval: 2000 });
    entry.receipt = receipt; await save();
    demand(eq(receipt.transactionHash, expectedHash) && receipt.status === 'success' && eq(receipt.contractAddress, intent.predictedAddress));
    const code = await client.getCode({ address: intent.predictedAddress });
    demand(code && code !== '0x' && eq(keccak256(code), intent.simulatedRuntimeHash));
    entry.runtimeCodeHash = keccak256(code); entry.status = 'confirmed';
    confirmed[intent.chain]++;
    // Budget using the conservative bound, rather than assuming all rollup fees appear in receipt fields.
    spent[intent.chain] += maximum;
    await save();
    console.log(json({ name: intent.name, chainId: intent.chainId, address: intent.predictedAddress, transactionHash: hash, status: 'confirmed' }));
  }
  checkpoint.status = 'four-contracts-confirmed-runtime-matched';
  checkpoint.completedAt = new Date().toISOString();
  checkpoint.costUpperBoundsWei = spent;
  await save();
  console.log(json({ status: checkpoint.status, checkpoint: 'evidence/hybrid-broadcast.json' }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch {
    // A signing/provider exception may contain sensitive context. Never print the exception.
    console.error(`Deployment stopped during ${phase}. Inspect the local plan/checkpoint and public receipts before retrying; no automatic retry was attempted.`);
    process.exitCode = 1;
  }
}
