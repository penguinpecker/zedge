#!/usr/bin/env node
/** Public-only source-verification preparation. Never reads credentials or submits to explorers.
 * --prepare (default): reproduce the four current Paris artifacts from inline Standard JSON.
 * --check-deployed: additionally bind public plan/checkpoint, live receipts, initcode and runtimes;
 *                  emit public per-contract verification parameters only after all checks pass.
 * --solc <path>: use an installed native solc 0.8.30 (no automatic download).
 * Generated files live in ignored evidence/verification/. API submission remains a separate step.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createPublicClient, http, keccak256, toHex, encodeAbiParameters, encodeDeployData, getContractAddress,
} from 'viem';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS = resolve(ROOT, 'contracts');
const OUTPUT = resolve(ROOT, 'evidence/verification');
const COMPILER = '0.8.30+commit.73712a01';
const NAMES = ['ChainlinkStreamsBoundaryOracle', 'BaseStreamsPublisher', 'HorizenStreamsOracle', 'StreamsRoundRegistry'];
const CHAINS = {
  base: { id: 8453, rpc: 'https://mainnet.base.org' },
  horizen: { id: 26514, rpc: 'https://horizen.calderachain.xyz/http' },
};
const json = value => `${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const demand = (value, message) => { if (!value) throw new Error(message); };
let phase = 'options';

function options() {
  const result = { checkDeployed: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare') continue;
    if (args[i] === '--check-deployed') result.checkDeployed = true;
    else if (args[i] === '--solc') {
      demand(args[i + 1] && !args[i + 1].startsWith('--'), '--solc requires a path');
      result.solc = resolve(args[++i]);
    } else throw new Error('Allowed options: --prepare, --check-deployed, --solc <path>');
  }
  return result;
}

async function solcPath(explicit) {
  const candidates = explicit ? [explicit] : [
    join(homedir(), '.svm', '0.8.30', 'solc-0.8.30'),
    ...(platform() === 'darwin' ? [join(homedir(), 'Library/Application Support/svm/0.8.30/solc-0.8.30')] : []),
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next local path. */ }
  }
  throw new Error('Installed solc 0.8.30 not found; provide --solc <absolute-path>');
}

