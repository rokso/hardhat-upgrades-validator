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

### Where the baseline comes from

The "before" layout is the layout of the implementation the proxy **runs right now**, read from the chain. Deployment files describe the latest build, which drifts from what a proxy runs whenever upgrades are lazy (a proxy stays on an older implementation until it needs a new one) or queued (a multisig executes the upgrade later). The chain does not drift.

For each proxy, the plugin:

1. Reads the implementation from the proxy's ERC-1967 slot (or its beacon).
2. Looks up a layout record for that implementation address under `deployments/<network>/.storage-layouts/`.
3. If there is none, rebuilds it: fetches the implementation's verified source from an Etherscan-compatible explorer, compiles it with the exact solc version, **proves** the result matches the deployed code (immutables masked), extracts the layout with the same oz-core pipeline the local build uses, and records it.

Deployed code never changes, so a record keyed by implementation address cannot go stale, and one record serves every proxy that shares the implementation.

| Mode (`--baseline` / `baseline`) | Old layout                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default)                 | The chain when reachable. Otherwise the stored record for the implementation named in the deployment file, then the deprecated `upgradeStorageLayout` field, each labeled as such. |
| `chain`                          | The chain only. Fails when it cannot supply a baseline.                                                                                                                            |
| `deployment`                     | The deprecated `upgradeStorageLayout` field only (0.1.0-alpha.1 behavior).                                                                                                         |

`auto` only falls back when the chain **cannot answer** (no RPC, unverified source, no explorer key). When the chain answers with something untrustworthy, such as verified source that does not compile to the deployed code, validation fails instead of silently comparing against a layout the proxy is not running. Every result names its baseline:

```
  [OK]   "mainnet/MyToken" — storage layout validation passed.
         baseline: chain, implementation 0x5fbd… (immutables-only, stored record)
```

The compile hook always runs offline (compiling must not need an RPC), so it uses stored records. `validate-upgrade` and the proxy helpers read the chain.

## Workflow

> **Adding to an existing project?** Nothing to do first. With a network configured and an explorer key (`ETHERSCAN_API_KEY`), the first `validate-upgrade` or `assertProxyUpgrade` reads each proxy's implementation from the chain and records its layout. To record up front, for review or for offline CI:
>
> ```sh
> npx hardhat compile
> npx hardhat record-baseline --all --network mainnet               # proxies running the current build
> npx hardhat record-baseline --all --network mainnet --from-chain  # proxies running older code
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

After the deploy, the deploy hook records the new implementation's layout under `deployments/<network>/.storage-layouts/`, once it has proven the chain runs the local build.

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

    // Reads the implementation the proxy runs on-chain and validates its
    // layout against the freshly compiled MyToken artifact. Throws if incompatible.
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

The deploy hook records the new implementation's layout. Until the upgrade executes (for example, while a multisig batch is pending), validation keeps comparing against the implementation the proxy still runs.

### Upgrading to a new implementation contract (MyToken → MyTokenV2)

When the new implementation lives in a separate file (`MyTokenV2.sol`) and the proxy deployment record is still named after the old contract (`MyToken`), use `newImpl` to tell the validator which artifact to check:

```ts
// deploy/01_upgrade_mytoken_v2.ts
import hre from "hardhat";
import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
import { deployScript, artifacts } from "../rocketh/deploy.js";

