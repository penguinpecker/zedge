# Keeper dress rehearsal

Runs the unmodified round keeper (`services/keeper/main.mjs --watch --rehearsal`) through real rounds on local forks of Base and Horizen, and measures it from its own status lines and from chain state.

```sh
node scripts/rehearsal/rehearse.mjs main     # about 27 minutes: 24 minutes of keeper time, no faults
node scripts/rehearsal/rehearse.mjs faults   # about 30 minutes: five faults, one per boundary
```

Options: `--minutes <n>` (main only, default 24), `--relay-delay <seconds>` (default 24, the delivery time observed on mainnet), `--out <directory>` (default `evidence/keeper-rehearsal-<date>/<scenario>/`; `evidence/` is git-ignored; a directory that already holds a run is refused, so a second run on one day needs its own). Ctrl-C stops everything it started.

Needs: Node 22, `npm install` done at the repository root, Anvil 1.7 on `PATH`, `contracts/out` built (the registry planner reads the build artifacts), and network access to `https://mainnet.base.org` and the Horizen endpoint named in `contracts/deployment/hybrid-mainnet.json`. It listens on 127.0.0.1 ports 39101, 39102 (the forks), 39111, 39112 (the keeper's endpoints) and 39120 (the report service stand-in); the registry planner starts one more short-lived Anvil child on a port the operating system picks.

## What one run does

1. Forks Base (from `mainnet.base.org`, which serves archive state and receipts) and Horizen at their current heads minus five blocks, pinned so Anvil caches upstream state, with 2 s and 1 s blocks, and sets both clocks to wall-clock time (`evm_setTime`; the keeper refuses a head more than 60 s from the host clock).
2. Deploys the new registry on the Horizen fork with the registry deployment tools in rehearsal mode (`contracts/scripts/plan-registry.mjs`, then `broadcast-registry.mjs`, both `--rehearsal <fork> --evidence <out>/deploy`): deployer impersonation, no key, the planned addresses. It then checks the proxy runtime hash against the committed release.
3. Replaces the Chainlink VerifierProxy's code on the Base fork (`anvil_setCode`) with a 38-byte test verifier that returns the report body of whatever envelope it is given.
4. Serves reports from the keeper simulator's report service (`services/keeper/sim.mjs`): the real HMAC scheme with a 5 s clock tolerance, one report per second and feed, exact-second lookups (404 for a second without a report), the page endpoint, `/latest`, and gap seconds.
5. Relays every `SentMessage` of the Base messenger to the Horizen fork the way the native bridge does: `relayMessage` from the aliased messenger address (impersonated), with the message's own nonce, sender, target, gas limit and data, an explicit 2,000,000 gas limit, `--relay-delay` seconds after the Base block that holds it.
6. Writes a throwaway key and settings file (mode 0600, in a temporary directory deleted at exit), funds the key with `anvil_setBalance` (0.05 ETH on Base, 0.01 ETH on Horizen), budgets 0.02 and 0.004 ETH a day (the README example), and runs `--plan --rehearsal` until it succeeds (a cold fork fails the first read; see Limits), then `--watch --rehearsal`.
7. Stops the keeper with SIGTERM, reads every registry, cache and publisher event of the run from the forks, and writes `summary.json`.

The keeper's endpoints are a small proxy in front of each fork. It passes every call through to Anvil one at a time (a cold fork stopped answering concurrent batches), answers `eth_maxPriorityFeePerGas` with the live chain's quote read once at start (Anvil quotes a 1 gwei floor neither chain has, which would put every keeper transaction over its per-transaction cap), answers a Base `eth_estimateGas` above 2^24 gas the way Base does (`-32003 out of gas: gas required exceeds: 16777216`, read from `mainnet.base.org` on 2026-10-05; the fork itself estimates past the cap), counts the keeper's calls, and injects the faults below.

## The fault scenario

`B0` is the first five-minute boundary at least 90 s after the keeper starts; `B1`…`B4` follow it.

| Fault | When | How |
| --- | --- | --- |
| Gap second | `B0` | Neither feed has a report stamped `B0`; the next report's window starts at `B0`. |
| Horizen 429 | `B1 - 5` to `B1 + 55` | The keeper's Horizen endpoint answers HTTP 429 with `Retry-After` = the seconds left of that minute. The bridge is not affected. |
| Deposit fee pumped | `B2 - 5` to `B2 + 115` | The Base portal's `ResourceParams` (slot 1) is rewritten every half second so the next block prices deposit gas at 20 gwei: a publication would burn about 18.5M gas, over Base's 2^24 per-transaction limit and over the keeper's gas cap. The original word is put back afterwards. |
| Closing price relayed 5 minutes late | BTC messages for `B3` | Every bridge message carrying BTC at `B3` (the closing price of the BTC 5-minute round ending at `B3`) is delivered 300 s after its Base block. The BTC round starting at `B3` cannot open in its 210 s window and is voided as unopened; the round ending at `B3` must resolve, not void. |
| Front-running | `B3 + 150` to `B4 + 240` | Every raw transaction the keeper sends is preceded, in the same proxy call, by the identical call from another account with a higher tip. This covers a void (the unopened round above), a relay, the late resolution, creations, publications, openings and resolutions. |

## What it proves, and what it does not

It shows, on forks of the real chains with the real deployed route contracts, the real registry build at its planned address, the real Multicall3, the real messenger, portal and gas-price oracle, and the keeper code unmodified: the keeper's timing per boundary, its call volume, the gas its transactions use, and what it does under each fault, all read from its status lines and from chain events.

It does not show:

- The real Chainlink report service or DON verification. The verifier checks no signature, prices are synthetic (`sim.mjs`), and what the live service answers for gaps, outages and old boundaries is still unobserved.
- The real bridge. Delivery is a `relayMessage` call by the harness, with a fixed delay and gas limit; deposit derivation, its ordering, the L2 deposit gas and any loss of messages are not modelled.
- Real fees. Anvil's base fee decays on the forks' near-empty blocks to a few wei and the rollup fee inputs stay at the fork block's, so what the keeper books (`spend.keeperBookedWei`) is far below mainnet. `spend.costAtLiveFees` prices the gas each keeper transaction actually used at the live base fee and priority fee read at the end of the run, plus the gas-price oracle's rollup fee upper bound and operator fee for its size; `impliedDailyLiveWei` scales whole quarter hours to a day.
- Public endpoint behaviour. The forks answer in about a millisecond; a public endpoint's latency, rate limits and lagging backends are only what the proxy injects.
- The overdue void path. These runs used the seven-day profile and registry build, under which an overdue (Voidable) opened round needs chain time a week ahead, and the keeper refuses a head more than 60 s from the host clock. [2026-10-06: with the five-minute grace (`voidableAfter = end + 360`) that path is reachable within a run, but the rehearsal has not been repeated with the five-minute build. The path, now the one most exposed to attack, is covered by the keeper's simulated tests only.]
- Restarts, reorganisations, a second keeper on the same wallet, or the container image.

Fork artefacts to keep in mind when reading the numbers: Anvil fetches every storage slot it has not seen from the upstream endpoint one at a time, so the harness reads the slots of each next boundary 40 s ahead and warms the publication path once at start (reads only); the first `--plan` on a fresh fork still times out once. Mining a block makes Anvil read one EIP-2935 history slot upstream (one public request per block per fork, and an upstream HTTP 502 made the Base fork panic once), so the harness sets the slots of the next 75 minutes locally at start; a run longer than that goes back to fetching them. If a fork dies anyway the run stops with `harness failed`. Horizen sometimes mines a few blocks in one second after Anvil was busy. The clocks drift by about a second (`load.log`). The Base fork does not apply Base's 2^24 per-transaction gas cap; the proxy gives the answer Base gives instead (above). The first fault run predates that step: there the pumped publication reached the keeper's own `KEEPER_GAS_CAP` check, and it did not show that the keeper read Base's real refusal as an endpoint failure (fixed, see Results).

## Output

| File | Content |
| --- | --- |
| `summary.json` | Per boundary: publications mined, bridge messages, deliveries, openings and resolutions in seconds after the boundary, who sent each (`(other)` = not the keeper), whether all markets opened within 210 s. Round counts, reason codes, reverted keeper transactions, spend, call volume (`rpcLoad`), fault windows with the keeper's waits, sends and settlements inside them, front-runs, relays, host load. |
| `keeper.jsonl`, `keeper-stderr.log`, `keeper-plan.log` | The keeper's own output, unchanged. |
| `state/` | The keeper's journal (`state.json`, `history.jsonl`). |
| `chain.json` | Every round, publication and delivery read from the forks. |
| `rpc-base.jsonl`, `rpc-horizen.jsonl` | Every request to the keeper's endpoints (time, duration, methods, errors); `keeper: false` before the watch loop started. |
| `streams.json` | Every request to the report service stand-in and its status. |
| `deploy/`, `deploy.log` | The registry rehearsal plan, checkpoint and output. |
| `harness.log`, `load.log`, `anvil-*.log` | The harness's own log; host load and fork clock drift each minute; Anvil. |

## Results of 2026-10-05

These runs used the seven-day profile and registry build of 2026-10-05; the five-minute build of 2026-10-06 has not been rehearsed. A closing price relayed 300 s late, as in the fault run below, would still resolve before the five-minute build's void time (end + 360 s).

Evidence in `evidence/keeper-rehearsal-2026-10-05/` (`main/`, `faults/`; `faults-aborted-base-fork-panic/` is the first fault run, stopped when the Base fork panicked on an upstream 502 before any fault, which led to the history-slot step above; the main run predates that step). Host load averages 1.5 to 3.5 on 14 cores throughout; the Vela stack was not running during these runs (Docker listed only unrelated containers).

- Main, 24 minutes, boundaries 17:40 to 18:00 UTC (17:45 and 18:00 with all four markets): every publication mined 3 s (BTC) and 5 s (ETH) after its boundary, delivered after 27 to 30 s, every market opened 29 to 34 s after its boundary, every round resolved 33 to 40 s after its end. No reverts, no waits other than `AWAITING_DELIVERY`, `KEEPER_BASE_BEHIND_BOUNDARY`, `KEEPER_TX_PENDING`. A publication used about 1.11M gas, a registry call about 125k. At the live fees of the day that is about 0.0039 ETH a day on Base and 0.00025 ETH on Horizen.
- Main, again with the final harness (`main-after-fixes/`, keeper 19:37 to 20:01 UTC, after the fixes below): the same picture. Publications mined 3 s and 5 s after each boundary, delivered after 27 to 30 s, every market opened 28 to 33 s after its boundary (20:00 with all four), every round resolved 29 to 37 s after its end; no reverts, the same three waits, the same gas (11.1M on Base for 10 publications, 5.75M on Horizen for 46 registry calls), about 0.0039 ETH a day on Base and 0.00025 ETH on Horizen. Horizen's busiest boundary minute was 242 calls, at most 125 in 10 s.
- Faults: after the gap second, the Horizen 429 and the deposit fee pump (at a four-market boundary) every market opened inside 210 s (30 to 32 s, 56 to 57 s, 156 to 159 s). With the closing price relayed 300 s late, the round resolved 304 s after its end and was never voided; the BTC round starting at that boundary could not open and was voided at 212 s, as it should be. Under front-running the keeper's seven registry transactions reverted on chain and were not retried, while its publications and its relay went through as duplicate bridge messages. The keeper never stopped (exit 0 on SIGTERM).

### Acted on (2026-10-05, after the runs above)

- **Keeper defect, fixed.** Base does apply its 2^24 cap to `eth_estimateGas` (one read-only probe of `mainnet.base.org`: `-32003 out of gas: gas required exceeds: 16777216`; `eth_call` is not capped, so a publication's simulation still passes). The keeper classified that answer as an endpoint failure (`RPC_ESTIMATEGASEXECUTIONERROR`) and backed off all of Base, 1 s doubling to 60 s, so after a fee spike it could publish up to 55 s after the fee fell (in simulation: T+185 for a fee back at T+130, too late for the opening window with a 24 to 30 s delivery). It now reads "gas required exceeds" (Base, geth and Anvil wordings) as `KEEPER_GAS_CAP` on that action, which retries at most 15 s apart inside an opening window. The first fault run could not show this because the fork estimates past the cap; the harness now answers as Base does.
- **Keeper defect, fixed.** A timeout inside a Multicall3 read was reported as `RPC_CONTRACTFUNCTIONEXECUTIONERROR` (the cold-fork `--plan` failure), which reads like a contract failing. It is `RPC_TIMEOUTERROR` again, as for an unwrapped timeout.
- **Keeper README.** A lone `reverted` registry step after which the round moves on is a lost race, not an alert; a raced publication or relay costs a second bridge message (the route contract accepts repeats; the keeper cannot see a same-block competitor). The boundary-minute call figures at fast endpoints are added to Limits.
- **Harness.** Base's estimate cap as above; a directory that already holds a run is refused (a second run on the same day used to write over the first); the summary starts at the first boundary the keeper can have rounds for.
- `faults-after-fixes/` (keeper 19:04 to 19:35 UTC): gap second, opened at 30 to 31 s; Horizen 429, one request refused, all four markets opened at 56 to 59 s; deposit fee pump, 22 estimates refused in Base's words, the keeper waited with `KEEPER_GAS_CAP` per publication (never a Base backoff), published 10.6 s after the fee came back, opened at 153 to 155 s; BTC closing price 300 s late, relayed twice, resolved at 305 s and never voided, the BTC round starting there voided at 213 s; front-running, 16 front-runs, the keeper's 13 registry transactions reverted once each and were not retried. Keeper exit 0, nothing on stderr. Not changed: the registry planner's own Anvil still takes a port the operating system picks (contracts tooling, outside this folder).

