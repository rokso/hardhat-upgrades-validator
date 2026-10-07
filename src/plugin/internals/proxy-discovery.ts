/**
 * Finds which deployments are proxies, and which file describes the code
 * behind each one, from the chain and file contents alone.
 *
 * hardhat-deploy v2 records no implementation address, and its file names
 * (`X`, `X_Proxy`, `X_Implementation`) are a convention, not a contract. So:
 *
 * - A deployment is a proxy when the chain has an ERC-1967 implementation or
 *   beacon slot set at its address.
 * - Several files can share a proxy address. One whose code is the code at
 *   that address describes the proxy contract itself; the others describe
 *   the code behind it, and are the ones to validate.
 *
 * Runs with an RPC refresh the proxy index, so offline runs know which
 * implementation each proxy ran when last observed.
 */

import {
  compareDeployedBytecode,
  inferImmutableReferences,
  type ImmutableReferences,
} from "../../core/bytecode-utils.js";
import { BaselineUnavailableError } from "../../core/onchain/errors.js";
import {
  readBlockNumber,
  readChainId,
  readCode,
  readProxy,
  type ProxyState,
} from "../../core/onchain/implementation.js";
import {
  layoutStoreDir,
  listProxyEntries,
  readProxyEntry,
  updateProxyEntry,
} from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import { readDeployments, resolveArtifactName, type DeploymentFile } from "./deployment-files.js";
import { logger } from "../../utils/logger.js";

export interface DiscoveredProxy extends ProxyState {
  proxy: string;
  /** Deployment names describing the code behind the proxy. */
  deployments: string[];
}

/** An address discovery could not decide; its deployments are not validated. */
export interface DiscoveryError {
  address: string;
  deployments: string[];
  reason: string;
}

export interface Discovery {
  proxies: DiscoveredProxy[];
  errors: DiscoveryError[];
}

export type DeploymentRole =
  | { role: "logic"; proxy: string; state: ProxyState }
  | { role: "proxy-contract" }
  | { role: "not-proxy" };

/** Code a deployment file describes, from the local build. */
export interface LocalCode {
  deployedBytecode?: string;
  immutableReferences?: ImmutableReferences;
}

/**
 * Supplies the local build of a deployment's contract, for files that lack
 * the code or immutable positions needed to compare them with the chain.
 */
export type LocalCodeLookup = (
  name: string,
  deployment: DeploymentFile,
) => Promise<LocalCode | undefined>;

const RPC_CONCURRENCY = 8;

/** A LocalCodeLookup reading Hardhat artifacts; undefined when there is none. */
export function artifactCodeLookup(artifacts: {
  readArtifact(name: string): Promise<unknown>;
}): LocalCodeLookup {
  return async (name, deployment) => {
    try {
      return (await artifacts.readArtifact(resolveArtifactName(deployment, name))) as LocalCode;
    } catch {
      return undefined;
    }
  };
}

/**
 * Proxies among `deployments`, optionally limited to the given addresses
 * (lowercase). Each comes with the deployment names to validate against it.
 * A failure at one address is reported for that address and does not stop
 * the others.
 */
export async function discoverProxies(
  provider: EthProvider,
  deployments: Map<string, DeploymentFile>,
  options: { only?: ReadonlySet<string>; localCode?: LocalCodeLookup } = {},
): Promise<Discovery> {
  const byAddress = new Map<string, string[]>();
  for (const [name, d] of deployments) {
    const address = d.address?.toLowerCase();
    if (address === undefined || (options.only !== undefined && !options.only.has(address))) {
      continue;
    }
    byAddress.set(address, [...(byAddress.get(address) ?? []), name]);
  }

  const proxies: DiscoveredProxy[] = [];
  const errors: DiscoveryError[] = [];
  await forEachLimit([...byAddress], RPC_CONCURRENCY, async ([address, names]) => {
    try {
      const state = await readProxy(provider, address);
      if (state === undefined) return;
      const code = await readCodeOrUndefined(provider, address);
      if (code === undefined) return;
      const logic: string[] = [];
      for (const name of names) {
        const role = await fileRole(code, name, deployments.get(name)!, options.localCode);
        if (role === "logic") logic.push(name);
      }
      if (logic.length > 0) {
        proxies.push({ proxy: address, ...state, deployments: logic.sort() });
      } else {
        // Nothing names the new side, so this proxy cannot be validated; say so.
        logger.warn(
          `${address} is a proxy, but ${names.map((n) => `"${n}"`).join(", ")} ` +
            `${names.length === 1 ? "describes" : "describe"} the proxy contract itself and no ` +
            `deployment describes the code behind it, so it is not validated.`,
        );
      }
    } catch (e) {
      errors.push({ address, deployments: names.sort(), reason: (e as Error).message });
    }
  });
  return {
    proxies: proxies.sort((a, b) => a.proxy.localeCompare(b.proxy)),
    errors: errors.sort((a, b) => a.address.localeCompare(b.address)),
  };
}

