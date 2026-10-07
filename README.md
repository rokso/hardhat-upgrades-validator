# hardhat-upgrades-validator

Hardhat v3 plugin that validates storage layout compatibility for upgradeable proxy contracts managed by [hardhat-deploy v2](https://github.com/wighawag/hardhat-deploy).

Powered by [@openzeppelin/upgrades-core](https://github.com/OpenZeppelin/openzeppelin-upgrades/tree/master/packages/upgrades-core), the same engine that backs `@openzeppelin/hardhat-upgrades`.

## Requirements

- Hardhat **v3.6** or later
- hardhat-deploy **v2** (optional; the proxy helper works with any deploy tool)
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
    networks: "all", // default: validate every network in deployments/
  },
};

export default config;
```

That's the setup. See [Workflow](#workflow) for the deploy, baseline, and upgrade flow.

## How it works

The plugin operates through four validation paths, all backed by the same storage-diff engine:

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
2. Looks up a layout record for that implementation address under `deployments/<network>/.storage-layouts/implementations/`.
3. If there is none, rebuilds it: fetches the implementation's verified source from an Etherscan-compatible explorer, compiles it with the exact solc version, **proves** the result matches the deployed code (immutables masked), extracts the layout with the same oz-core pipeline the local build uses, and records it.

Deployed code never changes, so a record keyed by implementation address cannot go stale, and one record serves every proxy that shares the implementation.

### Which deployments are proxies

hardhat-deploy v2 records no implementation address, and its file names (`X`, `X_Proxy`, `X_Implementation`) are a convention, not something to trust. So proxies are found from the chain and file contents only:

- A deployment is a proxy when the chain has an ERC-1967 implementation or beacon slot set at its address. A bare implementation or a plain contract has neither, and is skipped.
- Several files can share a proxy address (hardhat-deploy v2 writes `X` and `X_Proxy` there). A file whose code is the code at that address describes the proxy contract itself and is skipped; the others describe the code behind the proxy, and their artifact is the new side of the comparison. Immutables are masked for that comparison. Their positions come from the file, else the local build, else are inferred from the code (solc leaves each immutable as a zeroed `PUSH32` operand): hardhat-deploy v2's prebuilt proxy artifacts, such as its optimized transparent proxy with an immutable admin, list none.
- A proxy whose only file describes the proxy contract itself is reported, not validated: nothing names its new code.
- An address that cannot be read (an RPC error, a beacon whose `implementation()` reverts) is reported as an error for that address; the rest of the network is still validated.

Runs that can reach the chain (`validate-upgrade --all`, `record-baseline`, the deploy hook) keep a **proxy index** under `.storage-layouts/proxies/`: which implementation each proxy ran when last observed, and which deployments describe its code. Offline runs read it. It is written only from what the chain reports, so a queued or discarded upgrade never moves it; it goes stale when a proxy is upgraded outside these runs, until the next run with an RPC, and offline results name the block it was observed at.

| Mode (`--baseline` / `baseline`) | Old layout                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default)                 | The chain when reachable. If the chain cannot say which implementation the proxy runs (no RPC, no proxy slot), the stored record for the implementation the proxy index names, else the deprecated `upgradeStorageLayout` field, each labeled as such. |
| `chain`                          | The chain only. Fails when it cannot supply a baseline.                                                                                                                                                                                                |
| `deployment`                     | The deprecated `upgradeStorageLayout` field only (0.1.0-alpha.1 behavior).                                                                                                                                                                             |

`auto` falls back only while the chain **cannot say which implementation the proxy runs**. Once it has named one, only that implementation's layout is acceptable: if no record exists and it cannot be rebuilt (no explorer configured, unverified source, explorer or compiler download unreachable), validation fails rather than compare against another implementation's layout. Untrustworthy answers fail too, such as verified source that does not compile to the deployed code. A match only after stripping metadata is not accepted as proof: variables no code reads, gap sizes and field names never reach the bytecode, so two layouts can share the same code. Every result names its baseline:

```
  [OK]   "mainnet/MyToken": storage layout validation passed.
         baseline: chain, implementation 0x5fbd… (immutables-only, stored record)
```

The compile hook always runs offline (compiling must not need an RPC), so it validates the proxies the proxy index lists, against stored records. An indexed implementation with no record is skipped, never replaced by the deprecated field. `validate-upgrade` and the proxy helpers read the chain, and may write under `deployments/<network>/.storage-layouts/` and download a compiler the first time they rebuild a layout.

Hardhat 3 gives every new connection (`network.create()`) to an in-process (EDR) network a fresh chain. In a deploy script running on such a network, pass the script's own provider (`assertProxyUpgrade(hre, "MyToken", { provider })`) so validation sees the same chain; the deploy hook cannot, and skips recording there.

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

After the deploy, the deploy hook looks at the deployment files the deploy created or changed. For each proxy among them it updates the proxy index and records the layout of the implementation it runs, once it has proven the chain runs the local build. A freshly deployed implementation whose upgrade is still queued (in a multisig, say) is recorded too, when its contract is one a known proxy's deployment describes; if that upgrade is never executed, the record is simply never read. A queued upgrade to a differently named contract (`MyToken` to `MyTokenV2`) is linked to its proxy only by file names, which are not trusted, so it is recorded once the upgrade has executed, by the next deploy, `record-baseline` or validation. Until every deployment on the network has been classified once without errors (by the deploy hook, `record-baseline --all` or `validate-upgrade --all`, recorded in `scan.json`), the deploy hook classifies all of them, so the index is complete from then on, even on a network with no proxies.

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
  // network name. apiUrl defaults to Etherscan v2, which covers every chain
  // Etherscan indexes; set it for an Etherscan-compatible explorer (e.g.
  // Blockscout). apiKey falls back to ETHERSCAN_API_KEY for Etherscan only:
  // that key is never sent to another host, and a custom apiUrl may be keyless.
  explorers: {
    mainnet: { apiKey: process.env.ETHERSCAN_API_KEY },
    someL2: { apiUrl: "https://blockscout.example.org/api", apiKey: "..." },
  },

  // Where downloaded compilers are cached. Hardhat's own compiler cache is
  // checked first, so a version the project already compiled with is free.
  solcCacheDir: undefined, // default: <os cache>/hardhat-upgrades-validator/compilers
},
```

