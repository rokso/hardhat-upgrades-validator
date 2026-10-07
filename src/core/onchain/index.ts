/**
 * Framework-agnostic chain-sourced baselines. No Hardhat imports, so plain
 * ESM scripts and other tooling can use it directly:
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
  type LocalBuildResult,
} from "./baseline.js";
export { BaselineIntegrityError, BaselineUnavailableError } from "./errors.js";
export {
  fetchVerifiedSource,
  ETHERSCAN_V2_API_URL,
  type ExplorerConfig,
  type VerifiedSource,
} from "./explorer.js";
export {
  readProxy,
  readImplementation,
  readCode,
  readChainId,
  readBlockNumber,
  codeSha256,
  type ProxyState,
} from "./implementation.js";
export { reconstructLayout, layoutFromSource, type ReconstructedLayout } from "./reconstruct.js";
export { getSolc, type SolcOptions, type SolcRunner } from "./solc.js";
export {
  LAYOUT_STORE_DIRNAME,
  layoutStoreDir,
  readLayoutRecord,
  writeLayoutRecord,
  readProxyEntry,
  listProxyEntries,
  updateProxyEntry,
} from "./store.js";
export type { EthProvider, ImplementationLayoutRecord, ProxyIndexEntry } from "./types.js";
export {
  compareDeployedBytecode,
  isProvingMatch,
  type DeployedBytecodeMatch,
  type ProvingMatch,
  type ImmutableReferences,
} from "../bytecode-utils.js";
export { validateStorageUpgrade, formatValidationResult } from "../validator.js";
