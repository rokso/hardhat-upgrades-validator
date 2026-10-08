import type { NewTaskActionFunction } from "hardhat/types/tasks";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import { resolve } from "node:path";

import {
  validateStorageUpgrade,
  formatValidationResult,
  withSafetyErrors,
} from "../../core/validator.js";
import { UNSAFE_ALLOW_KINDS, type UnsafeAllowKind } from "../../types/validation.js";
import {
  readDeployment,
  listDeployedContractsWithLayout,
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoOutputCache,
  type ProxyKind,
  resolveArtifactName,
  resolveDeploymentNetworks,
  selectedNetwork,
  ArtifactNotFoundError,
} from "../internals/deployment-utils.js";
import { loadValidationsFromDisk, missingLayoutReason } from "../internals/validations-cache.js";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import type { ValidateOptions } from "../../types/validation.js";
import { detectProxy, detectProxyOnchain } from "../../core/proxy-detection.js";
import { logger } from "../../utils/logger.js";

const VALID_PROXY_KINDS: ReadonlySet<string> = new Set(["transparent", "uups", "beacon"]);

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
  const targetNetworks = await resolveDeploymentNetworks(deploymentsBase, selectedNetwork(hre));
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

    const networkConnection = await hre.network.create(networkName).catch(() => undefined);

    try {
      for (const name of contractNames) {
        let result;
        try {
          result = await validateContract(
            name,
            deploymentsDir,
            hre,
            cache,
            validations,
            networkConnection?.provider,
            {
              unsafeAllow: cliUnsafeAllow as UnsafeAllowKind[],
              unsafeAllowRenames,
              unsafeSkipStorageCheck,
              kind: resolvedProxyKind,
            },
          );
        } catch (e) {
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
  deploymentsDir: string,
  hre: HardhatRuntimeEnvironment,
  cache: BuildInfoOutputCache,
  validations: ValidationDataCurrent | undefined,
  provider: { send(method: string, params?: unknown[]): Promise<unknown> } | undefined,
  options: ValidateOptions,
) {
  const deployment = await readDeployment(deploymentsDir, name);

  const oldLayout = deployment?.upgradeStorageLayout;

  // A deployment with a baseline is always validated (as in the compile hook).
  // One without a baseline is not a first deployment: it fails unless it is
  // positively known not to be a proxy.
  if (deployment !== null && oldLayout === undefined) {
    let isProxy: boolean | undefined = detectProxy(deployment).isProxy ? true : undefined;
    if (isProxy === undefined && deployment.address && provider) {
      const onchain = await detectProxyOnchain(provider, deployment.address);
      isProxy = onchain.unknown ? undefined : onchain.isProxy;
    }
    if (isProxy === false) {
      logger.log(
        `  [SKIP] "${name}": not a proxy (no EIP-1967 slot on chain); nothing to validate.`,
      );
      return null;
    }
    throw new Error(
      `deployment exists but has no upgradeStorageLayout` +
        (isProxy ? "" : " (and it could not be confirmed not to be a proxy)") +
        `. Run record-baseline to record it.`,
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
    // A deployment with a baseline whose artifact is missing cannot be checked:
    // an error, like in the compile hook. Any other error propagates (fails too).
    if (err instanceof ArtifactNotFoundError) throw new Error(err.message, { cause: err });
    throw err;
  }

  // A compiled contract with no layout is never "nothing to check".
  if (upgradeStorageLayout === undefined) {
    throw new Error(`${artifactName}: ${missingLayoutReason(validations)}`);
  }

  return withSafetyErrors(
    validateStorageUpgrade(name, oldLayout, upgradeStorageLayout, {
      ...options,
      kind: resolvedProxyKind,
    }),
    safetyErrors,
  );
}
