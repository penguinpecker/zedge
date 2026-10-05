#!/usr/bin/env node
/** Broadcast exactly the fresh, simulated two-transaction registry plan written by plan-registry.mjs, and only
 * while the committed release (deployment/mainnet-addresses.json) names exactly what that plan creates.
 *   node contracts/scripts/broadcast-registry.mjs --broadcast-mainnet    real Horizen transactions
 *   node contracts/scripts/broadcast-registry.mjs --resume-mainnet       continue from the checkpoint. A recorded transaction is
 *        verified on chain; only one the chain never received (the deployer nonce is still its nonce) is signed
 *        again, to the identical bytes and hash, and sent
 *   node contracts/scripts/broadcast-registry.mjs --rehearsal <url> --evidence <directory> [--resume]
 * Nothing is written before the first signature: a run refused earlier leaves no checkpoint and is simply started again.
 * The mainnet modes read the deployer key from the local ignored 0600 file, never arguments, output or
 * artifacts, and require the owner's deployment authorization separately from this mechanical flag.
 * A rehearsal runs the same steps against a local Anvil fork by impersonating the deployer address: no key
 * file is opened and nothing is signed. The fork must mine on its own (anvil --block-time 2).
 */
import { constants } from 'node:fs';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import {
  CONTRACTS, RPCS, json, shown, parseArguments, anvilFork, loadArtifacts, recheckPublicDependencies,
} from './preflight-hybrid.mjs';
import {
  validateConstructorIntent, demandFreshPlan, demandSigningAge, validateRecoveryCheckpoint, transactionFor,
  feeUpperBound, verifyRecordedTransaction, waitForCanonicalRecordedTransaction, loadAccount,
} from './broadcast-hybrid.mjs';
import {
  NAMES, PLAN_STATUS, BROADCAST_STATUS, CONFIG, RELEASE, rehearsalFiles, registryCreation, expectedRegistry, verifyRegistry,
  differsFromRelease, exists,
} from './plan-registry.mjs';

const CHAIN_ID = 26514;
const CEILING = 120000000000000n;
const WINDOW = 'the signing window has passed (five minutes from the plan for the first creation, fifteen minutes from the start of the run for the second)';
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** A refusal raised by this file: its text is public by construction and may be printed. */
class Refusal extends Error {}
const demand = (condition, reason) => { if (!condition) throw new Refusal(reason); };
let phase = 'argument validation';
let rehearsing = false;

/** No arguments never broadcasts. Mainnet needs exactly one explicit mainnet flag; a rehearsal needs a loopback fork. */
export function parseOptions(args) {
  let options;
  try { options = parseArguments(args, ['--broadcast-mainnet', '--resume-mainnet', '--resume'], ['--rehearsal', '--evidence']); }
  catch (error) { throw new Refusal(error.message); }
  const mainnet = [options['broadcast-mainnet'], options['resume-mainnet']].filter(Boolean).length;
  if (options.rehearsal !== undefined) demand(mainnet === 0, 'choose a rehearsal or mainnet, not both');
  else demand(mainnet === 1 && !options.resume, 'refusing to start: a real broadcast needs exactly --broadcast-mainnet or --resume-mainnet');
  let files;
  try { files = rehearsalFiles(options); } catch (error) { throw new Refusal(error.message); }
  return { rehearsal: options.rehearsal, resume: Boolean(options.resume || options['resume-mainnet']), files };
}

/** Accept only the exact plan the planner simulated, rebuilt here from the reviewed profile and the deployer nonce,
 *  and only while the committed release names exactly the registry that plan creates. */