// Fully inline source inputs need no import callback, shell, inherited environment or network.
function runCompiler(binary, args, input = '') {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd: CONTRACTS, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let overflow = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Compiler timeout')); }, 60000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Cannot execute installed compiler')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => { /* Child exit is handled below. */ });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow) reject(new Error('Compiler failed or output exceeded its bound'));
      else accept(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

async function prepare(binary) {
  demand((await runCompiler(binary, ['--version'])).includes(`Version: ${COMPILER}`), 'Wrong solc version');
  const prepared = [];
  for (const name of NAMES) {
    phase = `${name}: reproduce public Standard JSON`;
    const artifactPath = `contracts/out/${name}.sol/${name}.json`;
    const artifact = JSON.parse(await readFile(resolve(ROOT, artifactPath), 'utf8'));
    const metadata = artifact.metadata;
    demand(metadata?.compiler?.version === COMPILER && metadata.language === 'Solidity', 'Unexpected compiler metadata');
    demand(metadata.settings.evmVersion === 'paris', 'Artifacts must target Paris');
    demand(metadata.settings.optimizer?.enabled === true && metadata.settings.optimizer.runs === 200, 'Unexpected optimizer');
    demand(metadata.settings.metadata?.bytecodeHash === 'none', 'Unexpected bytecode metadata hash');
    const source = `src/${name}.sol`;
    demand(Object.keys(metadata.settings.compilationTarget).length === 1 && metadata.settings.compilationTarget[source] === name, 'Wrong compilation target');
    demand(Object.keys(artifact.bytecode.linkReferences ?? {}).length === 0, 'Unreviewed library links');
    const sources = {};
    for (const [path, entry] of Object.entries(metadata.sources)) {
      const disk = resolve(CONTRACTS, path); const local = relative(CONTRACTS, disk);
      demand(!isAbsolute(path) && local !== '..' && !local.startsWith(`..${platform() === 'win32' ? '\\' : '/'}`), 'Source path outside contracts');
      const bytes = await readFile(disk);
      demand(eq(keccak256(bytes), entry.keccak256), `Stale artifact source: ${path}`);
      sources[path] = { content: bytes.toString('utf8') };
    }
    const settings = structuredClone(metadata.settings);
    delete settings.compilationTarget;
    settings.outputSelection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } };
    const input = { language: 'Solidity', sources, settings };
    const inputText = json(input);
    const compiled = JSON.parse(await runCompiler(binary, ['--standard-json'], inputText));
    demand(!(compiled.errors ?? []).some(error => error.severity === 'error'), 'Standard JSON compilation failed');
    const target = compiled.contracts?.[source]?.[name];
    demand(target && eq(`0x${target.evm.bytecode.object}`, artifact.bytecode.object), 'Creation bytecode does not reproduce exactly');
    demand(eq(`0x${target.evm.deployedBytecode.object}`, artifact.deployedBytecode.object), 'Runtime bytecode template does not reproduce exactly');
    prepared.push({ name, artifactPath, artifact, inputText, manifest: {
      name, contractName: `${source}:${name}`, compilerVersion: `v${COMPILER}`,
      standardInput: `${name}.standard-input.json`, standardInputHash: keccak256(toHex(inputText)),
      creationBytecodeHash: keccak256(artifact.bytecode.object),
      runtimeTemplateHash: keccak256(artifact.deployedBytecode.object), sourceCount: Object.keys(sources).length,
      evmVersion: 'paris', optimizerRuns: 200, bytecodeHash: 'none', bytecodeReproduction: 'exact',
    } });
  }
  // Publish inputs only after every source closure has reproduced the reviewed artifact.
  await mkdir(OUTPUT, { recursive: true });
  for (const item of prepared) await writeFile(resolve(OUTPUT, item.manifest.standardInput), item.inputText, { mode: 0o600 });
  await writeFile(resolve(OUTPUT, 'hybrid-inputs.json'), json({
    schemaVersion: 1, status: 'four-public-inputs-reproduced', contracts: prepared.map(x => x.manifest),
    notice: 'Source preparation does not prove deployment or explorer verification. No credentials read; no network submission.',
  }), { mode: 0o600 });
  return prepared;
}

