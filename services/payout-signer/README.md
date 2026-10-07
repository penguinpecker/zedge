# Payout signer

Pays what the order book approves. The guest emits a public `payout` event (`zedge.vela.payout.v1`: application, ordinal,
kind 1 withdrawal or 2 refund, account, to, amount) when a user withdraws or a deposit cannot be credited. This service reads
those events on Horizen, checks each one, signs it with the vault's payout key (EIP-712 domain `ZEDGE Vault` / `1` / Base) and
sends `BaseCustodyVault.withdraw` on Base itself. Its own Base sender: it never shares a nonce with the Vercel relayer.

## What it checks before signing

- the event came from the endpoint, in a transaction that also has `StateRootUpdate` and `RequestCompleted` (status 0) for the
  same request (a completed state update of our application);
- the application ID in the topic and in the data is the manifest's;
- `to` is neither zero nor the vault; the amount is above zero;
- the vault has not paid this `(application, ordinal)`; the amount is within the vault's maximum payout and today's (UTC) cap;
  the vault holds enough USDC. A failed limit or balance is a wait (retried every poll, alerted once), not a refusal.

Payouts are acted on at Horizen's latest head (seconds); the vault's per-payout maximum and daily cap bound what a sequencer
reorganisation could cost. One payout is in flight at a time.

## Restart safety

The state file holds a cursor (the last Horizen block read) and one entry per payout. A payout's signed transaction and its
hash are written before the broadcast. After a restart a sent entry is settled from the chain: its receipt, or the vault's
`paid`, or, while its nonce is still unused, the same bytes are sent again (after 30 s); if another transaction took the
nonce, it is signed again at the next nonce. The vault pays each `(application, ordinal)` once, whatever is resent.

## Settings

`~/.config/zedge/payout-signer.env`, mode 0600:

```
PAYOUT_SIGNER_KEY_FILE=/Users/<you>/.config/zedge/payout-signer.key      # 0600, 0x + 64 hex, nothing else
PAYOUT_SIGNER_HORIZEN_RPC_URL=https://26514.rpc.thirdweb.com            # never the operator's Caldera endpoint
PAYOUT_SIGNER_BASE_RPC_URL=https://base-rpc.publicnode.com              # a private Base endpoint is better
PAYOUT_SIGNER_STATE_DIRECTORY=/Users/<you>/.config/zedge/payout-signer-state
```

Addresses come from `public/deployments/26514-orderbook.json` (it must be `configured`); the key must be the vault's
`signer()`. Create the key without printing it, then plan custody with its address
(`node contracts/scripts/deploy-custody.mjs --plan --signer <address>`) or, after deployment, have the owner call
`setSigner(<address>)`:

```
node --input-type=module -e 'import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"; import { writeFileSync } from "node:fs"; const k = generatePrivateKey(); writeFileSync(process.env.HOME + "/.config/zedge/payout-signer.key", k, { mode: 0o600, flag: "wx" }); console.log(privateKeyToAccount(k).address);'
```

Fund it with a little Base ETH (a payout is about 85,000 gas).

## Run

```
node services/payout-signer/main.mjs --settings ~/.config/zedge/payout-signer.env
```

One JSON status line per change: `sent` (hash, to, amount, kind), `paid`, `waiting` (reason, `alert: true`), `refused`
(reason, `alert: true`), `dropped`, `rebroadcast`. `--once` runs one poll. `--rehearsal --manifest FILE` runs against two
loopback Anvil forks (both RPCs in the settings) with a fork manifest.

Test: `node --test services/payout-signer/*.test.mjs`.
