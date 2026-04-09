# hardhat-upgrades-validator

Hardhat v3 plugin that validates storage layout compatibility for upgradeable proxy contracts managed by [hardhat-deploy v2](https://github.com/wighawag/hardhat-deploy).

Powered by [@openzeppelin/upgrades-core](https://github.com/OpenZeppelin/openzeppelin-upgrades/tree/master/packages/upgrades-core) — the same engine that backs `@openzeppelin/hardhat-upgrades`.

## Requirements

- Hardhat **v3**
- hardhat-deploy **v2** (optional — proxy helper works with any deploy tool)
- Node.js **>= 18**

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
    settings: {
      // The plugin injects storageLayout, devdoc, and ast automatically.
      // Declaring them explicitly here is optional but makes the dependency clear.
      outputSelection: {
        "*": { "*": ["storageLayout", "devdoc", "ast"] },
      },
    },
  },

  upgradesValidator: {
    enableCompileHook: true, // default
    networks: "all", // default — validate every network in deployments/
  },
};

export default config;
```

That's the setup. See [Workflow](#workflow) for the deploy, baseline, and upgrade flow.

## How it works

The plugin operates through four validation paths — all backed by the same storage-diff engine:

| Path                        | When it runs       | What it does                                                                       |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| **Compile hook**            | `hardhat compile`  | Auto-validates baselines; networks filtered by `upgradesValidator.networks` config |
| **`validate-upgrade` task** | CI / manual        | Compares baselines vs current artifacts; `--network` flag to target one network    |
| **`assertProxyUpgrade`**    | Scripts, CI, tests | Throws if storage is incompatible; typically used just before upgrading            |
| **`validateProxyUpgrade`**  | Scripts, CI, tests | Same, returns a result instead of throwing                                         |

The ValidationData cache (written to `cache/validations.json` on each compile) is shared across all four paths so build-info files are parsed only once per compile.

## Workflow

> **Adding to an existing project?** If you already have deployed proxies, run `record-baseline` once to stamp their current layouts before validation will do anything useful:
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

    // No baseline yet — this is a no-op on first deploy.
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

The deploy hook stamps the baseline automatically after the deploy completes.

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

The deploy hook stamps the updated layout into `MyToken.json` after the deploy.

### Upgrading to a new implementation contract (MyToken → MyTokenV2)

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

All options are optional and apply to the **compile hook only**. The `validate-upgrade` task and proxy helpers (`assertProxyUpgrade`, `validateProxyUpgrade`) are not affected by these settings — they use CLI flags and call options respectively.

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

Stamps the current compiled storage layout into the deployment JSON as the upgrade baseline. Safe to re-run — skips contracts that already have a baseline unless `--force` is passed.

```sh
npx hardhat record-baseline --all --network mainnet
npx hardhat record-baseline --contract MyToken --network mainnet
npx hardhat record-baseline --all --network mainnet --force   # overwrite existing baselines
```

| Flag                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `--contract <name>` | Record a single contract                                         |
| `--all`             | Record all deployed contracts                                    |
| `--network <name>`  | Restrict to one network directory under `deployments/`           |
| `--force`           | Overwrite existing baselines; also skips bytecode mismatch check |

Bytecode verification: the task compares the local artifact's `deployedBytecode` against the value stored in the deployment JSON. If they don't match (code has changed since the last deploy), it skips and warns. Use `--force` to override.

### `validate-upgrade`

Compares all recorded baselines against the current compiled artifacts. Useful in CI after a compile step and before deploying.

```sh
npx hardhat validate-upgrade --all
npx hardhat validate-upgrade --contract MyToken --network mainnet
npx hardhat validate-upgrade --all --unsafe-allow "variable-renamed"
npx hardhat validate-upgrade --all --unsafe-skip-storage-check   # emergency escape hatch
```

| Flag                          | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| `--contract <name>`           | Validate a single contract                             |
| `--all`                       | Validate all contracts with a baseline                 |
| `--network <name>`            | Restrict to one network directory under `deployments/` |
| `--unsafe-allow <kinds>`      | Space/comma-separated list of checks to bypass         |
| `--unsafe-skip-storage-check` | Skip all storage checks (emits a loud warning)         |
| `--proxy-kind <kind>`         | Override proxy kind (`transparent`, `uups`, `beacon`)  |

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
  unsafeAllow: ["variable-renamed"],
  unsafeSkipStorageCheck: false, // set to true to skip all storage checks (emergency escape hatch)
  newImpl: "MyTokenV2", // validate against this artifact instead of what's in the deployment record
});
```

