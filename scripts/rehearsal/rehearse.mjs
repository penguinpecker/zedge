#!/usr/bin/env node
// Dress rehearsal of the round keeper on local forks of Base and Horizen. README.md in this folder says
// what it proves and what it does not.
//   node scripts/rehearsal/rehearse.mjs main   [--minutes 24] [--relay-delay 24] [--out <dir>]
//   node scripts/rehearsal/rehearse.mjs faults [--relay-delay 24] [--out <dir>]
// Ports 39101/39102 (forks), 39111/39112 (the keeper's endpoints), 39120 (report service stand-in). Nothing is sent
// to a public chain: public endpoints serve the forks' state (and the registry planner's own reads), a head and a fee quote
// per chain at start and a base fee per chain at the end.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createWriteStream, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, decodeFunctionResult, keccak256, numberToHex, parseAbi, parseTransaction, toEventSelector } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { simulate, BTC, ETH } from '../../services/keeper/sim.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opt, positionals: [scenario = 'main'] } = parseArgs({ allowPositionals: true,
  options: { minutes: { type: 'string', default: '24' }, 'relay-delay': { type: 'string', default: '24' }, out: { type: 'string' } } });
if (!['main', 'faults'].includes(scenario)) throw new Error('scenario: main or faults');
const OUT = resolve(opt.out ?? join(ROOT, 'evidence', `keeper-rehearsal-${new Date().toISOString().slice(0, 10)}`, scenario));
if ((await readdir(OUT).catch(() => [])).length) throw new Error(`${OUT} holds an earlier run: give --out a new directory`);
const PORT = { base: 39101, horizen: 39102 }, PROXY = { base: 39111, horizen: 39112 }, STREAMS = 39120;
const RELAY_DELAY = Number(opt['relay-delay']), GWEI = 10n ** 9n, JSONTYPE = { 'content-type': 'application/json' };
const profile = JSON.parse(await readFile(join(ROOT, 'contracts/deployment/hybrid-mainnet.json'), 'utf8'));
const release = JSON.parse(await readFile(join(ROOT, 'contracts/deployment/mainnet-addresses.json'), 'utf8'));
const at = name => release.contracts.find(c => c.name === name).address;
const abi = name => JSON.parse(readFileSync(join(ROOT, `contracts/abi/${name}.json`), 'utf8'));
const ABI = { registry: abi('StreamsRoundRegistry'), publisher: abi('BaseStreamsPublisher'), cache: abi('HorizenStreamsOracle') };
const BRIDGE = parseAbi(['event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)',
  'event RelayedMessage(bytes32 indexed msgHash)', 'event FailedRelayedMessage(bytes32 indexed msgHash)',
  'function relayMessage(uint256 nonce, address sender, address target, uint256 value, uint256 minGasLimit, bytes message) payable',
  'function receiveObservation(bytes32 routeHash, bytes32 feedId, uint64 boundary, (int192 price, uint32 validFromTimestamp, uint32 observationsTimestamp, uint32 expiresAt, bytes32 reportHash, uint8 decimals) observation)',
  'function verifierProxy() view returns (address)', 'function nativeMessenger() view returns (address)', 'function destinationMessenger() view returns (address)', 'function portal() view returns (address)',
  'function params() view returns (uint128 prevBaseFee, uint64 prevBoughtGas, uint64 prevBlockNum)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)']);
// Stands in for the Chainlink VerifierProxy: verify(payload, parameterPayload) returns the report blob of the payload's
// envelope (bytes32[3], bytes, ...) unchecked. No signature is checked; the stand-in report service is the only source.
//   PUSH1 4 CALLDATALOAD PUSH1 0x24 ADD DUP1 PUSH1 0x60 ADD CALLDATALOAD ADD DUP1 CALLDATALOAD  -> blob position, length L
//   mem[0]=0x20 mem[0x20]=L CALLDATACOPY(0x40, blob+32, L) RETURN(0, L+64)
const TEST_VERIFIER = '0x60043560240180606001350180356020600052806020529060200181906040376040016000f3';
const GAS_ORACLE = '0x420000000000000000000000000000000000000F', HISTORY = '0x0000F90827F1C53a10cb7a02335B175320002935';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = ms => new Promise(ok => setTimeout(ok, Math.max(0, ms)));
let broken; // set when a fork dies: the run is then meaningless and stops
const until = async seconds => { while (Date.now() < seconds * 1000) { if (broken) throw new Error(broken); await sleep(Math.min(1000, seconds * 1000 - Date.now())); } };
const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
await mkdir(OUT, { recursive: true });
const harnessLog = createWriteStream(join(OUT, 'harness.log'), { flags: 'a' });
const say = (...a) => { const line = `${iso()} ${a.join(' ')}`; console.log(line); harnessLog.write(`${line}\n`); };

