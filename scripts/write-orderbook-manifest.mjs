#!/usr/bin/env node
/** Writes the private order book's public manifest (schema 3) from chain reads at one block per chain: the Vela endpoint of
 * the deployment checkpoint, the application's deploy request, its BookClockTrigger, and the custody pair (Base vault and
 * Horizen inbox) of contracts/deployment/custody.json. Refuses anything those do not agree on. No keys, no transactions.
 *
 *   node scripts/write-orderbook-manifest.mjs --rpc https://26514.rpc.thirdweb.com --base-rpc https://base-rpc.publicnode.com \
 *     --checkpoint evidence/vela-mainnet/checkpoint.json --deploy-tx 0x… [--relayer 0x…] [--release NAME] --out FILE \
 *     [--rules public/events/us-house-2026.txt --events-out public/deployments/26514-events.json]
 *
 * Without --relayer it writes the "planned" manifest (its five head fields only, no reads, --release required): the site and the
 * relayer stay closed. The release defaults to orderbook-mainnet-<UTC date of the deploy transaction>. A deployment with an event
 * (docs/cutover-politics.md) also gets the events manifest: its event, resolver and depositsFrom, which the order-book manifest's
 * strict shape cannot carry; --rules must be the file under public/ whose Keccak-256 the deployment committed to.
 * Use the thirdweb gateway or a fork for Horizen, never the operator's Caldera endpoint.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, decodeFunctionData, encodeAbiParameters, hexToString, http, keccak256, parseAbi, parseAbiParameters, parseEventLogs, stringToHex } from 'viem';

const need = (condition, message) => { if (!condition) throw new Error(`write-orderbook-manifest: ${message}`); };
const lower = (value) => String(value).toLowerCase();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const USDCE = '0xdf7108f8b10f9b9ec1aba01cca057268cbf86b6c';
const PARAMS = ['engine', 'applicationFingerprint', 'origin', 'epoch', 'markets', 'stakeLimits', 'chainlink', 'custody', 'event', 'resolver', 'depositsFrom'];
const EVENT_KEYS = ['questionHash', 'start', 'cutoff', 'end', 'voidableAfter'];

/** The engine configuration exactly as the guest stores it (the deploy request's, with the application ID filled in), in its canonical key order. */
export function engineConfigJson(engine, applicationId) {
  const o = engine.oracle;
  return JSON.stringify({
    domain: { chainId: engine.domain.chainId, endpoint: engine.domain.endpoint, applicationId, rulesVersion: engine.domain.rulesVersion },
    authority: engine.authority, collateral: engine.collateral, feeBps: engine.feeBps,
    oracle: { chainId: o.chainId, registry: o.registry, oracle: o.oracle, rulesHash: o.rulesHash, btcFeedId: o.btcFeedId, ethFeedId: o.ethFeedId, decimals: o.decimals,
      observationWindow: o.observationWindow, openingGrace: o.openingGrace, voidGrace: o.voidGrace, cutoffBuffer: o.cutoffBuffer },
  });
}

export function permitDomainSeparator(name, version, chainId, token) {
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
    keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), token]));
}

/** The events manifest of a deployment's constructor parameters, or null for one without an event (the 10-07 application). The event,
 * its resolver and depositsFrom come together; the rules text (the file the site serves, at `rules.path` under public/) must hash to
 * the event's question hash. */
export function eventsManifest(p, { release, applicationId, deployTx, rules }) {
  const extra = Object.keys(p).filter((k) => !PARAMS.includes(k));
  need(extra.length === 0, `unexpected deploy parameters: ${extra.join(', ')}`);
  if (p.event === undefined && p.resolver === undefined && p.depositsFrom === undefined) return null;
  const e = p.event, uint = (x) => Number.isSafeInteger(x) && x > 0;
  need(e && typeof e === 'object' && JSON.stringify(Object.keys(e).sort()) === JSON.stringify([...EVENT_KEYS].sort()), 'the event parameter needs exactly questionHash, start, cutoff, end, voidableAfter');
  need(/^0x[0-9a-f]{64}$/.test(e.questionHash) && EVENT_KEYS.slice(1).every((k) => uint(e[k])) && e.start < e.cutoff && e.cutoff < e.end && e.end < e.voidableAfter && e.voidableAfter < 2 ** 32,
    'the event needs a question hash and times start < cutoff < end < voidableAfter within 32 bits');
  need(e.end % 900 !== 0, 'the event must end off the 900 s grid, or it shares the all-accounts limit with a BTC round');
  need(/^0x[0-9a-f]{40}$/.test(p.resolver ?? '') && !/^0x0{40}$/.test(p.resolver), 'the resolver must be a lowercase address');
  need(![p.stakeLimits.house, p.engine.authority, p.engine.domain.endpoint, p.custody.vault, p.custody.inbox].map(lower).includes(p.resolver), 'the resolver is one of the deployment\'s own roles');
  need(uint(p.depositsFrom), 'a deployment with an event needs depositsFrom, the last inbox index its predecessor processed');
  need(rules && /^\/(?!.*\.\.)[\w./-]+$/.test(rules.path) && keccak256(rules.bytes) === e.questionHash, '--rules must be the file under public/ that hashes to the event\'s question hash');
  return { schemaVersion: 1, kind: 'zedge-events', chainId: 26514, release, application: applicationId, deployTx, resolver: p.resolver, depositsFrom: p.depositsFrom,
    event: { rules: rules.path, questionHash: e.questionHash, start: e.start, cutoff: e.cutoff, end: e.end, voidableAfter: e.voidableAfter } };
}

