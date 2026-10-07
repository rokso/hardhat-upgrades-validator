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

import { compareDeployedBytecode } from "../../core/bytecode-utils.js";
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
import { readDeployments, type DeploymentFile } from "./deployment-files.js";
import { logger } from "../../utils/logger.js";

export interface DiscoveredProxy extends ProxyState {
  proxy: string;
  /** Deployment names describing the code behind the proxy. */
  deployments: string[];
}

export type DeploymentRole =
  | { role: "logic"; proxy: string; state: ProxyState }
  | { role: "proxy-contract" }
  | { role: "not-proxy" };

const RPC_CONCURRENCY = 8;

/**
 * Proxies among `deployments`, optionally limited to the given addresses
 * (lowercase). Each comes with the deployment names to validate against it.
 */
export async function discoverProxies(
  provider: EthProvider,
  deployments: Map<string, DeploymentFile>,
  only?: ReadonlySet<string>,
): Promise<DiscoveredProxy[]> {
  const byAddress = new Map<string, string[]>();
  for (const [name, d] of deployments) {
    const address = d.address?.toLowerCase();
    if (address === undefined || (only !== undefined && !only.has(address))) continue;
    byAddress.set(address, [...(byAddress.get(address) ?? []), name]);
  }

  const found: DiscoveredProxy[] = [];
  await forEachLimit([...byAddress], RPC_CONCURRENCY, async ([address, names]) => {
    const state = await readProxy(provider, address);
    if (state === undefined) return;
    const code = await readCodeOrUndefined(provider, address);
    if (code === undefined) return;
    const logic = names.filter((n) => !describesCode(code, deployments.get(n)!));
    if (logic.length > 0) {
      found.push({ proxy: address, ...state, deployments: logic.sort() });
    } else {
      // Nothing names the new side, so this proxy cannot be validated; say so.
      logger.warn(
        `${address} is a proxy, but ${names.map((n) => `"${n}"`).join(", ")} ` +
          `${names.length === 1 ? "describes" : "describe"} the proxy contract itself and no ` +
          `deployment describes the code behind it, so it is not validated.`,
      );
    }
  });
  return found.sort((a, b) => a.proxy.localeCompare(b.proxy));
}

/** What one deployment is, according to the chain. */
export async function classifyDeployment(
  provider: EthProvider,
  deployment: DeploymentFile,
): Promise<DeploymentRole> {
  const address = deployment.address?.toLowerCase();
  if (address === undefined) return { role: "not-proxy" };
  const state = await readProxy(provider, address);
  if (state === undefined) return { role: "not-proxy" };
  const code = await readCodeOrUndefined(provider, address);
  if (code === undefined) return { role: "not-proxy" };
  if (describesCode(code, deployment)) return { role: "proxy-contract" };
  return { role: "logic", proxy: address, state };
}

/** Records what the chain reported, rewriting an entry only when it changed. */
export async function updateProxyIndex(
  deploymentsDir: string,
  provider: EthProvider,
  discovered: DiscoveredProxy[],
): Promise<void> {
  if (discovered.length === 0) return;
  const [chainId, observedAtBlock] = await Promise.all([
    readChainId(provider),
    readBlockNumber(provider),
  ]);
  const storeDir = layoutStoreDir(deploymentsDir);
  for (const p of discovered) {
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
}

/**
 * Names of the deployments to validate on one network.
 *
 * With a provider: discovered from the chain, refreshing the proxy index.
 * Without: the deployments the index lists, plus files that still carry the
 * deprecated `upgradeStorageLayout` field.
 */
export async function listProxyDeployments(
  deploymentsDir: string,
  provider?: EthProvider,
): Promise<string[]> {
  const deployments = await readDeployments(deploymentsDir);
  if (provider !== undefined) {
    const discovered = await discoverProxies(provider, deployments);
    await updateProxyIndex(deploymentsDir, provider, discovered);
    return discovered.flatMap((p) => p.deployments).sort();
  }

  const names = new Set<string>();
  for (const entry of await listProxyEntries(layoutStoreDir(deploymentsDir))) {
    for (const name of entry.deployments) {
      if (deployments.get(name)?.address?.toLowerCase() === entry.proxy) names.add(name);
    }
  }
  for (const [name, d] of deployments) {
    if (d.upgradeStorageLayout !== undefined) names.add(name);
  }
  return [...names].sort();
}

/** Whether the proxy index lists `name` as the code behind its proxy. */
export async function isIndexedLogic(
  deploymentsDir: string,
  name: string,
  deployment: DeploymentFile,
): Promise<boolean> {
  if (deployment.address === undefined) return false;
  const entry = await readProxyEntry(layoutStoreDir(deploymentsDir), deployment.address);
  return entry?.deployments.includes(name) ?? false;
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

// Any match, even metadata-only, means the file is the contract at that
// address: this classifies, it does not prove a layout.
function describesCode(code: string, deployment: DeploymentFile): boolean {
  if (deployment.deployedBytecode === undefined) return false;
  return (
    compareDeployedBytecode(code, deployment.deployedBytecode, deployment.immutableReferences) !==
    "none"
  );
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
