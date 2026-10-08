/**
 * Unit tests for validateStorageUpgrade, withSafetyErrors and
 * formatValidationResult. The verdict is OZ's storage comparison; these tests
 * pin that we pass it through and do not weaken it.
 *
 * Uses synthetic StorageLayout objects (no compiled fixtures required).
 */
import { describe, it, expect } from "vitest";
import {
  validateStorageUpgrade,
  withSafetyErrors,
  formatValidationResult,
} from "../src/core/validator.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";
import type { SafetyError, UnsafeAllowKind } from "../src/types/validation.js";
import { layout, u256, u128, u160, addr } from "./helpers/layout-builder.js";

const T_U256 = { label: "uint256", numberOfBytes: "32" };
const T_U128 = { label: "uint128", numberOfBytes: "16" };

function withRenamedFrom(l: StorageLayout, label: string, from: string): StorageLayout {
  l.storage.find((s) => s.label === label)!.renamedFrom = from;
  return l;
}

function withRetypedFrom(l: StorageLayout, label: string, from: string): StorageLayout {
  l.storage.find((s) => s.label === label)!.retypedFrom = from;
  return l;
}

function nsLayout(
  nsId: string,
  items: Array<{ label: string; typeId: "t_uint256" | "t_uint128"; renamedFrom?: string }>,
): StorageLayout {
  return {
    storage: [],
    types: { t_uint256: T_U256, t_uint128: T_U128 },
    namespaces: {
      [nsId]: items.map(({ label, typeId, renamedFrom }, i) => ({
        contract: `namespace:${nsId}`,
        label,
        offset: 0,
        slot: String(i),
        type: typeId,
        src: "",
        ...(renamedFrom !== undefined ? { renamedFrom } : {}),
      })),
    },
  };
}

const opKinds = (r: ReturnType<typeof validateStorageUpgrade>) =>
  (r.storage?.ops ?? []).map((op) => op.kind);

describe("validateStorageUpgrade: OZ storage verdict", () => {
  it("passes an append", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u256("a"), u256("b")));
    expect(r.ok).toBe(true);
    expect(r.storage?.ok).toBe(true);
  });

  it("fails a removal", () => {
    const r = validateStorageUpgrade("C", layout(u256("a"), u256("b")), layout(u256("a")));
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["delete"]);
  });

  it("fails an insertion in the middle", () => {
    const r = validateStorageUpgrade(
      "C",
      layout(u256("a"), u256("b")),
      layout(u256("a"), u256("x"), u256("b")),
    );
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toContain("insert");
  });

  it("fails a type change", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u128("a")));
    expect(r.ok).toBe(false);
  });

  it("fails a rename without oz-renamed-from", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u256("b")));
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["rename"]);
  });

  it("passes a rename approved with renamedFrom", () => {
    const r = validateStorageUpgrade(
      "C",
      layout(u256("a")),
      withRenamedFrom(layout(u256("b")), "b", "a"),
    );
    expect(r.ok).toBe(true);
  });

  it("fails a rename whose renamedFrom names another variable", () => {
    const r = validateStorageUpgrade(
      "C",
      layout(u256("a")),
      withRenamedFrom(layout(u256("b")), "b", "other"),
    );
    expect(r.ok).toBe(false);
  });

  it("passes any rename with unsafeAllowRenames (OZ's option)", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u256("b")), {
      unsafeAllowRenames: true,
    });
    expect(r.ok).toBe(true);
  });

  it("passes uint160 -> address with retypedFrom (same size, slot known)", () => {
    const r = validateStorageUpgrade(
      "C",
      layout(u160("owner")),
      withRetypedFrom(layout(addr("owner")), "owner", "uint160"),
    );
    expect(r.ok).toBe(true);
  });

  it("fails a size change even with retypedFrom", () => {
    const r = validateStorageUpgrade(
      "C",
      layout(u256("a"), u256("b")),
      withRetypedFrom(layout(u128("a"), u256("b")), "a", "uint256"),
    );
    expect(r.ok).toBe(false);
  });

  it("fails a removed namespace", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const r = validateStorageUpgrade("C", old, { storage: [], types: {}, namespaces: {} });
    expect(r.ok).toBe(false);
    expect(opKinds(r)).toEqual(["delete-namespace"]);
  });

  it("fails a namespace member rename without renamedFrom, passes with it", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const untagged = nsLayout("erc7201:a", [{ label: "y", typeId: "t_uint256" }]);
    const tagged = nsLayout("erc7201:a", [{ label: "y", typeId: "t_uint256", renamedFrom: "x" }]);
    expect(validateStorageUpgrade("C", old, untagged).ok).toBe(false);
    expect(validateStorageUpgrade("C", old, tagged).ok).toBe(true);
  });

  it("fails a namespace member type change", () => {
    const old = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint256" }]);
    const changed = nsLayout("erc7201:a", [{ label: "x", typeId: "t_uint128" }]);
    expect(validateStorageUpgrade("C", old, changed).ok).toBe(false);
  });
});

