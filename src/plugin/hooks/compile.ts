/**
 * Hardhat v3 `solidity.build` hook handler.
 *
 * After a successful compilation pass, scans every network directory under
 * `deployments/` for contracts that have a saved `upgradeStorageLayout`
 * baseline, and validates each against the freshly compiled layout. Any
 * errors cause `process.exitCode = 1`.
 *
 * Also handles `getCompilationJobErrors`, which sees each compilation job's
 * solc input and full output, to run oz-core's `validate()` on it. Before
 * that it runs a second "namespaced" compilation (same approach as
 * @openzeppelin/hardhat-upgrades) through Hardhat's `compileBuildInfo`, so
 * types used only in namespace structs get proper `numberOfBytes` in the
 * extracted layout. Results are merged into a single ValidationData (same
 * format as hardhat-upgrades' cache/validations.json) and persisted to disk
 * so the deploy hook and tasks can use them without re-parsing build-info
 * files. The solc outputs this needs are requested by the config hook.
 */

import type { HookContext, SolidityHooks } from "hardhat/types/hooks";
import {
  type BuildOptions,
  type CompilationJob,
  type CompilationJobCreationError,
  type FileBuildResult,
  type CompilerInput,
  type CompilerOutput,
  FileBuildResultType,
} from "hardhat/types/solidity";
import {
  type ValidationDataCurrent,
  type SolcInput,
  type SolcOutput,
  concatRunData,
} from "@openzeppelin/upgrades-core";

import { resolve } from "node:path";

import {
  loadValidationsFromDisk,
  missingLayoutReason,
  removeValidationsFromDisk,
  writeValidationsToDisk,
} from "../internals/validations-cache.js";

import { isFullSolcOutput } from "../internals/is-full-solc-output.js";