/** One client and reader per chain, every read at the block taken first. */
export async function chain(url, chainId) {
  const client = createPublicClient({ transport: http(url, { batch: true, retryCount: 0, timeout: 20_000 }) });
  need(await client.getChainId() === chainId, `${url} is not chain ${chainId}`);
  const at = { blockNumber: (await client.getBlock()).number };
  const read = (address, signature, args = []) => client.readContract({ address, abi: parseAbi([`function ${signature}`]), functionName: signature.slice(0, signature.indexOf('(')), args, ...at });
  const code = async (address) => keccak256(await client.getCode({ address, ...at }) ?? '0x');
  const implementation = async (proxy) => lower(`0x${(await client.getStorageAt({ address: proxy, slot: SLOT, ...at })).slice(26)}`);
  return { client, read, code, implementation };
}

/** The custody section from both chains, checked against the custody release. */
export async function custodySection(release, base, horizen) {
  need(release.kind === 'zedge-custody' && release.status === 'deployed', 'contracts/deployment/custody.json is not a deployed custody release');
  const vault = lower(release.base.vault.proxy), inbox = lower(release.horizen.inbox.proxy), usdc = lower(release.base.usdc);
  const [vImpl, iImpl] = await Promise.all([base.implementation(vault), horizen.implementation(inbox)]);
  const [vCode, iCode, vOwner, signer, vInbox, limits, iOwner, iVault, name, version, separator, decimals, symbol] = await Promise.all([
    base.code(vImpl), horizen.code(iImpl), base.read(vault, 'owner() view returns (address)'), base.read(vault, 'signer() view returns (address)'),
    base.read(vault, 'inbox() view returns (address)'), base.read(vault, 'limits() view returns ((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap))'),
    horizen.read(inbox, 'owner() view returns (address)'), horizen.read(inbox, 'vault() view returns (address)'),
    base.read(usdc, 'name() view returns (string)'), base.read(usdc, 'version() view returns (string)'), base.read(usdc, 'DOMAIN_SEPARATOR() view returns (bytes32)'),
    base.read(usdc, 'decimals() view returns (uint8)'), base.read(usdc, 'symbol() view returns (string)')]);
  need(vImpl === lower(release.base.vault.implementation) && lower(vCode) === lower(release.base.vault.implementationCodeHash) &&
    iImpl === lower(release.horizen.inbox.implementation) && lower(iCode) === lower(release.horizen.inbox.implementationCodeHash), 'a custody proxy points at other code than its release');
  need(lower(vInbox) === inbox && lower(iVault) === vault, 'the vault and the inbox do not name each other');
  need(!/^0x0{40}$/.test(signer), 'the vault has no payout signer yet (setSigner first)');
  need(name === 'USD Coin' && version === '2' && decimals === 6 && symbol === 'USDC' && permitDomainSeparator(name, version, 8453, usdc) === separator, 'unexpected Base USDC');
  return { chainId: 8453,
    vault: { address: vault, implementation: vImpl, implementationCodeHash: lower(vCode), owner: lower(vOwner), signer: lower(signer),
      limits: { minDeposit: limits.minDeposit.toString(), maxDeposit: limits.maxDeposit.toString(), maxPayout: limits.maxPayout.toString(), dailyPayoutCap: limits.dailyPayoutCap.toString() } },
    usdc: { address: usdc, symbol, decimals, permit: { name, version, domainSeparator: separator } },
    messenger: { base: lower(release.base.messenger), horizen: lower(release.horizen.messenger), minGasLimit: release.minGasLimit },
    inbox: { address: inbox, implementation: iImpl, implementationCodeHash: lower(iCode), owner: lower(iOwner) },
    eip712: { name: 'ZEDGE Vault', version: '1' } };
}

