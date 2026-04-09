import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectProxy,
  detectProxyFromBytecode,
  detectProxyOnchain,
} from "../src/core/proxy-detection.js";

// ---------------------------------------------------------------------------
// Mock oz-core on-chain helpers for detectProxyOnchain tests.
// detectProxy / detectProxyFromBytecode do not use oz-core — spreading orig
// preserves all real functions, only isTransparentOrUUPSProxy and
// isBeaconProxy are replaced with controllable fakes.
// ---------------------------------------------------------------------------

vi.mock("@openzeppelin/upgrades-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@openzeppelin/upgrades-core")>();
  return {
    ...orig,
    isTransparentOrUUPSProxy: vi.fn(),
    isBeaconProxy: vi.fn(),
  };
});

import { isTransparentOrUUPSProxy, isBeaconProxy } from "@openzeppelin/upgrades-core";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Bytecode fixtures
// ---------------------------------------------------------------------------

/**
 * EIP-1167 minimal proxy (clone factory).
 * The deployed bytecode always starts with the well-known prefix.
 *
 * Format: 363d3d373d3d3d363d73 <20-byte impl addr> 5af43d82803e903d91602b57fd5bf3
 */
const EIP1167_BYTECODE =
  "0x363d3d373d3d3d363d73" +
  "5fbdb2315678afecb367f032d93f642f64180aa3" + // 20-byte implementation address
  "5af43d82803e903d91602b57fd5bf3";

/**
 * EIP-1967 transparent / UUPS proxy bytecode (abbreviated).
 * The implementation slot hash appears verbatim in the bytecode.
 */
const EIP1967_IMPL_SLOT = "360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_PROXY_BYTECODE =
  "0x60806040" + // typical preamble
  EIP1967_IMPL_SLOT + // the slot hash embedded in bytecode
  "5460a01b"; // rest of proxy code (abbreviated)

/**
 * EIP-1967 beacon proxy bytecode (abbreviated).
 */
const EIP1967_BEACON_SLOT = "a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_BEACON_BYTECODE = "0x60806040" + EIP1967_BEACON_SLOT + "5460a01b";

/**
 * Non-proxy contract — a simple counter with no delegation.
 * No known proxy slot or EIP-1167 prefix.
 */
const PLAIN_CONTRACT_BYTECODE =
  "0x608060405234801561001057600080fd5b506004361061002b5760003560e01c8063" +
  "60fe47b114610030578063";

// ---------------------------------------------------------------------------
// detectProxyFromBytecode
// ---------------------------------------------------------------------------

describe("detectProxyFromBytecode", () => {
  it("detects EIP-1167 minimal proxy", () => {
    const result = detectProxyFromBytecode(EIP1167_BYTECODE);
    expect(result).toEqual({ isProxy: true, kind: "eip-1167" });
  });

  it("detects EIP-1967 transparent/UUPS proxy via impl slot", () => {
    const result = detectProxyFromBytecode(EIP1967_PROXY_BYTECODE);
    expect(result).toEqual({ isProxy: true, kind: "eip-1967" });
  });

  it("detects EIP-1967 beacon proxy via beacon slot", () => {
    const result = detectProxyFromBytecode(EIP1967_BEACON_BYTECODE);
    expect(result).toEqual({ isProxy: true, kind: "eip-1967" });
  });

  it("returns false for a plain (non-proxy) contract", () => {
    const result = detectProxyFromBytecode(PLAIN_CONTRACT_BYTECODE);
    expect(result).toEqual({ isProxy: false });
  });

  it("handles bytecode without 0x prefix", () => {
    const hex = EIP1167_BYTECODE.slice(2); // strip 0x
    const result = detectProxyFromBytecode(hex);
    expect(result).toEqual({ isProxy: true, kind: "eip-1167" });
  });

  it("is case-insensitive", () => {
    const upper = EIP1967_PROXY_BYTECODE.toUpperCase();
    const result = detectProxyFromBytecode(upper);
    expect(result).toEqual({ isProxy: true, kind: "eip-1967" });
  });
});

