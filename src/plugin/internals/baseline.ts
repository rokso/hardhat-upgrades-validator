/**
 * Picks the "before" layout for one deployment according to the baseline mode.
 *
 * `auto` prefers the chain and falls back to an offline baseline only when the
 * chain cannot say which implementation the proxy runs (no RPC, no proxy slot).
 * Once the chain has named the implementation, only that implementation's
 * layout is acceptable: if it cannot be obtained the error propagates, since
 * any other layout describes code the proxy is known not to run. Integrity
 * failures (`BaselineIntegrityError`) always propagate.
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { resolveImplementationLayout } from "../../core/onchain/baseline.js";
import { ETHERSCAN_V2_API_URL } from "../../core/onchain/explorer.js";
import { readImplementation } from "../../core/onchain/implementation.js";
import { BaselineUnavailableError } from "../../core/onchain/errors.js";
import { layoutStoreDir, readLayoutRecord, readProxyEntry } from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import type { UpgradesValidatorConfig } from "../../types/hardhat-type-extensions.js";
import type { BaselineInfo, BaselineMode, ValidationWarning } from "../../types/validation.js";
import type { DeploymentFile } from "./deployment-files.js";

export interface BaselineContext {
  name: string;
  deployment: DeploymentFile | null;
  deploymentsDir: string;
  networkName: string;
  mode: BaselineMode;
  /** Undefined when running offline (no network connection). */
  provider?: EthProvider;
  config?: UpgradesValidatorConfig;
}

export interface ResolvedBaseline {
  layout: StorageLayout | undefined;
  info: BaselineInfo;
  warnings: ValidationWarning[];
}

export async function resolveBaseline(ctx: BaselineContext): Promise<ResolvedBaseline> {
  // No deployment file means a first deployment in every mode: nothing to compare against.
  if (ctx.deployment === null) return { layout: undefined, info: { source: "none" }, warnings: [] };
  if (ctx.mode === "deployment") return deploymentFileBaseline(ctx, []);

  const address = ctx.deployment?.address;
  if (ctx.provider === undefined || address === undefined) {
    if (ctx.mode === "chain") {
      throw new BaselineUnavailableError(
        `A chain baseline for "${ctx.name}" needs a network connection and a deployment address.`,
      );
    }
    return offlineBaseline(ctx, []);
  }

  let implementation: string;
  try {
    await probe(ctx.provider);
    implementation = await readImplementation(ctx.provider, address);
  } catch (e) {
    if (!(e instanceof BaselineUnavailableError) || ctx.mode === "chain") throw e;
    return offlineBaseline(ctx, [
      { kind: "chain-baseline-unavailable", contractName: ctx.name, reason: e.message },
    ]);
  }

  try {
    const chain = await resolveImplementationLayout(implementation, {
      provider: ctx.provider,
      storeDir: layoutStoreDir(ctx.deploymentsDir),
      explorer: explorerConfig(ctx.config, ctx.networkName),
      solc: { cacheDir: ctx.config?.solcCacheDir },
    });
    return {
      layout: chain.record.layout,
      info: {
        source: "chain",
        implementation: chain.implementation,
        bytecodeMatch: chain.record.bytecodeMatch,
        origin: chain.origin,
      },
      warnings: [],
    };
  } catch (e) {
    if (!(e instanceof BaselineUnavailableError)) throw e;
    throw new BaselineUnavailableError(
      `"${ctx.name}" runs implementation ${implementation}, but its layout could not be obtained: ` +
        `${e.message} No other baseline is used, because only this implementation's layout is ` +
        `correct. Record it from a matching local build (record-baseline --contract ${ctx.name}), ` +
        `configure an explorer, or opt out with --baseline deployment.`,
    );
  }
}

export function explorerConfig(
  config: UpgradesValidatorConfig | undefined,
  networkName: string,
): { apiKey?: string; apiUrl?: string } {
  const configured = config?.explorers?.[networkName];
  // Empty strings count as unset: CI passes "" for a missing secret.
  const apiUrl = configured?.apiUrl || undefined;
  // ETHERSCAN_API_KEY goes only to Etherscan, never to a third-party apiUrl.
  const etherscan = apiUrl === undefined || isEtherscan(apiUrl);
  const apiKey =
    configured?.apiKey || (etherscan ? process.env.ETHERSCAN_API_KEY || undefined : undefined);
  return {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiUrl !== undefined ? { apiUrl } : {}),
  };
}

function isEtherscan(apiUrl: string): boolean {
  try {
    const url = new URL(apiUrl);
    return url.protocol === "https:" && url.host === new URL(ETHERSCAN_V2_API_URL).host;
  } catch {
    return false;
  }
}

/** Separates "cannot reach the RPC" (fall back) from failures after the chain answered. */
export async function probe(provider: EthProvider): Promise<void> {
  try {
    await provider.send("eth_chainId", []);
  } catch (e) {
    throw new BaselineUnavailableError(`RPC unreachable: ${(e as Error).message}`);
  }
}

// Offline: the record for the implementation the proxy index says the proxy
// ran when last observed. Without an index entry, the deprecated field. With
// an entry but no record, nothing: another layout would describe other code.
async function offlineBaseline(
  ctx: BaselineContext,
  warnings: ValidationWarning[],
): Promise<ResolvedBaseline> {
  const address = ctx.deployment?.address;
  const storeDir = layoutStoreDir(ctx.deploymentsDir);
  const entry = address !== undefined ? await readProxyEntry(storeDir, address) : undefined;
  if (entry === undefined || !entry.deployments.includes(ctx.name)) {
    return deploymentFileBaseline(ctx, warnings);
  }
  const record = await readLayoutRecord(storeDir, entry.implementation);
  if (record === undefined) return { layout: undefined, info: { source: "none" }, warnings };
  return {
    layout: record.layout,
    info: {
      source: "offline-record",
      implementation: record.address,
      bytecodeMatch: record.bytecodeMatch,
      observedAtBlock: entry.observedAtBlock,
    },
    warnings,
  };
}

function deploymentFileBaseline(
  ctx: BaselineContext,
  warnings: ValidationWarning[],
): ResolvedBaseline {
  const layout = ctx.deployment?.upgradeStorageLayout;
  if (layout === undefined) return { layout, info: { source: "none" }, warnings };
  return {
    layout,
    info: { source: "deployment-file" },
    warnings: [...warnings, { kind: "deprecated-baseline", contractName: ctx.name }],
  };
}
