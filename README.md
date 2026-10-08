# hardhat-upgrades-validator

Hardhat v3 plugin that validates storage layout compatibility for upgradeable proxy contracts managed by [hardhat-deploy v2](https://github.com/wighawag/hardhat-deploy).

Powered by [@openzeppelin/upgrades-core](https://github.com/OpenZeppelin/openzeppelin-upgrades/tree/master/packages/upgrades-core), the same engine that backs `@openzeppelin/hardhat-upgrades`. Every check, annotation and error message is OpenZeppelin's: this plugin adds the baseline that hardhat-deploy projects lack (OZ keeps it in `.openzeppelin/<network>.json`, which hardhat-deploy does not write) and one annotation for struct members.

## Requirements

- Hardhat **v3.6** or later
- hardhat-deploy **v2** (optional; the proxy helper works with any deploy tool)
- Node.js **22** or later

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

### What the baseline is

The baseline is the layout stamped into the deployment file (`upgradeStorageLayout`) when the deploy hook or `record-baseline` last ran. It describes the code this repository deployed, not necessarily what the proxy runs on chain: if an upgrade is queued (for example in a multisig) or done outside these tools, the two drift until the baseline is recorded again.

## Workflow

> **Adding to an existing project?** If you already have deployed proxies, run `record-baseline` once to stamp their current layouts before validation will do anything useful. Check out the code each proxy runs first: the task refuses to record when the compiled bytecode does not match the deployment file.
>
> ```sh
> npx hardhat compile
> npx hardhat record-baseline --all --network mainnet
> ```

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

The deploy hook stamps the baseline automatically after the deploy completes. It needs `--network`, and records nothing under hardhat-deploy's fork mode (`HARDHAT_FORK`), where deployments exist only on the fork.

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

    // Reads baseline from deployments/mainnet/MyToken.json and validates
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

The deploy hook stamps the updated layout into `MyToken.json` after the deploy. hardhat-deploy rewrites that file on an upgrade, so the hook snapshots each baseline before the deploy and checks what was deployed at the same address against it. If it is incompatible, the deploy has already happened, but the hook keeps the old baseline (so validation keeps failing), prints OZ's report and exits 1. Call `assertProxyUpgrade` before deploying, as above, to stop it first: the compile hook's verdict does not stop `hardhat deploy`.

### Upgrading to a new implementation contract (MyToken to MyTokenV2)

When the new implementation lives in a separate file (`MyTokenV2.sol`) and the proxy deployment record is still named after the old contract (`MyToken`), use `newImpl` to tell the validator which artifact to check:

```ts
// deploy/01_upgrade_mytoken_v2.ts
import hre from "hardhat";
import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
import { deployScript, artifacts } from "../rocketh/deploy.js";

export default deployScript(async ({ deployViaProxy, namedAccounts }) => {
  const { deployer } = namedAccounts;

  // Reads old layout from deployments/mainnet/MyToken.json,
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

All options are optional and apply to the **compile hook only**. The `validate-upgrade` task and proxy helpers (`assertProxyUpgrade`, `validateProxyUpgrade`) are not affected by these settings; they use CLI flags and call options respectively.

```ts
upgradesValidator: {
  // Enables the compile hook: namespaced compilation pass, ValidationData cache,
  // and auto-validation of all recorded baselines after each compile.
  // Set to false to disable the hook entirely (cache will not be written).
  enableCompileHook: true,

  // Networks to validate during `hardhat compile`.
  // "all" validates every directory found under deployments/.
  // Pass a string array to restrict to specific networks.
  networks: "all",
},
```

## Tasks

### `record-baseline`

Stamps the current compiled storage layout into the deployment JSON as the upgrade baseline. Safe to re-run: skips contracts that already have a baseline unless `--force` is passed.

```sh
npx hardhat record-baseline --all --network mainnet
npx hardhat record-baseline --contract MyToken --network mainnet
npx hardhat record-baseline --all --network mainnet --force   # overwrite existing baselines
```

| Flag                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--contract <name>` | Record a single contract                                         |
| `--all`             | Record all deployed contracts                                    |
| `--network <name>`  | Hardhat's global option: restrict to that network's directory    |
| `--force`           | Overwrite existing baselines; also skips bytecode mismatch check |

Bytecode verification: the task compares the local artifact's `deployedBytecode` against the value stored in the deployment JSON. If they don't match (code has changed since the last deploy), it skips and warns. Use `--force` to override. A contract missing from the validation cache fails the task (exit code 1).

Without `--network`, both tasks process every directory under `deployments/`.

### `validate-upgrade`

Compares all recorded baselines against the current compiled artifacts. Useful in CI after a compile step and before deploying.

```sh
npx hardhat validate-upgrade --all
npx hardhat validate-upgrade --contract MyToken --network mainnet
npx hardhat validate-upgrade --all --unsafe-allow "constructor delegatecall"
npx hardhat validate-upgrade --all --unsafe-skip-storage-check   # emergency escape hatch
```

| Flag                          | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `--contract <name>`           | Validate a single contract                            |
| `--all`                       | Validate all contracts with a baseline                |
| `--network <name>`            | Hardhat's global option: restrict to that network     |
| `--unsafe-allow <kinds>`      | Space/comma-separated OZ error kinds to allow         |
| `--unsafe-allow-renames`      | Allow renames without `@custom:oz-renamed-from`       |
| `--unsafe-skip-storage-check` | Skip all storage checks (emits a loud warning)        |
| `--proxy-kind <kind>`         | Override proxy kind (`transparent`, `uups`, `beacon`) |

Every deployment with a baseline is validated. The task fails (exit code 1) when a contract cannot be checked: its artifact is missing, it is missing from the validation cache, or (with `--contract`) the deployment exists without a baseline and the chain does not show it is a plain contract.

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

Both throw when the deployment file exists but has no `upgradeStorageLayout`: that is not a first deployment, so there is nothing to check against. Run `record-baseline` first.

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

| Option                   | Type                | Description                                                                                       |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| `unsafeAllow`            | `UnsafeAllowKind[]` | OZ error kinds to allow for this call                                                             |
| `unsafeAllowRenames`     | `boolean`           | Allow renames without `@custom:oz-renamed-from` (OZ's option)                                     |
| `unsafeSkipStorageCheck` | `boolean`           | Skip all storage checks                                                                           |
| `newImpl`                | `string`            | Validate against a different compiled artifact instead of the one recorded in the deployment JSON |
| `kind`                   | `ProxyKind`         | `"transparent"`, `"uups"` or `"beacon"`; pass `"uups"` so a dropped `upgradeTo` is caught         |

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

Each deployment JSON file under `deployments/<network>/` gets an `upgradeStorageLayout` field stamped automatically by the deploy hook (or manually via `record-baseline`). This field is the OZ-format storage layout at the time of deploy:

```jsonc
// deployments/mainnet/MyToken.json
{
  "address": "0x...",
  "abi": [...],
  "deployedBytecode": "0x...",
  "upgradeStorageLayout": {
    "storage": [
      { "label": "value", "slot": "0", "type": "t_uint256", ... }
    ],
    "types": { ... }
  }
}
```

The validator reads this field as the "before" layout and compares it against the "after" layout from the compiled artifact.

## License

MIT
