/**
 * Unit tests for validateStorageUpgrade: namespace-level unsafe-allow
 * suppression and global vs namespace vs per-variable precedence.
 *
 * Uses synthetic StorageLayout objects (no compiled fixtures required).
 */
import { describe, it, expect } from "vitest";
import { validateStorageUpgrade } from "../src/core/validator.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";

// ---------------------------------------------------------------------------
// Synthetic layout builders
// ---------------------------------------------------------------------------

const T_U256 = { label: "uint256", numberOfBytes: "32" };
const T_U128 = { label: "uint128", numberOfBytes: "16" };
const T_ADDR = { label: "address", numberOfBytes: "20" };

/**
 * Regular (non-namespace) layout with a single variable.
 * Uses the same contract name for old and new to simulate an in-place upgrade.
 */
function regularLayout(
  label: string,
  typeId: "t_uint256" | "t_address",
  extra?: { renamedFrom?: string },
): StorageLayout {
  const item: StorageLayout["storage"][number] = {
    contract: "MyContract",
    label,
    offset: 0,
    slot: "0",
    type: typeId,
    src: "",
  };
  if (extra?.renamedFrom !== undefined) item.renamedFrom = extra.renamedFrom;
  return {
    storage: [item],
    types: { t_uint256: T_U256, t_address: T_ADDR },
  };
}

/**
 * Namespace-only layout.  Items are placed in layout.namespaces[nsId] with
 * contract = "namespace:" + nsId, which makes OZ set the same prefix on
 * op.original.contract so that namespaceIdFromOp() can extract the nsId.
 *
 * Note: do NOT set renamedFrom on namespace items when testing rename
 * detection: renamedFrom auto-approves same-contract renames (no op
 * emitted).  Slot-based matching (same slot, different label) is used
 * instead, which does produce a rename op.
 */
