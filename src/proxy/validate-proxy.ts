/**
 * Proxy upgrade validation helpers for use in hardhat-deploy / rocketh deploy scripts.
 *
 * The old layout is the implementation the proxy runs right now, read from the
 * chain (see `baseline`), and the new layout comes from the validations cache.
 * Neither needs to be passed explicitly.
 *
 * Usage:
 *
 *   import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
 *
 *   // Throws with a detailed error if storage layout is incompatible:
 *   await assertProxyUpgrade(hre, "MyContract");
 *
 *   // Your existing deploy call, completely unchanged:
 *   await deployViaProxy("MyContract", ...);
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { resolve } from "node:path";

import type { BaselineMode, UnsafeAllowKind, ValidationResult } from "../types/validation.js";

export type { BaselineInfo, BaselineMode, ValidationResult } from "../types/validation.js";
import {
  validateStorageUpgrade,
  formatValidationResult,
  filterSafetyErrors,
} from "../core/validator.js";
import type { EthProvider } from "../core/onchain/types.js";

/**
 * Thrown by `assertProxyUpgrade` when storage layout validation fails.
 * Catch this to handle upgrade failures programmatically.
 */
export class StorageLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageLayoutError";
  }
}
import {
  readDeployment,
  getContractBuildData,
  createBuildInfoOutputCache,
  resolveArtifactName,
  selectedNetwork,
} from "../plugin/internals/deployment-utils.js";
import {
  loadValidationsFromDisk,
  missingLayoutReason,
} from "../plugin/internals/validations-cache.js";
import { getInMemoryValidations } from "../plugin/hooks/compile.js";
import { resolveBaseline, type ResolvedBaseline } from "../plugin/internals/baseline.js";

export interface ProxyUpgradeOptions {
  unsafeAllow?: UnsafeAllowKind[];
  unsafeSkipStorageCheck?: boolean;
  /** Override the new implementation artifact name for this call only. */
  newImpl?: string;
  /** Where the old layout comes from. Defaults to `auto` (the chain when reachable). */
  baseline?: BaselineMode;
  /** Provider to read the chain with. Defaults to a connection to the `--network` network. */
  provider?: EthProvider;
}

async function resolveLayouts(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions,
) {
  const network = selectedNetwork(hre);
  if (network === undefined) {
    throw new Error(
      "[hardhat-upgrades-validator] Could not determine network. Pass --network when running your deploy script.",
    );
  }

  const deploymentsDir = resolve(hre.config.paths.root, "deployments", network);
  const deployment = await readDeployment(deploymentsDir, contractName);

  const mode = options.baseline ?? "auto";
  const baseline = await withProvider(hre, mode, options.provider, (provider) =>
    resolveBaseline({
      name: contractName,
      deployment,
      deploymentsDir,
      networkName: network,
      mode,
      provider,
      config: hre.config.upgradesValidator,
    }),
  );

  const validations =
    getInMemoryValidations() ?? (await loadValidationsFromDisk(hre.config.paths.cache));

  const artifactName = options.newImpl ?? resolveArtifactName(deployment, contractName);

  const cache = createBuildInfoOutputCache();
  const {
    upgradeStorageLayout: newLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind,
  } = await getContractBuildData(artifactName, hre.artifacts, validations, cache);

  return {
    baseline,
    validations,
    newLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind,
  };
}

// Opens a connection to the --network network unless the caller passed a
// provider or the mode never reads the chain. A failed connect means offline.
async function withProvider(
  hre: HardhatRuntimeEnvironment,
  mode: BaselineMode,
  provider: EthProvider | undefined,
  fn: (provider: EthProvider | undefined) => Promise<ResolvedBaseline>,
): Promise<ResolvedBaseline> {
  if (provider !== undefined || mode === "deployment") return fn(provider);
  const connection = await hre.network?.create().catch(() => undefined);
  try {
    return await fn(connection?.provider);
  } finally {
    await connection?.close().catch(() => {});
  }
}

export async function validateProxyUpgrade(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions = {},
): Promise<ValidationResult> {
  const {
    baseline,
    validations,
    newLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind,
  } = await resolveLayouts(hre, contractName, options);

  if (newLayout === undefined) {
    throw new Error(
      `[hardhat-upgrades-validator] No storage layout for "${contractName}": ${missingLayoutReason(validations)}`,
    );
  }

  const unsafeAllow = [...(options.unsafeAllow ?? []), ...(unsafeAllowFromAnnotation ?? [])];

  const result = validateStorageUpgrade(contractName, baseline.layout, newLayout, {
    unsafeAllow,
    unsafeSkipStorageCheck: options.unsafeSkipStorageCheck,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    kind: proxyKind,
  });

  const filteredSafety = filterSafetyErrors(safetyErrors, unsafeAllow);
  result.safetyErrors = filteredSafety;
  if (filteredSafety.length > 0) result.ok = false;
  result.baseline = baseline.info;
  result.warnings.push(...baseline.warnings);

  return result;
}

export async function assertProxyUpgrade(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions = {},
): Promise<void> {
  const result = await validateProxyUpgrade(hre, contractName, options);
  if (!result.ok) {
    // formatValidationResult returns "\nStorageLayoutError: ...\n  [ERROR]..."
    // Strip "StorageLayoutError: <header>" so error.name provides "StorageLayoutError:".
    // Keep the leading \n so detail lines start on a new line below the error name.
    const formatted = formatValidationResult(contractName, result);
    const message = formatted.replace(/StorageLayoutError: /, "").trimStart();
    throw new StorageLayoutError(message);
  }
}
