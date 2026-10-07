import type { StorageLayout } from "@openzeppelin/upgrades-core";
import type { ProvingMatch } from "../bytecode-utils.js";

/** The one JSON-RPC method used; `hre.network.provider` and ethers providers both fit. */
export interface EthProvider {
  send(method: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Storage layout of the code deployed at one address.
 *
 * Deployed code never changes, so a record keyed by address cannot go stale.
 * `codeSha256` binds the record to the exact runtime code it was proven
 * against; a reader that sees different code at the address must reject it.
 */
export interface ImplementationLayoutRecord {
  format: 1;
  address: string;
  chainId: number;
  codeSha256: string;
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  /** solc long version, when known. */
  compiler?: string;
  bytecodeMatch: ProvingMatch;
  /** `explorer`: rebuilt from verified source. `local-compile`: proven against the local build. */
  source: "explorer" | "local-compile";
  recordedAt: string;
  layout: StorageLayout;
}

/**
 * Which implementation a proxy ran when last observed, so offline readers
 * (the compile hook, runs without an RPC) know which record applies.
 *
 * Written only from what the chain reports, never from what a deploy meant
 * to do, so a queued or discarded upgrade never moves it. It goes stale when
 * the proxy is upgraded outside this tool, until the next run with an RPC;
 * offline results therefore name the block it was observed at.
 */
export interface ProxyIndexEntry {
  format: 1;
  proxy: string;
  chainId: number;
  implementation: string;
  /** Set for a beacon proxy; `implementation` is then the beacon's. */
  beacon?: string;
  /**
   * Deployment names that describe the code behind the proxy. Files that
   * describe the proxy contract itself are excluded by comparing their code
   * with the chain, never by their names.
   */
  deployments: string[];
  observedAtBlock: number;
}