function nsLayout(
  nsId: string,
  items: Array<{ label: string; typeId: "t_uint256" | "t_uint128" }>,
): StorageLayout {
  return {
    storage: [],
    types: { t_uint256: T_U256, t_uint128: T_U128 },
    namespaces: {
      [nsId]: items.map(({ label, typeId }) => ({
        contract: `namespace:${nsId}`,
        label,
        offset: 0,
        slot: "0",
        type: typeId,
        src: "",
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Namespace-level variable-renamed suppression
// ---------------------------------------------------------------------------

describe("namespace-level variable-renamed suppression", () => {
  const NS = "erc7201:test.v1";
  // Use slot-based rename detection (same slot, different label) rather than
  // renamedFrom: renamedFrom auto-approves same-contract renames in OZ.
  const oldLayout = nsLayout(NS, [{ label: "value", typeId: "t_uint256" }]);
  const newLayout = nsLayout(NS, [{ label: "renamedValue", typeId: "t_uint256" }]);

  it("reports variable-renamed error when no unsafe-allow is set", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "variable-renamed")).toBe(true);
  });

  it("suppresses the error with namespaceUnsafeAllow for the matching namespace", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout, {
      namespaceUnsafeAllow: new Map([[NS, ["variable-renamed"]]]),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does NOT suppress when namespaceUnsafeAllow targets a different namespace", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout, {
      namespaceUnsafeAllow: new Map([["erc7201:other.ns", ["variable-renamed"]]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "variable-renamed")).toBe(true);
  });

  it("suppresses via global unsafeAllow as well", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout, {
      unsafeAllow: ["variable-renamed"],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Namespace-level type-changed suppression
// ---------------------------------------------------------------------------

describe("namespace-level type-changed suppression", () => {
  const NS = "erc7201:test.v1";
  // uint256 → uint128 is a size-changing type change: NOT suppressed by the
  // same-size layoutchange shortcut, so it reaches our type-changed handling.
  const oldLayout = nsLayout(NS, [{ label: "value", typeId: "t_uint256" }]);
  const newLayout = nsLayout(NS, [{ label: "value", typeId: "t_uint128" }]);

  it("reports type-changed error when no unsafe-allow is set", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });

  it("suppresses the error with namespaceUnsafeAllow for the matching namespace", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout, {
      namespaceUnsafeAllow: new Map([[NS, ["type-changed"]]]),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does NOT suppress when namespaceUnsafeAllow targets a different namespace", () => {
    const result = validateStorageUpgrade("C", oldLayout, newLayout, {
      namespaceUnsafeAllow: new Map([["erc7201:other.ns", ["type-changed"]]]),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global vs namespace vs per-variable precedence
//
// Use type changes rather than renames: OZ auto-approves renames on regular
// storage items when renamedFrom is set (no op emitted), but type changes
// are always detected.  This gives reliable mixed-scope errors to suppress.
// ---------------------------------------------------------------------------

describe("unsafe-allow precedence: global vs namespace vs per-variable", () => {
  const NS = "erc7201:test.v1";

  // Old: regular uint256 "a" + namespace uint256 "x"
  const oldMixed: StorageLayout = {
    storage: [
      {
        contract: "A",
        label: "a",
        offset: 0,
        slot: "0",
        type: "t_uint256",
        src: "",
      },
    ],
    types: { t_uint256: T_U256, t_uint128: T_U128 },
    namespaces: {
      [NS]: [
        {
          contract: `namespace:${NS}`,
          label: "x",
          offset: 0,
          slot: "0",
          type: "t_uint256",
          src: "",
        },
      ],
    },
  };

  // New: regular uint128 "a" (type changed) + namespace uint128 "x" (type changed)
  const newMixed: StorageLayout = {
    storage: [
      {
        contract: "A",
        label: "a",
        offset: 0,
        slot: "0",
        type: "t_uint128",
        src: "",
      },
    ],
    types: { t_uint256: T_U256, t_uint128: T_U128 },
    namespaces: {
      [NS]: [
        {
          contract: `namespace:${NS}`,
          label: "x",
          offset: 0,
          slot: "0",
          type: "t_uint128",
          src: "",
        },
      ],
    },
  };

  it("both regular and namespace type changes error without unsafe-allow", () => {
    const result = validateStorageUpgrade("C", oldMixed, newMixed);
    expect(result.ok).toBe(false);
    const typeErrors = result.errors.filter((e) => e.kind === "type-changed");
    // At least one from regular storage and one from namespace.
    expect(typeErrors.length).toBeGreaterThanOrEqual(2);
  });

  it("global unsafeAllow suppresses all type changes", () => {
    const result = validateStorageUpgrade("C", oldMixed, newMixed, {
      unsafeAllow: ["type-changed"],
    });
    expect(result.ok).toBe(true);
    expect(result.errors.filter((e) => e.kind === "type-changed")).toHaveLength(0);
  });

  it("namespaceUnsafeAllow suppresses only the namespace type change, not the regular one", () => {
    const result = validateStorageUpgrade("C", oldMixed, newMixed, {
      namespaceUnsafeAllow: new Map([[NS, ["type-changed"]]]),
    });
    expect(result.ok).toBe(false);
    const typeErrors = result.errors.filter((e) => e.kind === "type-changed");
    // Regular type-change still present; namespace suppressed.
    expect(typeErrors.some((e) => e.kind === "type-changed" && e.label === "a")).toBe(true);
    expect(typeErrors.some((e) => e.kind === "type-changed" && e.label === "x")).toBe(false);
  });

  it("perVariableUnsafeAllow suppresses only the named regular variable", () => {
    // Two regular variables with type changes; only one is suppressed.
    const oldTwo: StorageLayout = {
      storage: [
        {
          contract: "A",
          label: "alpha",
          offset: 0,
          slot: "0",
          type: "t_uint256",
          src: "",
        },
        {
          contract: "A",
          label: "beta",
          offset: 0,
          slot: "1",
          type: "t_uint256",
          src: "",
        },
      ],
      types: { t_uint256: T_U256, t_uint128: T_U128 },
    };
    const newTwo: StorageLayout = {
      storage: [
        {
          contract: "A",
          label: "alpha",
          offset: 0,
          slot: "0",
          type: "t_uint128",
          src: "",
        },
        {
          contract: "A",
          label: "beta",
          offset: 0,
          slot: "1",
          type: "t_uint128",
          src: "",
        },
      ],
      types: { t_uint256: T_U256, t_uint128: T_U128 },
    };
    const result = validateStorageUpgrade("C", oldTwo, newTwo, {
      perVariableUnsafeAllow: new Map([["alpha", ["type-changed"]]]),
    });
    expect(result.ok).toBe(false);
    const typeErrors = result.errors.filter((e) => e.kind === "type-changed");
    // "alpha" suppressed; "beta" still errors.
    expect(typeErrors.some((e) => e.kind === "type-changed" && e.label === "alpha")).toBe(false);
    expect(typeErrors.some((e) => e.kind === "type-changed" && e.label === "beta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-place upgrade: same contract name (same `contract` field in both layouts)
//
// Simulates the real-world case where a deployed contract is upgraded in-place:
// the old baseline and the newly compiled layout share the same contract name.
// ---------------------------------------------------------------------------

describe("in-place upgrade: same contract name", () => {
  it("detects type change (uint256 → address, same label)", () => {
    const old = regularLayout("abc", "t_uint256");
    const updated = regularLayout("abc", "t_address");

    const result = validateStorageUpgrade("MyContract", old, updated);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  });

  it("detects rename without annotation", () => {
    const old = regularLayout("abc", "t_uint256");
    const updated = regularLayout("xyz", "t_uint256");

    const result = validateStorageUpgrade("MyContract", old, updated);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts rename with correct renamedFrom annotation", () => {
    const old = regularLayout("abc", "t_uint256");
    const updated = regularLayout("xyz", "t_uint256", { renamedFrom: "abc" });

    const result = validateStorageUpgrade("MyContract", old, updated);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects rename with wrong renamedFrom annotation", () => {
    const old = regularLayout("abc", "t_uint256");
    // renamedFrom points to a label that does not exist in the old layout
    const updated = regularLayout("xyz", "t_uint256", { renamedFrom: "wrong" });

    const result = validateStorageUpgrade("MyContract", old, updated);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
