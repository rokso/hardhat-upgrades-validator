import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { resolve } from "node:path";

import {
  validateStorageUpgrade,
  formatValidationResult,
  filterSafetyErrors,
} from "../../core/validator.js";
import {
  BASELINE_MODES,
  type BaselineMode,
  type UnsafeAllowKind,
  type ValidationResult,
} from "../../types/validation.js";
import {
  readDeployment,
  listDeployedProxies,
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoOutputCache,
  type ProxyKind,
  resolveArtifactName,
  resolveDeploymentNetworks,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { resolveBaseline } from "../internals/baseline.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import { detectProxy, detectProxyOnchain } from "../../core/proxy-detection.js";
import type { EthProvider } from "../../core/onchain/types.js";
import { logger } from "../../utils/logger.js";

const VALID_PROXY_KINDS: ReadonlySet<string> = new Set(["transparent", "uups", "beacon"]);

interface ValidateUpgradeArgs {
  contract?: string;
  all: boolean;
  unsafeAllow: string;
  unsafeSkipStorageCheck: boolean;
  proxyKind: string;
  baseline?: string;
  network?: string;
}

interface RunOptions {
  cliUnsafeAllow: UnsafeAllowKind[];
  unsafeSkipStorageCheck: boolean;
  proxyKind?: ProxyKind;
  baseline: BaselineMode;
}

const action: NewTaskActionFunction<ValidateUpgradeArgs> = async (
  { contract, all, unsafeAllow, unsafeSkipStorageCheck, proxyKind, baseline, network },
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

  const baselineMode = (baseline || "auto") as BaselineMode;
  if (!BASELINE_MODES.includes(baselineMode)) {
    throw new Error(
      `Invalid --baseline value: "${baseline}". Valid values: ${BASELINE_MODES.join(", ")}.`,
    );
  }

  if (!all && (contract === undefined || contract === "")) {
    throw new Error(
      "Provide --contract <name> to validate a single contract, or --all to validate every deployed contract.",
    );
  }

  const opts: RunOptions = {
    cliUnsafeAllow,
    unsafeSkipStorageCheck,
    proxyKind: proxyKind ? (proxyKind as ProxyKind) : undefined,
    baseline: baselineMode,
  };

  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, network);
  if (targetNetworks === null) return;

  let hasErrors = false;
  const cache = createBuildInfoOutputCache();
  const validations = await loadValidationsFromDisk(hre.config.paths.cache);

  for (const networkName of targetNetworks) {
    const deploymentsDir = resolve(deploymentsBase, networkName);
    const contractNames = all ? await listDeployedProxies(deploymentsDir) : [contract!];

    if (contractNames.length === 0) {
      logger.log(`[INFO] No deployments found in ${deploymentsDir}`);
      continue;
    }

    const networkConnection =
      opts.baseline === "deployment"
        ? undefined
        : await hre.network.connect(networkName).catch(() => undefined);

    try {
      for (const name of contractNames) {
        let result: ValidationResult | null;
        try {
          result = await validateContract(
            name,
            networkName,
            deploymentsDir,
            hre,
            cache,
            validations,
            networkConnection?.provider,
            opts,
          );
        } catch (e) {
          // One proxy's baseline failure must not hide the others' results.
          logger.log(`  [ERROR] "${networkName}/${name}": ${(e as Error).message}`);
          hasErrors = true;
          continue;
        }

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
  networkName: string,
  deploymentsDir: string,
  hre: HardhatRuntimeEnvironment,
  cache: BuildInfoOutputCache,
  validations: ValidationDataCurrent | undefined,
  provider: EthProvider | undefined,
  opts: RunOptions,
): Promise<ValidationResult | null> {
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

  const baseline = await resolveBaseline({
    name,
    deployment,
    deploymentsDir,
    networkName,
    mode: opts.baseline,
    provider,
    config: hre.config.upgradesValidator,
  });

  if (baseline.layout === undefined && deployment !== null) {
    logger.log(
      `  [SKIP] "${name}": no baseline. The chain could not supply one and no offline record exists. ` +
        `Run validate-upgrade with a reachable network, or record-baseline.`,
    );
    for (const w of baseline.warnings) {
      if (w.kind === "chain-baseline-unavailable") logger.log(`         reason: ${w.reason}`);
    }
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
    } = await getContractBuildData(
      artifactName,
      hre.artifacts,
      validations,
      cache,
      opts.proxyKind,
    ));
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

  const unsafeAllow = [...opts.cliUnsafeAllow, ...unsafeAllowFromAnnotation];
  const result = validateStorageUpgrade(name, baseline.layout, upgradeStorageLayout, {
    unsafeAllow,
    unsafeSkipStorageCheck: opts.unsafeSkipStorageCheck,
    perVariableUnsafeAllow,
    namespaceUnsafeAllow,
    kind: resolvedProxyKind,
  });
  const filteredSafety = filterSafetyErrors(safetyErrors, unsafeAllow);
  result.safetyErrors = filteredSafety;
  if (filteredSafety.length > 0) result.ok = false;
  result.baseline = baseline.info;
  result.warnings.push(...baseline.warnings);
  return result;
}
