import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { resolve } from "node:path";

import {
  validateStorageUpgrade,
  formatValidationResult,
  withSafetyErrors,
} from "../../core/validator.js";
import {
  UNSAFE_ALLOW_KINDS,
  PROXY_KINDS,
  type ProxyKind,
  type UnsafeAllowKind,
  type ValidateOptions,
  type ValidationResult,
} from "../../types/validation.js";
import {
  readDeployment,
  readDeployments,
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoOutputCache,
  resolveArtifactName,
  resolveDeploymentNetworks,
  selectedNetwork,
  ArtifactNotFoundError,
  type DeploymentFile,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk, missingLayoutReason } from "../internals/validations-cache.js";
import { probe, resolveBaseline } from "../internals/baseline.js";
import { assertSameChain } from "../internals/chain-identity.js";
import {
  artifactCodeLookup,
  discoverProxies,
  indexedRole,
  listProxyDeployments,
  updateProxyIndex,
  type LocalCodeLookup,
} from "../internals/proxy-discovery.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import type { EthProvider } from "../../core/onchain/types.js";
import { logger } from "../../utils/logger.js";

interface ValidateUpgradeArgs {
  contract?: string;
  all: boolean;
  unsafeAllow: string;
  unsafeAllowRenames: boolean;
  unsafeSkipStorageCheck: boolean;
  proxyKind: string;
}

const action: NewTaskActionFunction<ValidateUpgradeArgs> = async (
  { contract, all, unsafeAllow, unsafeAllowRenames, unsafeSkipStorageCheck, proxyKind },
  hre: HardhatRuntimeEnvironment,
) => {
  const cliUnsafeAllow = unsafeAllow ? unsafeAllow.split(/[\s,]+/).filter(Boolean) : [];
  const unknownUnsafeAllow = cliUnsafeAllow.filter(
    (k) => !(UNSAFE_ALLOW_KINDS as readonly string[]).includes(k),
  );
  if (unknownUnsafeAllow.length > 0) {
    throw new Error(
      `Invalid --unsafe-allow value(s): ${unknownUnsafeAllow.join(", ")}. ` +
        `Valid values: ${UNSAFE_ALLOW_KINDS.join(", ")}.`,
    );
  }

  if (proxyKind && !(PROXY_KINDS as readonly string[]).includes(proxyKind)) {
    throw new Error(
      `Invalid --proxy-kind value: "${proxyKind}". Valid values: ${PROXY_KINDS.join(", ")}.`,
    );
  }

  if (!all && (contract === undefined || contract === "")) {
    throw new Error(
      "Provide --contract <name> to validate a single contract, or --all to validate every deployed proxy.",
    );
  }

  const options: ValidateOptions = {
    unsafeAllow: cliUnsafeAllow as UnsafeAllowKind[],
    unsafeAllowRenames,
    unsafeSkipStorageCheck,
    kind: proxyKind ? (proxyKind as ProxyKind) : undefined,
  };

  const projectRoot = hre.config.paths.root;
  const deploymentsBase = resolve(projectRoot, "deployments");
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, selectedNetwork(hre));
  if (targetNetworks === null) return;

  let hasErrors = false;
  const cache = createBuildInfoOutputCache();
  const validations = await loadValidationsFromDisk(hre.config.paths.cache);

  for (const networkName of targetNetworks) {
    const deploymentsDir = resolve(deploymentsBase, networkName);

    // Which deployments are proxies comes from the chain when it is reachable.
    const networkConnection = await hre.network.create(networkName).catch(() => undefined);

    try {
      const provider = networkConnection?.provider;
      // Undefined means "decide from the proxy index and deployment files".
      const chain = provider !== undefined && (await isReachable(provider)) ? provider : undefined;

      const localCode = artifactCodeLookup(hre.artifacts);
      let contractNames: string[];
      let undiscovered = 0;
      try {
        if (chain !== undefined) await assertSameChain(deploymentsDir, chain);
        if (all) {
          const listed = await listProxyDeployments(deploymentsDir, chain, localCode);
          contractNames = listed.names;
          undiscovered = listed.errors.length;
          if (listed.unindexed.length > 0) {
            logger.log(
              `  [WARN] "${networkName}": offline, ${listed.unindexed.length} deployment(s) the ` +
                `proxy index does not cover were not checked (it is refreshed by every run with ` +
                `a reachable network): ${listed.unindexed.join(", ")}`,
            );
          }
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
        logger.log(`  [ERROR] "${networkName}": ${(e as Error).message}`);
        hasErrors = true;
        continue;
      }

      if (contractNames.length === 0) {
        logger.log(
          undiscovered === 0
            ? `[INFO] No proxy deployments found in ${deploymentsDir}`
            : `[INFO] No other proxy deployments found in ${deploymentsDir}`,
        );
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
            options,
          );
        } catch (e) {
          // One proxy's failure must not hide the others' results.
          logger.log(`  [ERROR] "${networkName}/${name}": ${(e as Error).message}`);
          hasErrors = true;
          continue;
        }

        if (result === null) continue;

        logger.log(formatValidationResult(`${networkName}/${name}`, result));
        if (!result.ok) hasErrors = true;
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
  /** Set only when reachable. */
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
  options: ValidateOptions,
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
    provider: access.provider,
    config: hre.config.upgradesValidator,
  });

  // A deployed proxy with no baseline is not a first deployment: nothing to
  // compare against is a failure, never a pass.
  if (baseline.layout === undefined && deployment !== null) {
    const reasons = baseline.warnings.flatMap((w) =>
      w.kind === "chain-baseline-unavailable" ? [` The chain was not used: ${w.reason}`] : [],
    );
    throw new Error(
      `no baseline: the chain could not supply one and no offline record exists. ` +
        `Run validate-upgrade with a reachable network, or record-baseline.${reasons.join("")}`,
    );
  }

  const artifactName = resolveArtifactName(deployment, name);

  let upgradeStorageLayout;
  let safetyErrors;
  let resolvedProxyKind: ProxyKind | undefined;
  try {
    ({
      upgradeStorageLayout,
      safetyErrors,
      proxyKind: resolvedProxyKind,
    } = await getContractBuildData(artifactName, hre.artifacts, validations, cache, {
      kind: options.kind,
      unsafeAllow: options.unsafeAllow,
    }));
  } catch (err) {
    // A proxy whose new code is not compiled here cannot be checked: an error,
    // like in the compile hook. Any other error propagates (fails too).
    if (err instanceof ArtifactNotFoundError) throw new Error(err.message, { cause: err });
    throw err;
  }

  // The new side cannot be checked: an error, never a pass.
  if (upgradeStorageLayout === undefined) {
    throw new Error(`${artifactName}: ${missingLayoutReason(validations)}`);
  }

  const result = withSafetyErrors(
    validateStorageUpgrade(name, baseline.layout, upgradeStorageLayout, {
      ...options,
      kind: resolvedProxyKind,
    }),
    safetyErrors,
  );
  result.baseline = baseline.info;
  result.warnings.push(...baseline.warnings);
  return result;
}

