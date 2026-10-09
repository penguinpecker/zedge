#!/usr/bin/env node
/** The event's result, signed with the resolver key (services/market-maker/README.md, "The event's result").
 *
 *   node scripts/sign-event-result.mjs <resolver key file> <yes|no> [--out FILE] [--book FILE] [--events FILE]
 *       Offline. Signs the result, recovers the signer and refuses unless it is the resolver the deployment pinned; prints the
 *       result and with --out also writes it (never over a file). The manifests default to the committed
 *       public/deployments/26514-orderbook.json and 26514-events.json.
 *   node scripts/sign-event-result.mjs <resolver key file> --check
 *       Offline. Signs a test message that can settle nothing and prints the address it recovers to: check it against the
 *       address the deployment will pin, before the deploy.
 *   node scripts/sign-event-result.mjs submit <result file> (--mainnet | --fork URL --settings FILE --events FILE) [--event]
 *       Sends the result through a registered sender: the event house with --event, otherwise the house
 *       (services/market-maker/main.mjs resolve).
 *
 * The key is never printed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Wallet, verifyTypedData } from "ethers";
import * as codec from "../adapters/vela/crypto/guest.ts";
import { checkResult, deploymentEvent, resultBody, resultTypedData } from "../services/market-maker/event.mjs";
import { readKey } from "../services/market-maker/keyfile.mjs";

const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };
const USAGE = "usage: sign-event-result.mjs <resolver key file> (<yes|no> [--out FILE] [--book FILE] [--events FILE] | --check)\n" +
  "       sign-event-result.mjs submit <result file> (--mainnet | --fork URL --settings FILE --events FILE) [--event]";
const deployments = new URL("../public/deployments/", import.meta.url);
const json = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { refuse(`${file}: ${e.message}`); } };

/** Outcome 1 for "yes", 2 for "no" (any case); anything else is refused. */
export function outcomeOf(answer) {
  const a = String(answer).toLowerCase();
  return a === "yes" ? 1 : a === "no" ? 2 : refuse(`the result is yes or no, not ${JSON.stringify(answer)}`);
}

/** The signed result of `answer` for the deployment of `book` and `events`, checked to recover to its pinned resolver. */
export async function signResult(keyFile, answer, book, events) {
  const outcome = outcomeOf(answer), event = deploymentEvent(book.application.engineConfigJson, events, codec);
  const result = resultBody(event, outcome, await new Wallet(readKey(keyFile)).signTypedData(...resultTypedData(event, outcome, codec)));
  checkResult(result, event, { ethers: { verifyTypedData }, codec });
  return result;
}

// Not an EventResult: another domain and type, so no deployment can take it as a result.
const CHECK = [{ name: "ZEDGE resolver check", version: "1" }, { Check: [{ name: "text", type: "string" }] }, { text: "This signature settles nothing." }];
/** The address a test signature by the key in keyFile recovers to. */
export async function checkKey(keyFile) {
  return verifyTypedData(...CHECK, await new Wallet(readKey(keyFile)).signTypedData(...CHECK)).toLowerCase();
}

async function cli(argv) {
  if (argv[0] === "submit") return (await import("../services/market-maker/main.mjs")).main(["resolve", ...argv.slice(1)]);
  const { values: a, positionals: [keyFile, answer, ...extra] } = parseArgs({ args: argv, allowPositionals: true,
    options: { check: { type: "boolean" }, out: { type: "string" }, book: { type: "string" }, events: { type: "string" } } });
  if (!keyFile || extra.length || (a.check ? answer !== undefined || a.out || a.book || a.events : answer === undefined)) refuse(USAGE);
  if (a.check) return console.log(JSON.stringify({ recovered: await checkKey(keyFile) }));
  outcomeOf(answer); // before the manifests are read
  const result = await signResult(keyFile, answer, json(a.book ?? new URL("26514-orderbook.json", deployments)), json(a.events ?? new URL("26514-events.json", deployments)));
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (a.out) writeFileSync(a.out, text, { flag: "wx" });
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(`sign-event-result: ${e.refused ? e.message : (e.stack ?? e.message)}`); process.exit(1); });
}