export function validatePlan({ plan, config, configText, artifacts, release, rehearsal, resume }) {
  demand(plan.schemaVersion === 1 && plan.status === PLAN_STATUS, 'the plan is not a simulated registry plan');
  demand(plan.noLiveTransactions === true && plan.simulation?.performed === true && plan.simulation.chainStateOverridden === false
    && plan.simulation.balancesOverridden === false && plan.simulation.generatedWalletAccounts === 0, 'the plan was not simulated on unmodified deployer state');
  demand(eq(plan.configHash, keccak256(toHex(configText))) && eq(plan.deployer, config.deployer) && plan.expiresAfterSeconds === 300,
    'the plan was made for a different profile');
  demand(plan.chains?.horizen?.chainId === CHAIN_ID && config.chains.horizen.chainId === CHAIN_ID && eq(config.chains.horizen.rpcUrl, RPCS.horizen),
    'the plan or the profile names another chain');
  demand(plan.rehearsal === (rehearsal !== undefined) && plan.chains.horizen.publicRpcUrl === (rehearsal ?? RPCS.horizen),
    rehearsal ? 'a rehearsal accepts only a plan made against the same fork' : 'a real broadcast accepts only a plan made against Horizen mainnet');
  if (!resume) {
    try { demandFreshPlan(plan); }
    catch { throw new Refusal('the plan is older than five minutes (or from the future): run plan-registry.mjs again'); }
  }
  const budget = plan.budgets?.horizen;
  demand(budget && BigInt(budget.approvedCeilingWei) === BigInt(config.maximumSpendWei.horizen) && BigInt(budget.approvedCeilingWei) > 0n
    && BigInt(budget.approvedCeilingWei) <= CEILING && BigInt(budget.maximumEstimatedWei) > 0n
    && BigInt(budget.maximumEstimatedWei) <= BigInt(budget.approvedCeilingWei), 'the planned cost is outside the approved spend ceiling');
  const creation = registryCreation(config, plan.deployer, plan.chains.horizen.nonce, artifacts.StreamsRoundRegistry.abi);
  const expected = expectedRegistry(creation, artifacts);
  demand(eq(plan.predicted?.implementation, creation.implementation) && eq(plan.predicted.proxy, creation.proxy)
    && eq(plan.owner, creation.owner) && eq(plan.rulesHash, creation.rulesHash), 'the planned addresses, owner or rules differ from the reviewed profile');
  // The reviewed record, not the build output or the profile on disk, decides what may be created. There is no
  // flag past this: a change is made by regenerating the release (write-release.mjs) and having it reviewed.
  const { changed, moved } = differsFromRelease(release, expected, artifacts, configText);
  demand(changed.length + moved.length === 0, `the committed release does not name what this plan creates (${[...changed, ...moved].join(', ')}): `
    + 'the profile, the build or the deployer nonce changed since it was reviewed');
  demand(resume || release.status === 'planned', 'the committed release is not planned any more: this deployment is already recorded');
  demand(Array.isArray(plan.intents) && plan.intents.length === NAMES.length, 'the plan must hold exactly two creations');
  for (const [i, intent] of plan.intents.entries()) {
    demand(intent.name === NAMES[i] && intent.chain === 'horizen' && intent.chainId === CHAIN_ID && eq(intent.from, plan.deployer)
      && BigInt(intent.value) === 0n, `${NAMES[i]}: unexpected creation identity`);
    demand(Number.isSafeInteger(intent.nonce) && intent.nonce === plan.chains.horizen.nonce + i
      && eq(intent.predictedAddress, i === 0 ? creation.implementation : creation.proxy), `${intent.name}: nonce or CREATE address mismatch`);
    demand(intent.artifactPath === `contracts/out/${intent.name}.sol/${intent.name}.json`
      && eq(keccak256(artifacts[intent.name].bytecode.object), intent.creationBytecodeHash), `${intent.name}: the build artifact changed since the plan`);
    // Integer arguments survive JSON as decimal strings; viem validates their ABI ranges.
    try { validateConstructorIntent(intent, artifacts[intent.name], creation.constructorArgs[i]); }
    catch { throw new Refusal(`${intent.name}: creation data differs from the reviewed profile`); }
    demand(eq(intent.simulatedRuntimeHash, i === 0 ? expected.implementationCodeHash : expected.proxyCodeHash) && intent.checksPassed === true,
      `${intent.name}: simulated runtime differs from the build artifact`);
    demand(BigInt(intent.simulatedGas) > 0n && BigInt(intent.gasLimit) >= BigInt(intent.simulatedGas) && BigInt(intent.gasLimit) <= 8000000n
      && BigInt(intent.maxFeePerGas) > 0n && BigInt(intent.maxPriorityFeePerGas) >= 0n && BigInt(intent.maxPriorityFeePerGas) <= BigInt(intent.maxFeePerGas)
      && BigInt(intent.fees.maximumEstimatedWei) >= BigInt(intent.gasLimit) * BigInt(intent.maxFeePerGas), `${intent.name}: gas or fee bounds are inconsistent`);
  }
  return expected;
}

