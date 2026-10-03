/** Evaluation-only Vela crypto boundary. No RPC, storage, analytics or submission.
 * Deployment attestation and canonical event validation are separate obligations.
 * This package intentionally is not imported by the public frontend.
 */
import {
  buildAssociateKeyPayload, decrypt, deriveP521PrivateKeyFromSigner,
  encrypt, importPublicKeyFromHex,
} from "@horizen/vela-common-ts";
import type { P521KeyPair } from "@horizen/vela-common-ts";
import type { Signer } from "ethers";

const MAX_PAYLOAD_BYTES = 16_384;
const MAX_RECEIPT_BYTES = 131_072;
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface EvaluationDomain {
  chainId: 31337 | 2651420 | 84532;
  endpoint: string;
  applicationId: string;
  applicationFingerprint: string;
  rulesHash: string;
  origin: string;
}
export interface EncryptionEpoch {
  id: string;
  enclavePublicKey: string;
}
export interface PrivateEnvelope {
  version: 1;
  domain: EvaluationDomain;
  account: string;
  epoch: string;
  requestId: string;
  kind: "command" | "receipt";
  body: unknown;
}
export type ReceiptResult =
  | { status: "readable"; envelope: PrivateEnvelope }
  | { status: "locked" | "unreadable" | "context-mismatch" };

function validateDomain(value: EvaluationDomain): EvaluationDomain {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "applicationFingerprint,applicationId,chainId,endpoint,origin,rulesHash") {
    throw new Error("Invalid deployment domain fields.");
  }
  if (![31337, 2651420, 84532].includes(value.chainId)) {
    throw new Error("This adapter is limited to evaluation networks.");
  }
  if (!addressPattern.test(value.endpoint) || value.endpoint === zeroAddress ||
      !/^[1-9][0-9]{0,19}$/.test(value.applicationId) ||
      BigInt(value.applicationId) > (1n << 64n) - 1n ||
      !hashPattern.test(value.applicationFingerprint) || !hashPattern.test(value.rulesHash)) {
    throw new Error("Invalid deployment domain.");
  }
  const url = new URL(value.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value.origin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("Use a canonical HTTPS origin or a local development origin.");
  }
  return Object.freeze({ chainId: value.chainId, endpoint: value.endpoint,
    applicationId: value.applicationId, applicationFingerprint: value.applicationFingerprint,
    rulesHash: value.rulesHash, origin: value.origin });
}

function validateEpoch(epoch: EncryptionEpoch): EncryptionEpoch {
  if (!/^[1-9][0-9]{0,9}$/.test(epoch.id) ||
      !/^(0x)?04[0-9a-f]{264}$/.test(epoch.enclavePublicKey)) {
    throw new Error("Invalid encryption epoch or uncompressed P-521 key.");
  }
  return Object.freeze({ id: epoch.id, enclavePublicKey: epoch.enclavePublicKey });
}

function requestIdValid(id: string) { return /^[a-zA-Z0-9:._-]{1,128}$/.test(id); }

/** A memory-only handle. Lock releases references and invalidates in-flight work;
 * JavaScript/WebCrypto cannot promise physical erasure of wallet signatures/keys.
 */
export class EvaluationSession {
  readonly domain: EvaluationDomain;
  readonly account: string;
  readonly epoch: EncryptionEpoch;
  #keys: P521KeyPair | undefined;
  #generation = 0;

  constructor(domain: EvaluationDomain, account: string, epoch: EncryptionEpoch) {
    this.domain = validateDomain(domain);
    if (!addressPattern.test(account) || account === zeroAddress) throw new Error("Invalid account.");
    this.account = account;
    this.epoch = validateEpoch(epoch);
  }

