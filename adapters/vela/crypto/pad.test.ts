// EVALUATION ONLY. pad.ts against the guest's shared vectors (../guest/testdata/vectors.json):
// each request vector's body, padded, must encrypt to exactly the plaintext the guest accepts.
//   node --experimental-strip-types --test pad.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { decrypt, exportPublicKeyToHex, generateKeyPair, importPublicKeyFromHex } from "@horizen/vela-common-ts";
import { EvaluationSession } from "./session.ts";
import type { EvaluationDomain } from "./session.ts";
import { commandBody, commandId, reportBody, reportRequestId, resolveBody, resolveRequestId, syncBody, syncRequestId } from "./guest.ts";
import type { EngineCommand } from "./guest.ts";
import { REQUEST_BYTES, padBody } from "./pad.ts";

interface Vectors {
  domain: EvaluationDomain;
  epoch: string;
  accounts: Record<string, string>;
  requests: { name: string; account: string; requestId: string; body: { type: string; command?: string; report?: string; outcome?: 1 | 2; signature?: string }; plaintext: string; padded: string }[];
}
const vectors: Vectors = JSON.parse(readFileSync(new URL("../guest/testdata/vectors.json", import.meta.url), "utf8"));
const reports: { feedId: string; observationsTimestamp: number; report: string }[] =
  JSON.parse(readFileSync(new URL("../guest/testdata/chainlink.json", import.meta.url), "utf8")).reports;

// Test-only wallet derived from a public label, as in guest.test.ts. Never fund it.
const wallet = (name: string) => new Wallet(keccak256(toUtf8Bytes(`zedge-vela-guest-vector:${name}`)));

test("padded requests are the one length the guest accepts, byte for byte", async () => {
  const enclave = await generateKeyPair();
  const session = new EvaluationSession(vectors.domain, vectors.accounts.alice!,
    { id: vectors.epoch, enclavePublicKey: await exportPublicKeyToHex(enclave.publicKey) });
  await session.unlock(wallet("alice"));
  const user = await importPublicKeyFromHex(Buffer.from(await session.associationPayload()).toString("hex"));
  assert.equal(vectors.requests.length, 5);
  for (const vector of vectors.requests) {
    let body: { type: string } = syncBody();
    let requestId = syncRequestId(session.account);
    if (vector.body.type === "command") {
      const command = JSON.parse(vector.body.command!) as EngineCommand;
      body = commandBody(command);
      requestId = commandId(session.account, command.nonce);
    }
    if (vector.body.type === "report") {
      const at = Number(vector.requestId.split(":").at(-1));
      body = reportBody(reports.find(r => r.feedId.startsWith("0x00039d9e") && r.observationsTimestamp === at)!.report);
      requestId = reportRequestId(session.account, at);
    }
    if (vector.body.type === "resolve") {
      body = resolveBody(vector.body.outcome!, vector.body.signature!);
      requestId = resolveRequestId(session.account);
    }
    const padded = padBody(session, requestId, body);
    assert.match(padded.pad, /^0*$/, vector.name);
    const plaintext = new TextDecoder().decode(await decrypt(enclave.privateKey, user, await session.encryptCommand(requestId, padded)));
    assert.equal(plaintext, vector.padded, vector.name);
    assert.equal(new TextEncoder().encode(plaintext).length, REQUEST_BYTES, vector.name);
    // Unpadded, session.ts gives the shorter plaintext the guest refuses.
    assert.ok(vector.plaintext.length < REQUEST_BYTES, vector.name);
  }
  // A body that cannot fit is refused here rather than sent at another length.
  assert.throws(() => padBody(session, syncRequestId(session.account), { type: "command", command: "x".repeat(REQUEST_BYTES) }));
});
