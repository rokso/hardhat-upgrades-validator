/**
 * `record-baseline` task action.
 *
 * Writes a layout record for the implementation each proxy runs right now,
 * keyed by implementation address under `deployments/<network>/.storage-layouts/`.
 *
 * - Default: the local build's layout, recorded only if the chain runs exactly
 *   that build (immutables masked).
 * - `--from-chain`: the layout rebuilt from the implementation's verified
 *   source, for proxies whose code the local tree has moved past.
 *
 * Usage:
 *   npx hardhat record-baseline --all
 *   npx hardhat record-baseline --contract MyToken --from-chain
 */

import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { resolve } from "node:path";

import {
  readDeployment,
  getContractBuildData,
  createBuildInfoOutputCache,
  listDeployedProxies,
  resolveArtifactName,
  resolveDeploymentNetworks,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { explorerConfig, probe } from "../internals/baseline.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import { recordLocalBuild, resolveImplementationLayout } from "../../core/onchain/baseline.js";
import { BaselineUnavailableError } from "../../core/onchain/errors.js";
import { readImplementation } from "../../core/onchain/implementation.js";
import { layoutStoreDir, readLayoutRecord } from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import type { ImmutableReferences } from "../../core/bytecode-utils.js";
import { logger } from "../../utils/logger.js";

interface RecordBaselineArgs {
  contract?: string;
  all: boolean;
  force: boolean;
  fromChain?: boolean;
  network?: string;
}

type Outcome = "recorded" | "skipped";

const action: NewTaskActionFunction<RecordBaselineArgs> = async (
  { contract, all, force, fromChain = false, network },
  hre: HardhatRuntimeEnvironment,
) => {
  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, network);
  if (targetNetworks === null) return;

  if (!all && (contract === undefined || contract === "")) {
    throw new Error(
      "Provide --contract <name> to record a single contract, or --all to record every deployed proxy.",
    );
  }

  let totalRecorded = 0;
  let totalSkipped = 0;
  let anyFailed = false;
  const cache = createBuildInfoOutputCache();
  const validations = await loadValidationsFromDisk(hre.config.paths.cache);

  for (const networkName of targetNetworks) {
    const deploymentsDir = resolve(deploymentsBase, networkName);
    const contractNames = all ? await listDeployedProxies(deploymentsDir) : [contract!];

    if (contractNames.length === 0) {
      logger.log(`[INFO] No deployments found in ${deploymentsDir}`);
      continue;
    }

    // Records describe what the chain runs, so there is nothing to record without it.
    const connection = await hre.network.connect(networkName).catch(() => undefined);
    const provider = connection?.provider;
    const reachable =
      provider !== undefined &&
      (await probe(provider).then(
        () => true,
        () => false,
      ));
    if (!reachable) {
      logger.log(
        `[SKIP] Network "${networkName}": no reachable RPC. record-baseline reads the live implementation, so it needs one.`,
      );
      await connection?.close().catch(() => {});
      totalSkipped += contractNames.length;
      continue;
    }

    try {
      for (const name of contractNames) {
        try {
          const outcome = await recordBaseline(name, deploymentsDir, networkName, hre, {
            provider: provider!,
            cache,
            validations,
            force,
            fromChain,
          });
          if (outcome === "recorded") totalRecorded++;
          else totalSkipped++;
        } catch (e) {
          logger.log(`  [ERROR] "${name}": ${(e as Error).message}`);
          anyFailed = true;
        }
      }
    } finally {
      await connection?.close().catch(() => {});
    }
  }

  logger.log(
    `\n[INFO] Baseline recording complete: ${totalRecorded} recorded, ${totalSkipped} skipped.`,
  );
  if (anyFailed) process.exitCode = 1;
};

export default action;

async function recordBaseline(
  name: string,
  deploymentsDir: string,
  networkName: string,
  hre: HardhatRuntimeEnvironment,
  ctx: {
    provider: EthProvider;
    cache: ReturnType<typeof createBuildInfoOutputCache>;
    validations: ValidationDataCurrent | undefined;
    force: boolean;
    fromChain: boolean;
  },
): Promise<Outcome> {
  const deployment = await readDeployment(deploymentsDir, name);
  if (deployment?.address === undefined) {
    logger.log(`  [SKIP] "${name}": no deployment file with an address.`);
    return "skipped";
  }

  let implementation: string;
  try {
    implementation = await readImplementation(ctx.provider, deployment.address);
  } catch (e) {
    if (!(e instanceof BaselineUnavailableError)) throw e;
    logger.log(`  [SKIP] "${name}": ${e.message}`);
    return "skipped";
  }

  const storeDir = layoutStoreDir(deploymentsDir);
  if (!ctx.force && (await readLayoutRecord(storeDir, implementation)) !== undefined) {
    logger.log(`  [SKIP] "${name}": implementation ${implementation} already recorded.`);
    return "skipped";
  }

  if (ctx.fromChain) {
    const { record } = await resolveImplementationLayout(implementation, {
      provider: ctx.provider,
      storeDir,
      explorer: explorerConfig(hre.config.upgradesValidator, networkName),
      solc: { cacheDir: hre.config.upgradesValidator?.solcCacheDir },
      refresh: ctx.force,
    });
    logger.log(
      `  [OK]   "${name}": recorded ${implementation} from verified source (${record.contract}, ${record.bytecodeMatch}).`,
    );
    return "recorded";
  }

  const artifactName = resolveArtifactName(deployment, name);
  let layout;
  let artifact;
  try {
    ({ upgradeStorageLayout: layout } = await getContractBuildData(
      artifactName,
      hre.artifacts,
      ctx.validations,
      ctx.cache,
    ));
    artifact = (await hre.artifacts.readArtifact(artifactName)) as {
      contractName: string;
      sourceName: string;
      deployedBytecode: string;
      immutableReferences?: ImmutableReferences;
    };
  } catch {
    logger.log(`  [SKIP] "${name}" — artifact not found. Run \`hardhat build\` first.`);
    return "skipped";
  }

  if (layout === undefined) {
    const reason =
      ctx.validations === undefined
        ? `validation cache not found — run \`hardhat compile\` first.`
        : `contract not in validation cache — run \`hardhat compile\` to refresh.`;
    logger.log(`  [SKIP] "${name}" — ${reason}`);
    return "skipped";
  }

  const record = await recordLocalBuild(ctx.provider, storeDir, implementation, {
    contract: `${artifact.sourceName}:${artifact.contractName}`,
    layout,
    deployedBytecode: artifact.deployedBytecode,
    immutableReferences: artifact.immutableReferences,
  });
  if (record === undefined) {
    logger.log(
      `  [WARN] "${name}": the local build is not the code ${implementation} runs; the source has moved on since it was deployed.\n` +
        `         Re-run with --from-chain to rebuild its layout from verified source.`,
    );
    return "skipped";
  }
  if (record.bytecodeMatch === "metadata-only") {
    logger.log(
      `  [WARN] "${name}": matched only after stripping metadata, so the compiler input differed from the deployed build. Check the layout before relying on it.`,
    );
  }
  logger.log(
    `  [OK]   "${name}": recorded ${implementation} from the local build (${record.bytecodeMatch}).`,
  );
  return "recorded";
}
