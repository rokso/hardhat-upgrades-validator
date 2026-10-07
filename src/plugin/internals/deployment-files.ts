import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { join } from "node:path";
import type { ImmutableReferences } from "../../core/bytecode-utils.js";
import { listDirOrEmpty, tryReadJsonFile } from "../../utils/io.js";

export interface DeploymentFile {
  address?: string;
  deployedBytecode?: string;
  /**
   * Deprecated OZ-format layout snapshot written by 0.1.0-alpha.1. Still read
   * as an offline fallback; never written.
   */
  upgradeStorageLayout?: StorageLayout;
  /** Lets `deployedBytecode` be compared with on-chain code, immutables masked. */
  immutableReferences?: ImmutableReferences;
  /**
   * The Solidity contract name that was actually compiled and deployed.
   */
  contractName?: string;
  /**
   * The source file path for the deployed contract (e.g. "contracts/Box.sol").
   */
  sourceName?: string;
}

export async function readDeployment(
  deploymentsDir: string,
  name: string,
): Promise<DeploymentFile | null> {
  const deployment = await tryReadJsonFile<DeploymentFile>(join(deploymentsDir, `${name}.json`));
  return deployment ?? null;
}

/**
 * Returns contract names that have an `upgradeStorageLayout` baseline recorded.
 */
export async function listDeployedContractsWithLayout(deploymentsDir: string): Promise<string[]> {
  const files = await listDirOrEmpty(deploymentsDir);

  const names: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const deployment = await readDeployment(deploymentsDir, name);
    if (deployment?.upgradeStorageLayout !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** Every deployment file in the directory, by deployment name. */
export async function readDeployments(
  deploymentsDir: string,
): Promise<Map<string, DeploymentFile>> {
  const deployments = new Map<string, DeploymentFile>();
  for (const file of (await listDirOrEmpty(deploymentsDir)).sort()) {
    // Dotfiles (`.migrations.json`, `.chainId`) are hardhat-deploy's bookkeeping.
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const name = file.slice(0, -5);
    const deployment = await readDeployment(deploymentsDir, name);
    if (deployment !== null) deployments.set(name, deployment);
  }
  return deployments;
}

/**
 * Returns the fully-qualified artifact name for a deployment file.
 * Falls back to the deployment name if the file has no contractName.
 */
export function resolveArtifactName(
  deployment: DeploymentFile | null,
  deploymentName: string,
): string {
  if (!deployment) return deploymentName;
  const { contractName, sourceName } = deployment;
  if (contractName && sourceName) return `${sourceName}:${contractName}`;
  if (contractName) return contractName;
  return deploymentName;
}
