# Security policy

hardhat-upgrades-validator decides whether an upgrade is safe, so a wrong pass is a security bug. So is anything that leaks an RPC URL or an API key.

## Reporting a vulnerability

Report it privately through GitHub: **Security** tab of [rokso/hardhat-upgrades-validator](https://github.com/rokso/hardhat-upgrades-validator/security/advisories/new) → **Report a vulnerability**. Please do not open a public issue.

Include what you ran (the task, hook or helper, the contracts or their shape) and what the plugin said against what it should have said. I aim to reply within a week.

## What the plugin touches

For anyone reviewing the plugin, or the alerts a supply-chain scanner raises about it:

- **Network:** the RPC of the Hardhat network you run on, and, through [slotdiff](https://github.com/rokso/slotdiff), the explorers you configure (`upgradesValidator.explorers`) for verified source and `binaries.soliditylang.org` for the compilers that rebuild it. Hardhat downloads the compiler of your own build as it always does. Nothing else; no telemetry.
- **Processes:** the solc binaries Hardhat and slotdiff run; see [slotdiff's policy](https://github.com/rokso/slotdiff/blob/main/SECURITY.md).
- **Files:** it reads your build info, sources and hardhat-deploy deployments. It writes only layout records and the proxy index under `deployments/<network>/.storage-layouts/`, and slotdiff's compiler cache (`upgradesValidator.solcCacheDir` when set).
- **Environment:** `ETHERSCAN_API_KEY` (sent only to Etherscan) and `HARDHAT_FORK` (hardhat-deploy's fork mode: the deploy hook records nothing and the chain id is not checked).
- **Install:** the plugin has no install scripts. Two transitive dependencies of OpenZeppelin upgrades-core (`keccak` and `secp256k1`, through `ethereumjs-util`) build optional native code at install (`node-gyp-build || exit 0`).

## Saved records

A layout record is bound to the deployed code by its hash, not to what it says about that code. Its `layout`, `kind` and `namespaces` decide the verdict and are trusted as written, so whoever can change a committed record (a pull request, a CI cache) can change the result. Review changes to `.storage-layouts/` like code.

## No guarantee

The plugin comes without warranty and its authors accept no liability for any loss, including funds; see [LICENSE](LICENSE). Reporting a problem helps everyone, but a report does not make anyone liable for an upgrade.

## Supported versions

Fixes go into the latest release only.