async function checkDeployed(prepared) {
  phase = 'confirmed public checkpoint and plan';
  const planText = await readFile(resolve(ROOT, 'evidence/hybrid-plan.json'), 'utf8');
  const plan = JSON.parse(planText);
  const checkpoint = JSON.parse(await readFile(resolve(ROOT, 'evidence/hybrid-broadcast.json'), 'utf8'));
  demand(plan.schemaVersion === 1 && plan.status === 'constructors-simulated-operational-gates-pending', 'Invalid deployment plan');
  demand(checkpoint.schemaVersion === 1 && checkpoint.status === 'four-contracts-confirmed-runtime-matched', 'No fully confirmed deployment checkpoint');
  demand(eq(checkpoint.planHash, keccak256(toHex(planText))) && eq(checkpoint.deployer, plan.deployer), 'Checkpoint is bound to a different plan');
  demand(plan.intents?.length === 4 && checkpoint.transactions?.length === 4, 'Expected exactly four deployments');
  const clients = Object.fromEntries(Object.entries(CHAINS).map(([key, value]) => [key, createPublicClient({
    transport: http(value.rpc, { timeout: 20000, retryCount: 2 }),
  })]));
  const packets = [];
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index]; const intent = plan.intents[index]; const entry = checkpoint.transactions[index];
    const chain = index < 2 ? 'base' : 'horizen'; const client = clients[chain];
    phase = `${item.name}: confirm public transaction and runtime`;
    demand(intent.name === item.name && entry.name === item.name && intent.chain === chain, 'Deployment order mismatch');
    demand(intent.chainId === CHAINS[chain].id && entry.chainId === intent.chainId && await client.getChainId() === intent.chainId, 'Wrong deployment chain');
    demand(entry.status === 'confirmed' && intent.artifactPath === item.artifactPath, 'Unconfirmed or different artifact');
    demand(eq(intent.from, plan.deployer) && entry.nonce === intent.nonce && Number.isSafeInteger(intent.nonce), 'Deployer or nonce mismatch');
    demand(eq(getContractAddress({ from: plan.deployer, nonce: BigInt(intent.nonce) }), intent.predictedAddress), 'CREATE address mismatch');
    demand(eq(entry.predictedAddress, intent.predictedAddress) && BigInt(intent.value) === 0n, 'Address or value mismatch');
    const constructor = item.artifact.abi.find(x => x.type === 'constructor');
    const encoded = encodeAbiParameters(constructor.inputs, intent.constructorArgs);
    const initCode = encodeDeployData({ abi: item.artifact.abi, bytecode: item.artifact.bytecode.object, args: intent.constructorArgs });
    demand(eq(encoded, intent.constructorArgsEncoded) && eq(initCode, intent.initCode), 'Constructor encoding mismatch');
    demand(eq(keccak256(initCode), intent.initCodeHash) && eq(entry.initCodeHash, intent.initCodeHash), 'Initcode hash mismatch');
    demand(eq(item.manifest.creationBytecodeHash, intent.creationBytecodeHash), 'Different creation artifact');
    const receipt = await client.getTransactionReceipt({ hash: entry.transactionHash });
    const transaction = await client.getTransaction({ hash: entry.transactionHash });
    demand(receipt.status === 'success' && entry.receipt?.status === 'success', 'Deployment receipt failed');
    demand(eq(receipt.contractAddress, intent.predictedAddress) && eq(entry.receipt.contractAddress, intent.predictedAddress), 'Receipt address mismatch');
    demand(eq(receipt.transactionHash, entry.transactionHash) && eq(entry.receipt.transactionHash, entry.transactionHash), 'Receipt transaction mismatch');
    demand(eq(receipt.blockHash, entry.receipt.blockHash) && receipt.blockNumber === BigInt(entry.receipt.blockNumber), 'Receipt changed since checkpoint');
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    demand(eq(block.hash, receipt.blockHash) && await client.getBlockNumber() >= receipt.blockNumber + 1n, 'Receipt is not canonical with two confirmations');
    demand(transaction.to === null && eq(transaction.from, plan.deployer) && transaction.nonce === intent.nonce
      && transaction.value === 0n && eq(transaction.input, initCode) && eq(transaction.blockHash, receipt.blockHash), 'Live deployment transaction differs from plan');
    const code = await client.getCode({ address: intent.predictedAddress });
    demand(code && code !== '0x' && eq(keccak256(code), intent.simulatedRuntimeHash)
      && eq(keccak256(code), entry.runtimeCodeHash), 'Live runtime differs from simulated and confirmed runtime');
    packets.push({
      ...item.manifest, chain, chainId: intent.chainId, address: intent.predictedAddress,
      transactionHash: entry.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      runtimeCodeHash: keccak256(code), constructorArguments: encoded.slice(2),
      codeFormat: 'solidity-standard-json-input', license: 'MIT',
      status: 'public-deployment-checked-explorer-submission-pending',
    });
  }
  // Never emit submit-ready address/constructor packets for a partial or mismatched deployment.
  for (const packet of packets) await writeFile(resolve(OUTPUT, `${packet.name}.verification.json`), json(packet), { mode: 0o600 });
  await writeFile(resolve(OUTPUT, 'hybrid-deployment-checked.json'), json({
    schemaVersion: 1, status: 'four-public-deployments-checked', planHash: checkpoint.planHash,
    checkedAt: new Date().toISOString(), contracts: packets,
    notice: 'Read-only public checks only. This is not explorer verification, a security audit, or trading enablement.',
  }), { mode: 0o600 });
  return packets;
}

try {
  const opts = options();
  const prepared = await prepare(await solcPath(opts.solc));
  const deployed = opts.checkDeployed ? await checkDeployed(prepared) : undefined;
  console.log(json({ status: deployed ? 'four-public-deployments-checked' : 'four-public-inputs-reproduced',
    directory: relative(ROOT, OUTPUT), contracts: NAMES, explorerSubmissions: 0, credentialsRead: false,
  }));
} catch (error) {
  // Provider errors can embed verbose transaction data. Report the failing check, not provider objects.
  const message = error instanceof Error && error.name === 'Error' ? error.message.slice(0, 180) : 'Public RPC or input check failed';
  console.error(`Verification preparation stopped during ${phase}: ${message}`);
  process.exitCode = 1;
}
