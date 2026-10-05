# Security policy

ZEDGE's on-chain/private trading implementation is under development. It has not undergone an independent security audit and is not accepting real collateral. Passing CI does not authorize a production release.

Please report vulnerabilities through this repository's **Security → Report a vulnerability** private reporting channel. Do not publish private keys, personal trading data, exploit transactions or unredacted logs in an issue. Include the affected commit and a minimal reproduction with test assets.

Never send wallet seed phrases or private keys to maintainers. Deployment uses a locally controlled signer and reviewed configuration. Changes to dependencies, oracle contracts, enclave measurements, custody, key derivation or financial accounting require a new scoped review. The planned Streams round registry can be upgraded by its single owner key, and an upgrade can change its rules and stored results; an upgrade or ownership transfer is a change to an oracle contract and needs the same review.

See [the security verification record](security/README.md) and [release dependencies](research/README.md#questions-that-close-the-production-gates) for the current boundaries. The public V1 site is a paper-trading demo; the development chain interface never substitutes demo balances for live state.
