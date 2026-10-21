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
 * A proxy upgraded in place by this run must be storage-compatible with what
 * it ran before (the proxy index's implementation, else the deprecated
 * `upgradeStorageLayout` field). The deploy has already happened, so an
 * incompatible upgrade is reported with OZ's report and the run exits 1;
 * call `assertProxyUpgrade` in the deploy script to stop it beforehand.
 * Adopting the plugin in an existing project: run `record-baseline --all` once.
 */

import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  readDeployments,
  resolveArtifactName,
  selectedNetwork,
  type DeploymentFile,
} from "../internals/deployment-utils.js";
import {
  formatValidationResult,
  validateRecordUpgrade,
  type UpgradeBaseline,
} from "../../core/validator.js";
import type { StorageLayout } from "../../types/validation.js";
import { ArtifactNotFoundError, createBuildAnalyzer } from "../internals/build-analysis.js";
import { probe } from "../internals/baseline.js";
import { assertSameChain } from "../internals/chain-identity.js";
import {
  artifactCodeLookup,
  discoverProxies,
  updateProxyIndex,
} from "../internals/proxy-discovery.js";
import { recordLocalBuild } from "../../core/onchain/baseline.js";
import { layoutStoreDir, listProxyEntries, readLayoutRecord } from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import type { ImmutableReferences } from "../../core/bytecode-utils.js";
import { listDirOrEmpty } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";

