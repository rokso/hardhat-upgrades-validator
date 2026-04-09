import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { resolve } from "node:path";

import {
  validateStorageUpgrade,
  formatValidationResult,
  filterSafetyErrors,
} from "../../core/validator.js";
import type { UnsafeAllowKind } from "../../types/validation.js";
import {
  readDeployment,
  listDeployedContractsWithLayout,
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoOutputCache,
  type ProxyKind,
  resolveArtifactName,
  resolveDeploymentNetworks,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import { detectProxy, detectProxyOnchain } from "../../core/proxy-detection.js";
import { logger } from "../../utils/logger.js";

const VALID_PROXY_KINDS: ReadonlySet<string> = new Set(["transparent", "uups", "beacon"]);

interface ValidateUpgradeArgs {
  contract?: string;
  all: boolean;
  unsafeAllow: string;
  unsafeSkipStorageCheck: boolean;
  proxyKind: string;
  network?: string;
}

const action: NewTaskActionFunction<ValidateUpgradeArgs> = async (
  { contract, all, unsafeAllow, unsafeSkipStorageCheck, proxyKind, network },
  hre: HardhatRuntimeEnvironment,
) => {
  const cliUnsafeAllow: UnsafeAllowKind[] = unsafeAllow
    ? (unsafeAllow.split(/[\s,]+/).filter(Boolean) as UnsafeAllowKind[])
    : [];

  if (proxyKind && !VALID_PROXY_KINDS.has(proxyKind)) {
    throw new Error(
      `Invalid --proxy-kind value: "${proxyKind}". Valid values: ${[...VALID_PROXY_KINDS].join(", ")}.`,
    );
  }

  if (!all && (contract === undefined || contract === "")) {
    throw new Error(
      "Provide --contract <name> to validate a single contract, or --all to validate every deployed contract.",
    );
  }

  const resolvedProxyKind = proxyKind ? (proxyKind as ProxyKind) : undefined;

  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, network);
  if (targetNetworks === null) return;

  let hasErrors = false;
  const cache = createBuildInfoOutputCache();
  const validations = await loadValidationsFromDisk(hre.config.paths.cache);

  for (const networkName of targetNetworks) {
    const deploymentsDir = resolve(deploymentsBase, networkName);
    const contractNames = all ? await listDeployedContractsWithLayout(deploymentsDir) : [contract!];

    if (contractNames.length === 0) {
      logger.log(`[INFO] No deployments found in ${deploymentsDir}`);
      continue;
    }

    const networkConnection = await hre.network.connect(networkName).catch(() => undefined);

    try {
      for (const name of contractNames) {
        const result = await validateContract(
          name,
          deploymentsDir,
          hre,
          cache,
          validations,
          networkConnection?.provider,
          cliUnsafeAllow,
          unsafeSkipStorageCheck,
          resolvedProxyKind,
        );

        if (result === null) continue;

        const message = formatValidationResult(`${networkName}/${name}`, result);
        logger.log(message);

        if (!result.ok) {
          hasErrors = true;
        }
      }
    } finally {
      await networkConnection?.close().catch(() => {});
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
  }
};

export default action;

async function validateContract(
  name: string,
  deploymentsDir: string,
  hre: HardhatRuntimeEnvironment,
  cache: BuildInfoOutputCache,
  validations: ValidationDataCurrent | undefined,
  provider?: { send(method: string, params?: unknown[]): Promise<unknown> },
  cliUnsafeAllow: UnsafeAllowKind[] = [],
  unsafeSkipStorageCheck = false,
  proxyKind?: ProxyKind,
) {
  const deployment = await readDeployment(deploymentsDir, name);

  if (deployment !== null) {
    let isProxy = detectProxy(deployment).isProxy;

    if (!isProxy && deployment.address && provider) {
      const onchain = await detectProxyOnchain(provider, deployment.address);
      isProxy = onchain.isProxy;
    }

    if (!isProxy) {
      logger.log(
        `  [SKIP] "${name}" — not detected as a proxy (checked deployment record, bytecode patterns, and on-chain EIP-1967 slots). Storage layout validation only applies to upgradeable proxy contracts.`,
      );
      return null;
    }
  }

  const oldLayout = deployment?.upgradeStorageLayout;

  if (oldLayout === undefined && deployment !== null) {
    logger.log(
      `  [SKIP] "${name}" — deployment exists but has no upgradeStorageLayout. Run record-baseline to populate it.`,
    );
    return null;
  }

  const artifactName = resolveArtifactName(deployment, name);

  let upgradeStorageLayout;
  let unsafeAllowFromAnnotation: UnsafeAllowKind[];
  let perVariableUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  let namespaceUnsafeAllow: Map<string, UnsafeAllowKind[]>;
  let safetyErrors;
  let resolvedProxyKind: ProxyKind | undefined;
  try {
    ({
      upgradeStorageLayout,
      unsafeAllowFromAnnotation,
      perVariableUnsafeAllow,
      namespaceUnsafeAllow,
      safetyErrors,
      proxyKind: resolvedProxyKind,
    } = await getContractBuildData(artifactName, hre.artifacts, validations, cache, proxyKind));
  } catch {
    logger.log(`  [SKIP] "${name}" — artifact not found. Has the contract been compiled?`);
    return null;
  }

  if (upgradeStorageLayout === undefined) {
    const reason =
      validations === undefined
        ? `validation cache not found — run \`hardhat compile\` first.`
        : `contract not in validation cache — run \`hardhat compile\` to refresh.`;
    logger.log(`  [SKIP] "${name}" — ${reason}`);
    return null;
  }

  const unsafeAllow = [...cliUnsafeAllow, ...unsafeAllowFromAnnotation];
  const result = validateStorageUpgrade(name, oldLayout, upgradeStorageLayout, {
    unsafeAllow,
    unsafeSkipStorageCheck,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    kind: resolvedProxyKind,
  });
  const filteredSafety = filterSafetyErrors(safetyErrors, unsafeAllow);
  result.safetyErrors = filteredSafety;
  if (filteredSafety.length > 0) result.ok = false;
  return result;
}
