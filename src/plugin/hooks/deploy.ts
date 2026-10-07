/**
 * Hardhat v3 `deploy` task override.
 *
 * After hardhat-deploy runs, looks only at the deployment files this run
 * created or changed on the selected network (`--network`) and:
 *
 * - refreshes the proxy index for any proxy among them, from the chain;
 * - records the layout of the implementation each such proxy runs;
 * - records the layout of a freshly deployed implementation whose upgrade is
 *   still pending (e.g. queued in a multisig), when its contract is the one
 *   some proxy's deployment describes. A queued upgrade to a differently
 *   named contract is recorded once the upgrade executes and a later deploy
 *   or record-baseline sees it.
 *
 * Until every deployment has been classified once without errors (recorded
 * in `.storage-layouts/scan.json`), a run classifies all of them, so the
 * index is complete from then on, even on a network with no proxies.
 */

import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  readDeployments,
  resolveArtifactName,
  getContractBuildData,
  createBuildInfoOutputCache,
  type DeploymentFile,
} from "../internals/deployment-utils.js";
import { getInMemoryValidations } from "./compile.js";
import { loadValidationsFromDisk } from "../internals/validations-cache.js";
import { probe } from "../internals/baseline.js";
import {
  artifactCodeLookup,
  discoverProxies,
  updateProxyIndex,
} from "../internals/proxy-discovery.js";
import { recordLocalBuild } from "../../core/onchain/baseline.js";
import {
  layoutStoreDir,
  listProxyEntries,
  readLayoutRecord,
  readScanMarker,
} from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import type { ImmutableReferences } from "../../core/bytecode-utils.js";
import { listDirOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

export default async function deployOverride(
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<unknown> {
  const deploymentsDir = targetDeploymentsDir(hre);
  const before =
    deploymentsDir === undefined
      ? undefined
      : await hashDeploymentFiles(deploymentsDir).catch(() => undefined);
  const result = await runSuper(args);
  // Recording is a side benefit: nothing here may fail a deploy that already succeeded.
  if (deploymentsDir !== undefined && before !== undefined) {
    try {
      await recordImplementationLayouts(hre, deploymentsDir, before);
    } catch (e) {
      logger.warn(`Could not record implementation layouts: ${(e as Error).message}`);
    }
  }
  return result;
}

// We only mutate one deployment network at a time, using Hardhat's global
// `--network` option from HRE.
function targetDeploymentsDir(hre: HardhatRuntimeEnvironment): string | undefined {
  const network = hre.globalOptions.network.trim();
  if (network === "") return undefined;
  return resolve(hre.config.paths.root, "deployments", network);
}

async function recordImplementationLayouts(
  hre: HardhatRuntimeEnvironment,
  deploymentsDir: string,
  before: Map<string, string>,
): Promise<void> {
  const after = await hashDeploymentFiles(deploymentsDir);
  const changed = new Set([...after].filter(([n, h]) => before.get(n) !== h).map(([n]) => n));
  if (changed.size === 0) return;

  const network = hre.globalOptions.network.trim();
  // hardhat-deploy's fork mode deploys onto a fork of `network`: what it
  // deployed exists only on the fork, so nothing may be recorded for the real
  // network. (Recent versions do not save deployments there at all.)
  if (process.env.HARDHAT_FORK) {
    logger.log(`[INFO] HARDHAT_FORK is set; skipped recording implementation layouts.`);
    return;
  }
  const connection = await hre.network.connect().catch(() => undefined);
  const provider = connection?.provider;
  try {
    // Each connection to an in-process network is a fresh chain, so the
    // contracts this deploy created are not on it: nothing could be proven.
    if (connection?.networkConfig.type === "edr-simulated") {
      logger.log(
        `[INFO] "${network}" is an in-process network; skipped recording implementation layouts.`,
      );
      return;
    }
    if (
      provider === undefined ||
      !(await probe(provider).then(
        () => true,
        () => false,
      ))
    ) {
      logger.log(
        `[INFO] No reachable RPC for "${network}"; skipped recording implementation layouts.`,
      );
      return;
    }

    const deployments = await readDeployments(deploymentsDir);
    const changedAddresses = new Set<string>();
    for (const name of changed) {
      const address = deployments.get(name)?.address?.toLowerCase();
      if (address !== undefined) changedAddresses.add(address);
    }

    // Until every deployment has been classified once (the first deploy after
    // adopting the plugin), look at all of them, so a queued upgrade's
    // implementation can be told apart from an unrelated contract.
    const storeDir = layoutStoreDir(deploymentsDir);
    const bootstrap = (await readScanMarker(storeDir)) === undefined;
    const { proxies: discovered, errors } = await discoverProxies(provider, deployments, {
      ...(bootstrap ? {} : { only: changedAddresses }),
      localCode: artifactCodeLookup(hre.artifacts),
    });
    for (const e of errors) {
      logger.warn(`Could not classify ${e.address} (${e.deployments.join(", ")}): ${e.reason}`);
    }
    await updateProxyIndex(deploymentsDir, provider, discovered, bootstrap && errors.length === 0);

    const recorder = makeRecorder(hre, provider, storeDir);

    // What each changed proxy runs now, from the deployments describing its code.
    for (const proxy of discovered.filter((p) => changedAddresses.has(p.proxy))) {
      for (const name of proxy.deployments) {
        const deployment = deployments.get(name)!;
        if (await recorder(proxy.implementation, resolveArtifactName(deployment, name), name)) {
          break;
        }
      }
    }

    // Freshly deployed implementations that no proxy runs yet: recorded when
    // their contract is one some proxy's deployment describes.
    const proxies = new Set(discovered.map((p) => p.proxy));
    const logicContracts = await proxyLogicContracts(deploymentsDir, deployments, discovered);
    for (const name of changed) {
      const deployment = deployments.get(name);
      const address = deployment?.address?.toLowerCase();
      if (deployment === undefined || address === undefined || proxies.has(address)) continue;
      const artifactName = resolveArtifactName(deployment, name);
      if (logicContracts.has(artifactName)) await recorder(address, artifactName, name);
    }
  } finally {
    await connection?.close().catch(() => {});
  }
}

// Artifact names of the code behind every known proxy: indexed ones and
// those discovered in this run.
async function proxyLogicContracts(
  deploymentsDir: string,
  deployments: Map<string, DeploymentFile>,
  discovered: Array<{ deployments: string[] }>,
): Promise<Set<string>> {
  const names = new Set(discovered.flatMap((p) => p.deployments));
  for (const entry of await listProxyEntries(layoutStoreDir(deploymentsDir))) {
    for (const name of entry.deployments) names.add(name);
  }
  const contracts = new Set<string>();
  for (const name of names) {
    const deployment = deployments.get(name);
    if (deployment !== undefined) contracts.add(resolveArtifactName(deployment, name));
  }
  return contracts;
}

// Returns a function that records `address` from the local build of
// `artifactName` if the chain runs that build. Resolves true when a record
// exists afterwards.
function makeRecorder(
  hre: HardhatRuntimeEnvironment,
  provider: EthProvider,
  storeDir: string,
): (address: string, artifactName: string, label: string) => Promise<boolean> {
  const cache = createBuildInfoOutputCache();
  let validations: Promise<ValidationDataCurrent | undefined> | undefined;

  return async (address, artifactName, label) => {
    try {
      if ((await readLayoutRecord(storeDir, address)) !== undefined) return true;

      validations ??= Promise.resolve(
        getInMemoryValidations() ?? loadValidationsFromDisk(hre.config.paths.cache),
      );
      let upgradeStorageLayout;
      let artifact;
      try {
        [{ upgradeStorageLayout }, artifact] = await Promise.all([
          getContractBuildData(artifactName, hre.artifacts, await validations, cache),
          hre.artifacts.readArtifact(artifactName) as Promise<{
            contractName: string;
            sourceName: string;
            deployedBytecode: string;
            immutableReferences?: ImmutableReferences;
          }>,
        ]);
      } catch {
        return false; // artifact not found: not our contract
      }
      if (upgradeStorageLayout === undefined) return false;

      const { bytecodeMatch, record } = await recordLocalBuild(provider, storeDir, address, {
        contract: `${artifact.sourceName}:${artifact.contractName}`,
        layout: upgradeStorageLayout,
        deployedBytecode: artifact.deployedBytecode,
        immutableReferences: artifact.immutableReferences,
      });
      if (bytecodeMatch === "metadata-only") {
        logger.warn(
          `Did not record ${label} (${address}): the local build matches the chain only after ` +
            `stripping metadata, which does not prove its storage layout.`,
        );
      }
      return record !== undefined;
    } catch (e) {
      // A failed record must not fail a deploy that already succeeded.
      logger.warn(`Could not record the layout of ${label} (${address}): ${(e as Error).message}`);
      return false;
    }
  };
}

// Content hash of every deployment file, by deployment name. A missing
// directory is an empty network, not an error.
async function hashDeploymentFiles(deploymentsDir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of await listDirOrEmpty(deploymentsDir)) {
    if (!file.endsWith(".json")) continue;
    const content = await readFile(join(deploymentsDir, file));
    hashes.set(file.slice(0, -5), createHash("sha256").update(content).digest("hex"));
  }
  return hashes;
}