Only standard-json verifications can be rebuilt: flattened and multi-file verifications do not record every compiler setting (`viaIR` among them). For those implementations, record the layout with `record-baseline` from a matching local build.

## Tasks

### `record-baseline`

Records the layout of the implementation each proxy runs on-chain, keyed by implementation address under `deployments/<network>/.storage-layouts/`, and refreshes the proxy index. Optional: validation records layouts on demand. Use it to record up front, for review in a PR or for CI without an explorer key. Needs an RPC for the network.

```sh
npx hardhat record-baseline --all --network mainnet
npx hardhat record-baseline --contract MyToken --network mainnet --from-chain
npx hardhat record-baseline --all --network mainnet --force   # overwrite existing records
```

| Flag                | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--contract <name>` | Record a single proxy                                                               |
| `--all`             | Record every proxy found on the chain                                               |
| `--network <name>`  | Restrict to one network directory under `deployments/`                              |
| `--from-chain`      | Rebuild the layout from the implementation's verified source instead of local build |
| `--force`           | Overwrite existing records. Never skips the bytecode proof.                         |

Without `--from-chain`, the local build's layout is recorded only if the chain runs exactly that build (`exact` or `immutables-only`). If the local source has moved on since the implementation was deployed, the task says so and points at `--from-chain`. A record is never written for code that is not on-chain.

### `validate-upgrade`

Compares the layout each proxy runs against the current compiled artifacts. Useful in CI after a compile step and before deploying.

```sh
npx hardhat validate-upgrade --all
npx hardhat validate-upgrade --contract MyToken --network mainnet
npx hardhat validate-upgrade --all --unsafe-allow "variable-renamed"
npx hardhat validate-upgrade --all --unsafe-skip-storage-check   # emergency escape hatch
```

| Flag                          | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| `--contract <name>`           | Validate a single contract                             |
| `--all`                       | Validate every proxy (chain, else the proxy index)     |
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

Throws `StorageLayoutError` if the upgrade is storage-incompatible. Use this inside deploy scripts to abort before touching the chain. It throws `BaselineUnavailableError` or `BaselineIntegrityError` (exported from `hardhat-upgrades-validator/onchain`) when no trustworthy baseline can be obtained for the implementation the proxy runs: in that case it never passes by comparing against something else.

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

Prefer NatSpec annotations over `unsafeAllow` where possible: annotations are scoped to the specific variable or contract they apply to, while `unsafeAllow` bypasses the check globally for the entire validation call.

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

Under `deployments/<network>/.storage-layouts/`, one JSON file per address:

```
deployments/mainnet/.storage-layouts/
  implementations/<implementation>.json   layout records
  proxies/<proxy>.json                    the proxy index
  scan.json                               when every deployment was first classified
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

A record is used only when the code at its address still hashes to `codeSha256`. A record copied from another chain is therefore rejected when that chain has different code at the address; when the code is identical, so is the layout, and reusing the record is safe.

### Deprecated: `upgradeStorageLayout`

0.1.0-alpha.1 stamped the layout into each deployment JSON as `upgradeStorageLayout`. That field is per deployment name, so it describes whatever was last stamped, not what the proxy runs. It is still **read** as a last-resort fallback, with a `deprecated baseline` warning, and is no longer written. It will be removed in a later release.

## Using the core without the plugin

The chain-baseline logic has no Hardhat dependency, so plain ESM scripts and other tooling can use it directly:

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

With a reachable network, baselines come from the chain. Each implementation's layout must be recorded once, either from verified source (needs an explorer: `ETHERSCAN_API_KEY` or `upgradesValidator.explorers`) or from a matching local build (`record-baseline --contract <name>`, no explorer needed). Validation records it on first use when an explorer is configured.

Existing `upgradeStorageLayout` fields are used only when the chain cannot say which implementation a proxy runs (offline, or no proxy slot), with a deprecation warning. Once the chain names the implementation and no layout for it can be obtained, validation fails instead of falling back to the field, which cannot be tied to any implementation. To keep the alpha.1 behavior explicitly, pass `--baseline deployment` / `baseline: "deployment"`.

Behavior changes:

- The deploy hook and `record-baseline` write `.storage-layouts/` records and the proxy index instead of `upgradeStorageLayout`.
- `record-baseline` needs an RPC for the network, and `--force` no longer skips the bytecode check: it only allows overwriting an existing record.
- `validate-upgrade --all` covers every proxy found on the chain (or, offline, in the proxy index), not only those with a stamped baseline. An `implementation` field in a deployment file is ignored.

## License

MIT