export default async function deployOverride(
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<unknown> {
  // Nothing before the deploy may fail it either.
  let deploymentsDir: string | undefined;
  let before: Snapshot | undefined;
  try {
    deploymentsDir = targetDeploymentsDir(hre);
    if (deploymentsDir !== undefined) before = await snapshot(hre, deploymentsDir);
  } catch {
    before = undefined;
  }
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
// `--network` option from HRE. Undefined at runtime when it is not passed,
// whatever its type says.
function targetDeploymentsDir(hre: HardhatRuntimeEnvironment): string | undefined {
  const network = selectedNetwork(hre);
  if (network === undefined) return undefined;
  return resolve(hre.config.paths.root, "deployments", network);
}

/** What the network looked like before the deploy. */
interface Snapshot {
  /** Content hash of every deployment file, by name. */
  hashes: Map<string, string>;
  /**
   * Implementation each proxy ran just before the deploy, by proxy address:
   * read from the chain when it is reachable, else the proxy index (which may
   * be stale).
   */
  implementations: Map<string, string>;
  /** The deprecated `upgradeStorageLayout` field, by name, with the file's address. */
  fileBaselines: Map<string, { address?: string; layout: StorageLayout }>;
}

async function snapshot(hre: HardhatRuntimeEnvironment, deploymentsDir: string): Promise<Snapshot> {
  const deployments = await readDeployments(deploymentsDir);
  const fileBaselines = new Map<string, { address?: string; layout: StorageLayout }>();
  for (const [name, d] of deployments) {
    if (d.upgradeStorageLayout !== undefined) {
      fileBaselines.set(name, { address: d.address, layout: d.upgradeStorageLayout });
    }
  }
  const hashes = await hashDeploymentFiles(deploymentsDir);

  // The chain's state right before the deploy, so an upgrade made outside
  // these tools since the last online run is not mistaken for this one's.
  const fromChain = await readChainImplementations(hre, deploymentsDir, deployments);
  if (fromChain !== undefined) return { hashes, implementations: fromChain, fileBaselines };

  const implementations = new Map<string, string>();
  for (const entry of await listProxyEntries(layoutStoreDir(deploymentsDir))) {
    implementations.set(entry.proxy, entry.implementation);
  }
  return { hashes, implementations, fileBaselines };
}

// Implementation of every proxy among the deployments, from the chain.
// Undefined when the chain cannot be read here (no RPC, fork mode, in-process).
async function readChainImplementations(
  hre: HardhatRuntimeEnvironment,
  deploymentsDir: string,
  deployments: Map<string, DeploymentFile>,
): Promise<Map<string, string> | undefined> {
  if (process.env.HARDHAT_FORK || deployments.size === 0) return undefined;
  const connection = await hre.network.create().catch(() => undefined);
  try {
    const provider = connection?.provider;
    if (provider === undefined || connection?.networkConfig.type === "edr-simulated") {
      return undefined;
    }
    await probe(provider);
    await assertSameChain(deploymentsDir, provider);
    const discovery = await discoverProxies(provider, deployments, {
      localCode: artifactCodeLookup(hre.artifacts),
    });
    if (discovery.errors.length > 0) return undefined;
    return new Map(discovery.proxies.map((p) => [p.proxy, p.implementation]));
  } catch {
    return undefined;
  } finally {
    await connection?.close().catch(() => {});
  }
}

async function recordImplementationLayouts(
  hre: HardhatRuntimeEnvironment,
  deploymentsDir: string,
  before: Snapshot,
): Promise<void> {
  const after = await hashDeploymentFiles(deploymentsDir);
  const changed = new Set(
    [...after].filter(([n, h]) => before.hashes.get(n) !== h).map(([n]) => n),
  );
  if (changed.size === 0) return;

  const network = selectedNetwork(hre);
  // hardhat-deploy's fork mode deploys onto a fork of `network`: what it
  // deployed exists only on the fork, so nothing may be recorded for the real
  // network. (Recent versions do not save deployments there at all.)
  if (process.env.HARDHAT_FORK) {
    logger.log(`[INFO] HARDHAT_FORK is set; skipped recording implementation layouts.`);
    return;
  }
  const connection = await hre.network.create().catch(() => undefined);
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

    try {
      await assertSameChain(deploymentsDir, provider);
    } catch (e) {
      logger.warn(`Skipped recording implementation layouts: ${(e as Error).message}`);
      return;
    }

    const deployments = await readDeployments(deploymentsDir);
    const changedAddresses = new Set<string>();
    for (const name of changed) {
      const address = deployments.get(name)?.address?.toLowerCase();
      if (address !== undefined) changedAddresses.add(address);
    }

    // Every proxy, not only those whose files changed: a beacon upgrade
    // changes what a beacon proxy runs without touching its file.
    const storeDir = layoutStoreDir(deploymentsDir);
    const discovery = await discoverProxies(provider, deployments, {
      localCode: artifactCodeLookup(hre.artifacts),
    });
    const discovered = discovery.proxies;
    for (const e of discovery.errors) {
      logger.warn(`Could not classify ${e.address} (${e.deployments.join(", ")}): ${e.reason}`);
    }
    await updateProxyIndex(deploymentsDir, provider, discovered);

    const recorder = makeRecorder(hre, provider, storeDir);

    // Proxies this run deployed or moved: record what each runs now, from the
    // deployments describing its code, then check the move.
    const moved = discovered.filter(
      (p) =>
        changedAddresses.has(p.proxy) ||
        (before.implementations.has(p.proxy) &&
          before.implementations.get(p.proxy) !== p.implementation),
    );
    for (const proxy of moved) {
      for (const name of proxy.deployments) {
        const deployment = deployments.get(name)!;
        if (await recorder(proxy.implementation, resolveArtifactName(deployment, name), name)) {
          break;
        }
      }
      // Each proxy on its own: one bad record must not hide another's result.
      try {
        await checkInPlaceUpgrade(network, storeDir, proxy, before);
      } catch (e) {
        logger.error(
          `"${network}" ${proxy.proxy} (${proxy.deployments.join(", ")}): could not check the ` +
            `upgrade this run made: ${(e as Error).message}`,
        );
        process.exitCode = 1;
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
  const analyze = createBuildAnalyzer(hre.artifacts, hre.solidity);

  return async (address, artifactName, label) => {
    try {
      if ((await readLayoutRecord(storeDir, address)) !== undefined) return true;

      let analysis;
      let artifact;
      try {
        [analysis, artifact] = await Promise.all([
          analyze(artifactName),
          hre.artifacts.readArtifact(artifactName) as Promise<{
            contractName: string;
            sourceName: string;
            deployedBytecode: string;
            immutableReferences?: ImmutableReferences;
          }>,
        ]);
      } catch (e) {
        if (e instanceof ArtifactNotFoundError) return false; // not our contract
        throw e;
      }

      const { bytecodeMatch, record } = await recordLocalBuild(provider, storeDir, address, {
        contract: `${artifact.sourceName}:${artifact.contractName}`,
        layout: analysis.layout,
        kind: analysis.kind,
        namespaces: analysis.namespaces,
        deployedBytecode: artifact.deployedBytecode,
        immutableReferences: artifact.immutableReferences,
      });
      if (bytecodeMatch === "metadata-only") {
        logger.warn(
          `Did not record ${label} (${address}): the local build matches the chain only after ` +
            `stripping metadata, which does not prove its storage layout.`,
        );
      } else if (bytecodeMatch === "code-only") {
        logger.warn(
          `Did not record ${label} (${address}): the build embeds no metadata hash ` +
            `(bytecodeHash: "none" or appendCBOR: false), so matching code does not prove its ` +
            `storage layout.`,
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

// A proxy this run moved to another implementation must be storage-compatible
// with the one it ran before. The deploy already happened: report and exit 1.
// An upgrade that happened but cannot be checked (a side has no layout) throws,
// which also exits 1: once the index moves on, nothing could check it again.
async function checkInPlaceUpgrade(
  network: string | undefined,
  storeDir: string,
  proxy: { proxy: string; implementation: string; deployments: string[] },
  before: Snapshot,
): Promise<void> {
  const previousImpl = before.implementations.get(proxy.proxy);
  if (previousImpl === proxy.implementation) return;

  let previous: UpgradeBaseline | undefined;
  if (previousImpl !== undefined) {
    previous = await readLayoutRecord(storeDir, previousImpl);
  }
  // No record, or not a proxy known before: the deprecated field at the same address.
  const field = proxy.deployments
    .map((n) => before.fileBaselines.get(n))
    .find((b) => b?.address?.toLowerCase() === proxy.proxy)?.layout;
  previous ??= field === undefined ? undefined : { layout: field };
  if (previous === undefined) {
    if (previousImpl === undefined) return; // a first deployment: nothing ran before
    throw new Error(
      `it moved from ${previousImpl} to ${proxy.implementation}, but ${previousImpl} has no ` +
        `layout record, so the upgrade was not checked. Compare the two implementations' ` +
        `layouts before relying on this proxy.`,
    );
  }

  const current = await readLayoutRecord(storeDir, proxy.implementation);
  if (current === undefined) {
    throw new Error(
      `it now runs ${proxy.implementation}, whose layout could not be recorded from the local ` +
        `build (see warnings above), so the upgrade was not checked. Run record-baseline ` +
        `--contract ${proxy.deployments[0]} --from-chain and compare it with the previous layout.`,
    );
  }

  const check = validateRecordUpgrade(proxy.deployments[0]!, previous, current);
  if (!check.ok) {
    // An upgrade alone writes no storage: until the new code writes, upgrading
    // back to the previous implementation undoes it.
    const rollback =
      previousImpl === undefined
        ? ""
        : ` It replaced ${previousImpl}; if nothing has written to the proxy's storage ` +
          `since, upgrading back to ${previousImpl} restores it.`;
    logger.error(
      `"${network}" ${proxy.proxy}: the implementation deployed in this run ` +
        `(${proxy.implementation}) is not storage-compatible with the one it replaced. ` +
        `Proxy storage may be corrupted.` +
        rollback +
        formatValidationResult(`${network}/${proxy.deployments.join(", ")}`, check),
    );
    process.exitCode = 1;
  } else if (check.warnings.length > 0) {
    logger.warn(
      `"${network}" ${proxy.proxy}: the upgrade to ${proxy.implementation} was checked with a ` +
        `caveat:` +
        formatValidationResult(`${network}/${proxy.deployments.join(", ")}`, check),
    );
  }
}