### `validateProxyUpgrade(hre, contractName, options?)`

Same logic, but returns a `ValidationResult` instead of throwing. Use when you want to inspect or log the result programmatically.

```ts
const result = await validateProxyUpgrade(hre, "MyToken");
if (!result.ok) {
  console.error(result.errors);
  process.exit(1);
}
```

### `ProxyUpgradeOptions`

| Option                   | Type                | Description                                                                                       |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| `unsafeAllow`            | `UnsafeAllowKind[]` | Bypass specific checks for this call                                                              |
| `unsafeSkipStorageCheck` | `boolean`           | Skip all storage checks                                                                           |
| `newImpl`                | `string`            | Validate against a different compiled artifact instead of the one recorded in the deployment JSON |

## unsafe-allow kinds

Used in `--unsafe-allow` (validate task) and `unsafeAllow` (proxy helper options). Each kind bypasses a specific class of error.

| Kind                        | What it bypasses                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `variable-renamed`          | Storage variable was renamed (use `@custom:upgrades-validator-renamed-from` per variable for a more precise alternative)  |
| `type-changed`              | Storage variable type changed (use `@custom:upgrades-validator-retyped-from` per variable for a more precise alternative) |
| `constructor`               | Contract has a non-empty constructor                                                                                      |
| `delegatecall`              | Contract uses `delegatecall`                                                                                              |
| `selfdestruct`              | Contract uses `selfdestruct`                                                                                              |
| `state-variable-immutable`  | Contract declares an immutable variable                                                                                   |
| `state-variable-assignment` | Contract assigns a value to a state variable at declaration                                                               |
| `external-library-linking`  | Contract links to an external library                                                                                     |

Prefer NatSpec annotations over `unsafeAllow` where possible — annotations are scoped to the specific variable or contract they apply to, while `unsafeAllow` bypasses the check globally for the entire validation call.

## NatSpec annotations

Annotations let you declare intentional storage changes so the validator doesn't flag them as errors.

### State variable annotations

Place on the state variable (or the struct field for namespace structs):

```solidity
/// @custom:upgrades-validator-renamed-from oldName
uint256 public newName;

/// @custom:upgrades-validator-retyped-from uint128
uint256 public value;

/// @custom:upgrades-validator-unsafe-allow state-variable-assignment
uint256 public initializedValue = 42;
```

### Contract-level unsafe-allow

Place on the contract or its `constructor` NatSpec:

```solidity
/// @custom:upgrades-validator-unsafe-allow constructor
contract MyImplementation {
    constructor() {
        _disableInitializers();
    }
}
```

Multiple kinds can be space- or comma-separated:

```solidity
/// @custom:upgrades-validator-unsafe-allow constructor delegatecall
```

### Struct member annotations (regular and namespace structs)

For members inside a struct, the annotation goes on the struct definition and uses a two-token format: `memberName oldValue`:

```solidity
/// @custom:upgrades-validator-renamed-from newBalance oldBalance
/// @custom:upgrades-validator-retyped-from newBalance uint128
struct MyStruct {
    uint256 newBalance;
}
```

### Annotation reference

| Annotation                                                   | Scope                                 | Description                                        |
| ------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------- |
| `@custom:upgrades-validator-renamed-from <oldName>`          | State variable                        | Variable was renamed from `oldName`                |
| `@custom:upgrades-validator-retyped-from <oldType>`          | State variable                        | Variable type changed from `oldType`               |
| `@custom:upgrades-validator-unsafe-allow <kind>`             | Contract, constructor, state variable | Bypass a specific check                            |
| `@custom:upgrades-validator-renamed-from <member> <oldName>` | Struct definition                     | Struct member `member` was renamed from `oldName`  |
| `@custom:upgrades-validator-retyped-from <member> <oldType>` | Struct definition                     | Struct member `member` type changed from `oldType` |

Valid `unsafe-allow` kinds: `constructor`, `delegatecall`, `selfdestruct`, `state-variable-immutable`, `state-variable-assignment`, `external-library-linking`, `variable-renamed`, `type-changed`.

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