  get unlocked() { return this.#keys !== undefined; }

  /** Wallet connect, this signature, and on-chain ASSOCIATEKEY are distinct steps.
   * The derivation signature MUST NEVER be sent to a login service or logs.
   * Account/epoch/domain separation intentionally differs from upstream defaults.
   */
  async unlock(signer: Signer): Promise<void> {
    this.lock();
    const generation = this.#generation;
    const initialAccount = (await signer.getAddress()).toLowerCase();
    if (generation !== this.#generation) throw new Error("Session locked before signing.");
    if (initialAccount !== this.account) throw new Error("Wrong signer.");
    const challenge = "ZEDGE private data key — evaluation only\n" +
      "This signature derives a secret encryption key. Do not share it.\n" +
      JSON.stringify({ version: 1, domain: this.domain, account: this.account, epoch: this.epoch.id }) + "\nAccount: ";
    // The SDK appends getAddress() verbatim. Canonicalize that internal read so
    // checksum casing differences between wallet implementations do not change keys.
    // With alternativeSign=false the SDK uses only these two signer methods.
    const canonicalSigner = {
      getAddress: async () => this.account,
      signMessage: (message: string | Uint8Array) => signer.signMessage(message),
    } as Signer;
    const keys = await deriveP521PrivateKeyFromSigner(canonicalSigner, false, challenge,
      encoder.encode("zedge-private-key-v1"), encoder.encode("evaluation-only"));
    const finalAccount = (await signer.getAddress()).toLowerCase();
    if (generation !== this.#generation || finalAccount !== this.account) {
      throw new Error("Account changed or session locked while signing.");
    }
    this.#keys = keys;
  }

  lock(): void { this.#generation++; this.#keys = undefined; }

  async associationPayload(): Promise<Uint8Array> {
    const { keys, generation } = this.#active();
    const payload = await buildAssociateKeyPayload(keys.publicKey);
    this.#checkGeneration(generation);
    // No seed: recipient/event metadata policy must be resolved before production.
    return payload;
  }

  async encryptCommand(requestId: string, body: unknown): Promise<Uint8Array> {
    if (!requestIdValid(requestId)) throw new Error("Invalid command ID.");
    const { keys, generation } = this.#active();
    const envelope: PrivateEnvelope = { version: 1, domain: this.domain,
      account: this.account, epoch: this.epoch.id, requestId, kind: "command", body };
    const data = encoder.encode(JSON.stringify(envelope));
    if (data.length > MAX_PAYLOAD_BYTES) throw new Error("Command exceeds the payload limit.");
    const peer = await importPublicKeyFromHex(this.epoch.enclavePublicKey);
    const ciphertext = await encrypt(keys.privateKey, peer, data);
    this.#checkGeneration(generation);
    return ciphertext;
  }

  /** Call only for a receipt selected from verified canonical application events.
   * Successful decryption alone is not proof of an accepted trade or finality.
   * This never silently drops an unreadable receipt or changes it to empty history.
   */
  async decryptReceipt(ciphertext: Uint8Array, expectedRequestId: string): Promise<ReceiptResult> {
    if (!this.#keys) return { status: "locked" };
    if (!requestIdValid(expectedRequestId) || ciphertext.length < 28 || ciphertext.length > MAX_RECEIPT_BYTES) {
      return { status: "unreadable" };
    }
    const { keys, generation } = this.#active();
    try {
      const peer = await importPublicKeyFromHex(this.epoch.enclavePublicKey);
      const data = await decrypt(keys.privateKey, peer, ciphertext);
      if (generation !== this.#generation) return { status: "locked" };
      const decoded: unknown = JSON.parse(decoder.decode(data));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return { status: "unreadable" };
      const value = decoded as PrivateEnvelope;
      let receiptDomain: EvaluationDomain;
      try { receiptDomain = validateDomain(value.domain); }
      catch { return { status: "context-mismatch" }; }
      if (Object.keys(value).sort().join(",") !== "account,body,domain,epoch,kind,requestId,version" ||
          value.version !== 1 || value.kind !== "receipt" || value.account !== this.account ||
          value.epoch !== this.epoch.id || value.requestId !== expectedRequestId ||
          JSON.stringify(receiptDomain) !== JSON.stringify(this.domain)) {
        return { status: "context-mismatch" };
      }
      return { status: "readable", envelope: value };
    } catch {
      return { status: generation === this.#generation ? "unreadable" : "locked" };
    }
  }

  #active() {
    if (!this.#keys) throw new Error("Private account is locked.");
    return { keys: this.#keys, generation: this.#generation };
  }
  #checkGeneration(generation: number) {
    if (generation !== this.#generation || !this.#keys) throw new Error("Private account was locked.");
  }
}
