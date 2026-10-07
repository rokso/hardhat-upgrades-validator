import type { StorageLayout } from "@openzeppelin/upgrades-core";
import type { DeployedBytecodeMatch } from "../bytecode-utils.js";

export type { EthProvider } from "../proxy-detection.js";

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
  bytecodeMatch: Exclude<DeployedBytecodeMatch, "none">;
  /** `explorer`: rebuilt from verified source. `local-compile`: proven against the local build. */
  source: "explorer" | "local-compile";
  recordedAt: string;
  layout: StorageLayout;
}
