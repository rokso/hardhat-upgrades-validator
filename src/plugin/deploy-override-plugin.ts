/**
 * Conditionally-loaded mini-plugin that overrides hardhat-deploy's "deploy"
 * task to record, after each deployment run, the layout of the implementation
 * each changed proxy runs and refresh the proxy index (see hooks/deploy.ts).
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
