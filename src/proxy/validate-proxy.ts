/**
 * Proxy upgrade validation helpers for use in hardhat-deploy / rocketh deploy scripts.
 *
 * The old layout is the layout of the implementation the proxy runs now, read
 * from the chain (offline: the proxy index's record), and the new layout comes
 * from the build info of the last compile; neither needs to be passed.
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
import type { EthProvider } from "../core/onchain/types.js";
import { formatValidationResult, validateUpgrade } from "../core/validator.js";
import { logger } from "../utils/logger.js";

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
  readDeployments,
  resolveArtifactName,
  selectedNetwork,
} from "../plugin/internals/deployment-utils.js";
import { createBuildAnalyzer } from "../plugin/internals/build-analysis.js";
import {
  baselineSide,
  probe,
  resolveBaseline,
  type ResolvedBaseline,
} from "../plugin/internals/baseline.js";
import {
  artifactCodeLookup,
  discoverProxies,
  updateProxyIndex,
} from "../plugin/internals/proxy-discovery.js";

export interface ProxyUpgradeOptions {
  /** OZ error kinds to allow (same values as OZ's `unsafeAllow`). */
  unsafeAllow?: UnsafeAllowKind[];
  /** Allow renamed variables without `@custom:oz-renamed-from` (OZ's `unsafeAllowRenames`). */
  unsafeAllowRenames?: boolean;
  /**
   * The proxy kind, for OZ's safety rules. Defaults to the baseline's (`beacon`
   * when a beacon serves the proxy, else the kind its running implementation's
   * code implies). Records made before 0.2.0 do not hold it, and the
   * new implementation's code is used then, which reads an implementation that
   * dropped `upgradeTo` as "transparent": pass "uups" for a UUPS proxy.
   */
  kind?: ProxyKind;
  unsafeSkipStorageCheck?: boolean;
  /** Override the new implementation artifact name for this call only. */
  newImpl?: string;
  /**
   * Provider to read the chain with. Defaults to a new connection to the
   * `--network` network. Pass the deploy script's own provider on an
   * in-process network, where every new connection is a fresh chain.
   */
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

  const baseline = await withProvider(hre, options.provider, async (provider) => {
    if (provider !== undefined && deployment?.address !== undefined) {
      await refreshIndex(hre, provider, deploymentsDir, deployment.address);
    }
    return resolveBaseline({
      name: contractName,
      deployment,
      deploymentsDir,
      networkName: network,
      provider,
      config: hre.config.upgradesValidator,
    });
  });

  // An existing deployment without a baseline is not a first deployment.
  if (deployment !== null && baseline.layout === undefined) {
    throw new Error(
      `[hardhat-upgrades-validator] "${network}/${contractName}" is deployed but has no baseline, ` +
        `so the upgrade cannot be checked. Run \`hardhat record-baseline --contract ` +
        `${contractName} --network ${network}\` (with --from-chain if the local code has moved on).`,
    );
  }

  const artifactName = options.newImpl ?? resolveArtifactName(deployment, contractName);
  const next = await createBuildAnalyzer(hre.artifacts, hre.solidity)(artifactName);

  return { baseline, next };
}

// Opens a connection to the --network network unless the caller passed a
// provider. A failed connect, or an RPC that does not answer, means offline.
async function withProvider(
  hre: HardhatRuntimeEnvironment,
  provider: EthProvider | undefined,
  fn: (provider: EthProvider | undefined) => Promise<ResolvedBaseline>,
): Promise<ResolvedBaseline> {
  if (provider !== undefined) return fn(provider);
  const connection = await hre.network?.create().catch(() => undefined);
  try {
    return await fn(connection?.provider);
  } finally {
    await connection?.close().catch(() => {});
  }
}

// Every run that reads a proxy from the chain refreshes its index entry, so
// offline runs see the state as of the last online one. Best effort: the
// baseline itself is read from the chain right after.
async function refreshIndex(
  hre: HardhatRuntimeEnvironment,
  provider: EthProvider,
  deploymentsDir: string,
  address: string,
): Promise<void> {
  try {
    await probe(provider);
    const { proxies } = await discoverProxies(provider, await readDeployments(deploymentsDir), {
      only: new Set([address.toLowerCase()]),
      localCode: artifactCodeLookup(hre.artifacts),
    });
    await updateProxyIndex(deploymentsDir, provider, proxies);
  } catch {
    // Offline or unclassifiable: resolveBaseline reports what matters.
  }
}

export async function validateProxyUpgrade(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  options: ProxyUpgradeOptions = {},
): Promise<ValidationResult> {
  const { baseline, next } = await resolveLayouts(hre, contractName, options);

  const result = validateUpgrade(contractName, baselineSide(baseline), next, {
    unsafeAllow: options.unsafeAllow,
    unsafeAllowRenames: options.unsafeAllowRenames,
    unsafeSkipStorageCheck: options.unsafeSkipStorageCheck,
    kind: options.kind,
  });
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
  // A pass with caveats (an older record, an offline fallback) says so.
  if (result.ok && result.warnings.length > 0) {
    logger.warn(formatValidationResult(contractName, result).trimStart());
  }
  if (!result.ok) {
    // formatValidationResult returns "\nStorageLayoutError: ...\n  [ERROR]..."
    // Strip "StorageLayoutError: <header>" so error.name provides "StorageLayoutError:".
    // Keep the leading \n so detail lines start on a new line below the error name.
    const formatted = formatValidationResult(contractName, result);
    const message = formatted.replace(/StorageLayoutError: /, "").trimStart();
    throw new StorageLayoutError(message);
  }
}
