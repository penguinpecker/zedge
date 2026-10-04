# Deployment gas snapshot

Measured 2026-10-04 at approximately 05:07 UTC against commit `d27ee453d6f20d1851cc391515c0ecbb5c22ecef`. No transaction was signed or broadcast.

This estimate covers **only `PythBoundaryOracle` and `RoundRegistry`**, the two original contracts currently written. It does not price a complete ZEDGE or Vela launch.

| Network | Snapshot estimate, including data-fee upper bound | Illustrative buffered gas allowance | ZEN for gas |
| --- | ---: | ---: | ---: |
| Base mainnet, hypothetical target | 0.00001547 ETH | 0.0001 ETH | 0 |
| Horizen mainnet, current code's target | 0.000002568 ETH | 0.00002 ETH | 0 |

These are alternative deployment targets, not two required deployments. Base is not allowed by the current simulation script; its number is an estimate of the compiled contracts on that network. A supported Horizen oracle verifier is still unresolved. Both amounts change with gas prices, bytecode, actual constructor inputs and transactions. Re-estimate the exact reviewed release immediately before deployment.

## Calculation

- Solc 0.8.30, Paris EVM, optimizer 200 runs.
- Foundry deployment gas: adapter 770,620; registry 1,772,293.
- Public RPC `eth_estimateGas` creation estimates: adapter 778,123; registry 1,788,143.
- Base: block 52,150,543; quoted gas price 6,000,000 wei; total 15,466,311,928,190 wei.
- Horizen: block 27,693,153; quoted gas price 1,000,252 wei; total 2,567,919,984,463 wei.
- Formula: sum of each creation gas estimate × quoted gas price + `GasPriceOracle.getL1FeeUpperBound(initcodeBytes + 160)` + the queried operator fee, which was zero.
- OP Stack gas oracle: `0x420000000000000000000000000000000000000F`.

The read-only creation calls used temporary state overrides with `STOP` code at arbitrary dependency addresses to satisfy constructor code-length checks. They do **not** verify a real oracle, token or deployment configuration. No state was changed. Foundry's execution-only figures differ from the RPC creation estimate because the latter also estimates the outer transaction.

## ETH, ZEN and Vela

[Horizen uses ETH for gas](https://docs.horizen.io/horizen-chain/tokens-and-gas/gas-on-horizen/), as does Base. [ZEN is not a gas token](https://docs.horizen.io/horizen-chain/tokens-and-gas/zen-token/). Deploying on Horizen requires ETH **on Horizen**; ETH remaining on Base does not pay the destination transaction. Bridging also has its own source-chain cost.

The inspected [Vela v0.2.0 registration path](https://github.com/HorizenOfficial/vela/blob/335724c95ba7b58d64ec97bbb67d18640123278e/contracts/contracts/ProcessorEndpoint.sol#L317) requires deployer permission, an available application slot and an ETH payment meeting the configured minimum. No required ZEN transfer was found in that path. This does not establish hosted-service prices or future commercial requirements. [Official Vela availability](https://docs.horizen.io/vela/introduction/) still lists Base Sepolia and Horizen testnet, with mainnet on the roadmap.

The table excludes Vela registration/runtime fees, oracle infrastructure and updates, bridging, custody integration, trading collateral/liquidity, hosting, ongoing operator transactions and audits. Those costs are not yet quoted. Current local development and the estimates above require **no real ETH or ZEN**; testnet work uses faucet ETH.

Fee references: [Base execution and data fees](https://docs.base.org/specifications/transactions/network-fees), [Horizen gas](https://docs.horizen.io/horizen-chain/tokens-and-gas/gas-on-horizen/).
