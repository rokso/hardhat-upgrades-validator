/**
 * Proxy upgrade validation helpers for use in hardhat-deploy / rocketh deploy scripts.
 *
 * Both the old layout (from the recorded baseline) and the new layout (from
 * the validations cache) are resolved automatically; no need to pass them
 * explicitly.
 *
 * Usage:
 *
 *   import { assertProxyUpgrade } from "hardhat-upgrades-validator/proxy";
 *
 *   // Throws with a detailed error if storage layout is incompatible:
 *   await assertProxyUpgrade(hre, "MyContract");
 *
 *   // Your existing deploy call; completely unchanged:
 *   await deployViaProxy("MyContract", ...);
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { resolve } from "node:path";

import type { ProxyKind, UnsafeAllowKind, ValidationResult } from "../types/validation.js";
import {
  validateStorageUpgrade,
  formatValidationResult,
  withSafetyErrors,
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
  selectedNetwork,
} from "../plugin/internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../plugin/internals/validations-cache.js";
import { getInMemoryValidations } from "../plugin/hooks/compile.js";

export interface ProxyUpgradeOptions {
  /** OZ error kinds to allow (same values as OZ's `unsafeAllow`). */
  unsafeAllow?: UnsafeAllowKind[];
  /** Allow renamed variables without `@custom:oz-renamed-from` (OZ's `unsafeAllowRenames`). */
  unsafeAllowRenames?: boolean;
  /**
   * The proxy kind, for OZ's safety rules. OZ infers it from the new
   * implementation otherwise, which reads an implementation that dropped
   * `upgradeTo` as "transparent": pass "uups" for a UUPS proxy.
   */
  kind?: ProxyKind;
  unsafeSkipStorageCheck?: boolean;
  /** Override the new implementation artifact name for this call only. */
  newImpl?: string;
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
  const oldLayout = deployment?.upgradeStorageLayout;
  // An existing deployment without a baseline is not a first deployment.
  if (deployment !== null && oldLayout === undefined) {
    throw new Error(
      `[hardhat-upgrades-validator] "${network}/${contractName}" is deployed but has no ` +
        `upgradeStorageLayout baseline, so the upgrade cannot be checked. Run ` +
        `\`hardhat record-baseline --contract ${contractName} --network ${network}\` ` +
        `with the deployed code checked out.`,
    );
  }

  const validations =
    getInMemoryValidations() ?? (await loadValidationsFromDisk(hre.config.paths.cache));

  const artifactName = options.newImpl ?? resolveArtifactName(deployment, contractName);

  const cache = createBuildInfoOutputCache();
  const {
    upgradeStorageLayout: newLayout,
    safetyErrors,
    proxyKind,
  } = await getContractBuildData(artifactName, hre.artifacts, validations, cache, {
    kind: options.kind,
    unsafeAllow: options.unsafeAllow,
  });

  return { oldLayout, newLayout, safetyErrors, proxyKind };
}

export async function validateProxyUpgrade(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions = {},
): Promise<ValidationResult> {
  const { oldLayout, newLayout, safetyErrors, proxyKind } = await resolveLayouts(
    hre,
    contractName,
    options,
  );

  if (newLayout === undefined) {
    throw new Error(
      `[hardhat-upgrades-validator] Storage layout for "${contractName}" not found in validation cache; run \`hardhat compile\` first.`,
    );
  }

  return withSafetyErrors(
    validateStorageUpgrade(contractName, oldLayout, newLayout, {
      unsafeAllow: options.unsafeAllow,
      unsafeAllowRenames: options.unsafeAllowRenames,
      unsafeSkipStorageCheck: options.unsafeSkipStorageCheck,
      kind: proxyKind,
    }),
    safetyErrors,
  );
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
