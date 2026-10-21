/**
 * Unit tests for validateStorageUpgrade, validateUpgrade and
 * formatValidationResult. The verdict is OZ's storage comparison; these tests
 * pin that we pass it through and do not weaken it.
 *
 * Uses synthetic StorageLayout objects (no compiled fixtures required).
 */
import { describe, it, expect } from "vitest";
import {
  validateStorageUpgrade,
  validateUpgrade,
  validateRecordUpgrade,
  formatValidationResult,
} from "../src/core/validator.js";
import type { StorageLayout } from "@openzeppelin/upgrades-core";
// slotdiff checks each slot against the ERC-7201 formula, so the tests use it too.
import { calculateERC7201StorageLocation } from "@openzeppelin/upgrades-core/dist/utils/erc7201.js";
import type { NamespaceSlot } from "slotdiff";
import { fakeAnalysis } from "./helpers/analysis.js";
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

const constructorError = { kind: "constructor" as const, src: "contracts/C.sol:5" };

describe("validateUpgrade: safety rules", () => {
  it("fails a passing storage result when the safety check reports an error", () => {
    const next = fakeAnalysis(layout(u256("a")), { safetyErrors: [constructorError] });
    const r = validateUpgrade("C", { layout: layout(u256("a")) }, next);
    expect(r.storage?.ok).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.safetyErrors.map((e) => e.kind)).toEqual(["constructor"]);
  });

  it("checks safety even without a baseline (a first deployment)", () => {
    const next = fakeAnalysis(layout(u256("a")), { safetyErrors: [constructorError] });
    const r = validateUpgrade("C", undefined, next);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual([{ kind: "no-baseline", contractName: "C" }]);
  });

  it("with unsafeSkipStorageCheck, still checks safety and says storage was skipped", () => {
    const next = fakeAnalysis(layout(u128("a")), { safetyErrors: [constructorError] });
    const r = validateUpgrade("C", { layout: layout(u256("a")) }, next, {
      unsafeSkipStorageCheck: true,
    });
    expect(r.storage).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual([{ kind: "storage-check-skipped", contractName: "C" }]);
  });

  it("honors unsafeAllow", () => {
    const next = fakeAnalysis(layout(u256("a")), { safetyErrors: [constructorError] });
    const r = validateUpgrade("C", { layout: layout(u256("a")) }, next, {
      unsafeAllow: ["constructor"],
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateUpgrade: the proxy kind", () => {
  const kindUsed = (old: { kind?: "uups" | "transparent" | "beacon" }, kind?: "beacon") => {
    const next = fakeAnalysis(layout(u256("a")), { kind: "transparent" });
    validateUpgrade("C", { layout: layout(u256("a")), ...old }, next, { kind });
    return next.safetyKinds;
  };

  it("is the baseline's, not the new code's", () => {
    expect(kindUsed({ kind: "uups" })).toEqual(["uups"]);
  });

  it("is the one given, over the baseline's", () => {
    expect(kindUsed({ kind: "uups" }, "beacon")).toEqual(["beacon"]);
  });

  it("is the new code's when the baseline does not know it, and says so", () => {
    expect(kindUsed({})).toEqual(["transparent"]);
    const r = validateUpgrade("C", { layout: layout(u256("a")) }, fakeAnalysis(layout(u256("a"))));
    expect(r.warnings).toEqual([
      { kind: "kind-from-new-code", contractName: "C", proxyKind: "transparent" },
    ]);
    expect(formatValidationResult("C", r)).toMatch(/lost its upgrade function would pass/);
  });

  it("does not warn about the kind when the baseline or the caller gives it", () => {
    const next = () => fakeAnalysis(layout(u256("a")));
    expect(
      validateUpgrade("C", { layout: layout(u256("a")), kind: "uups" }, next()).warnings,
    ).toEqual([]);
    expect(
      validateUpgrade("C", { layout: layout(u256("a")) }, next(), { kind: "uups" }).warnings,
    ).toEqual([]);
  });
});

describe("validateUpgrade: ERC-7201 namespaces by slot", () => {
  const loc = (id: string) => calculateERC7201StorageLocation(id);
  const slot = (id: string, actual = loc(id)): NamespaceSlot => ({
    namespace: `erc7201:${id}`,
    expected: loc(id),
    actual,
    status: actual === loc(id) ? "match" : "mismatch",
  });
  const ns = (id: string) => nsLayout(`erc7201:${id}`, [{ label: "a", typeId: "t_uint256" }]);

  it("passes a corrected annotation over an unchanged slot, which OZ alone reports as deleted", () => {
    // The deployed code used the slot of `vault.main` under a wrong annotation.
    const old = { layout: ns("vault.old"), namespaces: [slot("vault.old", loc("vault.main"))] };
    const next = fakeAnalysis(ns("vault.main"), { namespaces: [slot("vault.main")] });

    expect(validateStorageUpgrade("C", old.layout, next.layout).ok).toBe(false);
    const r = validateUpgrade("C", old, next);
    expect(r.ok).toBe(true);
    expect(r.namespaces?.result).toBe("pass");
  });

  it("fails a namespace whose slot moved under an unchanged annotation", () => {
    const old = { layout: ns("vault.main"), namespaces: [slot("vault.main")] };
    const next = fakeAnalysis(ns("vault.main"), {
      namespaces: [slot("vault.main", loc("vault.other"))],
    });

    const r = validateUpgrade("C", old, next);
    expect(r.storage?.ok).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.namespaces?.result).toBe("fail");
    expect(formatValidationResult("C", r)).toContain("vault.main");
  });

  it("fails a namespace whose slot cannot be read from the new code", () => {
    // Not knowing where the new code puts the data is no pass.
    const unread: NamespaceSlot = { ...slot("vault.main"), actual: undefined, status: "unread" };
    const old = {
      layout: ns("vault.main"),
      namespaces: [slot("vault.main")],
      kind: "uups" as const,
    };
    const r = validateUpgrade("C", old, fakeAnalysis(ns("vault.main"), { namespaces: [unread] }));
    expect(r.ok).toBe(false);
    expect(formatValidationResult("C", r)).toMatch(/the code does not show it/);
  });

  it("fails a namespace whose slot the deployed code's record could not read", () => {
    const unread: NamespaceSlot = { ...slot("vault.main"), actual: undefined, status: "unread" };
    const old = { layout: ns("vault.main"), namespaces: [unread], kind: "uups" as const };
    const r = validateUpgrade(
      "C",
      old,
      fakeAnalysis(ns("vault.main"), { namespaces: [slot("vault.main")] }),
    );
    expect(r.ok).toBe(false);
  });

  it("between records, warns about the new record when it is the one without slots", () => {
    const old = { layout: ns("vault.main"), namespaces: [slot("vault.main")] };
    const r = validateRecordUpgrade("C", old, { layout: ns("vault.main") });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        kind: "namespaces-unchecked",
        reason: expect.stringMatching(/^the new implementation's record has no recorded/),
      }),
    ]);
  });

  it("between records, fails a deployed slot off its annotation when the new record has no slots", () => {
    // Following the annotation now would move the data.
    const old = { layout: ns("vault.b"), namespaces: [slot("vault.b", loc("vault.q"))] };
    const r = validateRecordUpgrade("C", old, { layout: ns("vault.b") });
    expect(r.ok).toBe(false);
    expect(formatValidationResult("C", r)).toMatch(/deployed slot is off its annotation/);
  });

  it("between records, passes an unused deployed namespace when the new record has no slots", () => {
    const unused: NamespaceSlot = {
      namespace: "erc7201:vault.main",
      expected: loc("vault.main"),
      status: "unused",
    };
    const r = validateRecordUpgrade(
      "C",
      { layout: ns("vault.main"), namespaces: [unused] },
      {
        layout: ns("vault.main"),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.kind)).toEqual(["namespaces-unchecked"]);
  });

  it("fails a namespace missing from a baseline that has slots", () => {
    // A record with slots lists every namespace; a missing one is not a legacy record.
    const next = fakeAnalysis(ns("vault.main"), { namespaces: [slot("vault.main")] });
    expect(validateUpgrade("C", { layout: ns("vault.main"), namespaces: [] }, next).ok).toBe(false);
  });

  it("between records, fails a namespace missing from a new record that has slots", () => {
    const old = { layout: ns("vault.main"), namespaces: [slot("vault.main")] };
    const r = validateRecordUpgrade("C", old, { layout: ns("vault.main"), namespaces: [] });
    expect(r.ok).toBe(false);
  });

  it("compares by annotation and warns when the baseline has no slots", () => {
    const next = fakeAnalysis(ns("vault.main"), { namespaces: [slot("vault.main")] });

    const r = validateUpgrade("C", { layout: ns("vault.main"), kind: "transparent" }, next);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      expect.objectContaining({ kind: "namespaces-unchecked", contractName: "C" }),
    ]);
    expect(formatValidationResult("C", r)).toMatch(/compared by annotation only.*--force/);
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
    const next = fakeAnalysis(layout(u256("a")), { safetyErrors: [CONSTRUCTOR_ERROR as never] });
    const r = validateUpgrade("C", { layout: layout(u256("a")) }, next);
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
  it("is the installed upgrades-core's error kinds, less the two it never reports", async () => {
    // errorKinds is not exported from upgrades-core's index; read it from its module.
    const { errorKinds } = (await import("@openzeppelin/upgrades-core/dist/validate/run.js")) as {
      errorKinds: readonly string[];
    };
    const { UNSAFE_ALLOW_KINDS } = await import("../src/types/validation.js");
    const reported = errorKinds.filter((k) => k !== "struct-definition" && k !== "enum-definition");
    expect([...UNSAFE_ALLOW_KINDS].sort()).toEqual([...reported].sort());
  });
});