export default deployScript(async ({ deployViaProxy, namedAccounts }) => {
  const { deployer } = namedAccounts;

  // Old layout: the implementation the MyToken proxy runs on-chain.
  // New layout: the compiled MyTokenV2 artifact.
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
  // and auto-validation of all recorded baselines after each compile.
  // Set to false to disable the hook entirely (cache will not be written).
  enableCompileHook: true,

  // Networks to validate during `hardhat compile`.
  // "all" validates every directory found under deployments/.
  // Pass a string array to restrict to specific networks.
  networks: "all",

  // Explorer used to rebuild a chain baseline from verified source, keyed by
  // network name. apiKey falls back to ETHERSCAN_API_KEY; apiUrl defaults to
  // Etherscan v2, which covers every chain Etherscan indexes. Set apiUrl for
  // an Etherscan-compatible explorer (e.g. Blockscout).
  explorers: {
    mainnet: { apiKey: process.env.ETHERSCAN_API_KEY },
    someL2: { apiUrl: "https://blockscout.example.org/api", apiKey: "..." },
  },

  // Where downloaded compilers are cached. Hardhat's own compiler cache is
  // checked first, so a version the project already compiled with is free.
  solcCacheDir: undefined, // default: <os cache>/hardhat-upgrades-validator/compilers
},
```

Only standard-json verifications can be rebuilt: flattened and multi-file verifications do not record every compiler setting (`viaIR` among them). Those proxies fall back to an offline baseline in `auto` mode.

## Tasks

### `record-baseline`

Records the layout of the implementation each proxy runs on-chain, keyed by implementation address under `deployments/<network>/.storage-layouts/`. Optional: validation records layouts on demand. Use it to record up front, for review in a PR or for CI without an explorer key. Needs an RPC for the network.

```sh
npx hardhat record-baseline --all --network mainnet
npx hardhat record-baseline --contract MyToken --network mainnet --from-chain
npx hardhat record-baseline --all --network mainnet --force   # overwrite existing records
```

| Flag                | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--contract <name>` | Record a single proxy                                                               |
| `--all`             | Record every proxy deployment                                                       |
| `--network <name>`  | Restrict to one network directory under `deployments/`                              |
| `--from-chain`      | Rebuild the layout from the implementation's verified source instead of local build |
| `--force`           | Overwrite existing records. Never skips the bytecode proof.                         |

Without `--from-chain`, the local build's layout is recorded only if the chain runs exactly that build (`exact` or `immutables-only`). If the local source has moved on since the implementation was deployed, the task says so and points at `--from-chain`. A record is never written for code that is not on-chain.

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
| `--baseline <mode>`           | `auto` (default), `chain`, or `deployment`             |

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

| Option                   | Type                | Description                                                                                                     |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `unsafeAllow`            | `UnsafeAllowKind[]` | Bypass specific checks for this call                                                                            |
| `unsafeSkipStorageCheck` | `boolean`           | Skip all storage checks                                                                                         |
| `newImpl`                | `string`            | Validate against a different compiled artifact instead of the one recorded in the deployment JSON               |
| `baseline`               | `BaselineMode`      | `auto` (default), `chain`, or `deployment`. See [Where the baseline comes from](#where-the-baseline-comes-from) |
| `provider`               | `EthProvider`       | Provider to read the chain with. Defaults to a connection to the `--network` network                            |

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

One JSON file per implementation address, under `deployments/<network>/.storage-layouts/`. Commit them: they are reviewable in PRs and let CI validate without an explorer key. hardhat-deploy only loads `*.json` files directly inside the network directory, so the dot-directory is never read as a deployment.

```jsonc
// deployments/mainnet/.storage-layouts/0x5fbdb2315678afecb367f032d93f642f64180aa3.json
{
  "format": 1,
  "address": "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  "chainId": 1,
  "codeSha256": "…", // binds the record to the exact runtime code it was proven against
  "contract": "contracts/MyToken.sol:MyToken",
  "compiler": "0.8.25+commit.b61c2a91",
  "bytecodeMatch": "immutables-only", // exact | immutables-only | metadata-only
  "source": "explorer", // explorer | local-compile
  "recordedAt": "2026-10-07T00:00:00.000Z",
  "layout": { "storage": [...], "types": {...}, "namespaces": {...} }
}
```

A record is used only when the code at its address still hashes to `codeSha256`; a record copied from another chain is rejected rather than trusted.

### Deprecated: `upgradeStorageLayout`

0.1.0-alpha.1 stamped the layout into each deployment JSON as `upgradeStorageLayout`. That field is per deployment name, so it describes whatever was last stamped, not what the proxy runs. It is still **read** as a last-resort fallback, with a `deprecated baseline` warning, and is no longer written. It will be removed in a later release.

## Using the core without the plugin

The chain-baseline logic has no Hardhat dependency, so Hardhat v2 projects and plain scripts can use it directly:

```ts
import {
  resolveChainBaseline,
  layoutFromSource,
  getSolc,
  validateStorageUpgrade,
} from "hardhat-upgrades-validator/onchain";

// Old layout: what the proxy runs now (rebuilt from verified source and recorded on first use).
const { record } = await resolveChainBaseline(proxyAddress, {
  provider, // anything with send(method, params), e.g. hre.network.provider or ethers' JsonRpcProvider
  storeDir: "deployments/mainnet/.storage-layouts",
  explorer: { apiKey: process.env.ETHERSCAN_API_KEY },
});

// New layout: from your build-info.
const solc = await getSolc(buildInfo.solcLongVersion);
const newLayout = await layoutFromSource(buildInfo.input, solc, "contracts/MyToken.sol:MyToken");

const result = validateStorageUpgrade("MyToken", record.layout, newLayout, { kind: "uups" });
```

## Upgrading from 0.1.0-alpha.1

Nothing is required. On the next `validate-upgrade` or `assertProxyUpgrade` with a reachable network, baselines come from the chain and are recorded as they are first needed. Existing `upgradeStorageLayout` fields keep working as a fallback, with a deprecation warning.

Behavior changes:

- The deploy hook and `record-baseline` write `.storage-layouts/` records instead of `upgradeStorageLayout`.
- `record-baseline` needs an RPC for the network, and `--force` no longer skips the bytecode check: it only allows overwriting an existing record.
- `validate-upgrade --all` covers every proxy deployment (anything with an `implementation` field), not only those with a stamped baseline.

## License

MIT
