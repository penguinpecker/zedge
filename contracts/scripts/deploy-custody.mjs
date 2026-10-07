#!/usr/bin/env node
/** Plans, rehearses and, on the owner's go, deploys ZEDGE custody: HorizenDepositInbox on Horizen and BaseCustodyVault on
 * Base, each an implementation plus an ERC1967Proxy created by the deployer, at addresses fixed by its nonce on each chain.
 *   node contracts/scripts/deploy-custody.mjs --plan [--signer 0x…]
 *        reads both deployer nonces (public RPCs, no keys) and writes deployment/custody.json, status planned. Without
 *        --signer the vault starts with no payout signer (payouts halted until the owner calls setSigner); plan again
 *        with --signer once the payout signer's key exists: the addresses depend only on the nonces
 *   node contracts/scripts/deploy-custody.mjs --rehearsal --base-fork http://127.0.0.1:P --horizen-fork http://127.0.0.1:Q
 *        the planned creations on two loopback Anvil forks of the live chains, deployer impersonated; writes nothing
 *   node contracts/scripts/deploy-custody.mjs --broadcast-mainnet
 *        the planned creations for real (the key is read by loadAccount from the local 0600 file, never printed) and
 *        records them in deployment/custody.json. Only with the owner's explicit go.
 * Order: the inbox on Horizen first (it names the planned vault), then the vault on Base (it names the inbox). Lane B's
 * order-book trigger names the planned inbox, so custody goes before it on Horizen. A creation whose address already holds
 * the expected code is skipped: a run that stopped part-way is simply run again.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256, parseAbi, toHex } from 'viem';
import { CONTRACTS, json, loadArtifacts, parseArguments } from './preflight-hybrid.mjs';
import { runtimeCode } from './plan-registry.mjs';
import { loadAccount } from './broadcast-hybrid.mjs';

export const DEPLOYER = '0x279173ac297ad146bc92f877552c8c2b78334d07';
export const RELEASE = resolve(CONTRACTS, 'deployment/custody.json');
const RPC = { base: 'https://base-rpc.publicnode.com', horizen: 'https://26514.rpc.thirdweb.com' };
const CHAIN = { base: 8453, horizen: 26514 };
// Owner-adjustable later with setLimits. 1-500 USDC per deposit, 1,000 per payout, 10,000 of payouts a day.
export const LIMITS = { minDeposit: 1_000_000n, maxDeposit: 500_000_000n, maxPayout: 1_000_000_000n, dailyPayoutCap: 10_000_000_000n };
// Fee caps in wei per gas and a hard ceiling per chain for the two creations (about 2.3 M gas on Base, 1.5 M on Horizen).
const FEES = { base: { tip: 1_000_000n, max: 100_000_000n, ceiling: 300_000_000_000_000n }, horizen: { tip: 1_000_000n, max: 3_000_000n, ceiling: 20_000_000_000_000n } };
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const VIEW = parseAbi(['function owner() view returns (address)', 'function vault() view returns (address)', 'function inbox() view returns (address)',
  'function signer() view returns (address)', 'function limits() view returns ((uint128 minDeposit, uint128 maxDeposit, uint128 maxPayout, uint128 dailyPayoutCap))']);
const lower = (x) => String(x).toLowerCase();
const demand = (ok, reason) => { if (!ok) throw new Error(`deploy-custody: ${reason}`); };

/** The four creations, rebuilt from the deployer's nonce on each chain, the signer and the build alone. */
export function creations(artifacts, nonces, signer) {
  const at = (chain, k) => lower(getContractAddress({ from: DEPLOYER, nonce: BigInt(nonces[chain] + k) }));
  const inboxImpl = at('horizen', 0), inbox = at('horizen', 1), vaultImpl = at('base', 0), vault = at('base', 1);
  const proxy = (implementation, abi, functionName, args) => encodeDeployData({ abi: artifacts.ERC1967Proxy.abi, bytecode: artifacts.ERC1967Proxy.bytecode.object,
    args: [implementation, encodeFunctionData({ abi, functionName, args })] });
  return [
    { chain: 'horizen', name: 'HorizenDepositInbox', address: inboxImpl, data: artifacts.HorizenDepositInbox.bytecode.object, code: runtimeCode(artifacts.HorizenDepositInbox, inboxImpl) },
    { chain: 'horizen', name: 'ERC1967Proxy', address: inbox, implementation: inboxImpl, code: runtimeCode(artifacts.ERC1967Proxy, inbox),
      data: proxy(inboxImpl, artifacts.HorizenDepositInbox.abi, 'initialize', [DEPLOYER, vault]) },
    { chain: 'base', name: 'BaseCustodyVault', address: vaultImpl, data: artifacts.BaseCustodyVault.bytecode.object, code: runtimeCode(artifacts.BaseCustodyVault, vaultImpl) },
    { chain: 'base', name: 'ERC1967Proxy', address: vault, implementation: vaultImpl, code: runtimeCode(artifacts.ERC1967Proxy, vault),
      data: proxy(vaultImpl, artifacts.BaseCustodyVault.abi, 'initialize', [DEPLOYER, signer, inbox, LIMITS]) },
  ];
}