// --- Forks, and one queue per fork: a cold fork stopped answering under concurrent batches, so every
// JSON-RPC call, the keeper's included, reaches Anvil one at a time.
const children = [];
function run(name, cmd, args, stdout) {
  const fd = openSync(join(OUT, `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', stdout ? 'pipe' : fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  children.push(child); return child;
}
const exited = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(ok => child.once('exit', ok));
async function upstream(url, method, params = []) {
  const r = await (await fetch(url, { method: 'POST', headers: JSONTYPE, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result;
}
async function post(chain, call) {
  try { return await (await fetch(`http://127.0.0.1:${PORT[chain]}`, { method: 'POST', headers: JSONTYPE, body: JSON.stringify(call), signal: AbortSignal.timeout(60000) })).json(); }
  catch (error) { return { jsonrpc: '2.0', id: call.id, error: { code: -32603, message: `rehearsal: anvil ${error.name}` } }; }
}
const queue = { base: Promise.resolve(), horizen: Promise.resolve() };
const serial = (chain, job) => { const p = queue[chain].then(job); queue[chain] = p.catch(() => {}); return p; };
async function rpc(chain, method, params = []) {
  const r = await serial(chain, () => post(chain, { jsonrpc: '2.0', id: 1, method, params }));
  if (r.error) throw Object.assign(new Error(`${chain} ${method}: ${r.error.message}`), { data: r.error.data }); return r.result;
}
const view = async (chain, to, functionName, args = [], abiOf = BRIDGE) =>
  decodeFunctionResult({ abi: abiOf, functionName, data: await rpc(chain, 'eth_call', [{ to, data: encodeFunctionData({ abi: abiOf, functionName, args }) }, 'latest']) });
const blockTimes = { base: new Map(), horizen: new Map() };
const blockTime = async (chain, number) => {
  const key = BigInt(number); if (!blockTimes[chain].has(key)) blockTimes[chain].set(key, Number((await rpc(chain, 'eth_getBlockByNumber', [numberToHex(key), false])).timestamp));
  return blockTimes[chain].get(key);
};

function listen(port, handler) {
  return new Promise(ok => { const server = createServer((req, res) => { let body = ''; req.on('data', c => { body += c; });
    req.on('end', async () => { let r; try { r = await handler(req, body); } catch (e) { r = { status: 500, body: JSON.stringify({ error: String(e.message) }) }; }
      res.writeHead(r.status, { ...JSONTYPE, ...r.headers }); res.end(r.body); }); });
  server.listen(port, '127.0.0.1', () => ok(server)); });
}

// --- Faults, all off by default. fault.delay(feed, boundary): seconds the bridge takes for that message.
const fault = { limitUntil: 0, frontRun: false, delay: () => RELAY_DELAY };
const tips = {}, calls = { base: [], horizen: [] }, frontRuns = [], relays = [];
let counting = false, FRONT;
const describe = data => { for (const a of [ABI.registry, ABI.publisher]) { try { const d = decodeFunctionData({ abi: a, data });
  return `${d.functionName}(${d.args.map(x => typeof x === 'string' && x.length > 66 ? 'report' : String(x)).join(',')})`; } catch { /* other ABI */ } } return data.slice(0, 10); };
// The keeper's endpoints. Anvil quotes a 1 gwei priority-fee floor neither chain has, so eth_maxPriorityFeePerGas is
// answered with the live chain's own quote, read once at start (as the registry planner does). The Base fork estimates past
// Base's 2^24 per-transaction cap, so an estimate above it gets the answer mainnet.base.org gave on 2026-10-05.
// Everything else is Anvil's.
function proxy(chain) {
  const log = createWriteStream(join(OUT, `rpc-${chain}.jsonl`));
  return listen(PROXY[chain], async (req, body) => {
    const parsed = JSON.parse(body), list = [].concat(parsed), t = Date.now();
    if (chain === 'horizen' && t < fault.limitUntil) {
      if (counting) { calls[chain].push({ t, n: list.length, limited: true }); log.write(`${JSON.stringify({ t, n: list.length, status: 429 })}\n`); }
      return { status: 429, headers: { 'retry-after': String(Math.ceil((fault.limitUntil - t) / 1000)) }, body: '{"error":"rate limited (rehearsal fault)"}' };
    }
    const answers = await serial(chain, async () => { const out = [];
      for (const call of list) {
        if (call.method === 'eth_maxPriorityFeePerGas') { out.push({ jsonrpc: '2.0', id: call.id, result: tips[chain] }); continue; }
        if (call.method === 'eth_sendRawTransaction' && fault.frontRun) await frontRun(chain, call.params[0]);
        const answer = await post(chain, call);
        out.push(chain === 'base' && call.method === 'eth_estimateGas' && answer.result && BigInt(answer.result) > 2n ** 24n
          ? { jsonrpc: '2.0', id: call.id, error: { code: -32003, message: 'out of gas: gas required exceeds: 16777216' } } : answer);
      }
      return out; });
    if (counting) calls[chain].push({ t, n: list.length });
    log.write(`${JSON.stringify({ t, ms: Date.now() - t, keeper: counting, n: list.length, m: [...new Set(list.map(c => c.method))], errors: answers.filter(a => a.error).map(a => a.error.message.slice(0, 120)) })}\n`);
    return { status: 200, body: JSON.stringify(Array.isArray(parsed) ? answers : answers[0]) };
  });
}
// Somebody else takes the very step the keeper just signed, from another account with a higher tip, sent first.
async function frontRun(chain, raw) {
  const tx = parseTransaction(raw);
  const r = await post(chain, { jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{ from: FRONT, to: tx.to, data: tx.data, gas: numberToHex(tx.gas),
    maxFeePerGas: numberToHex(tx.maxFeePerGas * 2n + GWEI), maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas * 2n + 1n) }] });
  frontRuns.push({ at: iso(), chain, call: describe(tx.data), keeperHash: keccak256(raw), frontRunHash: r.result ?? null, error: r.error?.message });
}

