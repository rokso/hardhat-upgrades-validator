import { UNSAFE_ALLOW_KINDS } from "../../types/validation.js";
import { logger } from "../../utils/logger.js";

/**
 * The subset of Hardhat's ArtifactManager that getContractBuildData uses.
 * Defined here so tests can implement it without satisfying the full interface.
 */
export interface ArtifactsReader {
  readArtifact(name: string): Promise<{ bytecode: string; sourceName: string }>;
  getBuildInfoId(name: string): Promise<string | undefined>;
  getBuildInfoOutputPath(id: string): Promise<string | undefined>;
}
import type { UnsafeAllowKind, ContractSafetyError, ProxyKind } from "../../types/validation.js";
export type { ProxyKind };
import {
  type StorageLayout,
  type ValidationDataCurrent,
  getErrors,
  inferProxyKind,
  getStorageLayout,
  getUnlinkedBytecode,
  getVersion,
} from "@openzeppelin/upgrades-core";
import { loadBuildInfo } from "./build-info-utils.js";
import type { BuildInfoOutputCache, BuildInfoParsed } from "./build-info-utils.js";
import {
  extractAnnotationMaps as extractAnnotationMapsInternal,
  embedAnnotations,
} from "./annotation-utils.js";

export { createBuildInfoOutputCache } from "./build-info-utils.js";
export type { BuildInfoOutputCache, BuildInfoParsed } from "./build-info-utils.js";

/**
 * Shared utilities for reading deployment files and resolving storage layouts
 * from Hardhat artifacts and the oz-core ValidationData cache.
 *
 * Layout resolution follows the same pattern as @openzeppelin/hardhat-upgrades:
 *   artifact.bytecode
 *     → getUnlinkedBytecode(validations, bytecode)
 *     → getVersion(unlinkedBytecode, bytecode)
 *     → getStorageLayout(validations, version)
 *
 * This avoids re-parsing build-info files for layout extraction — oz-core
 * already ran extractStorageLayout (including the namespaced pass) during
 * validate() in the compile hook and baked the result into ValidationData.
 *
 * We still read the build-info output for our own NatSpec annotations
 * (@custom:upgrades-validator-renamed-from, @custom:upgrades-validator-retyped-from,
 * @custom:upgrades-validator-unsafe-allow) since those are not part of OZ's data.
 */

const UNSAFE_ALLOW_KINDS_SET: ReadonlySet<string> = new Set(UNSAFE_ALLOW_KINDS);

/**
 * Parses the raw value of a `@custom:upgrades-validator-unsafe-allow` devdoc
 * annotation into a validated `UnsafeAllowKind[]`.
 */
export function parseUnsafeAllowAnnotation(raw: unknown, context?: string): UnsafeAllowKind[] {
  if (typeof raw !== "string") return [];

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const unknown = tokens.filter((t) => !UNSAFE_ALLOW_KINDS_SET.has(t));

  if (unknown.length > 0 && context !== undefined) {
    logger.warn(
      `Unknown unsafe-allow token(s) "${unknown.join(", ")}" on ${context} — ignored.\n` +
        `  Valid values: ${UNSAFE_ALLOW_KINDS.join(", ")}`,
    );
  }

  return tokens.filter((t): t is UnsafeAllowKind => UNSAFE_ALLOW_KINDS_SET.has(t));
}

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
 * first and warns — callers should use a fully-qualified artifact name to avoid
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
        `multiple build-info sources match "${artifactSource}" — using "${matches[0]}". ` +
        `Use a fully-qualified artifact name (sourceName:contractName) to disambiguate.`,
    );
  }
  return matches[0] ?? artifactSource;
}

export function extractAnnotationMaps(
  parsed: BuildInfoParsed,
  simpleContractName: string,
  winnerSource: string,
): ReturnType<typeof extractAnnotationMapsInternal> {
  return extractAnnotationMapsInternal(
    parsed,
    simpleContractName,
    winnerSource,
    parseUnsafeAllowAnnotation,
  );
}

// ---------------------------------------------------------------------------
// Contract safety error kinds (from oz-core getErrors output)
// ---------------------------------------------------------------------------

const SUPPORTED_SAFETY_KINDS = new Set([
  "constructor",
  "delegatecall",
  "selfdestruct",
  "state-variable-immutable",
  "state-variable-assignment",
  "external-library-linking",
]);

