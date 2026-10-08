/**
 * Hardhat v3 `deploy` task override.
 *
 * After hardhat-deploy runs, stamps `upgradeStorageLayout` (OZ-format) into
 * deployment JSONs for the selected task network (`--network`) whose bytecode
 * matches the current compiled artifact. The bytecode check ensures we only
 * update contracts that were actually (re-)deployed in this run.
 *
 * Code deployed in place of a baselined deployment (same address: an upgrade)
 * must be storage-compatible with that baseline. If it is not, the old
 * baseline is kept and the run exits 1: the deploy already happened, but the
 * evidence is not overwritten.
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
  selectedNetwork,
} from "../internals/deployment-utils.js";
import { logger } from "../../utils/logger.js";
import { getInMemoryValidations } from "./compile.js";
import { loadValidationsFromDisk, missingLayoutReason } from "../internals/validations-cache.js";
import { validateStorageUpgrade, formatValidationResult } from "../../core/validator.js";
import type { StorageLayout } from "../../types/validation.js";
import { listDirOrEmpty, listSubdirsOrEmpty, readJsonFile, writeJsonFile } from "../../utils/io.js";

export default async function deployOverride(
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<unknown> {
  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  // We only mutate one deployment network at a time, using Hardhat's global
  // `--network` option from HRE. Without it there is nothing to stamp.
  const targetNetwork = selectedNetwork(hre);
  const deploymentsDir =
    targetNetwork === undefined ? undefined : resolve(deploymentsBase, targetNetwork);

  // hardhat-deploy rewrites a proxy's file on upgrade from the proxy record
  // and the new artifact, dropping `upgradeStorageLayout`. Snapshot the
  // baselines first, so what this run deployed is checked against them.
  const before = deploymentsDir === undefined ? new Map() : await snapshotBaselines(deploymentsDir);

  const result = await runSuper(args);

  if (targetNetwork === undefined || deploymentsDir === undefined) return result;

  // hardhat-deploy's fork mode deploys onto a fork of `--network`: what it
  // deployed exists only on the fork, so nothing may be stamped for the real
  // network's files.
  if (process.env.HARDHAT_FORK) {
    logger.log(`[INFO] HARDHAT_FORK is set; skipped stamping upgradeStorageLayout.`);
    return result;
  }

  const networkExists = (await listSubdirsOrEmpty(deploymentsBase)).includes(targetNetwork);
  if (!networkExists) return result;

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

    let artifactBytecode: string;
    try {
      ({ deployedBytecode: artifactBytecode } = await hre.artifacts.readArtifact(artifactName));
    } catch {
      continue; // not compiled in this project (e.g. a prebuilt proxy artifact)
    }

    // Only stamp contracts whose bytecode matches the current compiled
    // artifact; this identifies contracts deployed by this build.
    const cmp = compareBytecode(deployment.deployedBytecode, artifactBytecode);
    if (cmp.match === "none") continue;

    let data;
    try {
      data = await getContractBuildData(artifactName, hre.artifacts, validations, cache);
    } catch (err) {
      logger.warn(`"${targetNetwork}/${name}": not stamped: ${(err as Error).message}`);
      continue;
    }
    if (data.upgradeStorageLayout === undefined) {
      logger.warn(
        `"${targetNetwork}/${name}": not stamped: ${artifactName}: ${missingLayoutReason(validations)}`,
      );
      continue;
    }

    const deploymentPath = join(deploymentsDir, `${name}.json`);
    const deploymentJson = await readJsonFile<Record<string, unknown>>(deploymentPath);

    // Same address as before the run: the code behind it changed in place (an
    // upgrade), so the new layout must be compatible with the old baseline.
    // A new address is a fresh deployment, with no storage to carry over.
    const previous = before.get(name);
    if (previous !== undefined && sameAddress(previous.address, deployment.address)) {
      const check = validateStorageUpgrade(name, previous.layout, data.upgradeStorageLayout, {
        kind: data.proxyKind,
      });
      if (!check.ok) {
        logger.error(
          `"${targetNetwork}/${name}": the code deployed in this run is not storage-compatible ` +
            `with its previous baseline. Proxy storage may be corrupted. The previous baseline ` +
            `was kept, so validation keeps failing until this is resolved.` +
            formatValidationResult(`${targetNetwork}/${name}`, check),
        );
        deploymentJson.upgradeStorageLayout = previous.layout;
        await writeJsonFile(deploymentPath, deploymentJson, {
          pretty: true,
          trailingNewline: true,
        });
        process.exitCode = 1;
        continue;
      }
    }

    deploymentJson.upgradeStorageLayout = data.upgradeStorageLayout;
    await writeJsonFile(deploymentPath, deploymentJson, {
      pretty: true,
      trailingNewline: true,
    });
  }

  return result;
}

async function snapshotBaselines(
  deploymentsDir: string,
): Promise<Map<string, { address?: string; layout: StorageLayout }>> {
  const baselines = new Map<string, { address?: string; layout: StorageLayout }>();
  for (const file of await listDirOrEmpty(deploymentsDir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const deployment = await readDeployment(deploymentsDir, name).catch(() => null);
    if (deployment?.upgradeStorageLayout !== undefined) {
      baselines.set(name, { address: deployment.address, layout: deployment.upgradeStorageLayout });
    }
  }
  return baselines;
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
