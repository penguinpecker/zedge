# ZEDGE public round keeper

This service operates the already deployed Base → Horizen oracle route. It discovers BTC/ETH 300/900-second rounds, schedules future rounds, retrieves the signed report covering each exact boundary, authenticates it through the deployed Chainlink adapter, publishes on Base, waits for the Horizen cache, records the opening or closing, and voids timed-out rounds. A source publication is never treated as a destination receipt. Previously authenticated observations can be resent at most twice, 60 seconds apart, before the same immutable deadline.

No deposits, approvals, trading, custody, private keys, or exchange balances are sent to a server by the browser. This keeper only sends zero-value calls to six reviewed public methods. It is not a private matching service or a TEE, and it cannot establish private admission time or claim rollup finality.

From the repository root:

```sh
node services/keeper/main.mjs --check-public
node services/keeper/main.mjs --plan
node --test services/keeper/*.test.mjs
```

These commands do not load a key or sign. `--check-public` verifies the committed release against both actual chains, every application runtime, immutable bindings, and upstream proxy implementations/governance. `--plan` also shows actions derived from actual chain state. No local deployment checkpoint or Foundry output is needed; committed ABIs and the public mainnet address record are sufficient.

## Operating

Use a dedicated low-balance EOA, not a trader account. Copy `env.example` to a Git-ignored local file, fill the fields locally, and set file permissions to `0600`. Only an explicitly supplied `--secrets` file is read. The runner has no implicit `.env` loading and never reads the previous deployment key by default.

```sh
node services/keeper/main.mjs --run-once --secrets /absolute/path/.env.keeper.local
node services/keeper/main.mjs --watch --secrets /absolute/path/.env.keeper.local
```

Use a supervised long-lived process and persistent disk. Vercel's static frontend is not the host for this loop. `--state-directory` selects the persistent journal directory (default: ignored `evidence/keeper`). A filesystem lock allows one writer; do not share one wallet across competing keepers or run a second process on copied state. Separate independent keepers may use separate keys and disks because contract operations are permissionless. Canonical reverted transactions retain their consumed nonce and fee reservation. Their intent is not automatically repeated; other eligible work can continue. Unknown or pending transactions stop signing until reconciled.

Each transaction is simulated, limited to 2.5 million gas and 1 gwei maximum gas price, and charged to a persistent lifetime fee allowance. Bounds include execution gas and twice the current rollup data/operator quote. These quotes are conservative estimates, not an enforceable cap on separately charged rollup fees. The provided maximum session limits are 0.00025 ETH on Base and 0.00012 ETH on Horizen; a depleted session stops instead of automatically adding an allowance. No unattended refill is implemented.

## Reports and safety

The HMAC client uses the exact historical `/api/v1/reports` endpoint with the fixed boundary. It checks the canonical full report ABI, feed identity, signed interval, positive int192 price, 18-decimal policy, expiry, and bounded response size. Structural parsing never substitutes for DON authentication: the real contract verifier must succeed before publication. The service does not select a later price when the boundary report fails, use a ticker for settlement, or alter round deadlines. Fresh-report readiness for both configured feeds is required to schedule new markets. Cached resolution and timeout voiding remain possible during a report-access outage.

Credentials go only in authentication headers to the fixed official HTTPS origin. Redirects are rejected; error bodies and raw provider exceptions are not logged. Paid report payloads are passed to the public oracle contract as intended for on-chain verification. Never route user orders or private account state through this service.

## Persistence and failure behavior

Before the sole send attempt, the public transaction hash, exact intent, nonce and conservative cost are atomically written and fsynced. Both chain clocks/deadlines and the signer nonce/code are checked again after the durable write, so a disk stall cannot bypass the final submission check. A failed check preserves the signed hash for investigation. No raw signed transaction or secret is written. A crash/timeout never causes an automatic replacement or resend; restart inspects the saved hash. Pending/not-found hashes require investigation. Receipts need three observed confirmations and exact nonzero transaction/receipt/block identity and signed-field agreement. Saved block anchors are checked again; a reorg stops the service. Three confirmations are an operational observation, not L1-finalized state.

The journal retains active rounds through their terminal state, including ones outside the rolling discovery window after a restart. It refuses more than 1,024 active rounds or 32 MiB of local journal state; these are explicit operational limits, not a tested production capacity claim. The lifetime gas allowance generally stops the process first. Journal archival, multi-region scheduling and automated fee replacement are not implemented. Retain backups, establish canonical state before removing a stale lock, and never delete transaction history to reset gas accounting.

Current verification includes adversarial local tests and read-only mainnet dependency checks. Continuous authenticated live report retrieval requires actual subscription credentials; a recorded historical smoke report is not that entitlement. Production operation still needs sustained latency/availability testing and a finality policy.

Sources: [REST API](https://docs.chain.link/data-streams/reference/data-streams-api/interface-api), [HMAC authentication](https://docs.chain.link/data-streams/reference/data-streams-api/authentication), [subscription access](https://docs.chain.link/data-streams/sign-up), [deployed route](../../contracts/deployment/MAINNET.md).