/** What one deployment is, according to the chain. */
export async function classifyDeployment(
  provider: EthProvider,
  name: string,
  deployment: DeploymentFile,
  localCode?: LocalCodeLookup,
): Promise<DeploymentRole> {
  const address = deployment.address?.toLowerCase();
  if (address === undefined) return { role: "not-proxy" };
  const state = await readProxy(provider, address);
  if (state === undefined) return { role: "not-proxy" };
  const code = await readCodeOrUndefined(provider, address);
  if (code === undefined) return { role: "not-proxy" };
  if ((await fileRole(code, name, deployment, localCode)) === "proxy-contract") {
    return { role: "proxy-contract" };
  }
  return { role: "logic", proxy: address, state };
}

/**
 * Records what the chain reported, rewriting an entry only when it changed.
 * The index only helps later offline runs, so a failed write is a warning.
 */
export async function updateProxyIndex(
  deploymentsDir: string,
  provider: EthProvider,
  proxies: DiscoveredProxy[],
): Promise<void> {
  if (proxies.length === 0) return;
  try {
    const [chainId, observedAtBlock] = await Promise.all([
      readChainId(provider),
      readBlockNumber(provider),
    ]);
    const storeDir = layoutStoreDir(deploymentsDir);
    for (const p of proxies) {
      await updateProxyEntry(storeDir, {
        format: 1,
        proxy: p.proxy,
        chainId,
        implementation: p.implementation,
        ...(p.beacon !== undefined ? { beacon: p.beacon } : {}),
        deployments: p.deployments,
        observedAtBlock,
      });
    }
  } catch (e) {
    logger.warn(`Could not update the proxy index: ${(e as Error).message}`);
  }
}

/**
 * Names of the deployments to validate on one network.
 *
 * With a provider: discovered from the chain, refreshing the proxy index.
 * Without: the deployments the index lists, plus files with the deprecated
 * `upgradeStorageLayout` field at addresses the index does not know.
 */
export async function listProxyDeployments(
  deploymentsDir: string,
  provider?: EthProvider,
  localCode?: LocalCodeLookup,
): Promise<{ names: string[]; errors: DiscoveryError[] }> {
  const deployments = await readDeployments(deploymentsDir);
  if (provider !== undefined) {
    const { proxies, errors } = await discoverProxies(provider, deployments, { localCode });
    await updateProxyIndex(deploymentsDir, provider, proxies);
    return { names: proxies.flatMap((p) => p.deployments).sort(), errors };
  }

  const names = new Set<string>();
  const indexed = new Set<string>();
  for (const entry of await listProxyEntries(layoutStoreDir(deploymentsDir))) {
    indexed.add(entry.proxy);
    for (const name of entry.deployments) {
      if (deployments.get(name)?.address?.toLowerCase() === entry.proxy) names.add(name);
    }
  }
  for (const [name, d] of deployments) {
    const address = d.address?.toLowerCase();
    if (d.upgradeStorageLayout !== undefined && (address === undefined || !indexed.has(address))) {
      names.add(name);
    }
  }
  return { names: [...names].sort(), errors: [] };
}

/**
 * What the proxy index says about a deployment: `logic` when it lists the
 * name for that address, `other` when it knows the address but lists other
 * names, `unknown` when it has no entry for the address.
 */
export async function indexedRole(
  deploymentsDir: string,
  name: string,
  deployment: DeploymentFile,
): Promise<"logic" | "other" | "unknown"> {
  if (deployment.address === undefined) return "unknown";
  const entry = await readProxyEntry(layoutStoreDir(deploymentsDir), deployment.address);
  if (entry === undefined) return "unknown";
  return entry.deployments.includes(name) ? "logic" : "other";
}

// A slot set where there is no code is storage left behind, not a proxy.
async function readCodeOrUndefined(
  provider: EthProvider,
  address: string,
): Promise<string | undefined> {
  try {
    return await readCode(provider, address);
  } catch (e) {
    if (e instanceof BaselineUnavailableError) return undefined;
    throw e;
  }
}

// Whether a file at a proxy address describes the proxy contract itself (its
// code is the code there) or the code behind it. Any match, even
// metadata-only, means the former: this classifies, it does not prove a
// layout. Missing code comes from the local build. Immutable positions come
// from the file, else the local build, else are inferred from the code:
// prebuilt proxy artifacts (as hardhat-deploy v2 ships them) list none.
async function fileRole(
  code: string,
  name: string,
  deployment: DeploymentFile,
  localCode: LocalCodeLookup | undefined,
): Promise<"logic" | "proxy-contract"> {
  let { deployedBytecode, immutableReferences } = deployment;
  if (deployedBytecode === undefined || immutableReferences === undefined) {
    const local = await localCode?.(name, deployment);
    deployedBytecode ??= local?.deployedBytecode;
    immutableReferences ??= local?.immutableReferences;
  }
  // Nothing to compare: the file names a contract, which validation reads
  // from the build (and skips when there is none).
  if (deployedBytecode === undefined) return "logic";
  immutableReferences ??= inferImmutableReferences(deployedBytecode);
  return compareDeployedBytecode(code, deployedBytecode, immutableReferences) === "none"
    ? "logic"
    : "proxy-contract";
}

async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
