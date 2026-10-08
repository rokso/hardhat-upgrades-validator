/**
 * Chain-sourced upgrade baselines: the layout of whatever a proxy runs now.
 *
 * Under lazy upgrades or queued multisig upgrades, deployment files describe
 * the latest build while proxies keep running older implementations. Reading
 * the implementation from the chain at validation time, and keying layouts by
 * implementation address, makes the baseline correct in every one of those
 * states.
 *
 * slotdiff proves the layouts; this module keeps them in the layout store, so
 * a record is rebuilt from the explorer once and then served from the store.
 */

import {
  proveLocalBuild,
  readImplementation,
  resolveLayout,
  verifyRecord,
  type ExplorerConfig,
  type LocalBuild,
  type LocalBuildResult,
  type SolcOptions,
} from "slotdiff";
import { LayoutUnavailableError } from "./errors.js";
import { readLayoutRecord, writeLayoutRecord } from "./store.js";
import type { EthProvider, LayoutRecord } from "./types.js";

export type { LocalBuild, LocalBuildResult } from "slotdiff";

export interface ChainBaselineOptions {
  provider: EthProvider;
  storeDir: string;
  /**
   * Needed only when no record exists yet for the implementation. A function
   * is called only then, so a secret it reads is not read otherwise.
   */
  explorer?: ExplorerConfig | (() => Promise<ExplorerConfig>);
  solc?: SolcOptions;
  /** Rebuild from the explorer even when a record exists. */
  refresh?: boolean;
}

export interface ChainBaseline {
  implementation: string;
  record: LayoutRecord;
  /** `store`: an existing record. `explorer`: rebuilt and recorded during this call. */
  origin: "store" | "explorer";
}

export async function resolveChainBaseline(
  proxy: string,
  options: ChainBaselineOptions,
): Promise<ChainBaseline> {
  const implementation = await readImplementation(options.provider, proxy);
  return resolveImplementationLayout(implementation, options);
}

export async function resolveImplementationLayout(
  implementation: string,
  options: ChainBaselineOptions,
): Promise<ChainBaseline> {
  const { provider, storeDir } = options;
  const address = implementation.toLowerCase();

  if (!options.refresh) {
    const stored = await readLayoutRecord(storeDir, address);
    if (stored !== undefined) {
      // Refuses a record for another chain or for code no longer at the address.
      const record = await verifyRecord(provider, address, stored);
      return { implementation: address, record, origin: "store" };
    }
  }

  const explorer =
    typeof options.explorer === "function" ? await options.explorer() : options.explorer;
  if (explorer === undefined || !(explorer.apiKey || explorer.apiUrl)) {
    throw new LayoutUnavailableError(
      `No layout record for implementation ${address} and no explorer configured to rebuild one.`,
    );
  }
  const record = await resolveLayout(provider, address, { explorer, solc: options.solc });
  await writeLayoutRecord(storeDir, record);
  return { implementation: address, record, origin: "explorer" };
}

/**
 * Records the layout of a local build for the code at `address`, but only
 * after slotdiff proves the chain runs that build. Any weaker match records
 * nothing, so a layout is never recorded for code that is not there.
 */
export async function recordLocalBuild(
  provider: EthProvider,
  storeDir: string,
  address: string,
  build: LocalBuild,
): Promise<LocalBuildResult> {
  const result = await proveLocalBuild(provider, address, build);
  if (result.record !== undefined) await writeLayoutRecord(storeDir, result.record);
  return result;
}
