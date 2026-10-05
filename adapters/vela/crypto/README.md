# Vela encryption integration — evaluation only

An isolated, tested wrapper around the actual `@horizen/vela-common-ts@0.2.0` crypto primitives. It is **not imported into the public frontend**, does not submit transactions, and cannot select a production chain. Upstream BSL production rights remain a separate release dependency.

`npm ci && npm run check && npm test` runs real P-521/AES-GCM round trips, tampering, wallet/epoch/origin separation, relock and delayed-signature tests. Generated test wallets exist only in process memory.

The wrapper binds key derivation to the origin, account, chain, endpoint, application ID, WASM fingerprint, rules hash and key epoch. The signed derivation challenge is secret material; it must never become a server login signature. Connecting a wallet, deriving the key and registering its public key are three distinct actions. `associationPayload()` returns bytes for a separately authorized `ASSOCIATEKEY` request, not evidence registration occurred.

`encryptCommand()` produces an encrypted, versioned envelope. A guest integration must validate that envelope and the command authorization. `decryptReceipt()` checks its context and returns an explicit unreadable/locked result; callers must first verify the event's canonical chain provenance. Decryption is not finality or attestation. Historical records require their original account and enclave key epochs.

`guest.ts` is the client side of `adapters/vela/guest`: the canonical engine-command encoder, the two envelope bodies that guest accepts and the request IDs its receipts carry. The protocol is `../guest/README.md`. `guest.test.ts` reads `../guest/testdata/vectors.json`, which the guest's Go tests write and check, so both sides must reproduce the same bytes.

Keys are held in memory only. Lock invalidates pending work and drops references; JavaScript cannot guarantee physical erasure. No private-key export, storage, RPC, telemetry or automatic submission is included. The upstream association format here omits the optional subtype seed; event/recipient metadata remains a known limitation. No claim of unlinkability is made.

Before funded integration: reviewed persistent key recovery, hardware-wallet consistency, attestation, canonical event indexing, guest command binding, upstream output/logging fixes, request-time verification and safe exits must be implemented and tested. This wrapper alone supplies none of those guarantees.
