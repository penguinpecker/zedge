#!/usr/bin/env node
/** Writes the website's mainnet manifest public/deployments/26514.json (schema 3) from the committed release and
 * profile only: no RPC, no keys. Run it after contracts/scripts/write-release.mjs changes the release:
 *   node scripts/write-deployment-manifest.mjs
 * src/chain/streams.test.ts fails while the committed manifest differs from this output, so the two cannot drift.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const STATUS = { planned: 'planned', deployed: 'configured' };
const CONTRACTS = { registry: 'StreamsRoundRegistry', oracle: 'HorizenStreamsOracle', publisher: 'BaseStreamsPublisher', sourceOracle: 'ChainlinkStreamsBoundaryOracle' };
const need = (condition, message) => { if (!condition) throw new Error(message); };

/** release: parsed contracts/deployment/mainnet-addresses.json. profileText: exact text of hybrid-mainnet.json. Key order is the file format. */
export function deploymentManifest(release, profileText) {
  need(release.schemaVersion === 2 && Object.hasOwn(STATUS, release.status), 'Unsupported release format or status');
  need(release.configHash === keccak256(toHex(profileText)), 'The release was written for a different profile');
  const profile = JSON.parse(profileText);
  const chainId = (chain) => { need(Object.hasOwn(profile.chains, chain), `Unknown chain ${chain}`); return profile.chains[chain].chainId; };
  const contract = (name) => {
    const found = release.contracts.filter((entry) => entry.name === name);
    need(found.length === 1 && found[0].chainId === chainId(found[0].chain), `${name}: missing, repeated or on the wrong chain`);
    return found[0];
  };
  const pin = ({ chainId, address, runtimeCodeHash }) => ({ chainId, address, runtimeCodeHash });
  const registry = contract(CONTRACTS.registry);
  need(registry.proxy, 'The registry record has no proxy section');
  const { rules, feeds } = profile;
  return {
    schemaVersion: 3, chainId: chainId('horizen'), status: STATUS[release.status], release: release.release,
    rolePolicy: 'registry-owner-upgradeable-route-immutable', sourceChainId: chainId('base'),
    rpcUrls: { base: profile.chains.base.rpcUrl, horizen: profile.chains.horizen.rpcUrl },
    contracts: {
      registry: { ...pin(registry), implementation: registry.proxy.implementation, implementationCodeHash: registry.proxy.implementationCodeHash, owner: registry.proxy.owner },
      oracle: pin(contract(CONTRACTS.oracle)), publisher: pin(contract(CONTRACTS.publisher)), sourceOracle: pin(contract(CONTRACTS.sourceOracle)),
    },
    dependencies: Object.fromEntries(Object.entries(profile.dependencies).map(([name, d]) => [name, { chainId: chainId(d.chain), address: d.address, runtimeCodeHash: d.codeHash }])),
    bindings: profile.bindings,
    parameters: {
      observationWindow: String(rules.observationWindow), openingGrace: String(rules.openingGrace), voidGrace: String(rules.voidGrace),
      cutoffBuffer: String(rules.cutoffBuffer), minimumGasLimit: String(rules.minimumGasLimit),
      btcFeedId: feeds.btcFeedId, ethFeedId: feeds.ethFeedId, btcDecimals: feeds.btcDecimals, ethDecimals: feeds.ethDecimals,
      collateralDecimals: 6, routeHash: release.routeHash, rulesHash: release.rulesHash,
    },
  };
}

export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = JSON.parse(await readFile(file('contracts/deployment/mainnet-addresses.json'), 'utf8'));
    const manifest = deploymentManifest(release, await readFile(file('contracts/deployment/hybrid-mainnet.json'), 'utf8'));
    await writeFile(file('public/deployments/26514.json'), manifestText(manifest));
    console.log(JSON.stringify({ output: 'public/deployments/26514.json', status: manifest.status, release: manifest.release, registry: manifest.contracts.registry.address }, null, 2));
  } catch (error) {
    console.error(`Manifest not written: ${String(error?.message).slice(0, 400)}`);
    process.exitCode = 1;
  }
}