/** The release record: what --plan writes and --broadcast-mainnet completes. */
export function release(list, nonces, signer, status, blocks, hashes = {}) {
  const [inboxImpl, inbox, vaultImpl, vault] = list;
  const entry = (impl, proxy) => ({ proxy: proxy.address, implementation: impl.address, implementationCodeHash: keccak256(impl.code), proxyCodeHash: keccak256(proxy.code),
    ...(hashes[impl.address] ? { transactions: [hashes[impl.address], hashes[proxy.address]] } : {}) });
  return { schemaVersion: 1, kind: 'zedge-custody', status, deployer: DEPLOYER, owner: DEPLOYER, signer: lower(signer),
    plannedFrom: { base: { nonce: nonces.base, block: blocks.base }, horizen: { nonce: nonces.horizen, block: blocks.horizen } },
    limits: Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, v.toString()])), eip712: { name: 'ZEDGE Vault', version: '1' }, minGasLimit: 100000,
    base: { chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', messenger: '0x9f5e33f901ad50b50d6a27f63adabea4c81e953c', vault: entry(vaultImpl, vault) },
    horizen: { chainId: 26514, messenger: '0x4200000000000000000000000000000000000007', inbox: entry(inboxImpl, inbox) } };
}

/** Both proxies point at their implementations and name each other, the owner, the signer and the limits. */
async function verify(clients, list, signer) {
  const [inboxImpl, inbox, vaultImpl, vault] = list;
  for (const c of list) demand(lower(keccak256(await clients[c.chain].getCode({ address: c.address }))) === lower(keccak256(c.code)), `${c.chain} ${c.name} at ${c.address}: unexpected code`);
  const read = (chain, address, functionName) => clients[chain].readContract({ address, abi: VIEW, functionName });
  const slot = async (chain, address) => lower(`0x${(await clients[chain].getStorageAt({ address, slot: SLOT })).slice(26)}`);
  demand(await slot('horizen', inbox.address) === inboxImpl.address && await slot('base', vault.address) === vaultImpl.address, 'a proxy points elsewhere');
  demand(lower(await read('horizen', inbox.address, 'owner')) === DEPLOYER && lower(await read('base', vault.address, 'owner')) === DEPLOYER, 'unexpected owner');
  demand(lower(await read('horizen', inbox.address, 'vault')) === vault.address && lower(await read('base', vault.address, 'inbox')) === inbox.address, 'the proxies do not name each other');
  demand(lower(await read('base', vault.address, 'signer')) === lower(signer), 'unexpected signer');
  const l = await read('base', vault.address, 'limits');
  demand(Object.entries(LIMITS).every(([k, v]) => l[k] === v), 'unexpected limits');
}

