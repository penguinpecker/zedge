#!/usr/bin/env node
/** A new wallet for the event's resolver or the event house (services/market-maker/README.md): writes its private key to
 * <key file> with mode 600, never over an existing file, and prints only its address. Run it in your own Terminal.
 *
 *   node scripts/new-key.mjs ~/.config/zedge/resolver.key
 */
import { Wallet } from "ethers";
import { writeKey } from "../services/market-maker/keyfile.mjs";

const [file, ...extra] = process.argv.slice(2);
if (!file || extra.length) { console.error("usage: new-key.mjs <key file>"); process.exit(64); }
try {
  const wallet = Wallet.createRandom();
  writeKey(file, wallet.privateKey);
  console.log(wallet.address.toLowerCase());
} catch (e) { console.error(`new-key: ${e.refused ? e.message : e.stack}`); process.exit(1); }