describe("validateStorageUpgrade: no baseline and skip", () => {
  it("passes with a no-baseline warning when there is no old layout", () => {
    const r = validateStorageUpgrade("C", undefined, layout(u256("a")));
    expect(r.ok).toBe(true);
    expect(r.storage).toBeUndefined();
    expect(r.warnings).toEqual([{ kind: "no-baseline", contractName: "C" }]);
  });

  it("skips the comparison with unsafeSkipStorageCheck", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u128("a")), {
      unsafeSkipStorageCheck: true,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([{ kind: "storage-check-skipped", contractName: "C" }]);
  });
});

describe("validateStorageUpgrade: option checks", () => {
  it("rejects an unsafe-allow value that is not an OZ error kind", () => {
    expect(() =>
      validateStorageUpgrade("C", layout(u256("a")), layout(u256("a")), {
        unsafeAllow: ["type-changed" as UnsafeAllowKind],
      }),
    ).toThrow(/Unknown unsafe-allow value\(s\): type-changed/);
  });

  it("accepts every OZ error kind", () => {
    expect(() =>
      validateStorageUpgrade("C", layout(u256("a")), layout(u256("a")), {
        unsafeAllow: ["missing-initializer", "missing-public-upgradeto"],
      }),
    ).not.toThrow();
  });

  it("rejects an unknown proxy kind", () => {
    expect(() =>
      validateStorageUpgrade("C", layout(u256("a")), layout(u256("a")), {
        kind: "diamond" as never,
      }),
    ).toThrow(/Invalid proxy kind/);
  });
});

const CONSTRUCTOR_ERROR = {
  kind: "constructor",
  contract: "C",
  src: "contracts/C.sol:5",
} as SafetyError;

describe("withSafetyErrors", () => {
  it("fails a passing storage result when there is a safety error", () => {
    const r = withSafetyErrors(validateStorageUpgrade("C", layout(u256("a")), layout(u256("a"))), [
      CONSTRUCTOR_ERROR,
    ]);
    expect(r.ok).toBe(false);
    expect(r.safetyErrors).toEqual([CONSTRUCTOR_ERROR]);
  });

  it("fails even without a baseline", () => {
    const r = withSafetyErrors(validateStorageUpgrade("C", undefined, layout(u256("a"))), [
      CONSTRUCTOR_ERROR,
    ]);
    expect(r.ok).toBe(false);
  });

  it("keeps a passing result when there are no safety errors", () => {
    const r = withSafetyErrors(
      validateStorageUpgrade("C", layout(u256("a")), layout(u256("a"))),
      [],
    );
    expect(r.ok).toBe(true);
  });
});

describe("formatValidationResult", () => {
  it("prints one OK line for a clean pass", () => {
    const r = validateStorageUpgrade("C", layout(u256("a")), layout(u256("a")));
    expect(formatValidationResult("net/C", r)).toBe(
      '  [OK]   "net/C": storage layout validation passed.',
    );
  });

  it("prints OZ's explanation for a storage failure", () => {
    const r = validateStorageUpgrade("C", layout(u256("a"), u256("b")), layout(u256("a")));
    const text = formatValidationResult("net/C", r);
    expect(text).toContain('StorageLayoutError: Storage layout validation failed for "net/C"');
    expect(text).toContain("Deleted `b`");
  });

  it("prints OZ's explanation for a safety error", () => {
    const r = withSafetyErrors(validateStorageUpgrade("C", layout(u256("a")), layout(u256("a"))), [
      CONSTRUCTOR_ERROR,
    ]);
    const text = formatValidationResult("net/C", r);
    expect(text).toContain("contracts/C.sol:5");
    expect(text).toContain("Contract `C` has a constructor");
  });

  it("prints the no-baseline note", () => {
    const r = validateStorageUpgrade("C", undefined, layout(u256("a")));
    expect(formatValidationResult("net/C", r)).toContain('No prior deployment found for "C"');
  });
});

describe("UNSAFE_ALLOW_KINDS", () => {
  it("matches the error kinds of the installed upgrades-core", async () => {
    // errorKinds is not exported from upgrades-core's index; read it from its module.
    const { errorKinds } = (await import("@openzeppelin/upgrades-core/dist/validate/run.js")) as {
      errorKinds: readonly string[];
    };
    const { UNSAFE_ALLOW_KINDS } = await import("../src/types/validation.js");
    expect([...UNSAFE_ALLOW_KINDS].sort()).toEqual([...errorKinds].sort());
  });
});
