/**
 * Hardhat v3 `deploy` task override.
 *
 * After hardhat-deploy runs, records the layout of every implementation named
 * by a proxy deployment on the selected network (`--network`), keyed by
 * implementation address. A record is written only when the chain runs the
 * local build, so implementations deployed through the plugin never need an
 * explorer to be validated against later.
 *
 * Recording against the implementation (not the proxy) is what keeps queued
 * upgrades correct: the record for the new implementation exists from the
 * moment it is deployed, while validation keeps comparing against whatever
 * the proxy actually runs until the upgrade executes.
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";
import { resolve } from "node:path";

import {
  readDeployment,
  resolveArtifactName,
  getContractBuildData,
  createBuildInfoOutputCache,
  compareBytecode,
} from "../internals/deployment-utils.js";
import { getInMemoryValidations } from "./compile.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { probe } from "../internals/baseline.js";
import { recordLocalBuild } from "../../core/onchain/baseline.js";
import { layoutStoreDir, readLayoutRecord } from "../../core/onchain/store.js";
import type { ImmutableReferences } from "../../core/bytecode-utils.js";
import { listDirOrEmpty, listSubdirsOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

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
  const files = (await listDirOrEmpty(deploymentsDir)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return result;

  // Only implementations some proxy points at are worth a record.
  const implementations = new Set<string>();
  for (const file of files) {
    const impl = (await readDeployment(deploymentsDir, file.slice(0, -5)))?.implementation;
    if (impl !== undefined) implementations.add(impl.toLowerCase());
  }
  if (implementations.size === 0) return result;

  const connection = await hre.network.connect().catch(() => undefined);
  const provider = connection?.provider;
  try {
    if (
      provider === undefined ||
      !(await probe(provider).then(
        () => true,
        () => false,
      ))
    ) {
      logger.log(
        `[INFO] No reachable RPC for "${targetNetwork}"; skipped recording implementation layouts.`,
      );
      return result;
    }

    const storeDir = layoutStoreDir(deploymentsDir);
    const cache = createBuildInfoOutputCache();
    const validations =
      getInMemoryValidations() ?? (await loadValidationsFromDisk(hre.config.paths.cache));

    for (const file of files) {
      const name = file.slice(0, -5);
      const deployment = await readDeployment(deploymentsDir, name);
      const address = deployment?.address?.toLowerCase();
      if (address === undefined || !implementations.has(address)) continue;
      if (!deployment?.deployedBytecode) continue;
      if ((await readLayoutRecord(storeDir, address)) !== undefined) continue;

      const artifactName = resolveArtifactName(deployment, name);

      let upgradeStorageLayout;
      let artifact;
      try {
        [{ upgradeStorageLayout }, artifact] = await Promise.all([
          getContractBuildData(artifactName, hre.artifacts, validations, cache),
          hre.artifacts.readArtifact(artifactName) as Promise<{
            contractName: string;
            sourceName: string;
            deployedBytecode: string;
            immutableReferences?: ImmutableReferences;
          }>,
        ]);
      } catch {
        continue; // artifact not found — not our contract
      }

      if (upgradeStorageLayout === undefined) continue;

      // Cheap offline pre-filter; recordLocalBuild then proves it against the chain.
      if (
        compareBytecode(deployment.deployedBytecode, artifact.deployedBytecode).match === "none"
      ) {
        continue;
      }

      try {
        await recordLocalBuild(provider, storeDir, address, {
          contract: `${artifact.sourceName}:${artifact.contractName}`,
          layout: upgradeStorageLayout,
          deployedBytecode: artifact.deployedBytecode,
          immutableReferences: artifact.immutableReferences,
        });
      } catch (e) {
        // A failed record must not fail a deploy that already succeeded.
        logger.warn(`Could not record the layout of ${name} (${address}): ${(e as Error).message}`);
      }
    }
  } finally {
    await connection?.close().catch(() => {});
  }

  return result;
}
