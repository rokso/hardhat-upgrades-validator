import type { HardhatPlugin } from "hardhat/types/plugins";
import { task } from "hardhat/config";

const validateUpgradeTask = task(
  "validate-upgrade",
  "Validate storage layout compatibility for proxy upgrades managed by hardhat-deploy v2",
)
  .addOption({
    name: "contract",
    description: "Name of the contract to validate",
    defaultValue: "",
  })
  .addFlag({
    name: "all",
    description: "Validate all deployed contracts that have a stored storage layout",
  })
  .addOption({
    name: "unsafeAllow",
    description:
      'Space or comma-separated list of checks to bypass (e.g. "variable-renamed type-changed")',
    defaultValue: "",
  })
  .addFlag({
    name: "unsafeSkipStorageCheck",
    description:
      "Skip all storage layout validation. For emergency use only — emits a loud warning.",
  })
  .addOption({
    name: "proxyKind",
    description:
      "Proxy kind: transparent, uups, or beacon. Overrides auto-detection when validating contract-level safety.",
    defaultValue: "",
  })
  .setAction(() => import("./tasks/validate-upgrade.js"))
  .build();

const recordBaselineTask = task(
  "record-baseline",
  "Stamp the current compiled storageLayout into deployment files as the upgrade baseline",
)
  .addOption({
    name: "contract",
    description: "Name of the contract to record",
    defaultValue: "",
  })
  .addFlag({
    name: "all",
    description: "Record baselines for all deployed contracts",
  })
  .addFlag({
    name: "force",
    description: "Overwrite existing baselines",
  })
  .setAction(() => import("./tasks/record-baseline.js"))
  .build();

const plugin: HardhatPlugin = {
  id: "hardhat-upgrades-validator",
  npmPackage: "hardhat-upgrades-validator",
  // Override hardhat-deploy's "deploy" task only when hardhat-deploy is loaded.
  // If hardhat-deploy is absent, the import rejects and Hardhat silently skips
  // this override — no error for rocketh / other deploy tool users.
  conditionalDependencies: [
    {
      // @ts-expect-error hardhat-deploy is an optional peer dep — if absent the
      // import rejects at runtime and Hardhat silently skips this override.
      condition: () => [import("hardhat-deploy")],
      plugin: () => import("./deploy-override-plugin.js"),
    },
  ],
  hookHandlers: {
    config: () => import("./hooks/config.js"),
    solidity: () => import("./hooks/compile.js"),
  },
  tasks: [validateUpgradeTask, recordBaselineTask],
};

export default plugin;
