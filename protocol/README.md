# ZEDGE engine protocol v1

Authoritative implementation types: [`engine/types.go`](../engine/types.go). Serialization/validation: [`engine/codec.go`](../engine/codec.go). This protocol describes original ZEDGE application logic, not a Vela SDK endpoint.

## Canonical envelope and authorization

Every command has `domain`, `id`, `nonce`, `op`; user commands also require `account`. Domain is `{ chainId, endpoint, applicationId, rulesVersion }`. Addresses are nonzero lowercase `0x` plus 40 hex digits. `rulesVersion` is 1. `applicationId` and oracle feed IDs are 1–64 characters of letters, digits, `_`, `-` and `.`. Command ID equals `principal + ":" + decimal nonce` with no leading zeroes.

`engine.DecodeCommand` accepts canonical compact JSON in the field order defined by the Go struct, with omitted optional zero-valued fields. Unknown fields, duplicate keys, alternate ordering/whitespace, trailing documents, fractional/exponent numbers and out-of-range integers reject. For interoperable clients, construct objects in this order and omit zero-valued optional fields:

```text
domain, id, nonce, op, account, roundId, round, amount, outcome, side,
price, quantity, tif, expiry, maxFee, orderId, withdrawalId, destination,
evidence, observedAt, oraclePrice
```

Domain field order: `chainId, endpoint, applicationId, rulesVersion`.
Round field order: `asset, feed, start, end, cutoff, observationWindow, openingDeadline, resolutionDeadline`.

Amounts, quantities, prices, nonces and times are integers. Amount/share atom scale is 10^6; share lot is 1,000 atoms; price is cents 1–99. The engine caps amounts/nonces/times at 10^15, below JavaScript's exact integer bound. Reject unsafe numbers before encoding. All authenticated timestamps use UTC seconds, never milliseconds. Oracle prices use a fixed integer scale verified by the adapter for both observations; they are not order prices.

The application digest is `SHA256(canonicalCommandJSON)`. This is not by itself an EIP-712 or wallet signature scheme. An adapter must bind this digest and the complete domain to validated wallet authorization before constructing `AuthenticatedContext`. The context (principal, timestamp and system capability) is never a client-controlled envelope field.

## Commands

Only the relevant fields below may be present/nonzero. Commands reject additional operation fields even if they are recognized envelope fields.

| Operation | Authorization | Additional fields | Accepted effect |
| --- | --- | --- | --- |
| `register` | User | `account` | Register the principal with zero funds. |
| `deposit` | Verified authority | `account, amount, evidence` | Credit a verified unique external deposit. |
| `create_round` | Verified authority | `round` | Create immutable market terms before start. Receipt returns engine round ID. |
| `open_round` | Verified authority | `roundId, evidence, observedAt, oraclePrice` | Fix opening from validated boundary observation. |
| `checkpoint` | Verified authority | None | Advance authenticated time and release expired orders. |
| `mint` | User | `account, roundId, quantity` | Lock collateral and create equal Up/Down shares. |
| `merge` | User | `account, roundId, quantity` | Burn equal unreserved Up/Down shares before cutoff. |
| `place_order` | User | `account, roundId, outcome, side, price, quantity, tif, expiry, maxFee` | Reserve/match, then rest (`gtc`) or cancel remainder (`ioc`). |
| `cancel_order` | User | `account, orderId` | Cancel owned active remainder. |
| `cancel_all` | User | `account`, optional `roundId` | Cancel owned active orders in scope. |
| `resolve_round` | Verified authority | `roundId, evidence, observedAt, oraclePrice` | Fix Up if close >= open, otherwise Down. |
| `void_round` | Verified authority | `roundId, evidence` | Void after immutable applicable deadline. |
| `redeem` | User | `account, roundId` | Burn all owned settled shares and credit payout. |
| `request_withdrawal` | User | `account, amount, destination` | Reserve available cash as pending intent. |
| `cancel_withdrawal` | User | `account, withdrawalId` | Release an unexported intent. |
| `export_withdrawal` | Verified authority | `withdrawalId, evidence` | Produce public claim instruction and debit private custody. |
| `confirm_claim` | Verified authority | `withdrawalId, evidence` | Record verified external claim completion. |

`evidence` is exactly 64 lowercase hexadecimal characters identifying a verified canonical fact. It is deliberately not accepted as proof merely because it has the right shape. Deposit/export/claim IDs are persisted and deduplicated. Open/close feed evidence may legitimately be reused across aligned rounds, so verification and binding to each round are adapter responsibilities.

## Round and custody binding

Round duration is 300 or 900 seconds; asset is `BTC` or `ETH`. Start must align to its UTC epoch duration (`start % duration == 0`), creation is strictly before start, and start < cutoff < end. Observation window is 0–60 seconds. Opening deadline must be at least start+window and strictly before cutoff. Resolution deadline must be at least end+window and at most end+86,400 seconds. A first unique observation inside the inclusive window may be committed by its deadline. Missing opening may void strictly after opening deadline; opened round may void strictly after resolution deadline.

The engine round ID hashes `{config, round}` with SHA-256. The Solidity registry uses its own domain-separated Keccak ID. Explicitly verified mappings must bind chain, registry, registry rulesHash, asset/feed, collateral, all timestamps/deadlines, oracle selection rule, tie/void rules and the engine ID. Never treat one hash format as the other.

Collateral is one pinned six-decimal token. `custody` equals user available/reserved cash + round collateral + private fees + pending withdrawal intents. `deposited = custody + claimable + paidOut`. The adapter must reconcile these values against matching canonical contract state and handle pending, unprocessed chain deposits separately. Export and public custody movement must be atomically accepted; retries with unchanged state sequence must never re-emit effects.

## Confidential outputs

`State` and full `Receipt` are internal confidential objects. Use `AccountView` and `ProjectReceipt` to form authorized personal outputs. These projections remove counterparties and unrelated orders; they do not encrypt, authenticate a requester, hide event metadata or prevent inference. System exports intentionally reveal destination/token/amount through the public withdrawal path. No public depth/tape projection is implemented in this core.

Adapter acceptance checklist: authenticated principal; fresh authenticated time with commitment freshness; canonical state/rollback protection; unique deposits; verified first oracle observations and round mapping; exact-once public effects; encrypted/padded personal output; no raw state/receipt logging; independent audit and capacity/recovery plan. A missing required verifier is an unavailable operation, not an option to trust user input.
