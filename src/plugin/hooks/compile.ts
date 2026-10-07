/**
 * Hardhat v3 `solidity.build` hook handler.
 *
 * After a successful compilation pass, scans every network directory under
 * `deployments/` for contracts that have a saved `upgradeStorageLayout`
 * baseline. For each such contract, retrieves the freshly compiled layout and
 * runs storage upgrade validation. Any errors cause `process.exitCode = 1`.
 *
 * Also hooks `invokeSolc` to perform a second "namespaced" compilation pass
 * (same approach as @openzeppelin/hardhat-upgrades) so that types used only
 * in namespace structs get proper `numberOfBytes` in the extracted layout.
 *
 * Additionally runs oz-core's `validate()` during each solc invocation while
 * we have the full SolcOutput, SolcInput, and solcVersion in hand. Results
 * are merged into a single ValidationData (same format as hardhat-upgrades'
 * cache/validations.json) and persisted to disk so the deploy hook and tasks
 * can use them without re-parsing build-info files.
 */

import type { HookContext } from "hardhat/types/hooks";
import type { SolcConfig } from "hardhat/types/config";
import {
  type BuildOptions,
  type CompilationJobCreationError,
  type FileBuildResult,
  type CompilerInput,
  type CompilerOutput,
  type Compiler,
  FileBuildResultType,
} from "hardhat/types/solidity";
import {
  type ValidationDataCurrent,
  type SolcInput,
  type SolcOutput,
  concatRunData,
} from "@openzeppelin/upgrades-core";

import { resolve } from "node:path";

import { loadValidationsFromDisk, writeValidationsToDisk } from "../internals/validations-cache.js";

import { isFullSolcOutput } from "../internals/is-full-solc-output.js";

