/**
 * `record-baseline` task action.
 *
 * Writes a layout record for the implementation each proxy runs right now,
 * keyed by implementation address under `deployments/<network>/.storage-layouts/`,
 * and refreshes the proxy index offline runs read.
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
  getContractBuildData,
  createBuildInfoOutputCache,
  readDeployments,
  resolveArtifactName,
  resolveDeploymentNetworks,
  type DeploymentFile,
} from "../internals/deployment-utils.js";
import {
  artifactCodeLookup,
  classifyDeployment,
  discoverProxies,
  updateProxyIndex,
  type DiscoveredProxy,
  type DiscoveryError,
  type LocalCodeLookup,
} from "../internals/proxy-discovery.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { explorerConfig, probe } from "../internals/baseline.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import { recordLocalBuild, resolveImplementationLayout } from "../../core/onchain/baseline.js";
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
    const deployments = await readDeployments(deploymentsDir);
    if (deployments.size === 0) {
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
      totalSkipped += all ? deployments.size : 1;
      continue;
    }

    try {
      let found: Targets;
      try {
        found = await findTargets(
          provider!,
          deployments,
          all ? undefined : contract!,
          artifactCodeLookup(hre.artifacts),
        );
      } catch (e) {
        logger.log(
          `  [ERROR] "${networkName}": could not discover proxies: ${(e as Error).message}`,
        );
        anyFailed = true;
        continue;
      }
      for (const e of found.errors) {
        logger.log(
          `  [ERROR] ${e.address} (${e.deployments.map((n) => `"${n}"`).join(", ")}): ${e.reason}`,
        );
        anyFailed = true;
      }
      await updateProxyIndex(deploymentsDir, provider!, found.discovered);
      const { targets } = found;
      if (targets.length === 0) {
        if (all) logger.log(`[INFO] No proxy deployments found in ${deploymentsDir}`);
        else totalSkipped++;
        continue;
      }

      for (const [name, proxy] of targets) {
        try {
          const outcome = await recordBaseline(
            name,
            deployments.get(name)!,
            proxy.implementation,
            deploymentsDir,
            networkName,
            hre,
            { provider: provider!, cache, validations, force, fromChain },
          );
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

interface Targets {
  /** Every proxy found, for the index. */
  discovered: DiscoveredProxy[];
  /** (deployment name, its proxy) pairs to record. */
  targets: Array<[string, DiscoveredProxy]>;
  errors: DiscoveryError[];
}

// For a single contract, logs why it is skipped when it is not the code behind a proxy.
async function findTargets(
  provider: EthProvider,
  deployments: Map<string, DeploymentFile>,
  contract: string | undefined,
  localCode: LocalCodeLookup,
): Promise<Targets> {
  if (contract === undefined) {
    const { proxies, errors } = await discoverProxies(provider, deployments, { localCode });
    const targets = proxies.flatMap((p) =>
      p.deployments.map((n): [string, DiscoveredProxy] => [n, p]),
    );
    return { discovered: proxies, targets, errors };
  }
  const deployment = deployments.get(contract);
  const address = deployment?.address?.toLowerCase();
  if (deployment === undefined || address === undefined) {
    logger.log(`  [SKIP] "${contract}": no deployment file with an address.`);
    return { discovered: [], targets: [], errors: [] };
  }
  const { proxies, errors } = await discoverProxies(provider, deployments, {
    only: new Set([address]),
    localCode,
  });
  const proxy = proxies[0];
  if (errors.length === 0 && (proxy === undefined || !proxy.deployments.includes(contract))) {
    const { role } = await classifyDeployment(provider, contract, deployment, localCode);
    logger.log(
      role === "proxy-contract"
        ? `  [SKIP] "${contract}": describes the proxy contract itself; record the deployment that describes the code behind it${proxy ? ` (${proxy.deployments.join(", ")})` : ""}.`
        : `  [SKIP] "${contract}": ${address} has no ERC-1967 implementation or beacon slot set on this chain.`,
    );
    return { discovered: proxies, targets: [], errors };
  }
  return { discovered: proxies, targets: proxy ? [[contract, proxy]] : [], errors };
}

async function recordBaseline(
  name: string,
  deployment: DeploymentFile,
  implementation: string,
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

  const { bytecodeMatch, record } = await recordLocalBuild(ctx.provider, storeDir, implementation, {
    contract: `${artifact.sourceName}:${artifact.contractName}`,
    layout,
    deployedBytecode: artifact.deployedBytecode,
    immutableReferences: artifact.immutableReferences,
  });
  if (record === undefined) {
    const why =
      bytecodeMatch === "metadata-only"
        ? `matches the code ${implementation} runs only after stripping metadata, which does not prove its storage layout`
        : `is not the code ${implementation} runs; the source has moved on since it was deployed`;
    logger.log(
      `  [WARN] "${name}": the local build ${why}.\n` +
        `         Re-run with --from-chain to rebuild its layout from verified source.`,
    );
    return "skipped";
  }
  logger.log(
    `  [OK]   "${name}": recorded ${implementation} from the local build (${record.bytecodeMatch}).`,
  );
  return "recorded";
}
