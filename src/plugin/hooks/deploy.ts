/**
 * Hardhat v3 `deploy` task override.
 *
 * After hardhat-deploy runs, stamps `upgradeStorageLayout` (OZ-format) into
 * deployment JSONs for the selected task network (`--network`) whose bytecode
 * matches the current compiled artifact. The bytecode check ensures we only
 * update contracts that were actually (re-)deployed in this run.
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";
import { join, resolve } from "node:path";

import {
  readDeployment,
  resolveArtifactName,
  getContractBuildData,
  createBuildInfoOutputCache,
  compareBytecode,
} from "../internals/deployment-utils.js";
import { getInMemoryValidations } from "./compile.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { listDirOrEmpty, listSubdirsOrEmpty, readJsonFile, writeJsonFile } from "../../utils/io.js";

export default async function deployOverride(
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<unknown> {
  const result = await runSuper(args);

  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetwork = hre.globalOptions.network.trim();

  // We only mutate one deployment network at a time, using Hardhat's global
  // `--network` option from HRE.
  if (targetNetwork === "") return result;

  const networkExists = (await listSubdirsOrEmpty(deploymentsBase)).includes(targetNetwork);
  if (!networkExists) return result;

  const deploymentsDir = resolve(deploymentsBase, targetNetwork);

  const files = await listDirOrEmpty(deploymentsDir);
  if (files.length === 0) return result;

  const cache = createBuildInfoOutputCache();
  const validations =
    getInMemoryValidations() ?? (await loadValidationsFromDisk(hre.config.paths.cache));

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const deployment = await readDeployment(deploymentsDir, name);
    if (!deployment?.deployedBytecode) continue;

    const artifactName = resolveArtifactName(deployment, name);

    let upgradeStorageLayout;
    let artifactBytecode: string;
    try {
      [{ upgradeStorageLayout }, { deployedBytecode: artifactBytecode }] = await Promise.all([
        getContractBuildData(artifactName, hre.artifacts, validations, cache),
        hre.artifacts.readArtifact(artifactName),
      ]);
    } catch {
      continue; // artifact not found — not our contract
    }

    if (upgradeStorageLayout === undefined) continue;

    // Only stamp contracts whose bytecode matches the current compiled
    // artifact — this identifies contracts deployed in this run.
    const cmp = compareBytecode(deployment.deployedBytecode, artifactBytecode);
    if (cmp.match === "none") continue;

    const deploymentPath = join(deploymentsDir, `${name}.json`);
    const deploymentJson = await readJsonFile<Record<string, unknown>>(deploymentPath);
    deploymentJson.upgradeStorageLayout = upgradeStorageLayout;
    await writeJsonFile(deploymentPath, deploymentJson, {
      pretty: true,
      trailingNewline: true,
    });
  }

  return result;
}
