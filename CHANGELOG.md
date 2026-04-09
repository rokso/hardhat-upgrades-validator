# Changelog

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