// --- The bridge: every SentMessage of the Base messenger is executed on Horizen from the aliased messenger address,
// fault.delay seconds after the block that holds it, with an explicit gas limit (an estimated one records a failed message).
const ADDR = {};
let scanned = 0;
async function bridgeTick() {
  const head = Number(await rpc('base', 'eth_blockNumber'));
  if (head > scanned) {
    const logs = await rpc('base', 'eth_getLogs', [{ fromBlock: numberToHex(scanned + 1), toBlock: numberToHex(head), address: ADDR.messenger, topics: [toEventSelector(BRIDGE[0])] }]);
    scanned = head;
    for (const log of logs) {
      const { args } = decodeEventLog({ abi: BRIDGE, data: log.data, topics: log.topics });
      if (args.sender.toLowerCase() !== at('BaseStreamsPublisher').toLowerCase()) continue;
      const { args: [, feed, boundary] } = decodeFunctionData({ abi: BRIDGE, data: args.message }), sentAt = await blockTime('base', log.blockNumber);
      relays.push({ feed: feed === BTC ? 'BTC' : 'ETH', boundary: Number(boundary), sentTx: log.transactionHash, sentAt, due: sentAt + fault.delay(feed, Number(boundary)), args });
    }
  }
  for (const r of relays) if (!r.relayTx && Date.now() / 1000 >= r.due) {
    r.relayTx = await rpc('horizen', 'eth_sendTransaction', [{ from: ADDR.alias, to: ADDR.l2Messenger, gas: numberToHex(2_000_000n), data: encodeFunctionData({ abi: BRIDGE,
      functionName: 'relayMessage', args: [r.args.messageNonce, r.args.sender, r.args.target, 0n, r.args.gasLimit, r.args.message] }) }]);
    let receipt; for (let i = 0; i < 40 && !receipt; i++) { receipt = await rpc('horizen', 'eth_getTransactionReceipt', [r.relayTx]); if (!receipt) await sleep(250); }
    const relayed = receipt?.logs.some(l => l.topics[0] === toEventSelector(BRIDGE[1]));
    Object.assign(r, { deliveredAt: receipt ? await blockTime('horizen', receipt.blockNumber) : null, relayStatus: receipt ? relayed ? 'relayed' : 'failed-message' : 'no-receipt' });
    say(`bridge ${r.feed}:${r.boundary} sent ${r.sentAt - r.boundary}s delivered ${r.deliveredAt === null ? '-' : r.deliveredAt - r.boundary}s after the boundary: ${r.relayStatus}`);
  }
}

// --- Deposit-fee pump: the portal's ResourceParams (slot 1: prevBlockNum | prevBoughtGas | prevBaseFee) rewritten every
// half second so the next block prices deposit gas at `fee`; the original word is put back afterwards.
async function pump(seconds, fee) {
  const original = await rpc('base', 'eth_getStorageAt', [ADDR.portal, '0x1', 'latest']), end = Date.now() + seconds * 1000;
  say(`fault: deposit fee pumped to ${fee / GWEI} gwei for ${seconds}s`);
  while (Date.now() < end) {
    const block = BigInt(await rpc('base', 'eth_blockNumber'));
    await rpc('base', 'anvil_setStorageAt', [ADDR.portal, '0x1', numberToHex((block << 192n) | (2_000_000n << 128n) | fee, { size: 32 })]);
    await sleep(500);
  }
  await rpc('base', 'anvil_setStorageAt', [ADDR.portal, '0x1', original]); say('fault: deposit fee restored');
}

