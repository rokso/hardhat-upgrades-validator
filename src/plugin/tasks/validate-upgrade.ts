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
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoOutputCache,
  type ProxyKind,
  resolveArtifactName,
  resolveDeploymentNetworks,
  type DeploymentFile,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { probe, resolveBaseline } from "../internals/baseline.js";
import {
  artifactCodeLookup,
  classifyDeployment,
  indexedRole,
  listProxyDeployments,
  type LocalCodeLookup,
} from "../internals/proxy-discovery.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
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

    // Opened in every mode: which deployments are proxies comes from the
    // chain when it is reachable, even when the baseline does not.
    const networkConnection = await hre.network.connect(networkName).catch(() => undefined);

    try {
      const provider = networkConnection?.provider;
      // Undefined means "decide from the proxy index and deployment files".
      const chain =
        opts.baseline !== "deployment" && provider !== undefined && (await isReachable(provider))
          ? provider
          : undefined;

      const localCode = artifactCodeLookup(hre.artifacts);
      let contractNames: string[];
      try {
        if (all) {
          const listed = await listProxyDeployments(deploymentsDir, chain, localCode);
          contractNames = listed.names;
          for (const e of listed.errors) {
            logger.log(
              `  [ERROR] "${networkName}" ${e.address} (${e.deployments.map((n) => `"${n}"`).join(", ")}): ${e.reason}`,
            );
            hasErrors = true;
          }
        } else {
          contractNames = [contract!];
        }
      } catch (e) {
        logger.log(
          `  [ERROR] "${networkName}": could not discover proxies: ${(e as Error).message}`,
        );
        hasErrors = true;
        continue;
      }

      if (contractNames.length === 0) {
        logger.log(`[INFO] No proxy deployments found in ${deploymentsDir}`);
        continue;
      }

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
            { provider, chain, discovered: all, localCode },
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

async function isReachable(provider: EthProvider): Promise<boolean> {
  return probe(provider).then(
    () => true,
    () => false,
  );
}

interface ChainAccess {
  /** The network's provider, reachable or not; resolveBaseline decides what to do with it. */
  provider: EthProvider | undefined;
  /** Set only when reachable and the mode reads the chain. */
  chain: EthProvider | undefined;
  /** The name came from proxy discovery, so it is already known to be a proxy's code. */
  discovered: boolean;
  localCode: LocalCodeLookup;
}

async function validateContract(
  name: string,
  networkName: string,
  deploymentsDir: string,
  hre: HardhatRuntimeEnvironment,
  cache: BuildInfoOutputCache,
  validations: ValidationDataCurrent | undefined,
  access: ChainAccess,
  opts: RunOptions,
): Promise<ValidationResult | null> {
  const deployment = await readDeployment(deploymentsDir, name);

  if (deployment !== null && !access.discovered) {
    const skip = await whyNotProxyCode(name, deployment, deploymentsDir, access);
    if (skip !== undefined) {
      logger.log(`  [SKIP] "${name}": ${skip}`);
      return null;
    }
  }

  const baseline = await resolveBaseline({
    name,
    deployment,
    deploymentsDir,
    networkName,
    mode: opts.baseline,
    provider: access.provider,
    config: hre.config.upgradesValidator,
  });

  if (baseline.layout === undefined && deployment !== null) {
    logger.log(
      baseline.reason !== undefined
        ? `  [SKIP] "${name}": no baseline: ${baseline.reason}`
        : `  [SKIP] "${name}": no baseline. The chain could not supply one and no offline record exists. ` +
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

// Undefined when `name` describes the code behind a proxy; otherwise why not.
async function whyNotProxyCode(
  name: string,
  deployment: DeploymentFile,
  deploymentsDir: string,
  { chain, localCode }: ChainAccess,
): Promise<string | undefined> {
  if (chain !== undefined) {
    const { role } = await classifyDeployment(chain, name, deployment, localCode);
    if (role === "not-proxy") {
      return "not a proxy on this chain (no ERC-1967 implementation or beacon slot).";
    }
    if (role === "proxy-contract") {
      return "describes the proxy contract itself; validate the deployment that describes the code behind it.";
    }
    return undefined;
  }
  const indexed = await indexedRole(deploymentsDir, name, deployment);
  if (indexed === "logic") return undefined;
  if (indexed === "other") {
    return "the proxy index lists another deployment as the code behind this proxy.";
  }
  if (deployment.upgradeStorageLayout !== undefined) return undefined;
  return "not known as a proxy's code offline. Run with a reachable network, or record-baseline.";
}
