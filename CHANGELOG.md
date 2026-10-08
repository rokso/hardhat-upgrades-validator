# Changelog

## Unreleased (0.1.0-alpha.2)

All checks, tags and error messages are now OpenZeppelin's. This plugin keeps the baseline and one annotation for struct members.

### Fixed

- All 14 OZ safety checks run; alpha.1 silently skipped 8, including every initializer check. `missing-public-upgradeto` needs the proxy kind: pass `--proxy-kind uups` or `kind: "uups"`.
- Any storage change OZ reports fails the upgrade; unrecognized changes used to pass.
- An incompatible upgrade through `hardhat deploy` no longer overwrites its baseline: the old one is kept and the run exits 1.
- Contracts that cannot be checked now fail instead of being skipped: missing baseline, missing artifact, missing from the validation cache, or an error during validation.
- The validation cache can no longer silently miss contracts after a failed, partial or interrupted build.
- `--network` now applies to `validate-upgrade` and `record-baseline`.
- `hardhat deploy` without `--network` no longer fails, and nothing is recorded under `HARDHAT_FORK`.
- The compile hook names skipped contracts instead of reporting that all checks passed.
- No deprecated Hardhat hooks; `@openzeppelin/upgrades-core` 1.46.0.

### Breaking (alpha)

- Requires Hardhat 3.6+ and Node.js 22.
- Use OZ's tags: `@custom:oz-renamed-from`, `@custom:oz-retyped-from`, `@custom:oz-upgrades-unsafe-allow`. The old `@custom:upgrades-validator-*` tags on state variables and contracts are ignored. Struct-member tags are unchanged (`<old> <member>`; the old README had the order reversed).
- `unsafeAllow` / `--unsafe-allow` take OZ's error kinds. `variable-renamed` became `unsafeAllowRenames` / `--unsafe-allow-renames`; `type-changed` is gone (use `@custom:oz-retyped-from`).
- Contracts may newly fail on the checks alpha.1 skipped.
- An existing deployment without a baseline now fails; run `record-baseline` once for it.
- `ValidationResult` has `storage` (OZ's report) and `safetyErrors` instead of `errors`; `ValidationError` and `filterSafetyErrors` are removed.

## 0.1.0-alpha.1 (2026-04-08)

Initial alpha release.

- Storage layout compatibility validation for upgradeable proxy contracts, powered by `@openzeppelin/upgrades-core`
- Compile hook: auto-validates all recorded baselines after each `hardhat compile`
- `record-baseline` task: stamps current storage layout into deployment JSONs as the upgrade baseline
- `validate-upgrade` task: compare baselines vs compiled artifacts on demand or in CI
- `assertProxyUpgrade` / `validateProxyUpgrade` proxy helpers (import from `hardhat-upgrades-validator/proxy`)
- `newImpl` option on proxy helpers to validate against a different implementation artifact
- NatSpec annotations: `renamed-from`, `retyped-from`, `unsafe-allow`: on state variables, struct members, and contracts
- ERC-7201 namespace storage support
- hardhat-deploy v2 deploy hook: auto-stamps baseline after each proxy deploy
- Contract-level safety checks: constructor, delegatecall, selfdestruct, immutables, state variable assignment, external library linking
