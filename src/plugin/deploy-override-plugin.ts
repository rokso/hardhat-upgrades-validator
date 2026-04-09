/**
 * Conditionally-loaded mini-plugin that overrides hardhat-deploy's "deploy"
 * task to write `upgradeStorageLayout` into deployment JSON files after each
 * deployment run.
 *
 * This plugin is only loaded when hardhat-deploy is present (via
 * `conditionalDependencies` in the main plugin). If hardhat-deploy is not
 * installed, this file is never imported and the "deploy" override is skipped.
 */

import type { HardhatPlugin } from "hardhat/types/plugins";
import { overrideTask } from "hardhat/config";

const deployOverrideTask = overrideTask("deploy")
  .setAction(() => import("./hooks/deploy.js"))
  .build();

const deployOverridePlugin: HardhatPlugin = {
  id: "hardhat-upgrades-validator/deploy-baseline-recorder",
  tasks: [deployOverrideTask],
};

export default deployOverridePlugin;
