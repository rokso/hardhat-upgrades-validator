/**
 * Proxy detection — offline heuristics and on-chain EIP-1967 slot reads.
 *
 * The compile hook and CLI task only compare storage layouts for contracts
 * that are actually proxies — running the validation on a non-upgradeable
 * contract would produce false positives.
 *
 * **Offline signals** (used by `detectProxy`, no network needed):
 *
 * 1. `implementation` field — hardhat-deploy / rocketh writes this into the
 *    deployment JSON whenever a proxy is deployed. Strongest signal.
 * 2. EIP-1967 slot hash in bytecode — the implementation or beacon slot hash
 *    appears verbatim in proxy bytecode.
 * 3. EIP-1167 minimal proxy prefix — clones have a fixed bytecode prefix.
 *
 * **On-chain signal** (used by `detectProxyOnchain`, requires a provider):
 *
 * 4. `eth_getStorageAt` reading the EIP-1967 implementation and beacon slots
 *    directly from the contract's on-chain storage. Useful as a fallback in
 *    the `validate-upgrade` CLI task when the deployment file lacks an
 *    `implementation` field and bytecode is absent.
 *
 * **Why offline is preferred for the primary tools:**
 * `assertProxyUpgrade` / `validateProxyUpgrade` are called explicitly in
 * deploy scripts — the caller already knows it's a proxy. The `implementation`
 * field written by hardhat-deploy is authoritative. On-chain reads are a
 * fallback for edge cases (hand-crafted deployment files, custom proxies).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * EIP-1167 minimal proxy bytecode prefix (hex, no 0x, lowercase).
 * Reference: https://eips.ethereum.org/EIPS/eip-1167
 */
const EIP1167_PREFIX = "363d3d373d3d3d363d73";

/**
 * EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
 * (hex, no 0x, lowercase). Appears verbatim in proxy bytecode.
 * Reference: https://eips.ethereum.org/EIPS/eip-1967
 */
const EIP1967_IMPL_SLOT = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * EIP-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1
 * (hex, no 0x, lowercase). Present in beacon proxy bytecode.
 */
const EIP1967_BEACON_SLOT = "a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyKind =
  /** Clone factory / EIP-1167 minimal proxy */
  | "eip-1167"
  /** Transparent proxy / UUPS / Beacon proxy (EIP-1967 slot in bytecode) */
  | "eip-1967"
  /** Detected via the `implementation` field in the deployment file */
  | "deployment-record"
  /** Detected by reading EIP-1967 storage slots on-chain */
  | "onchain-slot";

export interface ProxyDetectionResult {
  isProxy: boolean;
  /** Present when `isProxy` is true. */
  kind?: ProxyKind;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects whether a contract is a proxy using any available signal.
 *
 * Pass in the fields from your deployment record. Any subset of fields can be
 * provided — the function applies whichever checks are possible given what
 * is available.
 *
 * @param deployment.implementation - The address of the implementation
 *   contract, if recorded in the deployment file (hardhat-deploy / rocketh).
 * @param deployment.deployedBytecode - The on-chain bytecode (hex string,
 *   with or without 0x prefix).
 */
export function detectProxy(deployment: {
  implementation?: string;
  deployedBytecode?: string;
}): ProxyDetectionResult {
  // Signal 1: explicit implementation address in deployment file.
  if (typeof deployment.implementation === "string" && deployment.implementation.length > 0) {
    return { isProxy: true, kind: "deployment-record" };
  }

  // Signal 2 + 3: bytecode pattern matching.
  if (deployment.deployedBytecode) {
    return detectProxyFromBytecode(deployment.deployedBytecode);
  }

  return { isProxy: false };
}

/**
 * Detects proxy patterns purely from the deployed bytecode hex string.
 * Useful when you only have the bytecode (e.g. when verifying on-chain).
 */
export function detectProxyFromBytecode(deployedBytecode: string): ProxyDetectionResult {
  const hex = deployedBytecode.toLowerCase().replace(/^0x/, "");

  // EIP-1167 minimal proxy has a well-known fixed prefix.
  if (hex.startsWith(EIP1167_PREFIX)) {
    return { isProxy: true, kind: "eip-1167" };
  }

  // EIP-1967 proxies contain the implementation (or beacon) slot hash
  // as a literal in their bytecode.
  if (hex.includes(EIP1967_IMPL_SLOT) || hex.includes(EIP1967_BEACON_SLOT)) {
    return { isProxy: true, kind: "eip-1967" };
  }

  return { isProxy: false };
}

// ---------------------------------------------------------------------------
// On-chain detection (requires a live provider)
// ---------------------------------------------------------------------------

import {
  isTransparentOrUUPSProxy,
  isBeaconProxy,
  type EthereumProvider,
} from "@openzeppelin/upgrades-core";

/**
 * Minimal interface for a network provider compatible with Hardhat's
 * EthereumProvider. We only use `send` for JSON-RPC calls.
 */
export interface EthProvider {
  send(method: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Reads the EIP-1967 implementation and beacon storage slots on-chain to
 * confirm whether `address` is a proxy.
 *
 * Delegates to oz-core's `isTransparentOrUUPSProxy` and `isBeaconProxy`
 * instead of reading raw storage slots directly, ensuring our detection
 * logic stays in sync with oz-core's implementation.
 *
 * Use this as a fallback in the `validate-upgrade` CLI task when the
 * deployment file has no `implementation` field and bytecode is absent.
 *
 * Returns `{ isProxy: false }` (never throws) when the call fails so that
 * network errors degrade gracefully.
 *
 * @param provider - An EIP-1193 provider (`hre.network.provider` works).
 * @param address  - The contract address to check.
 */
export async function detectProxyOnchain(
  provider: EthProvider,
  address: string,
): Promise<ProxyDetectionResult> {
  // EthProvider is structurally compatible with oz-core's EthereumProvider.
  const ozProvider = provider as unknown as EthereumProvider;
  try {
    if (await isTransparentOrUUPSProxy(ozProvider, address)) {
      return { isProxy: true, kind: "onchain-slot" };
    }
    if (await isBeaconProxy(ozProvider, address)) {
      return { isProxy: true, kind: "onchain-slot" };
    }
    return { isProxy: false };
  } catch {
    // Network unavailable, wrong network, or RPC error — degrade gracefully.
    return { isProxy: false };
  }
}
