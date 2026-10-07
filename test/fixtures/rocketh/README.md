# hardhat-deploy v2 fixtures

Real output of hardhat-deploy 2.0.30 (rocketh 0.23.1, @rocketh/proxy 0.20.1) on a local node, deploying this package's own contracts in [`generator/`](generator/) with three rocketh proxy kinds:

| Deployment | Proxy                                                 | Notes                                                     |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `Vault`    | `UUPS` (`ERC1967Proxy`)                               | logic has an immutable, so its files list `immutableReferences` |
| `Counter`  | `SharedAdminOptimizedTransparentProxy`                | the proxy has an immutable admin, but its prebuilt artifact lists no `immutableReferences` |
| `Ledger`   | default (`EIP173Proxy`)                               |                                                           |

Snapshots, each a deployments directory plus `<name>.chain.json` (runtime code and ERC-1967 slots of every address in it, read from the node):

- `fresh/`: first deploy.
- `upgraded/`: all three upgraded to their V2. `X.json` and `X_Implementation.json` are rewritten, `numDeployments` is 2.
- `queued/`: `Vault` is owned by an address with no key, so the V2 deploy cannot sign the upgrade. rocketh has deployed `VaultV2` and rewritten `Vault_Implementation.json`; `Vault.json` and the proxy still describe and run V1, as with an upgrade waiting in a multisig.

Deployment files are trimmed to the fields the plugin reads (`trim.mjs`); values are unchanged. Regenerate with:

```sh
cd test/fixtures/rocketh/generator && npm install && ./generate.sh ..
```
