import { logger } from "../../utils/logger.js";
import type {
  ProxyKind,
  SafetyError,
  StorageLayout,
  UnsafeAllowKind,
} from "../../types/validation.js";
import {
  type ValidationDataCurrent,
  getErrors,
  inferProxyKind,
  getStorageLayout,
  getUnlinkedBytecode,
  getVersion,
} from "@openzeppelin/upgrades-core";
import { loadBuildInfo } from "./build-info-utils.js";
import type { BuildInfoOutputCache } from "./build-info-utils.js";
import {
  extractStructMemberAnnotations,
  embedStructMemberAnnotations,
} from "./annotation-utils.js";

export type { ProxyKind };
export { createBuildInfoOutputCache } from "./build-info-utils.js";
export type { BuildInfoOutputCache, BuildInfoParsed } from "./build-info-utils.js";

/**
 * The subset of Hardhat's ArtifactManager that getContractBuildData uses.
 * Defined here so tests can implement it without satisfying the full interface.
 */
export interface ArtifactsReader {
  readArtifact(name: string): Promise<{ bytecode: string; sourceName: string }>;
  getBuildInfoId(name: string): Promise<string | undefined>;
  getBuildInfoOutputPath(id: string): Promise<string | undefined>;
}

/**
 * Shared utilities for reading deployment files and resolving storage layouts
 * from Hardhat artifacts and the oz-core ValidationData cache.
 *
 * Layout resolution follows the same pattern as @openzeppelin/hardhat-upgrades:
 *   artifact.bytecode
 *     -> getUnlinkedBytecode(validations, bytecode)
 *     -> getVersion(unlinkedBytecode, bytecode)
 *     -> getStorageLayout(validations, version)
 *
 * oz-core already ran extractStorageLayout (including the namespaced pass and
 * its `@custom:oz-*` tags) during validate() in the compile hook. Build-info is
 * read only for our struct-member tags, which OZ does not extract.
 */

// Helper for splitting artifact names (local utility)
function parseArtifactName(artifactName: string): {
  qualifiedName: string;
  simpleContractName: string;
} {
  const colonIdx = artifactName.indexOf(":");
  if (colonIdx === -1) {
    return { qualifiedName: artifactName, simpleContractName: artifactName };
  }

  return {
    qualifiedName: artifactName,
    simpleContractName: artifactName.slice(colonIdx + 1),
  };
}

/**
 * Finds the build-info source key matching `artifactSource`.
 * If multiple keys end with the same suffix (ambiguous path prefix), picks the
 * first and warns. Callers should use a fully-qualified artifact name to avoid
 * this. Falls back to `artifactSource` itself when no key matches.
 */
export function resolveWinnerSource(
  contractKeys: string[],
  artifactSource: string,
  contractName: string,
): string {
  const matches = contractKeys.filter(
    (k) => k === artifactSource || k.endsWith("/" + artifactSource),
  );
  if (matches.length > 1) {
    logger.warn(
      `Ambiguous source for contract "${contractName}": ` +
        `multiple build-info sources match "${artifactSource}"; using "${matches[0]}". ` +
        `Use a fully-qualified artifact name (sourceName:contractName) to disambiguate.`,
    );
  }
  return matches[0] ?? artifactSource;
}

/** The compiled artifact for a deployment does not exist (not compiled, or renamed/removed). */
export class ArtifactNotFoundError extends Error {
  constructor(artifactName: string, cause: unknown) {
    super(`artifact ${artifactName} not found. Has the contract been compiled?`, { cause });
    this.name = "ArtifactNotFoundError";
  }
}

export interface BuildDataOptions {
  /** Proxy kind for OZ's safety rules. Inferred by OZ when not given. */
  kind?: ProxyKind;
  /** OZ error kinds to allow, passed to OZ's `getErrors`. */
  unsafeAllow?: UnsafeAllowKind[];
}

// ---------------------------------------------------------------------------
// Combined artifact data lookup
// ---------------------------------------------------------------------------

/**
 * Resolves the OZ-format storage layout and OZ's upgrade-safety errors for a
 * contract.
 *
 * Layout and errors come from oz-core's ValidationData (computed during the
 * compile hook's validate() call), mirroring @openzeppelin/hardhat-upgrades:
 *   artifact.bytecode -> getVersion -> getStorageLayout / getErrors
 *
 * `upgradeStorageLayout` is undefined only when the contract is not in the
 * ValidationData (first compile, or cache cleared).
 *
 * @throws ArtifactNotFoundError if the artifact does not exist. Any other
 * error (including from OZ) propagates and must fail the caller.
 */
