/**
 * Hardhat v3 `solidity.build` hook handler.
 *
 * After a successful compilation pass, validates every proxy deployment the
 * proxy index (or a deprecated `upgradeStorageLayout` field) knows about, in
 * every network directory under `deployments/`, against the freshly compiled
 * code. Offline only. Any errors cause `process.exitCode = 1`.
 *
 * The new side comes from the build info Hardhat wrote, analyzed by slotdiff
 * (`build-analysis.ts`); the solc outputs that needs are requested by the
 * config hook.
 */

import type { HookContext, SolidityHooks } from "hardhat/types/hooks";
import {
  type BuildOptions,
  type CompilationJobCreationError,
  type FileBuildResult,
  FileBuildResultType,
} from "hardhat/types/solidity";

import { resolve } from "node:path";

import { formatValidationResult, validateUpgrade } from "../../core/validator.js";
import { readDeployment, resolveArtifactName } from "../internals/deployment-utils.js";
import { createBuildAnalyzer } from "../internals/build-analysis.js";
import { baselineSide, resolveBaseline } from "../internals/baseline.js";
import { LayoutUnavailableError } from "../../core/onchain/errors.js";
import { listProxyDeployments } from "../internals/proxy-discovery.js";
import { listSubdirsOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

function isCompileHookEnabled(context: HookContext): boolean {
  return (
    (
      context.config as typeof context.config & {
        upgradesValidator?: { enableCompileHook?: boolean };
      }
    ).upgradesValidator?.enableCompileHook ?? true
  );
}

// ---------------------------------------------------------------------------
// Build hook
// ---------------------------------------------------------------------------

type BuildResult = CompilationJobCreationError | Map<string, FileBuildResult>;
type BuildNext = (
  ctx: HookContext,
  paths: string[],
  opts: BuildOptions | undefined,
) => Promise<BuildResult>;

async function buildHandler(
  context: HookContext,
  rootFilePaths: string[],
  options: BuildOptions | undefined,
  next: BuildNext,
): Promise<BuildResult> {
  const result = await next(context, rootFilePaths, options);
  if (!isCompileHookEnabled(context)) return result;

  const noFailures =
    result instanceof Map &&
    [...result.values()].every((r) => r.type !== FileBuildResultType.BUILD_FAILURE);

  if (noFailures && (options?.scope ?? "contracts") === "contracts") {
    await runAutoValidation(context);
  }

  return result;
}

async function runAutoValidation(context: HookContext): Promise<void> {
  const projectRoot = context.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");

  const allNetworkDirs = await listSubdirsOrEmpty(deploymentsBase);
  const networksConfig = context.config.upgradesValidator?.networks ?? "all";
  const networkDirs =
    networksConfig === "all"
      ? allNetworkDirs
      : allNetworkDirs.filter((n) => networksConfig.includes(n));
  if (networkDirs.length === 0) return;

  logger.log("\n[hardhat-upgrades-validator] Checking storage layout compatibility...");

  let anyErrors = false;
  let anyValidated = false;
  let skipped = 0;
  const analyze = createBuildAnalyzer(context.artifacts, context.solidity);

  for (const network of networkDirs) {
    const deploymentsDir = resolve(deploymentsBase, network);
    let contractNames: string[];
    try {
      const listed = await listProxyDeployments(deploymentsDir);
      contractNames = listed.names;
      for (const e of listed.errors) {
        logger.error(`"${network}" ${e.address} (${e.deployments.join(", ")}): ${e.reason}`);
        anyErrors = true;
      }
    } catch (err) {
      logger.error(`Could not read the proxy index for "${network}": ${(err as Error).message}`);
      anyErrors = true;
      continue;
    }

    for (const name of contractNames) {
      const deployment = await readDeployment(deploymentsDir, name);

      if (!deployment) {
        logger.log(`  [SKIP] "${network}/${name}": deployment file not found.`);
        skipped++;
        continue;
      }

      // Compiling must not need an RPC or explorer, so this is always offline:
      // the record for the implementation the proxy index names, else the
      // deprecated field. validate-upgrade and assertProxyUpgrade read the chain.
      let baseline;
      try {
        baseline = await resolveBaseline({
          name,
          deployment,
          deploymentsDir,
          networkName: network,
          config: context.config.upgradesValidator,
        });
      } catch (err) {
        // Compiling stays usable offline: a known proxy with no record is
        // reported here, and fails validate-upgrade and assertProxyUpgrade.
        if (err instanceof LayoutUnavailableError) {
          logger.log(`  [SKIP] "${network}/${name}": ${err.message}`);
          skipped++;
          continue;
        }
        logger.error(`Could not read the baseline for "${name}": ${(err as Error).message}`);
        anyErrors = true;
        continue;
      }
      if (baseline.layout === undefined) {
        logger.log(`  [SKIP] "${network}/${name}": no baseline.`);
        skipped++;
        continue;
      }

      const artifactName = resolveArtifactName(deployment, name);

      let next;
      try {
        next = await analyze(artifactName);
      } catch (err) {
        logger.error(`Failed to read build data for "${name}": ${(err as Error).message}`);
        anyErrors = true;
        continue;
      }

      const validation = validateUpgrade(name, baselineSide(baseline), next);
      validation.baseline = baseline.info;
      validation.warnings.push(...baseline.warnings);

      anyValidated = true;

      if (!validation.ok || validation.warnings.length > 0) {
        logger.log(formatValidationResult(`${network}/${name}`, validation));
      }

      if (!validation.ok) {
        anyErrors = true;
      }
    }
  }

  if (anyValidated && !anyErrors) {
    logger.log(
      skipped === 0
        ? "[OK] All storage layout checks passed.\n"
        : `[OK] Storage layout checks passed; ${skipped} skipped (see above).\n`,
    );
  } else if (anyErrors) {
    console.log(); // blank line after last error block
  }

  if (anyErrors) {
    process.exitCode = 1;
  }
}

export default async function () {
  return {
    build: buildHandler,
  } satisfies Partial<SolidityHooks>;
}
