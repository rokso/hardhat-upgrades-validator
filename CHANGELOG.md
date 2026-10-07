# Changelog

## Unreleased (0.1.0-alpha.2)

Chain-sourced baselines: the "before" layout is now the implementation each proxy runs on-chain, not a layout stamped into the deployment file.

- `validate-upgrade` and `assertProxyUpgrade` / `validateProxyUpgrade` read the implementation from the proxy's ERC-1967 slot (or beacon) and validate against its layout. New `--baseline` / `baseline` option: `auto` (default), `chain`, `deployment`. Every result names its baseline.
- Layout records keyed by implementation address under `deployments/<network>/.storage-layouts/implementations/`, bound to the exact runtime code by hash. Missing records are rebuilt from the implementation's verified source (Etherscan v2 or any Etherscan-compatible explorer) after proving the rebuild matches the deployed code.
- Bytecode comparison masks immutables (`immutables-only`), so UUPS implementations (`UUPSUpgradeable.__self`) match on-chain code. A match only after stripping metadata (`metadata-only`) is reported but never accepted as proof of a layout, and metadata is only stripped when the tail is a CBOR map.
- Once the chain names a proxy's implementation, only that implementation's layout is used; `auto` never substitutes another implementation's record.
- Explorer outages, HTTP 429/5xx, unsupported chains and compiler-download failures count as "unavailable"; rejected API keys and checksum failures are hard errors. `ETHERSCAN_API_KEY` is never sent to a non-Etherscan `apiUrl`, and custom explorers may be keyless.
- Proxies are discovered from the chain (ERC-1967 implementation or beacon slot) and file contents, never from file names or an `implementation` field, which hardhat-deploy v2 does not write. Of several files at one proxy address, the one whose code is the proxy's own is skipped, with immutable positions inferred when a prebuilt proxy artifact lists none. A failure at one address is reported for that address only.
- A proxy index under `.storage-layouts/proxies/` records which implementation each proxy ran when last observed, so the compile hook and other offline runs pick the right record. Offline results name the block it was observed at.
- The deploy hook looks only at deployment files the deploy changed, and also records freshly deployed implementations whose upgrade is still queued (same contract name; a renamed contract is recorded once its upgrade executes).
- The compile hook names every proxy it skips and no longer prints "All storage layout checks passed" when it skipped any.
- `record-baseline --from-chain` rebuilds records from verified source for proxies running code the local tree has moved past.
- New `hardhat-upgrades-validator/onchain` entry point with no Hardhat dependency, usable from plain ESM scripts and other tooling.
- New config: `upgradesValidator.explorers`, `upgradesValidator.solcCacheDir`.

### Breaking (alpha)

- The deploy hook and `record-baseline` write `.storage-layouts/` records; they no longer write `upgradeStorageLayout`. The field is still read as a deprecated fallback.
- `record-baseline` needs an RPC, and `--force` no longer skips the bytecode check.
- `validate-upgrade --all` covers every proxy found on the chain (offline: in the proxy index), not only those with a stamped baseline. The `implementation` deployment field is no longer read.
- With a reachable network, `upgradeStorageLayout` is no longer a fallback for a proxy whose implementation the chain reports: if that implementation's layout cannot be obtained (no record, no explorer), `validate-upgrade` reports an error and `assertProxyUpgrade` throws `BaselineUnavailableError`, where alpha.1 passed. Record the layout once (`record-baseline --contract <name>`, or configure an explorer), or opt out with `--baseline deployment`.

## 0.1.0-alpha.1 (2026-04-08)

Initial alpha release.

- Storage layout compatibility validation for upgradeable proxy contracts, powered by `@openzeppelin/upgrades-core`
- Compile hook: auto-validates all recorded baselines after each `hardhat compile`
- `record-baseline` task: stamps current storage layout into deployment JSONs as the upgrade baseline
- `validate-upgrade` task: compare baselines vs compiled artifacts on demand or in CI
- `assertProxyUpgrade` / `validateProxyUpgrade` proxy helpers (import from `hardhat-upgrades-validator/proxy`)
- `newImpl` option on proxy helpers to validate against a different implementation artifact
- NatSpec annotations: `renamed-from`, `retyped-from`, `unsafe-allow` — on state variables, struct members, and contracts
- ERC-7201 namespace storage support
- hardhat-deploy v2 deploy hook: auto-stamps baseline after each proxy deploy
- Contract-level safety checks: constructor, delegatecall, selfdestruct, immutables, state variable assignment, external library linking