// ---------------------------------------------------------------------------
// detectProxy — deployment-record signal
// ---------------------------------------------------------------------------

describe("detectProxy — deployment-record signal", () => {
  it("returns isProxy=true when implementation field is present", () => {
    const result = detectProxy({
      implementation: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    });
    expect(result).toEqual({ isProxy: true, kind: "deployment-record" });
  });

  it("prefers deployment-record over bytecode detection", () => {
    // Even if bytecode also looks like a proxy, the explicit field wins.
    const result = detectProxy({
      implementation: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      deployedBytecode: EIP1167_BYTECODE,
    });
    expect(result).toEqual({ isProxy: true, kind: "deployment-record" });
  });

  it("returns false when implementation is empty string", () => {
    const result = detectProxy({ implementation: "" });
    expect(result.isProxy).toBe(false);
  });

  it("returns false when implementation is undefined", () => {
    const result = detectProxy({ implementation: undefined });
    expect(result.isProxy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectProxy — bytecode fallback
// ---------------------------------------------------------------------------

describe("detectProxy — bytecode fallback", () => {
  it("falls back to bytecode detection when no implementation field", () => {
    const result = detectProxy({ deployedBytecode: EIP1967_PROXY_BYTECODE });
    expect(result).toEqual({ isProxy: true, kind: "eip-1967" });
  });

  it("returns false when bytecode is plain contract and no implementation field", () => {
    const result = detectProxy({ deployedBytecode: PLAIN_CONTRACT_BYTECODE });
    expect(result.isProxy).toBe(false);
  });

  it("returns false when neither field is present", () => {
    const result = detectProxy({});
    expect(result.isProxy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectProxyOnchain — on-chain EIP-1967 slot reads via oz-core helpers
// ---------------------------------------------------------------------------

const FAKE_ADDRESS = "0x1234567890123456789012345678901234567890";
const fakeProvider = { send: vi.fn() };

describe("detectProxyOnchain", () => {
  it("returns isProxy=true with onchain-slot when isTransparentOrUUPSProxy resolves true", async () => {
    vi.mocked(isTransparentOrUUPSProxy).mockResolvedValue(true);
    vi.mocked(isBeaconProxy).mockResolvedValue(false);

    const result = await detectProxyOnchain(fakeProvider, FAKE_ADDRESS);
    expect(result).toEqual({ isProxy: true, kind: "onchain-slot" });
  });

  it("returns isProxy=true with onchain-slot when isBeaconProxy resolves true", async () => {
    vi.mocked(isTransparentOrUUPSProxy).mockResolvedValue(false);
    vi.mocked(isBeaconProxy).mockResolvedValue(true);

    const result = await detectProxyOnchain(fakeProvider, FAKE_ADDRESS);
    expect(result).toEqual({ isProxy: true, kind: "onchain-slot" });
  });

  it("returns isProxy=false when both helpers resolve false", async () => {
    vi.mocked(isTransparentOrUUPSProxy).mockResolvedValue(false);
    vi.mocked(isBeaconProxy).mockResolvedValue(false);

    const result = await detectProxyOnchain(fakeProvider, FAKE_ADDRESS);
    expect(result).toEqual({ isProxy: false });
  });

  it("returns isProxy=false when the provider throws (network error)", async () => {
    vi.mocked(isTransparentOrUUPSProxy).mockRejectedValue(new Error("network unavailable"));

    const result = await detectProxyOnchain(fakeProvider, FAKE_ADDRESS);
    expect(result).toEqual({ isProxy: false });
  });

  it("does not call isBeaconProxy when isTransparentOrUUPSProxy already returns true", async () => {
    vi.mocked(isTransparentOrUUPSProxy).mockResolvedValue(true);

    await detectProxyOnchain(fakeProvider, FAKE_ADDRESS);
    expect(vi.mocked(isBeaconProxy)).not.toHaveBeenCalled();
  });
});
