/**
 * Framework-agnostic chain-sourced baselines. No Hardhat imports, so Hardhat
 * v2 projects and plain scripts can use it directly:
 *
 *   import { resolveChainBaseline } from "hardhat-upgrades-validator/onchain";
 */

export {
  resolveChainBaseline,
  resolveImplementationLayout,
  recordLocalBuild,
  type ChainBaseline,
  type ChainBaselineOptions,
  type LocalBuild,
} from "./baseline.js";
export { BaselineIntegrityError, BaselineUnavailableError } from "./errors.js";
export {
  fetchVerifiedSource,
  ETHERSCAN_V2_API_URL,
  type ExplorerConfig,
  type VerifiedSource,
} from "./explorer.js";
export { readImplementation, readCode, readChainId, codeSha256 } from "./implementation.js";
export { reconstructLayout, layoutFromSource, type ReconstructedLayout } from "./reconstruct.js";
export { getSolc, type SolcOptions, type SolcRunner } from "./solc.js";
export {
  LAYOUT_STORE_DIRNAME,
  layoutStoreDir,
  readLayoutRecord,
  writeLayoutRecord,
} from "./store.js";
export type { EthProvider, ImplementationLayoutRecord } from "./types.js";
export {
  compareDeployedBytecode,
  type DeployedBytecodeMatch,
  type ImmutableReferences,
} from "../bytecode-utils.js";
export { validateStorageUpgrade, formatValidationResult } from "../validator.js";
