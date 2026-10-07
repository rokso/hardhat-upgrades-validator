/**
 * In-memory JSON-RPC provider for the handful of calls the chain-baseline
 * code makes: eth_chainId, eth_getCode, and eth_getStorageAt on the ERC-1967
 * slots (read through oz-core's getImplementationAddressFromProxy).
 */
import { vi } from "vitest";

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_WORD = "0x" + "0".repeat(64);

export interface MockChainState {
  chainId?: number;
  /** address → runtime code */
  code?: Record<string, string>;
  /** proxy address → implementation address */
  implementations?: Record<string, string>;
}

export function makeMockChain(state: MockChainState = {}) {
  const code = lowerKeys(state.code ?? {});
  const implementations = lowerKeys(state.implementations ?? {});
  const send = vi.fn(async (method: string, params: unknown[] = []) => {
    switch (method) {
      case "eth_chainId":
        return "0x" + (state.chainId ?? 1).toString(16);
      case "eth_getCode":
        return code[String(params[0]).toLowerCase()] ?? "0x";
      case "eth_getStorageAt": {
        const [address, slot] = params as [string, string];
        const impl = implementations[address.toLowerCase()];
        if (impl !== undefined && slot.toLowerCase() === IMPL_SLOT) {
          return "0x" + impl.replace(/^0x/, "").toLowerCase().padStart(64, "0");
        }
        return ZERO_WORD;
      }
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  });
  return { send };
}

/** A provider whose every call fails, as an unreachable RPC does. */
export function makeDeadChain() {
  return { send: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
}

function lowerKeys(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
}