export async function getContractBuildData(
  artifactName: string,
  artifacts: ArtifactsReader,
  validations: ValidationDataCurrent | undefined,
  cache: BuildInfoOutputCache,
  options: BuildDataOptions = {},
): Promise<{
  upgradeStorageLayout: StorageLayout | undefined;
  safetyErrors: SafetyError[];
  proxyKind: ProxyKind | undefined;
}> {
  const { qualifiedName, simpleContractName } = parseArtifactName(artifactName);
  const missing = { upgradeStorageLayout: undefined, safetyErrors: [], proxyKind: undefined };

  let artifact: Awaited<ReturnType<ArtifactsReader["readArtifact"]>>;
  try {
    artifact = await artifacts.readArtifact(qualifiedName);
  } catch (err) {
    throw new ArtifactNotFoundError(qualifiedName, err);
  }

  if (validations === undefined) return missing;

  let version: ReturnType<typeof getVersion>;
  let upgradeStorageLayout: StorageLayout;
  try {
    const unlinkedBytecode = getUnlinkedBytecode(validations, artifact.bytecode);
    version = getVersion(unlinkedBytecode, artifact.bytecode);
    upgradeStorageLayout = getStorageLayout(validations, version);
  } catch {
    // Contract not in ValidationData (first compile, or cache cleared).
    return missing;
  }

  // Outside the try above: a failure here must not turn into "no errors".
  const proxyKind = options.kind ?? (inferProxyKind(validations, version) as ProxyKind);
  const safetyErrors = getErrors(validations, version, {
    kind: proxyKind,
    unsafeAllow: options.unsafeAllow ?? [],
  });

  // --- Our struct-member tags from build-info AST ---
  const buildInfoId = await artifacts.getBuildInfoId(qualifiedName);
  const parsed = buildInfoId ? await loadBuildInfo(buildInfoId, artifacts, cache) : null;
  if (parsed) {
    // The build-info output may have a different path prefix than artifact.sourceName
    // (e.g. "project/contracts/Box.sol" vs "contracts/Box.sol"). Find the matching key.
    const winnerSource = resolveWinnerSource(
      Object.keys(parsed.contracts),
      artifact.sourceName,
      simpleContractName,
    );
    embedStructMemberAnnotations(
      upgradeStorageLayout,
      extractStructMemberAnnotations(parsed, simpleContractName, winnerSource),
    );
  }

  return { upgradeStorageLayout, safetyErrors, proxyKind };
}

export {
  readDeployment,
  listDeployedContractsWithLayout,
  resolveArtifactName,
} from "./deployment-files.js";
export type { DeploymentFile } from "./deployment-files.js";

export { stripBytecodeMetadata, compareBytecode } from "../../core/bytecode-utils.js";
export type { BytecodeMatchResult } from "../../core/bytecode-utils.js";

import { listSubdirsOrEmpty } from "../../utils/io.js";

/**
 * Hardhat's global `--network` option, trimmed; undefined when not passed.
 * It is a global option, so it never reaches a task's own arguments, and
 * Hardhat leaves it undefined at runtime when it is not passed.
 */
export function selectedNetwork(hre: { globalOptions: { network?: string } }): string | undefined {
  const network = (hre.globalOptions.network as string | undefined)?.trim();
  return network === undefined || network === "" ? undefined : network;
}

/**
 * Resolves the list of deployment network directories to operate on.
 *
 * - If `network` is provided, returns `[network]`.
 * - Otherwise scans `deploymentsBase` for subdirectories.
 * - Returns `null` (and logs a message) when no networks are found.
 */
export async function resolveDeploymentNetworks(
  deploymentsBase: string,
  network: string | undefined,
): Promise<string[] | null> {
  const requested = (network ?? "").trim();
  const networks = requested !== "" ? [requested] : await listSubdirsOrEmpty(deploymentsBase);
  if (networks.length === 0) {
    logger.log(`[INFO] No deployment networks found in ${deploymentsBase}`);
    return null;
  }
  return networks;
}