async function main() {
  const { values: a } = parseArgs({ options: { rpc: { type: 'string' }, 'base-rpc': { type: 'string' }, checkpoint: { type: 'string' }, 'deploy-tx': { type: 'string' },
    custody: { type: 'string', default: new URL('../contracts/deployment/custody.json', import.meta.url).pathname }, relayer: { type: 'string' }, out: { type: 'string' }, release: { type: 'string' },
    rules: { type: 'string' }, 'events-out': { type: 'string' } } });
  need(a.out, '--out is required');
  const head = (release) => ({ schemaVersion: 3, kind: 'zedge-private-orderbook', chainId: 26514, status: a.relayer ? 'configured' : 'planned', release });
  if (a.relayer === undefined) { need(a.release, '--release is required for a planned manifest'); return { manifest: head(a.release), out: a.out }; }
  need(isAddress(a.relayer), '--relayer must be an address');
  need(a.rpc && a['base-rpc'] && a.checkpoint && /^0x[0-9a-fA-F]{64}$/.test(a['deploy-tx'] ?? ''), '--rpc, --base-rpc, --checkpoint and --deploy-tx are required');
  need(!/calderachain/i.test(a.rpc), 'use the thirdweb gateway or a fork: the live operator depends on Caldera');
  const cp = JSON.parse(await readFile(a.checkpoint, 'utf8'));
  const step = (n, label) => { const s = cp.steps[n]; need(s?.label === label, `checkpoint step ${n} is not ${label}`); return s; };
  const endpoint = lower(step(5, 'ProcessorEndpoint').address), authenticator = lower(step(3, 'NoAttestationTeeAuthenticator').address);
  const allowlist = lower(step(4, 'TokenAllowlist').address);
  const streams = JSON.parse(await readFile(new URL('../public/deployments/26514.json', import.meta.url), 'utf8'));
  const registry = lower(streams.contracts.registry.address);
  const [hz, base] = await Promise.all([chain(a.rpc, cp.chainId), chain(a['base-rpc'], 8453)]);
  const { read, code } = hz;

  // The application: its deploy request names the trigger and carries the guest parameters; DeployRequestSubmitted names the ID.
  const tx = await hz.client.getTransaction({ hash: a['deploy-tx'] });
  const receipt = await hz.client.getTransactionReceipt({ hash: a['deploy-tx'] });
  need(lower(tx.to) === endpoint && receipt.status === 'success', 'the deploy transaction is not a successful call to the checkpoint endpoint');
  const call = decodeFunctionData({ abi: parseAbi(['function submitDeployRequestWithTrigger(uint8, bytes, address)']), data: tx.input });
  const trigger = lower(call.args[2]);
  const [submitted] = parseEventLogs({ abi: parseAbi(['event DeployRequestSubmitted(uint64 indexed applicationId, bytes32 requestId, address indexed sender)']),
    logs: receipt.logs.filter((l) => lower(l.address) === endpoint) });
  need(submitted, 'no DeployRequestSubmitted in the deploy transaction');
  const applicationId = submitted.args.applicationId.toString();
  const description = JSON.parse(hexToString(call.args[1]));
  const p = description.constructorParams, engine = p.engine;

  const custodyRelease = JSON.parse(await readFile(a.custody, 'utf8'));
  const [codes, domain, typehash, minFee, maxQueue, operator, tee, list, root, bound, owner, signer, enclaveKey, tEndpoint, tRegistry, tInbox, tAsset, tDuration, tOwner, tImpl, custody] = await Promise.all([
    Promise.all([endpoint, authenticator, allowlist].map(code)),
    read(endpoint, 'eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])'),
    read(endpoint, 'REQUEST_AUTHORIZATION_TYPEHASH() view returns (bytes32)'), read(endpoint, 'minFeePerRequest() view returns (uint256)'),
    read(endpoint, 'maxQueueSize() view returns (uint256)'), read(endpoint, 'feeCollector() view returns (address)'),
    read(endpoint, 'teeAuthenticator() view returns (address)'), read(endpoint, 'tokenAllowlist() view returns (address)'),
    read(endpoint, 'applicationStateRoots(uint64) view returns (bytes32)', [BigInt(applicationId)]), read(endpoint, 'triggerContracts(uint64) view returns (address)', [BigInt(applicationId)]),
    read(authenticator, 'owner() view returns (address)'), read(authenticator, 'getTeeSigner() view returns (address)'), read(authenticator, 'getPubSecp521r1() view returns (bytes)'),
    read(trigger, 'processorEndpoint() view returns (address)'), read(trigger, 'registry() view returns (address)'), read(trigger, 'inbox() view returns (address)'),
    read(trigger, 'asset() view returns (uint8)'), read(trigger, 'duration() view returns (uint32)'), read(trigger, 'owner() view returns (address)'), hz.implementation(trigger),
    custodySection(custodyRelease, base, hz),
  ]);
  need(lower(tee) === authenticator && lower(list) === allowlist && lower(bound) === trigger && root !== `0x${'0'.repeat(64)}`, 'endpoint bindings do not match the checkpoint and the deploy request');
  need(domain[1] === 'Vela' && domain[2] === '0' && domain[3] === 26514n && lower(domain[4]) === endpoint, 'unexpected endpoint EIP-712 domain');
  need(lower(tEndpoint) === endpoint && lower(tRegistry) === registry && lower(tInbox) === custody.inbox.address && tAsset === 0 && tDuration === 900, 'trigger bindings do not match');
  need(lower(operator) === lower(cp.manager), 'the fee collector is not the checkpoint manager');
  need(lower(tx.from) === lower(cp.deployer), 'the deploy request was not sent by the checkpoint deployer');
  need(description.wasmSha256 === p.applicationFingerprint && /^[0-9a-f]{64}$/.test(p.applicationFingerprint), 'wasm fingerprint mismatch');
  need(engine.domain.chainId === 26514 && lower(engine.domain.endpoint) === endpoint && engine.domain.applicationId === '' && lower(engine.authority) === trigger &&
    lower(engine.collateral) === USDCE && engine.feeBps === 0 && lower(engine.oracle.registry) === registry && engine.oracle.rulesHash === streams.parameters.rulesHash &&
    lower(engine.oracle.oracle) === lower(streams.contracts.oracle.address), 'the engine configuration does not match the endpoint and the streams manifest');
  need(JSON.stringify(p.markets) === JSON.stringify([{ asset: 'BTC', duration: 900 }]), 'unexpected markets');
  const k = p.custody;
  need(k?.chainId === 8453 && lower(k.vault) === custody.vault.address && lower(k.inbox) === custody.inbox.address && lower(k.usdc) === custody.usdc.address, 'the guest custody parameter does not name the custody release');
  need(p.chainlink?.feedId === engine.oracle.btcFeedId && Array.isArray(p.chainlink.configs), 'unexpected chainlink parameter');
  const config = engineConfigJson(engine, applicationId);
  const release = a.release ?? `orderbook-mainnet-${new Date(Number((await hz.client.getBlock({ blockNumber: receipt.blockNumber })).timestamp) * 1000).toISOString().slice(0, 10)}`;
  const publicDir = new URL('../public/', import.meta.url).pathname;
  const rules = a.rules && { path: `/${relative(publicDir, resolve(a.rules))}`, bytes: await readFile(a.rules) };
  need(!rules || !rules.path.startsWith('/..'), '--rules must be a file under public/ (the site serves it)');
  const events = eventsManifest(p, { release, applicationId, deployTx: lower(a['deploy-tx']), rules });
  need(Boolean(events) === Boolean(a['events-out']), events ? '--events-out is required: this deployment has an event' : '--events-out is only for a deployment with an event');

  const manifest = { ...head(release),
    endpoint: { address: endpoint, runtimeCodeHash: codes[0], eip712: { name: 'Vela', version: '0' }, requestTypehash: typehash, protocolVersion: 0,
      minFeePerRequestWei: minFee.toString(), maxQueueSize: maxQueue.toString(), operator: lower(operator) },
    authenticator: { address: authenticator, runtimeCodeHash: codes[1], owner: lower(owner), teeSigner: lower(signer), enclavePublicKey: lower(enclaveKey) },
    tokenAllowlist: { address: allowlist, runtimeCodeHash: codes[2] },
    trigger: { address: trigger, implementation: tImpl, implementationCodeHash: lower(await code(tImpl)), owner: lower(tOwner), registry, inbox: custody.inbox.address, asset: 0, duration: 900 },
    application: { id: applicationId, wasmSha256: p.applicationFingerprint, origin: p.origin, epoch: p.epoch, engineConfigJson: config, sessionRulesHash: sha256(config),
      markets: p.markets, house: lower(p.stakeLimits.house),
      stakeLimits: { account: String(p.stakeLimits.account), boundary: String(p.stakeLimits.boundary), houseTotal: String(p.stakeLimits.houseTotal) },
      deployTx: lower(a['deploy-tx']), deployBlock: Number(receipt.blockNumber),
      chainlink: { feedId: p.chainlink.feedId, configs: p.chainlink.configs.map((c) => ({ digest: lower(c.digest), f: c.f, signers: c.signers.map(lower) })) } },
    custody,
    relayer: { path: '/api/relay', facilitator: lower(a.relayer) },
  };
  return { manifest, out: a.out, events, eventsOut: a['events-out'] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { manifest, out, events, eventsOut } = await main();
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
  if (events) { await writeFile(eventsOut, `${JSON.stringify(events, null, 2)}\n`); console.log(`wrote ${eventsOut}: event ${events.event.questionHash}, resolver ${events.resolver}, depositsFrom ${events.depositsFrom}`); }
  console.log(`wrote ${out}: ${manifest.status}${manifest.application ? `, application ${manifest.application.id}, rules ${manifest.application.sessionRulesHash}, vault ${manifest.custody.vault.address}` : ''}`);
}
