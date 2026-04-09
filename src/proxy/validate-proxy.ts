/**
 * Proxy upgrade validation helpers for use in hardhat-deploy / rocketh deploy scripts.
 *
 * Both the old layout (from the recorded baseline) and the new layout (from
 * the validations cache) are resolved automatically — no need to pass them
 * explicitly.
 *
 * Usage:
 *
 *   import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
 *
 *   // Throws with a detailed error if storage layout is incompatible:
 *   await assertProxyUpgrade(hre, "MyContract");
 *
 *   // Your existing deploy call — completely unchanged:
 *   await deployViaProxy("MyContract", ...);
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { resolve } from "node:path";

import type { UnsafeAllowKind, ValidationResult } from "../types/validation.js";
import {
  validateStorageUpgrade,
  formatValidationResult,
  filterSafetyErrors,
} from "../core/validator.js";

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
} from "../plugin/internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../plugin/internals/validations-cache.js";
import { getInMemoryValidations } from "../plugin/hooks/compile.js";

export interface ProxyUpgradeOptions {
  unsafeAllow?: UnsafeAllowKind[];
  unsafeSkipStorageCheck?: boolean;
  /** Override the new implementation artifact name for this call only. */
  newImpl?: string;
}

async function resolveLayouts(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  newImplOverride?: string,
) {
  const network = hre.globalOptions.network?.trim();
  if (!network) {
    throw new Error(
      "[hardhat-upgrades-validator] Could not determine network. Pass --network when running your deploy script.",
    );
  }

  const deploymentsDir = resolve(hre.config.paths.root, "deployments", network);
  const deployment = await readDeployment(deploymentsDir, contractName);
  const oldLayout = deployment?.upgradeStorageLayout;

  const validations =
    getInMemoryValidations() ?? (await loadValidationsFromDisk(hre.config.paths.cache));

  const artifactName = newImplOverride ?? resolveArtifactName(deployment, contractName);

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
    oldLayout,
    newLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind,
  };
}

export async function validateProxyUpgrade(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions = {},
): Promise<ValidationResult> {
  const {
    oldLayout,
    newLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind,
  } = await resolveLayouts(hre, contractName, options.newImpl);

  if (newLayout === undefined) {
    throw new Error(
      `[hardhat-upgrades-validator] Storage layout for "${contractName}" not found in validation cache — run \`hardhat compile\` first.`,
    );
  }

  const unsafeAllow = [...(options.unsafeAllow ?? []), ...(unsafeAllowFromAnnotation ?? [])];

  const result = validateStorageUpgrade(contractName, oldLayout, newLayout, {
    unsafeAllow,
    unsafeSkipStorageCheck: options.unsafeSkipStorageCheck,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    kind: proxyKind,
  });

  const filteredSafety = filterSafetyErrors(safetyErrors, unsafeAllow);
  result.safetyErrors = filteredSafety;
  if (filteredSafety.length > 0) result.ok = false;

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