let keeper, secretsDir, servers = [], stopping = false;
async function cleanup() {
  if (stopping) return; stopping = true;
  if (keeper && keeper.exitCode === null) { keeper.kill('SIGTERM'); await Promise.race([exited(keeper), sleep(40000)]); }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited(child), sleep(5000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  for (const server of servers) server.close();
  if (secretsDir) await rm(secretsDir, { recursive: true, force: true });
}
process.once('SIGINT', () => { cleanup().then(() => process.exit(130)); });

try {
  // 1. Forks at the current heads (pinned so Anvil caches upstream state), on wall-clock time.
  const UP = { base: profile.chains.base.receiptRpcUrl, horizen: profile.chains.horizen.rpcUrl }; // Base: an endpoint that serves archive state and receipts
  const forkBlock = {};
  for (const chain of ['base', 'horizen']) {
    forkBlock[chain] = Number(await upstream(UP[chain], 'eth_blockNumber')) - 5; tips[chain] = await upstream(UP[chain], 'eth_maxPriorityFeePerGas');
    run(`anvil-${chain}`, 'anvil', ['--host', '127.0.0.1', '--port', String(PORT[chain]), '--chain-id', String(profile.chains[chain].chainId), '--fork-url', UP[chain],
      '--fork-block-number', String(forkBlock[chain]), '--block-time', chain === 'base' ? '2' : '1', '--accounts', '0'])
      .once('exit', code => { if (!stopping) broken = `the ${chain} fork exited (${code}): see anvil-${chain}.log`; });
  }
  for (const chain of ['base', 'horizen']) {
    for (let i = 0; i < 120 && !(await post(chain, { jsonrpc: '2.0', id: 1, method: 'web3_clientVersion' })).result; i++) await sleep(500);
    await rpc(chain, 'evm_setTime', [Math.floor(Date.now() / 1000)]); // the first blocks would otherwise carry the fork block's age
    // Mining each block writes the parent hash into the EIP-2935 history contract, and Anvil fetches that slot upstream
    // first: one public request per block, and an upstream 502 made the Base fork panic. The slots of the next 75
    // minutes are set locally instead (to zero; mining overwrites each one before anything could read it).
    const head = Number(await rpc(chain, 'eth_blockNumber')), blocks = 75 * 60 / (chain === 'base' ? 2 : 1);
    for (let i = 0; i < blocks; i++) await rpc(chain, 'anvil_setStorageAt', [HISTORY, numberToHex((head + i) % 8191, { size: 32 }), numberToHex(0, { size: 32 })]);
  }
  say(`forks: base ${forkBlock.base}, horizen ${forkBlock.horizen}; live priority-fee quotes base ${BigInt(tips.base)} wei, horizen ${BigInt(tips.horizen)} wei`);
  servers.push(await proxy('base'), await proxy('horizen'));

  // 2. The registry, deployed by the unmodified registry deployment tools in rehearsal mode (same addresses as planned).
  const tool = (script, args) => new Promise(ok => { const child = run('deploy', process.execPath, [`contracts/scripts/${script}`, ...args]); child.once('exit', ok); });
  const deployArgs = ['--rehearsal', `http://127.0.0.1:${PROXY.horizen}`, '--evidence', join(OUT, 'deploy')];
  if (await tool('plan-registry.mjs', deployArgs) !== 0 || await tool('broadcast-registry.mjs', deployArgs) !== 0) throw new Error('registry rehearsal deployment failed: see deploy.log');
  const registryCode = await rpc('horizen', 'eth_getCode', [at('StreamsRoundRegistry'), 'latest']);
  if (keccak256(registryCode) !== release.contracts.find(c => c.name === 'StreamsRoundRegistry').runtimeCodeHash) throw new Error('registry proxy runtime differs from the release');
  const deployBlock = Number(await rpc('horizen', 'eth_blockNumber'));
  say(`registry deployed at ${at('StreamsRoundRegistry')} (Horizen fork block ${deployBlock})`);

  // 3. Test verifier on Base, bridge addresses, accounts.
  const sim = await simulate({});
  const publisher = at('BaseStreamsPublisher');
  ADDR.verifier = (await view('base', at('ChainlinkStreamsBoundaryOracle'), 'verifierProxy')); await rpc('base', 'anvil_setCode', [ADDR.verifier, TEST_VERIFIER]);
  ADDR.messenger = await view('base', publisher, 'nativeMessenger'); ADDR.l2Messenger = await view('base', publisher, 'destinationMessenger');
  ADDR.portal = await view('base', ADDR.messenger, 'portal');
  ADDR.alias = `0x${((BigInt(ADDR.messenger) + 0x1111000000000000000000000000000000001111n) % 2n ** 160n).toString(16).padStart(40, '0')}`;
  const params = await view('base', ADDR.portal, 'params'), slot1 = BigInt(await rpc('base', 'eth_getStorageAt', [ADDR.portal, '0x1', 'latest']));
  if (slot1 !== ((params[2] << 192n) | (params[1] << 128n) | params[0])) throw new Error('portal ResourceParams is not at slot 1');
  FRONT = privateKeyToAccount(generatePrivateKey()).address;
  const key = generatePrivateKey(), signer = privateKeyToAccount(key);
  for (const [chain, who, wei] of [['base', signer.address, 5n * 10n ** 16n], ['horizen', signer.address, 10n ** 16n], ['horizen', ADDR.alias, 10n ** 18n], ['base', FRONT, 10n ** 18n], ['horizen', FRONT, 10n ** 18n]]) {
    await rpc(chain, 'anvil_setBalance', [who, numberToHex(wei)]); if (who !== signer.address) await rpc(chain, 'anvil_impersonateAccount', [who]);
  }
  scanned = Number(await rpc('base', 'eth_blockNumber'));
  // Warm the forks: a first publication and the fee views make Anvil fetch hundreds of slots upstream one by one
  // (seconds that a real endpoint does not take), so they are fetched now, and each boundary's observation slots are
  // read 40 s before it (the second loop in step 4). Reads only; nothing on either fork changes.
  const recent = Math.floor(Date.now() / 1000 / 60) * 60 - 60, sample = sim.report(BTC, recent);
  await rpc('base', 'eth_estimateGas', [{ from: FRONT, to: publisher, data: encodeFunctionData({ abi: ABI.publisher, functionName: 'publishBoundary', args: [BTC, BigInt(recent), sample.fullReport] }) }]);
  for (const chain of ['base', 'horizen']) { await view(chain, GAS_ORACLE, 'getL1FeeUpperBound', [300n]); await view(chain, GAS_ORACLE, 'getOperatorFee', [300000n]); }
  say(`verifier ${ADDR.verifier} replaced; messenger ${ADDR.messenger} -> ${ADDR.l2Messenger} via alias ${ADDR.alias}; portal ${ADDR.portal}; keeper ${signer.address}; front-runner ${FRONT}`);

  // 4. The report service stand-in (the keeper simulator's: real HMAC check, exact-second lookups, gap seconds) and the bridge.
  servers.push(await listen(STREAMS, async req => {
    const r = await sim.streamsFetch(`http://stand-in${req.url}`, { headers: { Authorization: req.headers.authorization, 'X-Authorization-Timestamp': req.headers['x-authorization-timestamp'],
      'X-Authorization-Signature-SHA256': req.headers['x-authorization-signature-sha256'] } });
    return { status: r.status, headers: { date: r.headers.get('date') }, body: await r.text() };
  }));
  (async () => { while (!stopping) { try { await bridgeTick(); } catch (e) { say(`bridge error: ${e.message}`); } await sleep(1000); } })();
  (async () => { for (let warmed = 0; !stopping; await sleep(1000)) { const next = Math.ceil(Date.now() / 1000 / 300) * 300; if (warmed === next || next - Date.now() / 1000 > 40) continue;
    try { for (const feed of [BTC, ETH]) { await view('base', publisher, 'getObservation', [feed, BigInt(next)], ABI.publisher); await view('horizen', at('HorizenStreamsOracle'), 'getObservation', [feed, BigInt(next)], ABI.cache); } warmed = next; }
    catch (e) { say(`warm-up error: ${e.message}`); } } })();
  (async () => { const load = createWriteStream(join(OUT, 'load.log')); while (!stopping) {
    const [b, h] = await Promise.all(['base', 'horizen'].map(c => rpc(c, 'eth_getBlockByNumber', ['latest', false]).then(x => Number(x.timestamp)).catch(() => null)));
    const wall = Date.now() / 1000; load.write(`${iso()} load ${loadavg().map(x => x.toFixed(2)).join(' ')} clock-drift base ${b === null ? '-' : (b - wall).toFixed(1)}s horizen ${h === null ? '-' : (h - wall).toFixed(1)}s\n`);
    await sleep(60000); } })();

  // 5. The keeper, unmodified, with a throwaway key and its own rehearsal switches only.
  secretsDir = await mkdtemp(join(tmpdir(), 'keeper-rehearsal-'));
  const secrets = join(secretsDir, 'keeper.env');
  await writeFile(secrets, [`KEEPER_PRIVATE_KEY=${key}`, `KEEPER_ADDRESS=${signer.address}`, `CHAINLINK_STREAMS_USERNAME=${sim.username}`, `CHAINLINK_STREAMS_SECRET=${sim.secret}`,
    'KEEPER_BASE_DAILY_BUDGET_WEI=20000000000000000', 'KEEPER_HORIZEN_DAILY_BUDGET_WEI=4000000000000000', `KEEPER_BASE_RPC_URL=http://127.0.0.1:${PROXY.base}`,
    `KEEPER_HORIZEN_RPC_URL=http://127.0.0.1:${PROXY.horizen}`, `KEEPER_STREAMS_ORIGIN=http://127.0.0.1:${STREAMS}`].join('\n') + '\n', { mode: 0o600 });
  const keeperArgs = ['services/keeper/main.mjs', '--rehearsal', '--secrets', secrets];
  // Read-only first. On a cold fork the first tick's single eth_call makes Anvil fetch about a hundred storage slots
  // upstream one by one (about 35 s), past the keeper's 12 s request timeout; a later try finds them cached.
  for (let i = 1; i <= 6; i++) {
    const code = await new Promise(ok => run('keeper-plan', process.execPath, [keeperArgs[0], '--plan', ...keeperArgs.slice(1)]).once('exit', ok));
    say(`keeper --plan attempt ${i}: exit ${code}`); if (code === 0) break; if (i === 6) throw new Error('keeper --plan failed six times: see keeper-plan.log');
    await sleep(20000);
  }
  counting = true;
  const lines = [], started = Date.now();
  keeper = run('keeper-stderr', process.execPath, [keeperArgs[0], '--watch', ...keeperArgs.slice(1), '--state-directory', join(OUT, 'state')], true);
  const stdout = createWriteStream(join(OUT, 'keeper.jsonl'));
  createInterface({ input: keeper.stdout }).on('line', line => { stdout.write(`${line}\n`); try { const s = JSON.parse(line); lines.push(s);
    for (const x of s.sent) say(`keeper sent ${x.chain} ${x.action}`); for (const x of s.settled) if (x.status !== 'confirmed') say(`keeper settled ${x.key} ${x.status}`);
    for (const x of s.done) say(`keeper done ${x.action} ${x.already}`); } catch { /* not a status line */ } });
  say(`keeper --watch started (pid ${keeper.pid})`);

  // 6. The scenario. main: no faults. faults: one per boundary, B0 the first boundary at least 90 s away.
  const t0 = Math.floor(started / 1000), B = [0, 1, 2, 3, 4].map(i => Math.ceil((t0 + 90) / 300) * 300 + 300 * i), windows = {};
  const mark = (name, from, to, extra = {}) => { windows[name] = { from, to, ...extra }; };
  let end;
  if (scenario === 'main') { end = t0 + Number(opt.minutes) * 60; await until(end); }
  else {
    fault.delay = (feed, boundary) => feed === BTC && boundary === B[3] ? 300 : RELAY_DELAY;
    mark('gapSecond', B[0], B[0] + 210, { boundary: B[0] }); mark('horizen429', B[1] - 5, B[1] + 55, { boundary: B[1] });
    mark('depositFeePump', B[2] - 5, B[2] + 115, { boundary: B[2], feeGwei: 20 }); mark('relayDelayClosing', B[3], B[3] + 330, { boundary: B[3], feed: 'BTC', delay: 300 });
    mark('frontRun', B[3] + 150, B[4] + 240, { boundary: B[4] });
    await until(B[0] - 30); for (const feed of [BTC, ETH]) sim.streams.gaps.add(`${feed}:${B[0]}`); say(`fault: no report at second ${B[0]} for either feed`);
    await until(B[1] - 5); fault.limitUntil = (B[1] + 55) * 1000; say('fault: Horizen endpoint answers 429 for 60 s');
    await until(B[2] - 5); await pump(120, 20n * GWEI);
    say(`fault: BTC messages for boundary ${B[3]} take 300 s to relay`);
    await until(B[3] + 150); fault.frontRun = true; say('fault: front-running every keeper transaction');
    await until(B[4] + 240); fault.frontRun = false; say('fault: front-running off');
    end = B[4] + 300; await until(end);
  }
  keeper.kill('SIGTERM'); await Promise.race([exited(keeper), sleep(40000)]);
  say(`keeper stopped: exit ${keeper.exitCode} signal ${keeper.signalCode}`);
  counting = false;

  // 7. Measurements, from chain state and the keeper's own status lines only.
  const logs = async (chain, address, from) => (await rpc(chain, 'eth_getLogs', [{ fromBlock: numberToHex(from), toBlock: 'latest', address }]))
    .flatMap(l => { try { return [{ ...decodeEventLog({ abi: chain === 'base' ? ABI.publisher : address === at('HorizenStreamsOracle') ? ABI.cache : ABI.registry, data: l.data, topics: l.topics }), log: l }]; } catch { return []; } });
  const withTime = async (chain, list) => { for (const e of list) { e.time = await blockTime(chain, e.log.blockNumber);
    e.from = (await rpc(chain, 'eth_getTransactionByHash', [e.log.transactionHash])).from.toLowerCase() === signer.address.toLowerCase() ? 'keeper' : 'other'; } return list; };
  const registryEvents = await withTime('horizen', await logs('horizen', at('StreamsRoundRegistry'), deployBlock));
  const cacheEvents = await withTime('horizen', await logs('horizen', at('HorizenStreamsOracle'), forkBlock.horizen + 1));
  const baseEvents = await withTime('base', await logs('base', publisher, forkBlock.base + 1));
  const rounds = new Map(), feedName = f => f === BTC ? 'BTC' : 'ETH';
  for (const e of registryEvents) {
    if (e.eventName === 'RoundCreated') rounds.set(e.args.roundId, { market: `${e.args.asset === 0 ? 'BTC' : 'ETH'}${e.args.duration / 60}m`, start: Number(e.args.start), end: Number(e.args.end), createdAt: e.time, createdBy: e.from });
    const r = rounds.get(e.args.roundId); if (!r) continue;
    if (e.eventName === 'OpeningRecorded') Object.assign(r, { openedAt: e.time, openedBy: e.from });
    if (e.eventName === 'RoundResolved') Object.assign(r, { resolvedAt: e.time, resolvedBy: e.from, outcome: e.args.outcome });
    if (e.eventName === 'RoundVoided') Object.assign(r, { voidedAt: e.time, voidedBy: e.from, openingMissing: e.args.openingMissing });
  }
  const first = (list, name, feed, boundary) => list.find(e => e.eventName === name && e.args.feedId === feed && Number(e.args.boundary) === boundary);
  const boundaries = [];
  // From the first boundary the keeper can have rounds for: it creates a round only more than 20 s before its start.
  for (let b = Math.ceil((t0 + 21) / 300) * 300; b <= end - 210; b += 300) {
    const opening = [...rounds.values()].filter(r => r.start === b), closing = [...rounds.values()].filter(r => r.end === b && r.openedAt);
    const per = (list, f) => list.map(r => `${r.market} ${f(r)}`).join(', ');
    const rel = (t, by) => t === undefined ? 'none' : `+${t - b}s${by === 'other' ? ' (other)' : ''}`;
    boundaries.push({ boundary_utc: iso(b * 1000), boundary: b, aligned_900: b % 900 === 0,
      publications_mined_s: [BTC, ETH].map(f => `${feedName(f)} ${rel(first(baseEvents, 'BoundaryPublished', f, b)?.time, first(baseEvents, 'BoundaryPublished', f, b)?.from)}`).join(', '),
      bridge_messages: [BTC, ETH].map(f => `${feedName(f)} ${baseEvents.filter(e => e.eventName === 'BoundarySent' && e.args.feedId === f && Number(e.args.boundary) === b).length}`).join(', '),
      delivered_s: [BTC, ETH].map(f => `${feedName(f)} ${rel(first(cacheEvents, 'ObservationReceived', f, b)?.time)}`).join(', '),
      openings_recorded_s: per(opening, r => rel(r.openedAt, r.openedBy)),
      all_markets_opened_in_window: opening.length === (b % 900 === 0 ? 4 : 2) && opening.every(r => r.openedAt !== undefined && r.openedAt - b <= 210),
      resolutions_s: per(closing, r => rel(r.resolvedAt, r.resolvedBy)), voids: per(opening.filter(r => r.voidedAt), r => rel(r.voidedAt, r.voidedBy)) });
  }
  // Spend: what the keeper booked (its last status line, fork fees) and what the same gas costs at the live fees now.
  const history = (await readFile(join(OUT, 'state/history.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(t => t.receipt);
  const live = {};
  for (const chain of ['base', 'horizen']) live[chain] = BigInt((await upstream(UP[chain], 'eth_getBlockByNumber', ['latest', false])).baseFeePerGas) + BigInt(tips[chain]);
  // Whole quarter hours from the first boundary (each holds the same work), or whole five minutes in a shorter run.
  const from = boundaries[0]?.boundary ?? t0, span = end - from, window = { from, to: from + Math.max(300, Math.floor(span / (span >= 900 ? 900 : 300)) * (span >= 900 ? 900 : 300)) };
  const cost = { base: { txs: 0, reverted: 0, gas: 0n, liveWei: 0n, windowLiveWei: 0n }, horizen: { txs: 0, reverted: 0, gas: 0n, liveWei: 0n, windowLiveWei: 0n } };
  for (const t of history) {
    const receipt = await rpc(t.chain, 'eth_getTransactionReceipt', [t.hash]), gas = BigInt(receipt.gasUsed);
    const size = (((await rpc(t.chain, 'eth_getRawTransactionByHash', [t.hash])) ?? '0x').length - 2) / 2;
    const extra = (await view(t.chain, GAS_ORACLE, 'getL1FeeUpperBound', [BigInt(size)])) + (await view(t.chain, GAS_ORACLE, 'getOperatorFee', [gas]));
    const c = cost[t.chain], wei = gas * live[t.chain] + extra, time = Number(t.receipt.timestamp);
    c.txs++; if (t.status === 'reverted') c.reverted++; c.gas += gas; c.liveWei += wei; if (time >= window.from && time < window.to) c.windowLiveWei += wei;
  }
  for (const c of Object.values(cost)) c.impliedDailyLiveWei = c.windowLiveWei * 86400n / BigInt(window.to - window.from);
  const last = lines.at(-1) ?? {};
  const codes = new Set();
  for (const s of lines) { for (const w of s.waiting ?? []) codes.add(w.wait); for (const w of Object.values(s.chains ?? {})) codes.add(w.wait);
    for (const d of s.done ?? []) codes.add(d.already); for (const r of Object.values(s.reports ?? {})) if (r.failing) codes.add(r.failing); }
  const stderr = (await readFile(join(OUT, 'keeper-stderr.log'), 'utf8')).split('\n').filter(Boolean);
  for (const l of stderr) { try { codes.add(JSON.parse(l).code); } catch { /* not a status line */ } }
  const perMinute = chain => { const by = new Map(); for (const c of calls[chain]) { const m = Math.floor(c.t / 60000); by.set(m, (by.get(m) ?? 0) + c.n); }
    const idle = [...by].filter(([m]) => m * 60 % 300 !== 0 && m * 60 > t0 + 120 && m * 60 + 60 < end).map(([, n]) => n).sort((a, b) => a - b); // not a boundary minute, not the start
    return { maxCallsPerMinute: Math.max(0, ...by.values()), medianCallsPerNonBoundaryMinute: idle[Math.floor(idle.length / 2)] ?? null }; };
  const boundaryMinute = (chain, b) => { const list = calls[chain].filter(c => c.t >= b * 1000 && c.t < (b + 60) * 1000);
    return { calls: list.reduce((n, c) => n + c.n, 0), httpRequests: list.length, maxIn10s: Math.max(0, ...list.map(c => list.filter(d => d.t >= c.t && d.t < c.t + 10000).reduce((n, d) => n + d.n, 0))) }; };
  // Per fault: what the keeper's own status lines show from the start of the fault to a minute after its end.
  for (const w of Object.values(windows)) {
    const inside = lines.filter(s => Date.parse(s.at) >= w.from * 1000 && Date.parse(s.at) <= (w.to + 60) * 1000), count = new Map();
    for (const s of inside) for (const code of [...(s.waiting ?? []).map(x => `${x.action ?? x.chain}=${x.wait}`), ...Object.entries(s.chains ?? {}).map(([c, x]) => `chain ${c}=${x.wait}`)]) count.set(code, (count.get(code) ?? 0) + 1);
    Object.assign(w, { keeperWaits: Object.fromEntries(count), keeperSent: inside.flatMap(s => s.sent.map(x => `${s.at} ${x.chain} ${x.action}`)),
      keeperSettledNotConfirmed: inside.flatMap(s => s.settled.filter(x => x.status !== 'confirmed').map(x => `${s.at} ${x.key} ${x.status} fee ${x.feeWei}`)),
      keeperDone: inside.flatMap(s => s.done.map(x => `${s.at} ${x.action} ${x.already}`)), rejected429: calls.horizen.filter(c => c.limited && c.t >= w.from * 1000 && c.t <= w.to * 1000).length });
  }
  const all = [...rounds.values()];
  const summary = { scenario, startedAt: iso(started), stoppedAt: iso(end * 1000), wallClockMinutes: +((end * 1000 - started) / 60000).toFixed(1), forkBlocks: forkBlock, keeperExit: { code: keeper.exitCode, signal: keeper.signalCode },
    statusLines: lines.length, stderrLines: stderr,
    rounds: { created: all.length, opened: all.filter(r => r.openedAt).length, resolved: all.filter(r => r.resolvedAt).length,
      voidedUnopened: all.filter(r => r.voidedAt && !r.openedAt).length, openedVoided: all.filter(r => r.voidedAt && r.openedAt).length,
      resolutionDelays_s: all.filter(r => r.resolvedAt).map(r => `${r.market}@${r.start}: +${r.resolvedAt - r.end}`) },
    boundaries, reasonCodes: [...codes].sort(), revertedKeeperTransactions: lines.flatMap(s => s.settled.filter(x => x.status !== 'confirmed').map(x => `${x.key} ${x.status}`)),
    spend: { keeperBookedWei: last.spentWei, livePricePerGasWei: live, costAtLiveFees: cost, dailyWindow: { from: iso(window.from * 1000), to: iso(window.to * 1000) } },
    rpcLoad: { base: perMinute('base'), horizen: { ...perMinute('horizen'), limited429: calls.horizen.filter(c => c.limited).length },
      boundaryMinutes: boundaries.map(b => ({ boundary: b.boundary_utc, base: boundaryMinute('base', b.boundary), horizen: boundaryMinute('horizen', b.boundary) })) },
    faults: windows, frontRuns, relays: relays.map(({ args: _args, ...r }) => r), streamsRequests: sim.streams.requests.length,
    load: (await readFile(join(OUT, 'load.log'), 'utf8')).trim().split('\n') };
  await writeFile(join(OUT, 'chain.json'), json({ rounds: Object.fromEntries(rounds), publications: baseEvents.map(e => ({ event: e.eventName, ...e.args, time: e.time, from: e.from, tx: e.log.transactionHash })),
    deliveries: cacheEvents.map(e => ({ ...e.args, time: e.time })) }));
  await writeFile(join(OUT, 'streams.json'), json(sim.streams.requests));
  await writeFile(join(OUT, 'summary.json'), json(summary));
  say(`summary: ${join(OUT, 'summary.json')}`);
  for (const b of boundaries) say(`${b.boundary_utc} pub ${b.publications_mined_s} | delivered ${b.delivered_s} | opened ${b.openings_recorded_s} | in window ${b.all_markets_opened_in_window} | resolved ${b.resolutions_s}${b.voids ? ` | voided ${b.voids}` : ''}`);
} catch (error) { say(`harness failed: ${error.stack ?? error.message}`); process.exitCode = 1; }
finally { await cleanup(); harnessLog.end(); }