import {
  validateStorageUpgrade,
  formatValidationResult,
  withSafetyErrors,
} from "../../core/validator.js";
import {
  readDeployment,
  listDeployedContractsWithLayout,
  getContractBuildData,
  createBuildInfoOutputCache,
  resolveArtifactName,
} from "../internals/deployment-utils.js";
import { listSubdirsOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// In-memory ValidationData store (populated per compilation job, consumed by build)
// Mirrors the approach in @openzeppelin/hardhat-upgrades/utils/validations.ts
// ---------------------------------------------------------------------------

let inMemoryValidations: ValidationDataCurrent | null = null;
// Set when a job compiled but could not be validated, so the disk cache would
// be missing contracts Hardhat will not recompile.
let incompleteValidations = false;

export function getInMemoryValidations(): ValidationDataCurrent | null {
  return inMemoryValidations;
}

// ---------------------------------------------------------------------------
// Type cast helpers
// Adapted from @openzeppelin/hardhat-upgrades (MIT)
// https://github.com/OpenZeppelin/openzeppelin-upgrades
// Hardhat's CompilerInput/CompilerOutput and oz-core's SolcInput/SolcOutput are
// structurally compatible but have separate type declarations. These helpers
// make the intent of each cast explicit instead of scattering `as never`.
// ---------------------------------------------------------------------------

function toSolcInput(input: CompilerInput): SolcInput {
  return input as unknown as SolcInput;
}

function toSolcOutput(output: CompilerOutput): SolcOutput {
  return output as unknown as SolcOutput;
}

function toCompilerInput(input: SolcInput): CompilerInput {
  return input as unknown as CompilerInput;
}

// ---------------------------------------------------------------------------
// getCompilationJobErrors hook
// ---------------------------------------------------------------------------

type JobErrorsNext = Parameters<SolidityHooks["getCompilationJobErrors"]>[3];

function isCompileHookEnabled(context: HookContext): boolean {
  return (
    (
      context.config as typeof context.config & {
        upgradesValidator?: { enableCompileHook?: boolean };
      }
    ).upgradesValidator?.enableCompileHook ?? true
  );
}

// Runs once per compilation job that actually compiled (not cache hits),
// after its artifacts are emitted and before build() returns. The job's
// errors pass through untouched.
async function getCompilationJobErrorsHandler(
  context: HookContext,
  compilationJob: Readonly<CompilationJob>,
  compilerOutput: Readonly<CompilerOutput>,
  next: JobErrorsNext,
): ReturnType<JobErrorsNext> {
  const errors = await next(context, compilationJob, compilerOutput);
  if (!isCompileHookEnabled(context)) return errors;

  // Skip partial/failed outputs: only process full solc output (has contracts
  // with bytecode and sources with ASTs). Adapted from @openzeppelin/hardhat-upgrades.
  const output = toSolcOutput(compilerOutput as CompilerOutput);
  if (!isFullSolcOutput(output)) return errors;

  await recordValidations(context, compilationJob, output);
  return errors;
}

async function recordValidations(
  context: HookContext,
  compilationJob: Readonly<CompilationJob>,
  output: SolcOutput,
): Promise<void> {
  const {
    makeNamespacedInput,
    trySanitizeNatSpec,
    isNamespaceSupported,
    validate: ozValidate,
    solcInputOutputDecoder,
  } = await import("@openzeppelin/upgrades-core");

  const version = compilationJob.solcConfig.version;
  const input = toSolcInput(await compilationJob.getSolcInput());

  // --- Namespaced compilation pass ---
  // A second solc pass so namespace struct members get proper slot/type info
  // in the extracted layout (mirrors @openzeppelin/hardhat-upgrades). Errors
  // fail the build: without it, namespace layouts would be silently incomplete.
  let namespacedOutput: SolcOutput | undefined;
  if (isNamespaceSupported(version)) {
    let nsOut: CompilerOutput;
    try {
      const namespacedInput = await trySanitizeNatSpec(
        makeNamespacedInput(input, output, version),
        version,
      );
      nsOut = await compileNamespaced(context, compilationJob, toCompilerInput(namespacedInput));
    } catch (err) {
      throw new Error(
        `[hardhat-upgrades-validator] Namespaced compilation failed (namespace layout types may be incomplete): ${(err as Error).message ?? err}`,
        { cause: err },
      );
    }
    const nsErrors = (nsOut.errors ?? []).filter((e) => e.severity === "error");
    if (nsErrors.length > 0) {
      throw new Error(
        `[hardhat-upgrades-validator] Namespaced compilation produced errors (namespace layout types may be incomplete). First error: ${nsErrors[0].message}`,
      );
    }
    namespacedOutput = toSolcOutput(nsOut);
  }

  // --- oz-core safety validation ---
  // Run validate() with full context: handles @custom:oz-upgrades-unsafe-allow
  // annotations, constructor/delegatecall/selfdestruct checks, proxy kind
  // inference, and namespace layout extraction, all baked into the returned
  // ValidationRunData. Merge into the module-level store so a single
  // validations.json is written at the end of the build (same as hardhat-upgrades).
  try {
    const decodeSrc = solcInputOutputDecoder(input, output);
    const runData = ozValidate(output, decodeSrc, version, input, namespacedOutput);
    inMemoryValidations = concatRunData(runData, inMemoryValidations ?? undefined);
  } catch (err) {
    incompleteValidations = true;
    logger.warn(
      `Validation failed for a compilation job: ${err}. Upgrade checks are off until this is ` +
        `fixed: the validation cache is not saved, so validate-upgrade fails for every proxy, ` +
        `and every build recompiles everything to retry.`,
    );
  }
}

// Compiles the namespaced input with the job's compiler version through
// Hardhat's compileBuildInfo, which downloads solc by version (it ignores a
// configured compiler `path`; Hardhat before 3.10 also ignores `compilerType`).
// It runs no hooks and caches nothing, so this cannot recurse into the build.
async function compileNamespaced(
  context: HookContext,
  compilationJob: Readonly<CompilationJob>,
  input: CompilerInput,
): Promise<CompilerOutput> {
  const { type } = compilationJob.solcConfig;
  return context.solidity.compileBuildInfo(
    {
      _format: "hh3-sol-build-info-1",
      id: `${await compilationJob.getBuildId()}-namespaced`,
      solcVersion: compilationJob.solcConfig.version,
      solcLongVersion: compilationJob.solcLongVersion,
      ...(type !== undefined && type !== "solc" ? { compilerType: type } : {}),
      userSourceNameMap: {},
      input,
    },
    { quiet: true },
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
  if (!isCompileHookEnabled(context)) {
    // Jobs compiled now are cached by Hardhat without being validated, so the
    // validation cache would be missing them once the hook is re-enabled.
    await removeValidationsFromDisk(context.config.paths.cache);
    return next(context, rootFilePaths, options);
  }

  inMemoryValidations = null;
  incompleteValidations = false;
  const cachePath = context.config.paths.cache;

  // If the validations cache is missing, force a full recompile so all contracts
  // get a fresh solc invocation and populate the cache. Without this, incremental
  // builds would silently skip unchanged contracts, leaving them out of the cache
  // and causing "layout not found" errors at deploy time.
  // Mirrors the same guard in @openzeppelin/hardhat-upgrades.
  const existing = await loadValidationsFromDisk(cachePath);
  if (!existing && !options?.force) {
    options = { ...options, force: true };
  }

  // Hardhat caches each compilation job before getCompilationJobErrors
  // validates it, and never recompiles a cached job. So the cache file is
  // removed for the duration of the build and written back only when every
  // job that compiled was validated: a build that throws or dies in between
  // leaves it missing, which forces the full recompile above next time.
  // Readers treat a missing cache as an error, never as nothing to check.
  if (existing) await removeValidationsFromDisk(cachePath);
  // Without an existing cache, only a build of every contract can start one:
  // a partial one would leave out contracts Hardhat then keeps cached.
  const canStartCache =
    existing !== undefined || (await buildsEveryContract(context, rootFilePaths, options));

  const result = await next(context, rootFilePaths, options);

  // Newer entries come first, so oz-core's lookup (which scans the log from
  // the front) finds the latest version of a contract. ValidationDataCurrent
  // objects are merged by concatenating their logs: concatRunData takes a
  // single run.
  // (Read through the getter: the job handler set it during next().)
  const fresh = getInMemoryValidations();
  if (fresh !== null && existing) {
    inMemoryValidations = { version: fresh.version, log: [...fresh.log, ...existing.log] };
  }
  const merged = getInMemoryValidations() ?? existing;
  if (merged !== undefined && !incompleteValidations && canStartCache) {
    await writeValidationsToDisk(cachePath, merged).catch((err) =>
      logger.warn(
        `Could not save the validation cache (the next build recompiles everything): ${err}`,
      ),
    );
  }

  const noFailures =
    result instanceof Map &&
    [...result.values()].every((r) => r.type !== FileBuildResultType.BUILD_FAILURE);

  if (noFailures && (options?.scope ?? "contracts") === "contracts") {
    await runAutoValidation(context, merged);
  }

  return result;
}

async function buildsEveryContract(
  context: HookContext,
  rootFilePaths: string[],
  options: BuildOptions | undefined,
): Promise<boolean> {
  if ((options?.scope ?? "contracts") !== "contracts") return false;
  const built = new Set(rootFilePaths);
  const all = await context.solidity.getRootFilePaths({ scope: "contracts" });
  return all.every((p) => built.has(p));
}

async function runAutoValidation(
  context: HookContext,
  validations: ValidationDataCurrent | undefined,
): Promise<void> {
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
  const cache = createBuildInfoOutputCache();

  for (const network of networkDirs) {
    const deploymentsDir = resolve(deploymentsBase, network);
    const contractNames = await listDeployedContractsWithLayout(deploymentsDir);

    for (const name of contractNames) {
      const deployment = await readDeployment(deploymentsDir, name);

      if (!deployment) {
        logger.log(`  [SKIP] "${network}/${name}": deployment file not found.`);
        skipped++;
        continue;
      }

      // listDeployedContractsWithLayout guarantees upgradeStorageLayout is present.
      const oldLayout = deployment.upgradeStorageLayout!;

      const artifactName = resolveArtifactName(deployment, name);

      let upgradeStorageLayout;
      let safetyErrors;
      let proxyKind;
      try {
        ({ upgradeStorageLayout, safetyErrors, proxyKind } = await getContractBuildData(
          artifactName,
          context.artifacts,
          validations,
          cache,
        ));
      } catch (err) {
        logger.error(`Failed to read build data for "${name}": ${err}`);
        anyErrors = true;
        continue;
      }

      if (upgradeStorageLayout === undefined) {
        logger.log(
          `  [SKIP] "${network}/${name}": ${artifactName}: ${missingLayoutReason(validations)}`,
        );
        skipped++;
        continue;
      }

      const validation = withSafetyErrors(
        validateStorageUpgrade(name, oldLayout, upgradeStorageLayout, { kind: proxyKind }),
        safetyErrors,
      );

      const message = formatValidationResult(name, validation);

      anyValidated = true;

      if (!validation.ok || validation.warnings.length > 0) {
        logger.log(message);
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
    getCompilationJobErrors: getCompilationJobErrorsHandler,
  } satisfies Partial<SolidityHooks>;
}
