/**
 * Picks the "before" layout for one deployment according to the baseline mode.
 *
 * `auto` prefers the chain and falls back to an offline baseline only when the
 * chain cannot answer (`BaselineUnavailableError`). When the chain answers
 * with something untrustworthy (`BaselineIntegrityError`) the error
 * propagates: falling back there would validate against a layout the proxy
 * is not running.
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import { resolveChainBaseline } from "../../core/onchain/baseline.js";
import { BaselineUnavailableError } from "../../core/onchain/errors.js";
import { layoutStoreDir, readLayoutRecord } from "../../core/onchain/store.js";
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

  try {
    await probe(ctx.provider);
    const chain = await resolveChainBaseline(address, {
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
    if (!(e instanceof BaselineUnavailableError) || ctx.mode === "chain") throw e;
    return offlineBaseline(ctx, [
      { kind: "chain-baseline-unavailable", contractName: ctx.name, reason: e.message },
    ]);
  }
}

export function explorerConfig(
  config: UpgradesValidatorConfig | undefined,
  networkName: string,
): { apiKey?: string; apiUrl?: string } {
  const configured = config?.explorers?.[networkName];
  return {
    apiKey: configured?.apiKey ?? process.env.ETHERSCAN_API_KEY,
    ...(configured?.apiUrl !== undefined ? { apiUrl: configured.apiUrl } : {}),
  };
}

/** Separates "cannot reach the RPC" (fall back) from failures after the chain answered. */
export async function probe(provider: EthProvider): Promise<void> {
  try {
    await provider.send("eth_chainId", []);
  } catch (e) {
    throw new BaselineUnavailableError(`RPC unreachable: ${(e as Error).message}`);
  }
}

// Offline: the record for the implementation the deployment file names, else
// the deprecated deployment-file layout.
async function offlineBaseline(
  ctx: BaselineContext,
  warnings: ValidationWarning[],
): Promise<ResolvedBaseline> {
  const implementation = ctx.deployment?.implementation;
  if (implementation !== undefined) {
    const record = await readLayoutRecord(layoutStoreDir(ctx.deploymentsDir), implementation);
    if (record !== undefined) {
      return {
        layout: record.layout,
        info: {
          source: "offline-record",
          implementation: record.address,
          bytecodeMatch: record.bytecodeMatch,
        },
        warnings,
      };
    }
  }
  return deploymentFileBaseline(ctx, warnings);
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
