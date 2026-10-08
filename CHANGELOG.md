# Changelog

## Unreleased (0.1.0-alpha.3)

The baseline is now what each proxy runs on chain.

### Added

- Chain baselines: the old layout is the layout of the implementation each proxy runs, read from its ERC-1967 slot (or beacon), from layout records keyed by implementation address under `deployments/<network>/.storage-layouts/`. Records are proven against the deployed bytecode and meant to be committed.
- `record-baseline --from-chain` rebuilds a record from verified source (Etherscan v2 or any Etherscan-compatible explorer) for proxies running code the local tree has moved past. New config: `upgradesValidator.explorers`, `upgradesValidator.solcCacheDir`.
- Proxies are found from the chain and file contents, never from file names. A proxy index records which implementation each proxy ran, refreshed by every run that reads the chain, so the compile hook and RPC-less CI validate offline ("as of block N").
- Results say where the baseline came from (`ValidationResult.baseline`).
- The proxy helpers take `provider` (for in-process networks).
- Layouts are proven and rebuilt by [slotdiff](https://github.com/rokso/slotdiff), a new framework-agnostic package this plugin now depends on. Use it directly outside Hardhat.

### Changed

- A local build proves its layout only when it embeds solc's metadata hash. Builds with `bytecodeHash: "none"` or `appendCBOR: false` compile identical code for different layouts, so their layouts are no longer recorded from the local build.
- A layout record is used only on the chain it was made on.
- An upgrade made by `hardhat deploy` is checked against what the proxy ran on chain just before the deploy; an incompatible one, or one that cannot be checked, exits 1, and the error names the implementation to roll back to.

### Fixed

- With `bytecodeHash: "none"`, two contracts that compile to identical code could swap storage layouts, safety errors and proxy kind, because OZ looks contracts up by bytecode. The lookup now lands on the artifact asked for. This also affects 0.1.0-alpha.2.

### Breaking (alpha)

- Adopting: run `record-baseline --all --network <name>` once per network (add `--from-chain` for proxies running older code), and commit `.storage-layouts/`. Online, a proxy whose implementation has no record fails until it is recorded (with an explorer configured, validation records it on first use).
- The deploy hook and `record-baseline` write records and the proxy index, not `upgradeStorageLayout`. The field is deprecated and read only as an offline fallback, with a warning. `record-baseline` needs an RPC.
- `validate-upgrade --all` covers every proxy found on the chain (offline: in the proxy index).

## 0.1.0-alpha.2 (2026-10-08)

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
- Deployment files are written atomically: a crash or Ctrl-C mid-write no longer leaves one cut off.
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