async function main(args) {
  const o = parseArguments(args, ['--plan', '--broadcast-mainnet'], ['--signer', '--base-fork', '--horizen-fork']);
  const modes = [o.plan, o['broadcast-mainnet'], o['base-fork'] || o['horizen-fork']].filter(Boolean).length;
  demand(modes === 1 && (o.signer === undefined || o.plan) && (!(o['base-fork'] || o['horizen-fork']) || (o['base-fork'] && o['horizen-fork'])), 'choose --plan, --broadcast-mainnet or both --base-fork and --horizen-fork');
  const rehearsal = Boolean(o['base-fork']);
  const url = rehearsal ? { base: o['base-fork'], horizen: o['horizen-fork'] } : RPC;
  const clients = Object.fromEntries(Object.entries(url).map(([chain, u]) => [chain, createPublicClient({ transport: http(u, { timeout: 20_000, retryCount: 1 }) })]));
  for (const chain of ['base', 'horizen']) {
    demand(await clients[chain].getChainId() === CHAIN[chain], `${chain}: wrong chain`);
    if (rehearsal) {
      demand(/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(url[chain]), '--base-fork and --horizen-fork take loopback URLs');
      demand(/anvil/i.test(await clients[chain].request({ method: 'web3_clientVersion' })), `${chain}: the rehearsal endpoint is not Anvil`);
    }
  }
  const artifacts = await loadArtifacts(resolve(CONTRACTS, 'out'), ['BaseCustodyVault', 'HorizenDepositInbox', 'ERC1967Proxy']);
  const nonceOf = async (chain) => clients[chain].getTransactionCount({ address: DEPLOYER, blockTag: 'pending' });

  if (o.plan) {
    o.signer ??= `0x${'0'.repeat(40)}`;
    demand(/^0x[0-9a-fA-F]{40}$/.test(o.signer), '--signer takes an address');
    const nonces = { base: await nonceOf('base'), horizen: await nonceOf('horizen') };
    const blocks = { base: Number(await clients.base.getBlockNumber()), horizen: Number(await clients.horizen.getBlockNumber()) };
    const list = creations(artifacts, nonces, o.signer);
    for (const c of list) demand((await clients[c.chain].getCode({ address: c.address }) ?? '0x') === '0x', `${c.address} already has code`);
    const record = release(list, nonces, o.signer, 'planned', blocks);
    await writeFile(RELEASE, `${json(record)}\n`);
    console.log(json({ wrote: 'contracts/deployment/custody.json', vault: record.base.vault.proxy, inbox: record.horizen.inbox.proxy, nonces }));
    return;
  }

  const planned = JSON.parse(await readFile(RELEASE, 'utf8'));
  demand(planned.kind === 'zedge-custody' && planned.status === 'planned', 'deployment/custody.json is not a planned custody release');
  const nonces = { base: planned.plannedFrom.base.nonce, horizen: planned.plannedFrom.horizen.nonce };
  const list = creations(artifacts, nonces, planned.signer);
  const expected = release(list, nonces, planned.signer, 'planned', { base: planned.plannedFrom.base.block, horizen: planned.plannedFrom.horizen.block });
  demand(JSON.stringify(expected) === JSON.stringify(planned), 'the build or the plan changed since custody.json was written: plan again');
  const account = rehearsal ? null : await loadAccount(DEPLOYER);
  if (rehearsal) for (const chain of ['base', 'horizen']) await clients[chain].request({ method: 'anvil_impersonateAccount', params: [DEPLOYER] });
  const hashes = {}, spent = { base: 0n, horizen: 0n };
  for (const [i, c] of list.entries()) {
    const client = clients[c.chain], have = await client.getCode({ address: c.address }) ?? '0x';
    if (have !== '0x') { demand(keccak256(have) === keccak256(c.code), `${c.address} holds other code`); console.log(json({ step: i, name: c.name, chain: c.chain, address: c.address, status: 'already there' })); continue; }
    const nonce = nonces[c.chain] + (i % 2);
    demand(await nonceOf(c.chain) === nonce, `${c.chain}: the deployer nonce is not the planned ${nonce}: plan again`);
    const gas = (await client.estimateGas({ account: DEPLOYER, data: c.data })) * 12n / 10n;
    const block = await client.getBlock(), fee = FEES[c.chain], maxFeePerGas = 2n * (block.baseFeePerGas ?? 0n) + fee.tip;
    demand(maxFeePerGas <= fee.max, `${c.chain}: fees above the cap`);
    spent[c.chain] += gas * maxFeePerGas;
    demand(spent[c.chain] <= fee.ceiling, `${c.chain}: the creations would cost more than the ceiling`);
    const tx = { chainId: CHAIN[c.chain], type: 'eip1559', nonce, data: c.data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: fee.tip };
    const hash = rehearsal
      ? await client.request({ method: 'eth_sendTransaction', params: [{ from: DEPLOYER, data: c.data, nonce: toHex(nonce), gas: toHex(gas), maxFeePerGas: toHex(maxFeePerGas), maxPriorityFeePerGas: toHex(fee.tip), type: '0x2' }] })
      : await client.request({ method: 'eth_sendRawTransaction', params: [await account.signTransaction(tx)] });
    if (rehearsal) await client.request({ method: 'evm_mine', params: [] }).catch(() => {});
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    demand(receipt.status === 'success' && lower(receipt.contractAddress) === c.address, `${c.name} on ${c.chain}: creation failed`);
    hashes[c.address] = hash;
    console.log(json({ step: i, name: c.name, chain: c.chain, address: c.address, hash, gasUsed: receipt.gasUsed }));
  }
  await verify(clients, list, planned.signer);
  if (!rehearsal) await writeFile(RELEASE, `${json(release(list, nonces, planned.signer, 'deployed', { base: planned.plannedFrom.base.block, horizen: planned.plannedFrom.horizen.block }, hashes))}\n`);
  console.log(json({ status: rehearsal ? 'rehearsed' : 'deployed', vault: list[3].address, inbox: list[1].address }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(String(error?.message ?? error).slice(0, 400)); process.exitCode = 1; });
}
