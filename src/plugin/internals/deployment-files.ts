import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { join } from "node:path";
import { listDirOrEmpty, tryReadJsonFile } from "../../utils/io.js";

export interface DeploymentFile {
  address?: string;
  deployedBytecode?: string;
  /**
   * OZ-format storage layout snapshot. Populated by `record-baseline` and
   * used as the baseline for upgrade validation.
   */
  upgradeStorageLayout?: StorageLayout;
  /**
   * Address of the implementation contract.
   */
  implementation?: string;
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

// hardhat-deploy's companion files for a proxy deployment `X`; validating them
// would compare the proxy's or the bare implementation's code, not `X`.
const COMPANION_SUFFIXES = ["_Proxy", "_Implementation"];

/**
 * Returns deployments that can have a baseline: proxies (an `implementation`
 * field, so the chain or a stored record can supply one) and deployments that
 * still carry a deprecated `upgradeStorageLayout`.
 */
export async function listDeployedProxies(deploymentsDir: string): Promise<string[]> {
  const files = await listDirOrEmpty(deploymentsDir);

  const names: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    if (COMPANION_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const deployment = await readDeployment(deploymentsDir, name);
    if (
      deployment?.implementation !== undefined ||
      deployment?.upgradeStorageLayout !== undefined
    ) {
      names.push(name);
    }
  }
  return names;
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