/** The one place the two modes differ. Mainnet: load the key, sign locally, send the raw bytes. Rehearsal: Anvil
 *  accepts the same unsigned transaction from the impersonated deployer; loadAccount and sendRaw are never touched. */
export async function makeSigner({ rehearsal, client, deployer, loadAccount, sendRaw }) {
  if (rehearsal !== undefined) {
    await client.request({ method: 'anvil_impersonateAccount', params: [deployer] });
    return async transaction => ({ send: () => client.request({ method: 'eth_sendTransaction', params: [{ from: deployer, data: transaction.data,
      value: '0x0', nonce: toHex(transaction.nonce), gas: toHex(transaction.gas), maxFeePerGas: toHex(transaction.maxFeePerGas),
      maxPriorityFeePerGas: toHex(transaction.maxPriorityFeePerGas), type: '0x2' }] }) });
  }
  const account = await loadAccount(deployer);
  return async transaction => {
    const signed = await account.signTransaction(transaction);
    // Only the deterministic public hash is persisted. Signed bytes and signing material stay in memory.
    return { hash: keccak256(signed), send: () => sendRaw(signed) };
  };
}

/** The whole flow, identical for mainnet and rehearsal apart from makeSigner. Every chain and file access is
 *  passed in, so this function can never reach an endpoint or a key that its caller did not hand it. */
