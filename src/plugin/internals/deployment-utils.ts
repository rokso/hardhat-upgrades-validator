import { logger } from "../../utils/logger.js";

/**
 * Deployment-file and network helpers shared by the tasks and hooks. The new
 * side of an upgrade comes from `build-analysis.ts`.
 */

export { ArtifactNotFoundError } from "./build-analysis.js";

export { readDeployment, readDeployments, resolveArtifactName } from "./deployment-files.js";
export type { DeploymentFile } from "./deployment-files.js";

export { stripBytecodeMetadata } from "../../core/bytecode-utils.js";

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
