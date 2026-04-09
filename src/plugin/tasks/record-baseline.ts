/**
 * `record-baseline` task action.
 *
 * Extracts the OZ-format storage layout from the current compiled artifact
 * and stamps it into each deployment JSON file as `upgradeStorageLayout`.
 *
 * Usage:
 *   npx hardhat record-baseline --all --network mainnet
 *   npx hardhat record-baseline --contract MyToken --network mainnet
 */

import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { join, resolve } from "node:path";

import {
  readDeployment,
  getContractBuildData,
  createBuildInfoOutputCache,
  compareBytecode,
  resolveArtifactName,
  resolveDeploymentNetworks,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import { listDirOrEmpty, readJsonFile, writeJsonFile } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

interface RecordBaselineArgs {
  contract?: string;
  all: boolean;
  force: boolean;
  network?: string;
}

const action: NewTaskActionFunction<RecordBaselineArgs> = async (
  { contract, all, force, network },
  hre: HardhatRuntimeEnvironment,
) => {
  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, network);
  if (targetNetworks === null) return;

  if (!all && (contract === undefined || contract === "")) {
    throw new Error(
      "Provide --contract <name> to record a single contract, or --all to record every deployed contract.",
    );
  }

  let totalRecorded = 0;
  let totalSkipped = 0;
  const cache = createBuildInfoOutputCache();
  const validations = await loadValidationsFromDisk(hre.config.paths.cache);

  for (const networkName of targetNetworks) {
    const deploymentsDir = resolve(deploymentsBase, networkName);

    const contractNames = all ? await listAllDeployedContracts(deploymentsDir) : [contract!];

    if (contractNames.length === 0) {
      logger.log(`[INFO] No deployments found in ${deploymentsDir}`);
      continue;
    }

    for (const name of contractNames) {
      const result = await recordBaseline(name, deploymentsDir, hre, cache, validations, force);
      if (result === "recorded") totalRecorded++;
      else totalSkipped++;
    }
  }

  logger.log(
    `\n[INFO] Baseline recording complete: ${totalRecorded} recorded, ${totalSkipped} skipped.`,
  );
};

export default action;

async function recordBaseline(
  name: string,
  deploymentsDir: string,
  hre: HardhatRuntimeEnvironment,
  cache: ReturnType<typeof createBuildInfoOutputCache>,
  validations: ValidationDataCurrent | undefined,
  force: boolean,
): Promise<"recorded" | "skipped"> {
  const deployment = await readDeployment(deploymentsDir, name);
  if (deployment === null) {
    logger.log(`  [SKIP] "${name}" — no deployment file found.`);
    return "skipped";
  }

  if (deployment.upgradeStorageLayout !== undefined && !force) {
    logger.log(`  [SKIP] "${name}" — baseline already recorded. Use --force to overwrite.`);
    return "skipped";
  }

  const artifactName = resolveArtifactName(deployment, name);

  let upgradeStorageLayout;
  try {
    ({ upgradeStorageLayout } = await getContractBuildData(
      artifactName,
      hre.artifacts,
      validations,
      cache,
    ));
  } catch {
    logger.log(`  [SKIP] "${name}" — artifact not found. Run \`hardhat build\` first.`);
    return "skipped";
  }

  if (upgradeStorageLayout === undefined) {
    const reason =
      validations === undefined
        ? `validation cache not found — run \`hardhat compile\` first.`
        : `contract not in validation cache — run \`hardhat compile\` to refresh.`;
    logger.log(`  [SKIP] "${name}" — ${reason}`);
    return "skipped";
  }

  // Verify bytecode matches before trusting the local layout.
  const artifactBytecode = (await hre.artifacts.readArtifact(artifactName)).deployedBytecode;
  const deployedBytecode = deployment.deployedBytecode;

  if (deployedBytecode === undefined || deployedBytecode === "") {
    if (!force) {
      logger.log(
        `  [SKIP] "${name}" — deployment file has no deployedBytecode, cannot verify code matches on-chain.\n` +
          `         Use --force to record anyway (risky if code has been updated since last deploy).`,
      );
      return "skipped";
    }
    logger.log(`  [WARN] "${name}" — skipping bytecode check (--force).`);
  } else {
    const cmp = compareBytecode(deployedBytecode, artifactBytecode);
    if (cmp.match === "none") {
      if (!force) {
        logger.log(
          `  [WARN] "${name}" — compiled bytecode does not match deployed bytecode.\n` +
            `         The local code has likely been updated since the last deploy.\n` +
            `         Check out the version that was deployed, then run record-baseline again.\n` +
            `         Use --force to record anyway (only if you are certain the layout is correct).`,
        );
        return "skipped";
      }
      logger.log(`  [WARN] "${name}" — bytecode mismatch ignored (--force).`);
    } else if (cmp.match === "metadata-only") {
      logger.log(
        `  [INFO] "${name}" — bytecode matches (metadata-only diff, likely compiler settings).`,
      );
    }
  }

  const deploymentPath = join(deploymentsDir, `${name}.json`);
  const deploymentJson = await readJsonFile<Record<string, unknown>>(deploymentPath);

  deploymentJson.upgradeStorageLayout = upgradeStorageLayout;

  await writeJsonFile(deploymentPath, deploymentJson, {
    pretty: true,
    trailingNewline: true,
  });

  logger.log(
    `  [OK]   "${name}" — baseline recorded (${upgradeStorageLayout.storage.length} variable(s)).`,
  );
  return "recorded";
}

async function listAllDeployedContracts(deploymentsDir: string): Promise<string[]> {
  const files = await listDirOrEmpty(deploymentsDir);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}