function mapSafetyErrors(
  ozErrors: Array<{
    kind: string;
    src: string;
    name?: string;
    contract?: string;
  }>,
): ContractSafetyError[] {
  const result: ContractSafetyError[] = [];
  for (const e of ozErrors) {
    if (!SUPPORTED_SAFETY_KINDS.has(e.kind)) continue;
    switch (e.kind) {
      case "constructor":
        result.push({
          kind: "constructor",
          contract: e.contract ?? "",
          src: e.src,
        });
        break;
      case "delegatecall":
        result.push({ kind: "delegatecall", src: e.src });
        break;
      case "selfdestruct":
        result.push({ kind: "selfdestruct", src: e.src });
        break;
      case "state-variable-immutable":
        result.push({
          kind: "state-variable-immutable",
          name: e.name ?? "",
          src: e.src,
        });
        break;
      case "state-variable-assignment":
        result.push({
          kind: "state-variable-assignment",
          name: e.name ?? "",
          src: e.src,
        });
        break;
      case "external-library-linking":
        result.push({
          kind: "external-library-linking",
          name: e.name ?? "",
          src: e.src,
        });
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Combined artifact data lookup
// ---------------------------------------------------------------------------

/**
 * Resolves the OZ-format storage layout and annotations for a contract.
 *
 * Layout comes from oz-core's ValidationData (computed during the compile
 * hook's validate() call), mirroring @openzeppelin/hardhat-upgrades:
 *   artifact.bytecode → getVersion → getStorageLayout(validations, version)
 *
 * Build-info output is read only for our NatSpec annotations
 * (@custom:upgrades-validator-*) which oz-core does not process.
 *
 * @throws if the artifact does not exist (callers should catch and skip).
 */
export async function getContractBuildData(
  artifactName: string,
  artifacts: ArtifactsReader,
  validations: ValidationDataCurrent | undefined,
  cache: BuildInfoOutputCache,
  proxyKind?: ProxyKind,
): Promise<{
  upgradeStorageLayout: StorageLayout | undefined;
  unsafeAllowFromAnnotation: UnsafeAllowKind[];
  perVariableUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  namespaceUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  safetyErrors: ContractSafetyError[];
  proxyKind: ProxyKind | undefined;
}> {
  const { qualifiedName, simpleContractName } = parseArtifactName(artifactName);

  const empty = {
    upgradeStorageLayout: undefined,
    unsafeAllowFromAnnotation: [] as UnsafeAllowKind[],
    perVariableUnsafeAllow: new Map<string, UnsafeAllowKind[]>(),
    namespaceUnsafeAllow: new Map<string, UnsafeAllowKind[]>(),
    safetyErrors: [] as ContractSafetyError[],
    proxyKind: undefined as ProxyKind | undefined,
  };

  // readArtifact throws if the contract has not been compiled — let it propagate
  // so callers can catch and show "[SKIP] artifact not found".
  const artifact = await artifacts.readArtifact(qualifiedName);

  // --- Layout + safety errors from ValidationData (oz-core style) ---
  let upgradeStorageLayout: StorageLayout | undefined;
  let safetyErrors: ContractSafetyError[] = [];
  let resolvedKind: ProxyKind | undefined;

  if (validations !== undefined) {
    try {
      const unlinkedBytecode = getUnlinkedBytecode(validations, artifact.bytecode);
      const version = getVersion(unlinkedBytecode, artifact.bytecode);
      upgradeStorageLayout = getStorageLayout(validations, version);

      resolvedKind = proxyKind ?? (inferProxyKind(validations, version) as ProxyKind);
      const ozErrors = getErrors(validations, version, {
        kind: resolvedKind,
        unsafeAllow: [],
      });
      safetyErrors = mapSafetyErrors(ozErrors as never);
    } catch {
      // Contract not yet in ValidationData (first compile, or cache cleared).
      // Return empty so the caller can decide whether to skip.
    }
  }

  if (upgradeStorageLayout === undefined) {
    return { ...empty, safetyErrors };
  }

  // --- Our NatSpec annotations from build-info devdoc + AST ---
  // Use artifact.sourceName directly (no need to search matchingSources).
  const noAnnotations = () => ({
    upgradeStorageLayout,
    unsafeAllowFromAnnotation: [] as UnsafeAllowKind[],
    perVariableUnsafeAllow: new Map<string, UnsafeAllowKind[]>(),
    namespaceUnsafeAllow: new Map<string, UnsafeAllowKind[]>(),
    safetyErrors,
    proxyKind: resolvedKind,
  });

  const buildInfoId = await artifacts.getBuildInfoId(qualifiedName);
  if (!buildInfoId) return noAnnotations();

  const parsed = await loadBuildInfo(buildInfoId, artifacts, cache);
  if (!parsed) return noAnnotations();

  // The build-info output may have a different path prefix than artifact.sourceName
  // (e.g. "project/contracts/Box.sol" vs "contracts/Box.sol"). Find the matching key.
  const winnerSource = resolveWinnerSource(
    Object.keys(parsed.contracts),
    artifact.sourceName,
    simpleContractName,
  );

  const {
    renameAnnotations,
    retypeAnnotations,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    namespaceMemberRenameAnnotations,
    namespaceMemberRetypeAnnotations,
    structMemberRenameAnnotations,
    structMemberRetypeAnnotations,
    unsafeAllowFromAnnotation,
  } = extractAnnotationMapsInternal(
    parsed,
    simpleContractName,
    winnerSource,
    parseUnsafeAllowAnnotation,
  );

  embedAnnotations(
    upgradeStorageLayout,
    renameAnnotations,
    retypeAnnotations,
    namespaceMemberRenameAnnotations,
    namespaceMemberRetypeAnnotations,
    structMemberRenameAnnotations,
    structMemberRetypeAnnotations,
  );

  return {
    upgradeStorageLayout,
    unsafeAllowFromAnnotation,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    safetyErrors,
    proxyKind: resolvedKind,
  };
}

export {
  readDeployment,
  readDeployments,
  listDeployedContractsWithLayout,
  resolveArtifactName,
} from "./deployment-files.js";
export type { DeploymentFile } from "./deployment-files.js";

export { stripBytecodeMetadata, compareBytecode } from "../../core/bytecode-utils.js";
export type { BytecodeMatchResult } from "../../core/bytecode-utils.js";

import { listSubdirsOrEmpty } from "../../utils/io.js";

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
