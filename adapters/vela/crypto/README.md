# Vela encryption integration — evaluation only

An isolated, tested wrapper around the actual `@horizen/vela-common-ts@0.2.0` crypto primitives. It is **not imported into the public frontend** and does not submit transactions. It accepts four chains only: local Anvil (31337), Horizen mainnet (26514), Horizen testnet (2651420) and Base Sepolia (84532), the same list as the guest. Upstream BSL production rights remain a separate release dependency.

`npm ci && npm run check && npm test` runs real P-521/AES-GCM round trips, tampering, wallet/epoch/origin separation, relock and delayed-signature tests, and the guest's shared vectors (`guest.test.ts`, `pad.test.ts`). Generated test wallets exist only in process memory.

The wrapper binds key derivation to the origin, account, chain, endpoint, application ID, WASM fingerprint, rules hash and key epoch. The signed derivation challenge is secret material; it must never become a server login signature. Connecting a wallet, deriving the key and registering its public key are three distinct actions. `associationPayload()` returns bytes for a separately authorized `ASSOCIATEKEY` request, not evidence registration occurred.

`encryptCommand()` produces an encrypted, versioned envelope. A guest integration must validate that envelope and the command authorization. `decryptReceipt()` checks its context and returns an explicit unreadable/locked result; callers must first verify the event's canonical chain provenance. Decryption is not finality or attestation. Historical records require their original account and enclave key epochs.

`guest.ts` is the client side of `adapters/vela/guest`: the canonical engine-command encoder, the four envelope bodies that guest accepts (`commandBody`, `syncBody`, `reportBody` for a Chainlink full report in 0x hex, and `resolveBody` for the event resolver's signed result), the request IDs its receipts carry (`commandId`, `syncRequestId`, `reportRequestId`, `resolveRequestId`), `SUBTYPES` with decoders for its public records (`decodeClock`, `decodeSettle`, `decodeCredit`, `decodePayout`, `decodeConfirm`), and the operator-resolved event (guest README §13): `eventRound(engineConfigJson, event)`, which derives the event's engine round ID and spec exactly as the engine does, and `eventResultTypedData(domain, roundId, outcome)`, the EIP-712 typed data its resolver signs. The protocol is `../guest/README.md`. `guest.test.ts` reads `../guest/testdata/vectors.json`, which the guest's Go tests write and check, so both sides must reproduce the same bytes.

The guest accepts only requests of one length, 2,048 bytes of plaintext, and refuses any other (guest README §4). `pad.ts` adds the zeros: every body goes through `padBody` before `encryptCommand`, for a command and for a sync alike:

```ts
session.encryptCommand(command.id, padBody(session, command.id, commandBody(command)));
session.encryptCommand(syncRequestId(account), padBody(session, syncRequestId(account), syncBody()));
session.encryptCommand(reportRequestId(account, ts), padBody(session, reportRequestId(account, ts), reportBody(fullReportHex)));
session.encryptCommand(resolveRequestId(account), padBody(session, resolveRequestId(account), resolveBody(outcome, signature)));
```

`pad.test.ts` checks every request vector in `../guest/testdata/vectors.json`, padded and encrypted, against the exact plaintext the guest accepts.

Keys are held in memory only. Lock invalidates pending work and drops references; JavaScript cannot guarantee physical erasure. No private-key export, storage, RPC, telemetry or automatic submission is included. The upstream association format here omits the optional subtype seed; event/recipient metadata remains a known limitation. No claim of unlinkability is made.

Before funded integration: reviewed persistent key recovery, hardware-wallet consistency, attestation, canonical event indexing, guest command binding, upstream output/logging fixes, request-time verification and safe exits must be implemented and tested. This wrapper alone supplies none of those guarantees.
