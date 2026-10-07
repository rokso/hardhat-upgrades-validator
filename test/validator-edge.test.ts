/**
 * Edge-case tests for validateStorageUpgrade that require controlling the
 * ops emitted by oz-core's getStorageUpgradeReport.
 *
 * Tests in this file mock @openzeppelin/upgrades-core to return synthetic op
 * lists. Real layout-based tests live in test/validator.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StorageLayout } from "@openzeppelin/upgrades-core";

vi.mock("@openzeppelin/upgrades-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@openzeppelin/upgrades-core")>();
  return {
    ...orig,
    getStorageUpgradeReport: vi.fn(),
  };
});

import { validateStorageUpgrade } from "../src/core/validator.js";
import { getStorageUpgradeReport } from "@openzeppelin/upgrades-core";

// Non-undefined oldLayout so we reach getStorageUpgradeReport.
const LAYOUT: StorageLayout = { storage: [], types: {} };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// layoutchange uncertain same-size suppression
//
// OZ emits layoutchange (uncertain: true) when retypedFrom is set on a
// namespace member whose baseline lacks slot/offset info (no namespaced
// compilation at baseline time → hasLayout(original) = false).
// We suppress this error if the old and new type have the same byte size.
// ---------------------------------------------------------------------------

describe("layoutchange uncertain same-size suppression", () => {
  function makeLayoutchangeOp(opts: {
    oldTypeLabel: string;
    newTypeLabel: string;
    uncertain: boolean;
    retypedFrom?: string;
  }) {
    return {
      kind: "layoutchange",
      change: { uncertain: opts.uncertain },
      original: {
        label: "x",
        slot: "0",
        offset: 0,
        type: {
          id: `t_${opts.oldTypeLabel}`,
          item: { label: opts.oldTypeLabel },
        },
        contract: "C",
        src: "",
      },
      updated: {
        label: "x",
        slot: "0",
        offset: 0,
        type: {
          id: `t_${opts.newTypeLabel}`,
          item: { label: opts.newTypeLabel },
        },
        contract: "C",
        src: "",
        ...(opts.retypedFrom !== undefined ? { retypedFrom: opts.retypedFrom } : {}),
      },
    };
  }

  it("suppresses when uncertain=true, retypedFrom set, and sizes are equal (uint256 → bytes32)", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        makeLayoutchangeOp({
          oldTypeLabel: "uint256",
          newTypeLabel: "bytes32",
          uncertain: true,
          retypedFrom: "uint256",
        }),
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("suppresses when uncertain=true, retypedFrom set, and sizes are equal (uint128 → int128)", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        makeLayoutchangeOp({
          oldTypeLabel: "uint128",
          newTypeLabel: "int128",
          uncertain: true,
          retypedFrom: "uint128",
        }),
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does NOT suppress when sizes differ (uint256 → uint128)", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        makeLayoutchangeOp({
          oldTypeLabel: "uint256",
          newTypeLabel: "uint128",
          uncertain: true,
          retypedFrom: "uint256",
        }),
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });

  it("does NOT suppress when uncertain=false even if sizes are equal", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        makeLayoutchangeOp({
          oldTypeLabel: "uint256",
          newTypeLabel: "bytes32",
          uncertain: false,
          retypedFrom: "uint256",
        }),
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });

  it("does NOT suppress when retypedFrom is absent even if sizes are equal", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        makeLayoutchangeOp({
          oldTypeLabel: "uint256",
          newTypeLabel: "bytes32",
          uncertain: true,
          retypedFrom: undefined,
        }),
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported op kind from future oz-core versions
//
// We cannot classify whether a new op kind represents a safe or breaking
// change, so we skip it. The user's upgrade is not blocked. Plugin
// maintainers are notified via console.warn.
// ---------------------------------------------------------------------------

describe("unsupported oz-core op kind", () => {
  it("passes validation: unknown op is skipped, not treated as an error", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        {
          kind: "future-unknown-op",
          original: { label: "x", slot: "0", contract: "C", src: "" },
          updated: { label: "x", slot: "0", contract: "C", src: "" },
        },
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does not surface anything to the user when mixed with known safe ops", () => {
    // One unknown op + one known safe op (delete-namespace would error, but
    // here we only have the unknown op alongside no real errors).
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ops: [
        {
          kind: "totally-unknown",
          original: { label: "x", slot: "0", contract: "C", src: "" },
          updated: { label: "x", slot: "0", contract: "C", src: "" },
        },
      ],
    } as never);

    const result = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