import {
  validateStorageUpgrade,
  formatValidationResult,
  filterSafetyErrors,
} from "../../core/validator.js";
import {
  readDeployment,
  listDeployedProxies,
  getContractBuildData,
  createBuildInfoOutputCache,
  resolveArtifactName,
} from "../internals/deployment-utils.js";
import { resolveBaseline } from "../internals/baseline.js";
import { listSubdirsOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// In-memory ValidationData store (populated by invokeSolc, consumed by build)
// Mirrors the approach in @openzeppelin/hardhat-upgrades/utils/validations.ts
// ---------------------------------------------------------------------------

let inMemoryValidations: ValidationDataCurrent | null = null;

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
// invokeSolc hook
// ---------------------------------------------------------------------------

type InvokeSolcNext = (
  ctx: HookContext,
  compiler: Compiler,
  input: CompilerInput,
  config: SolcConfig,
) => Promise<CompilerOutput>;

function isCompileHookEnabled(context: HookContext): boolean {
  return (
    (
      context.config as typeof context.config & {
        upgradesValidator?: { enableCompileHook?: boolean };
      }
    ).upgradesValidator?.enableCompileHook ?? true
  );
}

async function invokeSolcHandler(
  context: HookContext,
  compiler: Compiler,
  solcInput: CompilerInput,
  solcConfig: SolcConfig,
  next: InvokeSolcNext,
): Promise<CompilerOutput> {
  const output = await next(context, compiler, solcInput, solcConfig);

  if (!isCompileHookEnabled(context)) return output;

  // Skip partial/cached outputs — only process full solc output (has contracts
  // with bytecode and sources with ASTs). Adapted from @openzeppelin/hardhat-upgrades.
  if (!isFullSolcOutput(toSolcOutput(output))) return output;

  const {
    makeNamespacedInput,
    trySanitizeNatSpec,
    isNamespaceSupported,
    validate: ozValidate,
    solcInputOutputDecoder,
  } = await import("@openzeppelin/upgrades-core");

  // --- Namespaced compilation pass ---
  // Run a second solc pass so namespace struct members get proper slot/type
  // info in the extracted layout (mirrors @openzeppelin/hardhat-upgrades).
  let namespacedOutput: SolcOutput | undefined;
  if (isNamespaceSupported(compiler.version)) {
    try {
      let namespacedInput = makeNamespacedInput(
        toSolcInput(solcInput),
        toSolcOutput(output),
        compiler.version,
      );
      namespacedInput = await trySanitizeNatSpec(namespacedInput, compiler.version);

      const nsOut = await next(context, compiler, toCompilerInput(namespacedInput), solcConfig);
      const nsErrors = (nsOut.errors ?? []).filter((e) => e.severity === "error");
      if (nsErrors.length === 0) {
        namespacedOutput = toSolcOutput(nsOut);
      } else {
        const msg = `Namespaced compilation produced errors (namespace layout types may be incomplete). First error: ${nsErrors[0].message}`;
        throw new Error(`[hardhat-upgrades-validator] ${msg}`);
      }
    } catch (err) {
      throw err instanceof Error
        ? err
        : new Error(
            `[hardhat-upgrades-validator] Namespaced compilation failed (namespace layout types may be incomplete): ${err}`,
          );
    }
  }

  // --- oz-core safety validation ---
  // Run validate() with full context: handles @custom:oz-upgrades-unsafe-allow
  // annotations, constructor/delegatecall/selfdestruct checks, proxy kind
  // inference, and namespace layout extraction — all baked into the returned
  // ValidationRunData. Merge into the module-level store so a single
  // validations.json is written at the end of the build (same as hardhat-upgrades).
  try {
    const decodeSrc = solcInputOutputDecoder(toSolcInput(solcInput), toSolcOutput(output));
    const runData = ozValidate(
      toSolcOutput(output),
      decodeSrc,
      compiler.version,
      toSolcInput(solcInput),
      namespacedOutput,
    );
    inMemoryValidations = concatRunData(runData, inMemoryValidations ?? undefined);
  } catch (err) {
    logger.warn(`Safety validation step failed (contract-level checks may be skipped): ${err}`);
  }

  return output;
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
  if (!isCompileHookEnabled(context)) return next(context, rootFilePaths, options);

  inMemoryValidations = null;

  // If the validations cache is missing, force a full recompile so all contracts
  // get a fresh solc invocation and populate the cache. Without this, incremental
  // builds would silently skip unchanged contracts, leaving them out of the cache
  // and causing "layout not found" errors at deploy time.
  // Mirrors the same guard in @openzeppelin/hardhat-upgrades.
  const cacheExists = await loadValidationsFromDisk(context.config.paths.cache);
  if (!cacheExists && !options?.force) {
    options = { ...options, force: true };
  }

  const result = await next(context, rootFilePaths, options);

  // If fresh compilations ran, merge with the existing disk cache and persist.
  // Without merging, incremental builds (only changed files recompiled) would
  // overwrite and lose validations for unchanged contracts. If all jobs were
  // cache hits (inMemoryValidations is still null), leave the disk file intact.
  //
  // Note: concatRunData expects a single ValidationRunData (one solc run), not
  // a ValidationDataCurrent. We merge two ValidationDataCurrent objects by
  // concatenating their log arrays directly. Newer entries come first so that
  // oz-core's lookup (which scans log from the front) finds the latest version.
  if (inMemoryValidations !== null) {
    const current: ValidationDataCurrent = inMemoryValidations;
    const existing = await loadValidationsFromDisk(context.config.paths.cache);
    if (existing) {
      inMemoryValidations = {
        version: current.version,
        log: [...current.log, ...existing.log],
      };
    }
    await writeValidationsToDisk(context.config.paths.cache, inMemoryValidations).catch(() => {});
  }

  const noFailures =
    result instanceof Map &&
    [...result.values()].every((r) => r.type !== FileBuildResultType.BUILD_FAILURE);

  const validations =
    inMemoryValidations ?? (await loadValidationsFromDisk(context.config.paths.cache));

  if (noFailures && (options?.scope ?? "contracts") === "contracts") {
    await runAutoValidation(context, validations);
  }

  return result;
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
  const cache = createBuildInfoOutputCache();

  for (const network of networkDirs) {
    const deploymentsDir = resolve(deploymentsBase, network);
    const contractNames = await listDeployedProxies(deploymentsDir);

    for (const name of contractNames) {
      const deployment = await readDeployment(deploymentsDir, name);

      if (!deployment) continue;

      // Compiling must not need an RPC or explorer, so this is always offline:
      // the stored record for the deployment file's implementation, else the
      // deprecated field. validate-upgrade and assertProxyUpgrade read the chain.
      const baseline = await resolveBaseline({
        name,
        deployment,
        deploymentsDir,
        networkName: network,
        mode: "auto",
        config: context.config.upgradesValidator,
      });
      const oldLayout = baseline.layout;
      if (oldLayout === undefined) continue;

      const artifactName = resolveArtifactName(deployment, name);

      let upgradeStorageLayout;
      let unsafeAllowFromAnnotation;
      let perVariableUnsafeAllow;
      let namespaceUnsafeAllow;
      let safetyErrors;
      let proxyKind;
      try {
        ({
          upgradeStorageLayout,
          unsafeAllowFromAnnotation,
          perVariableUnsafeAllow,
          namespaceUnsafeAllow,
          safetyErrors,
          proxyKind,
        } = await getContractBuildData(artifactName, context.artifacts, validations, cache));
      } catch (err) {
        logger.error(`Failed to read build data for "${name}": ${err}`);
        anyErrors = true;
        continue;
      }

      if (upgradeStorageLayout === undefined) {
        continue;
      }

      const validation = validateStorageUpgrade(name, oldLayout, upgradeStorageLayout, {
        unsafeAllow: unsafeAllowFromAnnotation,
        perVariableUnsafeAllow,
        namespaceUnsafeAllow,
        kind: proxyKind,
      });
      const filteredSafety = filterSafetyErrors(safetyErrors, unsafeAllowFromAnnotation);
      validation.safetyErrors = filteredSafety;
      if (filteredSafety.length > 0) validation.ok = false;
      validation.baseline = baseline.info;
      validation.warnings.push(...baseline.warnings);

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
    logger.log("[OK] All storage layout checks passed.\n");
  } else if (anyErrors) {
    console.log(); // blank line after last error block
  }

  if (anyErrors) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// storageLayout + devdoc + ast output injection
// ---------------------------------------------------------------------------

const REQUIRED_CONTRACT_OUTPUTS = ["storageLayout", "devdoc"];
const REQUIRED_FILE_OUTPUTS = ["ast"];

async function injectRequiredOutputs(
  _context: HookContext,
  solcInput: CompilerInput,
  next: (ctx: HookContext, input: CompilerInput) => Promise<CompilerInput>,
): Promise<CompilerInput> {
  const sel = solcInput.settings?.outputSelection;
  if (sel !== undefined) {
    for (const file of Object.keys(sel)) {
      for (const contract of Object.keys(sel[file])) {
        if (contract === "") continue;
        for (const output of REQUIRED_CONTRACT_OUTPUTS) {
          if (!sel[file][contract].includes(output)) {
            sel[file][contract].push(output);
          }
        }
      }
      sel[file][""] ??= [];
      for (const output of REQUIRED_FILE_OUTPUTS) {
        if (!sel[file][""].includes(output)) {
          sel[file][""].push(output);
        }
      }
    }
  }
  return next(_context, solcInput);
}

export default async function () {
  return {
    build: buildHandler,
    invokeSolc: invokeSolcHandler,
    preprocessSolcInputBeforeBuilding: injectRequiredOutputs,
  };
}