// Undefined when `name` describes the code behind a proxy (or may, so it must
// be checked); otherwise why it is skipped. Skips only on positive knowledge:
// the chain shows no proxy, or the file is the proxy contract itself.
async function whyNotProxyCode(
  name: string,
  deployment: DeploymentFile,
  deploymentsDir: string,
  { chain, localCode }: ChainAccess,
): Promise<string | undefined> {
  if (chain !== undefined) {
    const address = deployment.address?.toLowerCase();
    if (address === undefined) return undefined;
    const deployments = await readDeployments(deploymentsDir);
    const discovery = await discoverProxies(chain, deployments, {
      only: new Set([address]),
      localCode,
    });
    if (discovery.errors.length > 0) throw new Error(discovery.errors[0]!.reason);
    // Every run that reads a proxy from the chain refreshes the index.
    await updateProxyIndex(deploymentsDir, chain, discovery.proxies);
    const proxy = discovery.proxies[0];
    if (proxy === undefined && !discovery.unvalidated.includes(address)) {
      // A proxy does not stop being one: an indexed proxy the chain no longer
      // shows means a wrong RPC or changed files, never "not a proxy".
      const indexed = await indexedRole(deploymentsDir, name, deployment);
      if (indexed !== "unknown") {
        throw new Error(
          `the proxy index has ${address} as a proxy, but the chain shows no proxy there now. ` +
            `Check that the RPC points at the right chain; if the proxy is really gone, delete ` +
            `its entry under .storage-layouts/proxies/.`,
        );
      }
      return "not a proxy on this chain (no ERC-1967 implementation or beacon slot).";
    }
    if (!proxy?.deployments.includes(name)) {
      return "describes the proxy contract itself; validate the deployment that describes the code behind it.";
    }
    return undefined;
  }
  // Offline: the index decides. Without an entry the deployment is checked
  // (resolveBaseline then fails it unless the deprecated field supplies a baseline).
  const indexed = await indexedRole(deploymentsDir, name, deployment);
  if (indexed === "other") {
    return "the proxy index lists another deployment as the code behind this proxy.";
  }
  return undefined;
}