export async function broadcast({ options, plan, planText, config, configText, artifacts, release, client, quotes, recheck, loadAccount, sendRaw, log = console.log }) {
  const { rehearsal, resume, files } = options;
  phase = 'public plan validation';
  const expected = validatePlan({ plan, config, configText, artifacts, release, rehearsal, resume });
  const intents = plan.intents; const start = plan.chains.horizen.nonce; const ceiling = BigInt(config.maximumSpendWei.horizen);
  if (!resume) {
    phase = 'recovery checkpoint check';
    demand(!await exists(files.checkpoint), `a checkpoint exists (${shown(files.checkpoint)}): this plan was already signed for; continue with ${rehearsal === undefined ? '--resume-mainnet' : '--resume'}`);
  }
  phase = 'public dependency validation';
  await recheck();
  const planHash = keccak256(toHex(planText));
  let confirmed = 0; let spent = 0n; let runStartedAt = Date.now(); let checkpoint;
  if (resume) {
    phase = 'frozen recovery checkpoint validation';
    checkpoint = JSON.parse(await readFile(files.checkpoint, 'utf8'));
    demand(checkpoint.rehearsal === (rehearsal !== undefined), 'the checkpoint belongs to the other mode');
    try { runStartedAt = validateRecoveryCheckpoint(checkpoint, plan, planHash); }
    catch { throw new Refusal(`the checkpoint does not continue this plan, or ${WINDOW}`); }
  } else {
    checkpoint = { schemaVersion: 1, status: 'prepared', rehearsal: rehearsal !== undefined, startedAt: new Date(runStartedAt).toISOString(),
      planHash, deployer: plan.deployer, transactions: [] };
  }
  // A fresh run writes its checkpoint for the first time with its first signed entry in it, exclusively: a run
  // refused before any signature leaves nothing behind, and two runs can never both reach a send.
  let written = resume;
  const save = async () => {
    const path = written ? `${files.checkpoint}.${process.pid}.next` : files.checkpoint;
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${json(checkpoint)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    if (written) await rename(path, files.checkpoint);
    written = true;
  };
  // Budget using the conservative bound, rather than assuming all rollup fees appear in receipt fields.
  const settle = async (intent, entry, verified) => {
    entry.receipt = verified.receipt; entry.runtimeCodeHash = verified.runtimeCodeHash;
    entry.feeUpperBoundWei = verified.maximum; entry.status = 'confirmed';
    confirmed++; spent += verified.maximum; checkpoint.costUpperBoundsWei = { horizen: spent };
    await save();
    demand(spent <= ceiling, 'the hard spend ceiling was reached');
    if (intent.name === 'ERC1967Proxy') {
      // The proxy is the registry: implementation slot, owner and every stored rule must be the simulated ones.
      phase = 'registry verification';
      // Read-only public calls after the last send: their failure text is public and worth showing.
      try { entry.registryChecked = await verifyRegistry(client, expected); }
      catch (error) { throw new Refusal(String(error?.message).slice(0, 300)); }
      await save();
    }
  };
  const signingWindow = () => { try { demandSigningAge(plan, runStartedAt, confirmed); } catch { throw new Refusal(WINDOW); } };
  if (resume) {
    for (const [i, entry] of checkpoint.transactions.entries()) {
      const intent = intents[i];
      phase = `${intent.name}: recorded transaction recovery`;
      demand(await client.getChainId() === CHAIN_ID, 'wrong chain');
      if (entry.status !== 'confirmed') {
        // One failed send request must not lose the run. While the deployer's nonce is still this entry's, the
        // chain holds no transaction for it: the intent is signed again below, to the same bytes and hash, and a
        // nonce is spent once, so sending it again can neither repeat nor change anything.
        const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: plan.deployer, blockTag })));
        if (latest === entry.nonce && pending === entry.nonce) break;
        demand(entry.transactionHash !== undefined, 'the fork holds a transaction whose hash was never recorded: rehearse again on a fresh fork');
      }
      await settle(intent, entry, await verifyRecordedTransaction(client, client, intent, entry));
      log(json({ name: intent.name, transactionHash: entry.transactionHash, status: 'confirmed-from-chain-recovery' }));
    }
  }
  // Recover and validate public facts before loading any signing material. A run with nothing left to send
  // loads none and is not bound by the signing window: it only verified what the chain already holds.
  const remaining = intents.slice(confirmed);
  if (remaining.length > 0) signingWindow();
  phase = 'local signer validation';
  const sign = remaining.length > 0 ? await makeSigner({ rehearsal, client, deployer: plan.deployer, loadAccount, sendRaw }) : undefined;
  // Never update the plan or nonce silently if another wallet action intervenes.
  const signerState = async () => {
    const [chainId, latest, pending, code] = await Promise.all([
      client.getChainId(), client.getTransactionCount({ address: plan.deployer, blockTag: 'latest' }),
      client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' }), client.getCode({ address: plan.deployer }),
    ]);
    demand(chainId === CHAIN_ID && latest === start + confirmed && pending === start + confirmed, 'the chain id or the deployer nonce is not the planned one');
    demand(code === undefined || code === '0x', 'the deployer account has code');
  };
  for (const intent of remaining) {
    phase = `${intent.name}: live preflight`;
    await recheck();
    await signerState();
    const anchor = await client.getBlock({ blockNumber: BigInt(plan.chains.horizen.blockNumber) });
    demand(eq(anchor.hash, plan.chains.horizen.blockHash), 'the planned block is no longer canonical');
    const existingCode = await client.getCode({ address: intent.predictedAddress });
    demand(existingCode === undefined || existingCode === '0x', 'the predicted address already has code');
    const transaction = transactionFor(intent);
    const estimated = await client.estimateGas({ account: plan.deployer, data: intent.initCode, value: 0n, nonce: intent.nonce });
    demand(estimated <= transaction.gas, 'the gas estimate rose above the planned limit');
    const feesNow = await quotes.estimateFeesPerGas();
    demand(feesNow.maxFeePerGas <= transaction.maxFeePerGas && feesNow.maxPriorityFeePerGas <= transaction.maxPriorityFeePerGas, 'fees rose above the planned caps');
    const maximum = await feeUpperBound(client, intent);
    const future = intents.filter(x => x.nonce > intent.nonce).reduce((sum, x) => sum + BigInt(x.fees.maximumEstimatedWei), 0n);
    demand(spent + maximum + future <= ceiling, 'the remaining transactions would exceed the hard spend ceiling');
    demand(await client.getBalance({ address: plan.deployer }) >= maximum + future, 'the deployer balance does not cover the remaining transactions');
    // Fee estimation can involve several RPC round trips; recheck signer state immediately before signing.
    await signerState();
    // First signing requires a <=5-minute plan. The second requires all live checks above and a <=15-minute run.
    signingWindow();
    phase = `${intent.name}: local signing`;
    const prepared = await sign(transaction);
    // An entry an earlier run recorded but the chain never received is completed here, never duplicated.
    let entry = checkpoint.transactions[confirmed];
    if (entry) demand(eq(prepared.hash, entry.transactionHash), 'signing the recorded transaction again gave another hash');
    else {
      entry = { name: intent.name, chainId: intent.chainId, nonce: intent.nonce, predictedAddress: intent.predictedAddress,
        initCodeHash: intent.initCodeHash, transactionHash: prepared.hash, feeUpperBoundWei: maximum, status: 'signed-awaiting-submission' };
      checkpoint.transactions.push(entry);
    }
    phase = `${intent.name}: checkpoint before submission`;
    await save();
    phase = `${intent.name}: transaction submission`;
    const hash = await prepared.send();
    // A rehearsal learns the hash from Anvil; a real hash is fixed by the signature before anything is sent.
    demand(prepared.hash === undefined ? /^0x[0-9a-f]{64}$/i.test(hash) : eq(hash, prepared.hash), 'the node returned a different transaction hash');
    entry.transactionHash = hash; entry.status = 'submitted'; await save();
    log(json({ name: intent.name, chainId: intent.chainId, transactionHash: hash, status: 'submitted' }));
    phase = `${intent.name}: receipt confirmation`;
    await settle(intent, entry, await waitForCanonicalRecordedTransaction(client, client, intent, entry));
    log(json({ name: intent.name, chainId: intent.chainId, address: intent.predictedAddress, transactionHash: hash, status: 'confirmed' }));
  }
  checkpoint.status = BROADCAST_STATUS;
  checkpoint.completedAt = new Date().toISOString();
  await save();
  log(json({ status: checkpoint.status, rehearsal: checkpoint.rehearsal, implementation: plan.predicted.implementation, proxy: plan.predicted.proxy,
    owner: plan.owner, rulesHash: plan.rulesHash, costUpperBoundWei: spent, checkpoint: shown(files.checkpoint),
    next: 'write-release.mjs --deployed, then (mainnet) node scripts/write-deployment-manifest.mjs from the repository root, then check-hybrid-live.mjs and verify-hybrid.mjs --check-deployed' }));
  return checkpoint;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  rehearsing = options.rehearsal !== undefined;
  phase = 'public plan validation';
  const planText = await readFile(options.files.plan, 'utf8');
  const configText = await readFile(CONFIG, 'utf8');
  const config = JSON.parse(configText);
  const artifacts = await loadArtifacts(resolve(CONTRACTS, 'out'), NAMES);
  const chain = defineChain({ id: CHAIN_ID, name: 'horizen', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPCS.horizen] } } });
  const live = createPublicClient({ chain, transport: http(RPCS.horizen, { timeout: 20000, retryCount: 2 }) });
  const input = { options, plan: JSON.parse(planText), planText, config, configText, artifacts, release: JSON.parse(await readFile(RELEASE, 'utf8')),
    // Anvil quotes a 1 gwei tip floor that Horizen does not have, so fee quotes always come from the live chain.
    quotes: live, recheck: () => recheckPublicDependencies(config, { horizen: options.rehearsal }) };
  if (rehearsing) await broadcast({ ...input, client: await anvilFork(options.rehearsal) });
  else {
    const wallet = createWalletClient({ chain, transport: http(RPCS.horizen, { timeout: 20000, retryCount: 0 }) });
    await broadcast({ ...input, client: live, loadAccount, sendRaw: serializedTransaction => wallet.sendRawTransaction({ serializedTransaction }) });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    // A signing/provider exception may contain sensitive context. Print only this file's own refusals, or
    // anything during a rehearsal, where no signing material exists.
    const reason = error instanceof Refusal || rehearsing ? `: ${String(error?.message).slice(0, 400)}` : '';
    console.error(`Registry deployment stopped during ${phase}${reason}. Inspect the local plan/checkpoint and public receipts before retrying; no automatic retry was attempted.`);
    process.exitCode = 1;
  }
}
