# hardhat-upgrades-validator

Hardhat v3 plugin that validates storage layout compatibility for upgradeable proxy contracts managed by [hardhat-deploy v2](https://github.com/wighawag/hardhat-deploy).

Powered by [@openzeppelin/upgrades-core](https://github.com/OpenZeppelin/openzeppelin-upgrades/tree/master/packages/upgrades-core), the same engine that backs `@openzeppelin/hardhat-upgrades`. Every check, annotation and error message is OpenZeppelin's: this plugin adds the baseline that hardhat-deploy projects lack (OZ keeps it in `.openzeppelin/<network>.json`, which hardhat-deploy does not write) and one annotation for struct members.

## Requirements

- Hardhat **v3.6** or later
- hardhat-deploy **v2** (optional; the proxy helper works with any deploy tool)
- Node.js **22.13** or later

## Installation

```sh
npm install --save-dev hardhat-upgrades-validator
# or
pnpm add -D hardhat-upgrades-validator
```

## Quick start

**1. Register the plugin** in `hardhat.config.ts`:

```ts
import upgradesValidator from "hardhat-upgrades-validator";
import hardhatDeploy from "hardhat-deploy";

const config: HardhatUserConfig = {
  plugins: [upgradesValidator, hardhatDeploy],

  solidity: {
    version: "0.8.24",
    // The plugin asks solc for storageLayout and ast itself, added to
    // whatever outputSelection you configure.
  },

  upgradesValidator: {
    enableCompileHook: true, // default
    networks: "all", // default: validate every network in deployments/
  },
};

export default config;
```

That's the setup. See [Workflow](#workflow) for the deploy, baseline, and upgrade flow.

## How it works

The plugin operates through four validation paths, all running the same OZ checks:

| Path                        | When it runs       | What it does                                                                       |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **Compile hook**            | `hardhat compile`  | Auto-validates baselines; networks filtered by `upgradesValidator.networks` config |
| **`validate-upgrade` task** | CI / manual        | Compares baselines vs current artifacts; `--network` flag to target one network    |
| **`assertProxyUpgrade`**    | Scripts, CI, tests | Throws if storage is incompatible; typically used just before upgrading            |
| **`validateProxyUpgrade`**  | Scripts, CI, tests | Same, returns a result instead of throwing                                         |

Each path runs two OZ checks and fails on either. (The compile hook is the exception for a contract it cannot check, such as one missing from the validation cache: it names it as skipped and does not fail the build. The other paths fail.)

- **Storage layout:** OZ's comparison of the baseline layout with the compiled one (`getStorageUpgradeReport`). Any change OZ reports fails the upgrade.
- **Upgrade safety:** all of OZ's checks on the new implementation (`getErrors`): constructors, `delegatecall`, `selfdestruct`, immutables, inline assignments, linked libraries, initializers, and a missing `upgradeTo` for UUPS proxies. The proxy kind is inferred by OZ from the new implementation unless you pass `--proxy-kind` (task) or `kind` (proxy helpers). OZ infers `uups` only when the new implementation has `upgradeTo`, so **an implementation that drops `upgradeTo` (which bricks a UUPS proxy) is caught only when you pass the kind**; the compile hook cannot, since it has no kind setting.

The ValidationData cache (`cache/hardhat-upgrades-validator/validations-*.json`, named after the plugin's cache format and the upgrades-core version) is shared across all four paths so build-info files are parsed only once per compile. It is removed while a build runs and written back only when every compiled job was validated, so a failed or interrupted build forces a full recompile next time instead of leaving contracts out. A contract missing from the cache fails `validate-upgrade`, `record-baseline` and the proxy helpers; the compile hook names it as skipped.

### Where the baseline comes from

The "before" layout is the layout of the implementation the proxy **runs right now**, read from the chain. Deployment files describe the latest build, which drifts from what a proxy runs whenever upgrades are lazy (a proxy stays on an older implementation until it needs a new one) or queued (a multisig executes the upgrade later). The chain does not drift.

For each proxy, the plugin:

1. Reads the implementation from the proxy's ERC-1967 slot (or its beacon).
2. Looks up a layout record for that implementation address under `deployments/<network>/.storage-layouts/implementations/`.
3. If there is none and an explorer is configured, rebuilds it: fetches the implementation's verified source from an Etherscan-compatible explorer, compiles it with the exact solc version, **proves** the result matches the deployed code (immutables masked), extracts the layout with the same oz-core pipeline the local build uses, and records it. Without an explorer, record it once with `record-baseline`.

Deployed code never changes, so a record keyed by implementation address cannot go stale, and one record serves every proxy that shares the implementation.

### Which deployments are proxies

hardhat-deploy v2 records no implementation address, and its file names (`X`, `X_Proxy`, `X_Implementation`) are a convention, not something to trust. So proxies are found from the chain and file contents only:

- A deployment is a proxy when the chain has an ERC-1967 implementation or beacon slot set at its address. A bare implementation or a plain contract has neither, and is skipped.
- Several files can share a proxy address (hardhat-deploy v2 writes `X` and `X_Proxy` there). A file whose code is the code at that address describes the proxy contract itself and is skipped; the others describe the code behind the proxy, and their artifact is the new side of the comparison. Immutables are masked for that comparison. Their positions come from the file, else the local build, else are inferred from the code (solc leaves each immutable as a zeroed `PUSH32` operand): hardhat-deploy v2's prebuilt proxy artifacts, such as its optimized transparent proxy with an immutable admin, list none.
- A proxy whose only file describes the proxy contract itself is reported, not validated: nothing names its new code.
- An address that cannot be read (an RPC error, a beacon whose `implementation()` reverts) is reported as an error for that address; the rest of the network is still validated.
- The RPC must answer for the chain the deployments are on. If its chain id differs from one recorded for the network (hardhat-deploy's `.chain` or older `.chainId` file, or the proxy index), the network fails instead of finding no proxies. hardhat-deploy's fork mode (`HARDHAT_FORK`) is exempt: its fork keeps its own chain id. A proxy the index knows that the chain no longer shows as one, while a deployment still sits at its address, is an error too, never silently dropped.

Every run that reads a proxy from the chain (`validate-upgrade`, `record-baseline`, the proxy helpers, the deploy hook) refreshes a **proxy index** under `.storage-layouts/proxies/`: which implementation each proxy ran when last observed, and which deployments describe its code. Offline runs read it. It is written only from what the chain reports, so a queued or discarded upgrade never moves it; it goes stale when a proxy is upgraded outside these runs, until the next run with an RPC, and offline results name the block it was observed at.

The proxy index (then the deprecated `upgradeStorageLayout` field) is used only while the chain **cannot say which implementation the proxy runs** (no RPC, no proxy slot), and the result says so. Once it has named one, only that implementation's layout is acceptable: if no record exists and it cannot be rebuilt (no explorer configured, unverified source, explorer or compiler download unreachable), validation fails rather than compare against another implementation's layout. Untrustworthy answers fail too, such as verified source that does not compile to the deployed code. A match only after stripping metadata is not accepted as proof: variables no code reads, gap sizes and field names never reach the bytecode, so two layouts can share the same code. Every result names its baseline:

```
  [OK]   "mainnet/MyToken": storage layout validation passed.
         baseline: chain, implementation 0x5fbd… (immutables-only, stored record)
```

The compile hook always runs offline (compiling must not need an RPC), so it validates the proxies the proxy index lists, against stored records. An indexed implementation with no record is reported as skipped there, never replaced by the deprecated field; offline, `validate-upgrade` and the proxy helpers fail for it (`LayoutUnavailableError`), since a proxy the index knows is not a first deployment. `validate-upgrade` and the proxy helpers read the chain, and may write under `deployments/<network>/.storage-layouts/` and download a compiler the first time they rebuild a layout.

Hardhat 3 gives every new connection (`network.create()`) to an in-process (EDR) network a fresh chain. In a deploy script running on such a network, pass the script's own provider (`assertProxyUpgrade(hre, "MyToken", { provider })`) so validation sees the same chain; the deploy hook cannot, and skips recording there.

## Workflow

> **Adding to an existing project?** Record each proxy's implementation once, then commit `deployments/<network>/.storage-layouts/`:
>
> ```sh
> npx hardhat compile
> npx hardhat record-baseline --all --network mainnet               # proxies running the current build
> npx hardhat record-baseline --all --network mainnet --from-chain  # proxies running older code (needs an explorer)
> ```
>
> With an explorer configured, validation also records a missing implementation on first use.

### Initial deploy

```ts
// deploy/00_deploy_mytoken.ts
import hre from "hardhat";
import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
import { deployScript, artifacts } from "../rocketh/deploy.js";

export default deployScript(
  async ({ deployViaProxy, namedAccounts }) => {
    const { deployer } = namedAccounts;

    // No baseline yet: this is a no-op on first deploy.
    await assertProxyUpgrade(hre, "MyToken");

    await deployViaProxy(
      "MyToken",
      { account: deployer, artifact: artifacts.MyToken },
      {
        owner: deployer,
        proxyContract: "UUPS",
        execute: { methodName: "initialize", args: [deployer] },
      },
    );
  },
  { tags: ["MyToken"] },
);
```

After the deploy, the hook records the layout of the implementation the new proxy runs (when the chain runs the local build) and indexes the proxy. It needs `--network`, and records nothing under hardhat-deploy's fork mode (`HARDHAT_FORK`), on an in-process network, or without a reachable RPC.

### Standard upgrade

Edit `MyToken.sol`, compile, then deploy:

```ts
// deploy/01_upgrade_mytoken.ts
import hre from "hardhat";
import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
import { deployScript, artifacts } from "../rocketh/deploy.js";

export default deployScript(
  async ({ deployViaProxy, namedAccounts }) => {
    const { deployer } = namedAccounts;

    // Reads the implementation MyToken's proxy runs from the chain, and validates
    // against the freshly compiled MyToken artifact. Throws if incompatible.
    await assertProxyUpgrade(hre, "MyToken");

    await deployViaProxy(
      "MyToken",
      { account: deployer, artifact: artifacts.MyToken },
      { owner: deployer, proxyContract: "UUPS" },
    );
  },
  { tags: ["MyTokenUpgrade"] },
);
```

```sh
npx hardhat compile   # compile hook validates the recorded baseline immediately
npx hardhat deploy --tags MyTokenUpgrade --network mainnet
```

After the deploy, the hook records the new implementation and moves the proxy index once the chain shows the upgrade (a queued upgrade leaves the index alone until it executes). It also checks every upgrade the run made, against what the chain ran just before the deploy (the proxy index when the chain could not be read then): if the new implementation is not storage-compatible with the old one, or either side has no layout to compare, the deploy has already happened, so the hook prints why and exits 1. For an incompatible upgrade it also names the implementation the proxy ran before: an upgrade alone writes no storage, so upgrading back to it undoes the change as long as nothing has written since. Call `assertProxyUpgrade` before deploying, as above, to stop it first: the compile hook's verdict does not stop `hardhat deploy`. From then on the baseline is what the chain runs, the new implementation.

### Upgrading to a new implementation contract (MyToken to MyTokenV2)

When the new implementation lives in a separate file (`MyTokenV2.sol`) and the proxy deployment record is still named after the old contract (`MyToken`), use `newImpl` to tell the validator which artifact to check:

```ts
// deploy/01_upgrade_mytoken_v2.ts
import hre from "hardhat";
import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
import { deployScript, artifacts } from "../rocketh/deploy.js";

export default deployScript(async ({ deployViaProxy, namedAccounts }) => {
  const { deployer } = namedAccounts;

  // Old layout: the implementation MyToken's proxy runs (from the chain),
  // new layout from compiled MyTokenV2 artifact.
  await assertProxyUpgrade(hre, "MyToken", { newImpl: "MyTokenV2" });

  await deployViaProxy(
    "MyToken",
    { account: deployer, artifact: artifacts.MyTokenV2 },
    {
      owner: deployer,
      proxyContract: "UUPS",
    },
  );
});
```

## Configuration

All options are optional. `networks` and `enableCompileHook` apply to the compile hook only; `explorers` and `solcCacheDir` apply wherever a chain baseline is rebuilt.

```ts
upgradesValidator: {
  // Enables the compile hook: namespaced compilation pass, ValidationData cache,
  // and auto-validation of every indexed proxy after each compile.
  // Set to false to disable the hook (a build then removes the cache).
  enableCompileHook: true,

  // Networks to validate during `hardhat compile`.
  // "all" validates every directory found under deployments/.
  // Pass a string array to restrict to specific networks.
  networks: "all",

  // Explorer used to rebuild a chain baseline from verified source, keyed by
  // network name. apiUrl defaults to Etherscan v2, which covers every chain
  // Etherscan indexes; set it for an Etherscan-compatible explorer (e.g.
  // Blockscout). apiKey falls back to ETHERSCAN_API_KEY for Etherscan only:
  // that key is never sent to another host, and a custom apiUrl may be keyless.
  // apiKey takes a string or a configVariable("...") from hardhat/config,
  // which is read only when a baseline has to be rebuilt (a variable that
  // cannot be read then is an error, not "no key").
  explorers: {
    mainnet: { apiKey: configVariable("ETHERSCAN_API_KEY") },
    someL2: { apiUrl: "https://blockscout.example.org/api", apiKey: "..." },
  },

  // Where compilers for rebuilding verified source are cached. Hardhat's own
  // compiler cache is checked after it, so a version the project already
  // compiled with needs no download.
  solcCacheDir: undefined, // default: <os cache>/hardhat-upgrades-validator/compilers
},
```

The compile hook's second, namespaced compilation goes through Hardhat's `compileBuildInfo`, which for solc downloads the compiler by version: a compiler `path` configured for the project is not used, so an offline machine with a custom compiler fails that pass (and the build). Other compiler types (solx, for example) need Hardhat 3.10 or later for it.

Only standard-json verifications can be rebuilt: flattened and multi-file verifications do not record every compiler setting (`viaIR` among them). For those implementations, record the layout with `record-baseline` from a matching local build.

## Tasks

### `record-baseline`

Records the layout of the implementation each proxy runs on-chain, keyed by implementation address under `deployments/<network>/.storage-layouts/`, and refreshes the proxy index. Run it once when adopting the plugin, and whenever a proxy runs an implementation with no record. Needs an RPC for the network: without one it fails (exit code 1).

```sh
npx hardhat record-baseline --all --network mainnet
npx hardhat record-baseline --contract MyToken --network mainnet --from-chain
npx hardhat record-baseline --all --network mainnet --force   # overwrite existing records
```

| Flag                | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--contract <name>` | Record a single proxy                                                               |
| `--all`             | Record every proxy found on the chain                                               |
| `--network <name>`  | Hardhat's global option: restrict to that network                                   |
| `--from-chain`      | Rebuild the layout from the implementation's verified source instead of local build |
| `--force`           | Overwrite existing records. Never skips the bytecode proof.                         |

Without `--from-chain`, the local build's layout is recorded only if the chain runs exactly that build (`exact` or `immutables-only`) and the build embeds solc's metadata hash. Builds with `bytecodeHash: "none"` or `appendCBOR: false` cannot be proven this way: matching code does not prove matching source, so their layouts are never recorded. If the local source has moved on since the implementation was deployed, the task says so and points at `--from-chain`. A record is never written for code that is not on-chain.

### `validate-upgrade`

Compares the layout each proxy runs against the current compiled artifacts. Useful in CI after a compile step and before deploying.

```sh
npx hardhat validate-upgrade --all
npx hardhat validate-upgrade --contract MyToken --network mainnet
npx hardhat validate-upgrade --all --unsafe-allow "constructor delegatecall"
npx hardhat validate-upgrade --all --unsafe-skip-storage-check   # emergency escape hatch
```

| Flag                          | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `--contract <name>`           | Validate a single contract                            |
| `--all`                       | Validate every proxy (chain, else the proxy index)    |
| `--network <name>`            | Hardhat's global option: restrict to that network     |
| `--unsafe-allow <kinds>`      | Space/comma-separated OZ error kinds to allow         |
| `--unsafe-allow-renames`      | Allow renames without `@custom:oz-renamed-from`       |
| `--unsafe-skip-storage-check` | Skip all storage checks (emits a loud warning)        |
| `--proxy-kind <kind>`         | Override proxy kind (`transparent`, `uups`, `beacon`) |

The task fails (exit code 1) when a proxy cannot be checked: no baseline can be found for it, its artifact is missing, or it is missing from the validation cache. A deployment is skipped only on positive knowledge: the chain shows it is not a proxy, or that the file describes the proxy contract itself, or (offline) the proxy index lists another file for its proxy. Offline, `--all` names the deployments the index does not cover, which it cannot classify.

## Proxy helper API

Import from `hardhat-upgrades-validator/proxy`:

```ts
import {
  assertProxyUpgrade,
  validateProxyUpgrade,
  StorageLayoutError,
} from "hardhat-upgrades-validator/proxy";
```

### `assertProxyUpgrade(hre, contractName, options?)`

Throws `StorageLayoutError` if the upgrade is storage-incompatible. Use this inside deploy scripts to abort before touching the chain.

```ts
await assertProxyUpgrade(hre, "MyToken");

// With options:
await assertProxyUpgrade(hre, "MyToken", {
  unsafeAllow: ["constructor"], // OZ error kinds
  unsafeAllowRenames: false,
  unsafeSkipStorageCheck: false, // set to true to skip all storage checks (emergency escape hatch)
  newImpl: "MyTokenV2", // validate against this artifact instead of what's in the deployment record
});
```

### `validateProxyUpgrade(hre, contractName, options?)`

Both throw when the deployment exists but no baseline can be found for it: that is not a first deployment, so there is nothing to check against. Run `record-baseline` first.

Same logic, but returns a `ValidationResult` instead of throwing. Use when you want to inspect or log the result programmatically.

```ts
import { formatValidationResult } from "hardhat-upgrades-validator";

const result = await validateProxyUpgrade(hre, "MyToken");
if (!result.ok) {
  // result.storage is OZ's storage report, result.safetyErrors OZ's safety errors.
  console.error(formatValidationResult("MyToken", result));
  process.exit(1);
}
```

### `ProxyUpgradeOptions`

| Option                   | Type                | Description                                                                                                                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsafeAllow`            | `UnsafeAllowKind[]` | OZ error kinds to allow for this call                                                                                                           |
| `unsafeAllowRenames`     | `boolean`           | Allow renames without `@custom:oz-renamed-from` (OZ's option)                                                                                   |
| `unsafeSkipStorageCheck` | `boolean`           | Skip all storage checks                                                                                                                         |
| `newImpl`                | `string`            | Validate against a different compiled artifact instead of the one recorded in the deployment JSON                                               |
| `kind`                   | `ProxyKind`         | `"transparent"`, `"uups"` or `"beacon"`; pass `"uups"` so a dropped `upgradeTo` is caught                                                       |
| `provider`               | `EthProvider`       | Provider to read the chain with. Defaults to a new connection to the `--network` network; pass the deploy script's own on an in-process network |

## unsafe-allow kinds

`--unsafe-allow` (validate task) and `unsafeAllow` (proxy helper options) take OZ's error kinds, the same values as OZ's `unsafeAllow`. Each allows one class of safety error for the whole call.

| Kind                          | What it allows                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| `constructor`                 | A constructor                                                         |
| `delegatecall`                | Use of `delegatecall`                                                 |
| `selfdestruct`                | Use of `selfdestruct`                                                 |
| `state-variable-immutable`    | An immutable variable                                                 |
| `state-variable-assignment`   | A state variable assigned at declaration                              |
| `external-library-linking`    | A linked external library                                             |
| `struct-definition`           | Deprecated by OZ; structs are checked automatically                   |
| `enum-definition`             | Deprecated by OZ; enums are checked automatically                     |
| `internal-function-storage`   | An internal function pointer stored in storage                        |
| `missing-public-upgradeto`    | A UUPS implementation without a public `upgradeTo`/`upgradeToAndCall` |
| `missing-initializer`         | No initializer although a parent has one                              |
| `missing-initializer-call`    | An initializer that does not call a parent's initializer              |
| `duplicate-initializer-call`  | An initializer that calls a parent's initializer twice                |
| `incorrect-initializer-order` | Parent initializers called out of order (OZ reports it as a warning)  |

Storage layout changes have no kind: approve each one with a tag (below), or use `unsafeAllowRenames` for renames. Prefer the scoped `@custom:oz-upgrades-unsafe-allow` tag over a call-wide `unsafeAllow`.

## NatSpec annotations

Annotations declare intentional changes so the validator does not flag them.

### OZ's tags

State variables, contracts and functions use OpenZeppelin's own tags, with OZ's semantics:

```solidity
/// @custom:oz-renamed-from oldName
uint256 public newName;

/// @custom:oz-retyped-from uint160
address public owner;

/// @custom:oz-upgrades-unsafe-allow state-variable-assignment
uint256 public initializedValue = 42;

/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}

/// @custom:oz-upgrades-unsafe-allow-reachable delegatecall
function multicall(bytes[] calldata data) external { ... }
```

A retype passes only when OZ can prove the new type has the same size and position (for example `uint160` to `address`); a size change still fails.

### Struct member tags (this plugin's extension)

Solidity has no NatSpec on struct members, so OZ cannot read rename or retype tags for them. Put them on the struct, one per member, old name or type first:

```solidity
/// @custom:upgrades-validator-renamed-from oldBalance balance
/// @custom:upgrades-validator-retyped-from uint160 owner
struct Account {
    uint256 balance;
    address owner;
}
```

This works for structs declared in the contract or one of its base contracts, plain or ERC-7201 namespace (`@custom:storage-location`). Tags on file-level or library structs are not read, and an old type must be a single token (no spaces, so not `mapping(...)` or function types); in both cases the change fails as untagged.

| Annotation                                                   | Scope             | Description                                        |
| ------------------------------------------------------------ | ----------------- | -------------------------------------------------- |
| `@custom:upgrades-validator-renamed-from <oldName> <member>` | Struct definition | Struct member `member` was renamed from `oldName`  |
| `@custom:upgrades-validator-retyped-from <oldType> <member>` | Struct definition | Struct member `member` type changed from `oldType` |

## How baselines are stored

Under `deployments/<network>/.storage-layouts/`, one JSON file per address:

```
deployments/mainnet/.storage-layouts/
  implementations/<implementation>.json   layout records
  proxies/<proxy>.json                    the proxy index
```

Commit them: they are reviewable in PRs and let CI validate without an explorer key or an RPC. One file per address keeps unrelated upgrades from conflicting. hardhat-deploy only loads `*.json` files directly inside the network directory, so the dot-directory is never read as a deployment.

```jsonc
// deployments/mainnet/.storage-layouts/implementations/0x5fbdb2315678afecb367f032d93f642f64180aa3.json
{
  "format": 1,
  "address": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  "chainId": 1,
  "codeSha256": "…", // binds the record to the exact runtime code it was proven against
  "contract": "contracts/MyToken.sol:MyToken",
  "compiler": "0.8.25+commit.b61c2a91",
  "bytecodeMatch": "immutables-only", // exact | immutables-only
  "source": "explorer", // explorer | local-compile
  "recordedAt": "2026-10-07T00:00:00.000Z",
  "layout": { "storage": [...], "types": {...}, "namespaces": {...} }
}
```

```jsonc
// deployments/mainnet/.storage-layouts/proxies/0xe7f1725e7734ce288f8367e1bb143e90bb3f0512.json
{
  "format": 1,
  "proxy": "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
  "chainId": 1,
  "implementation": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  "deployments": ["MyToken"], // the files describing the code behind the proxy
  "observedAtBlock": 21000000, // rewritten only when the entry's content changes
}
```

A record is used only when it was made on this chain and the code at its address still hashes to `codeSha256`. A record copied from another chain is rejected, even for identical code.

A record is bound to the deployed code, not to its own `layout` field, so review changes to committed records like code.

### Deprecated: `upgradeStorageLayout`

0.1.0-alpha.1 stamped the layout into each deployment JSON as `upgradeStorageLayout`. That field is per deployment name, so it describes whatever was last stamped, not what the proxy runs. It is still **read** as a last-resort offline fallback, with a `deprecated baseline` warning, and is no longer written. Once the chain names a proxy's implementation, the field is never used. It will be removed in a later release.

## Without Hardhat: slotdiff

The chain-baseline core ships separately as [slotdiff](https://github.com/rokso/slotdiff), which this plugin is built on. It has no Hardhat dependency, so Foundry projects and plain scripts can resolve the layout a proxy runs on chain, prove it against the deployed code, and diff it against a local build.

## License

MIT
