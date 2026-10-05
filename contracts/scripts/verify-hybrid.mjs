#!/usr/bin/env node
/** Public-only source-verification preparation for the registry on Horizen Blockscout: the UUPS implementation
 * and its ERC1967Proxy. Never reads credentials or submits to explorers.
 * --prepare (default): reproduce both current Paris artifacts from inline Standard JSON.
 * --check-deployed: additionally run the live checker (release, creation data, runtimes, implementation slot,
 *                  owner, getters) and emit public per-contract verification parameters only after it passes.
 * --rehearsal <url> --evidence <directory>: the same against a local Anvil fork and its own release.
 * --solc <path>: use an installed native solc 0.8.30 (no automatic download).
 * Generated files live in ignored evidence/registry-verification/. API submission remains a separate step.
 * The three route contracts were verified on 2026-10-04; their packets in evidence/verification/ are not touched.
 */
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { keccak256, toHex, encodeAbiParameters } from 'viem';
import { parseArguments, shown } from './preflight-hybrid.mjs';
import { rehearsalFiles } from './plan-registry.mjs';
// The checker's entrypoint is guarded and is never invoked here; it never signs or sends.
import { loadAndCheck } from './check-hybrid-live.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACTS = resolve(ROOT, 'contracts');
const COMPILER = '0.8.30+commit.73712a01';
// Contract name -> its compilation target. The proxy is OpenZeppelin's, compiled from the pinned package.
const TARGETS = {
  StreamsRoundRegistry: 'src/StreamsRoundRegistry.sol',
  ERC1967Proxy: 'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol',
};
const NAMES = Object.keys(TARGETS);
const json = value => `${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const demand = (value, message) => { if (!value) throw new Error(message); };
let phase = 'options';

async function invalidateCheckedPackets(output) {
  for (const name of NAMES) await rm(resolve(output, `${name}.verification.json`), { force: true });
  await rm(resolve(output, 'registry-deployment-checked.json'), { force: true });
}

function options() {
  const parsed = parseArguments(process.argv.slice(2), ['--prepare', '--check-deployed'], ['--solc', '--rehearsal', '--evidence']);
  return { ...parsed, checkDeployed: Boolean(parsed['check-deployed']), solc: parsed.solc && resolve(parsed.solc) };
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

async function prepare(binary, output) {
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
    const source = TARGETS[name];
    demand(Object.keys(metadata.settings.compilationTarget).length === 1 && metadata.settings.compilationTarget[source] === name, 'Wrong compilation target');
    demand(Object.keys(artifact.bytecode.linkReferences ?? {}).length === 0, 'Unreviewed library links');
    const sources = {};
    for (const [path, entry] of Object.entries(metadata.sources)) {
      const disk = resolve(CONTRACTS, path); const local = relative(CONTRACTS, disk);
      demand(path.endsWith('.sol') && !isAbsolute(path) && local !== '..' && !local.startsWith(`..${platform() === 'win32' ? '\\' : '/'}`), 'Source path outside contracts or not Solidity');
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
  await mkdir(output, { recursive: true });
  for (const item of prepared) await writeFile(resolve(output, item.manifest.standardInput), item.inputText, { mode: 0o600 });
  await writeFile(resolve(output, 'registry-inputs.json'), json({
    schemaVersion: 1, status: 'registry-public-inputs-reproduced', contracts: prepared.map(x => x.manifest),
    notice: 'Source preparation does not prove deployment or explorer verification. No credentials read; no network submission.',
  }), { mode: 0o600 });
  return prepared;
}

async function checkDeployed(prepared, opts, output) {
  phase = 'live release check';
  const { release, live } = await loadAndCheck(opts);
  demand(live.registry.status === 'deployed-verified', 'The registry is not deployed yet: there is nothing to verify on the explorer');
  const packets = prepared.map((item, index) => {
    const made = live.registry.creations[index];
    phase = `${item.name}: bind the reproduced input to the checked deployment`;
    demand(made.name === item.name && eq(item.manifest.creationBytecodeHash, keccak256(item.artifact.bytecode.object)), 'Different creation artifact');
    const constructor = item.artifact.abi.find(x => x.type === 'constructor');
    return {
      ...item.manifest, chain: 'horizen', chainId: 26514, address: made.address, release: release.release, rehearsal: live.rehearsal,
      configHash: release.configHash, checkedAt: live.checkedAt, transactionHash: made.transactionHash,
      blockNumber: made.blockNumber.toString(), blockHash: made.blockHash, runtimeCodeHash: made.runtimeCodeHash,
      constructorArguments: encodeAbiParameters(constructor.inputs, live.registry.constructorArgs[index]).slice(2),
      codeFormat: 'solidity-standard-json-input', license: 'MIT',
      status: 'public-deployment-checked-explorer-submission-pending',
    };
  });
  // Never emit submit-ready address/constructor packets for a partial or mismatched deployment.
  for (const packet of packets) await writeFile(resolve(output, `${packet.name}.verification.json`), json(packet), { mode: 0o600 });
  await writeFile(resolve(output, 'registry-deployment-checked.json'), json({
    schemaVersion: 1, status: 'registry-public-deployment-checked', release: release.release, rehearsal: live.rehearsal,
    checkedAt: live.checkedAt, contracts: packets,
    notice: 'Read-only public checks only. This is not explorer verification, a security audit, or trading enablement. '
      + 'Submit the implementation first; Blockscout then links the verified proxy to it through the ERC-1967 slot.',
  }), { mode: 0o600 });
  return packets;
}

try {
  const opts = options();
  const output = resolve(rehearsalFiles(opts).directory, 'registry-verification');
  // Input preparation can replace bundles; previous submit-ready packets of this tool must not survive that.
  await invalidateCheckedPackets(output);
  const prepared = await prepare(await solcPath(opts.solc), output);
  const deployed = opts.checkDeployed ? await checkDeployed(prepared, opts, output) : undefined;
  console.log(json({ status: deployed ? 'registry-public-deployment-checked' : 'registry-public-inputs-reproduced',
    directory: shown(output), contracts: NAMES, explorerSubmissions: 0, credentialsRead: false,
  }));
} catch (error) {
  // Provider errors can embed verbose transaction data. Report the failing check, not provider objects.
  const message = error instanceof Error && error.name === 'Error' ? error.message.slice(0, 180) : 'Public RPC or input check failed';
  console.error(`Verification preparation stopped during ${phase}: ${message}`);
  process.exitCode = 1;
}
