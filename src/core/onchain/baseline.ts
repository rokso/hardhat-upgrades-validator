/**
 * Chain-sourced upgrade baselines: the layout of whatever a proxy runs now.
 *
 * Under lazy upgrades or queued multisig upgrades, deployment files describe
 * the latest build while proxies keep running older implementations. Reading
 * the implementation from the chain at validation time, and keying layouts by
 * implementation address, makes the baseline correct in every one of those
 * states.
 */

import type { StorageLayout } from "@openzeppelin/upgrades-core";
import {
  compareDeployedBytecode,
  isProvingMatch,
  type DeployedBytecodeMatch,
  type ImmutableReferences,
} from "../bytecode-utils.js";
import { BaselineIntegrityError, BaselineUnavailableError } from "./errors.js";
import { canQueryExplorer, fetchVerifiedSource, type ExplorerConfig } from "./explorer.js";
import { codeSha256, readChainId, readCode, readImplementation } from "./implementation.js";
import { reconstructLayout } from "./reconstruct.js";
import { getSolc, type SolcOptions } from "./solc.js";
import { readLayoutRecord, writeLayoutRecord } from "./store.js";
import type { EthProvider, ImplementationLayoutRecord } from "./types.js";

export interface ChainBaselineOptions {
  provider: EthProvider;
  storeDir: string;
  /** Needed only when no record exists yet for the implementation. */
  explorer?: ExplorerConfig;
  solc?: SolcOptions;
  /** Rebuild from the explorer even when a record exists. */
  refresh?: boolean;
}

export interface ChainBaseline {
  implementation: string;
  record: ImplementationLayoutRecord;
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
  const code = await readCode(provider, address);
  const hash = codeSha256(code);

  const stored = await readLayoutRecord(storeDir, address);
  if (stored !== undefined && !options.refresh) {
    if (stored.codeSha256 !== hash) {
      throw new BaselineIntegrityError(
        `The layout record for ${address} was proven against different code than this chain has at ` +
          `that address. If the record was copied from another chain, delete it and re-run.`,
      );
    }
    if (!isProvingMatch(stored.bytecodeMatch)) {
      throw new BaselineIntegrityError(
        `The layout record for ${address} rests on a "${String(stored.bytecodeMatch)}" match, which ` +
          `does not prove a storage layout. Delete it and re-run.`,
      );
    }
    return { implementation: address, record: stored, origin: "store" };
  }

  if (options.explorer === undefined || !canQueryExplorer(options.explorer)) {
    throw new BaselineUnavailableError(
      `No layout record for implementation ${address} and no explorer configured to rebuild one.`,
    );
  }

  const chainId = await readChainId(provider);
  const source = await fetchVerifiedSource(chainId, address, options.explorer);
  const solc = await getSolc(source.solcLongVersion, options.solc);
  const rebuilt = await reconstructLayout(source, solc, code);

  const record: ImplementationLayoutRecord = {
    format: 1,
    address,
    chainId,
    codeSha256: hash,
    contract: rebuilt.contract,
    compiler: rebuilt.compiler,
    bytecodeMatch: rebuilt.bytecodeMatch,
    source: "explorer",
    recordedAt: new Date().toISOString(),
    layout: rebuilt.layout,
  };
  await writeLayoutRecord(storeDir, record);
  return { implementation: address, record, origin: "explorer" };
}

export interface LocalBuild {
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  compiler?: string;
  layout: StorageLayout;
  deployedBytecode: string;
  immutableReferences?: ImmutableReferences;
}

export interface LocalBuildResult {
  bytecodeMatch: DeployedBytecodeMatch;
  /** Set only when the match proves the layout (`exact` or `immutables-only`). */
  record?: ImplementationLayoutRecord;
}

/**
 * Records the layout of a local build for the code at `address`, but only
 * after proving the chain runs that build. A `metadata-only` or `none` match
 * records nothing, so a layout is never recorded for code that is not there.
 */
export async function recordLocalBuild(
  provider: EthProvider,
  storeDir: string,
  address: string,
  build: LocalBuild,
): Promise<LocalBuildResult> {
  const lower = address.toLowerCase();
  const code = await readCode(provider, lower);
  const bytecodeMatch = compareDeployedBytecode(
    code,
    build.deployedBytecode,
    build.immutableReferences,
  );
  if (!isProvingMatch(bytecodeMatch)) return { bytecodeMatch };

  const record: ImplementationLayoutRecord = {
    format: 1,
    address: lower,
    chainId: await readChainId(provider),
    codeSha256: codeSha256(code),
    contract: build.contract,
    ...(build.compiler !== undefined ? { compiler: build.compiler } : {}),
    bytecodeMatch,
    source: "local-compile",
    recordedAt: new Date().toISOString(),
    layout: build.layout,
  };
  await writeLayoutRecord(storeDir, record);
  return { bytecodeMatch, record };
}
