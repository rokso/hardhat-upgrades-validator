/**
 * Edge cases that need control over the report OZ's getStorageUpgradeReport
 * returns. Real layout-based tests live in test/validator.test.ts.
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

describe("OZ's report decides", () => {
  it("fails on an op kind this package has never seen (fail closed)", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ok: false,
      pass: false,
      ops: [{ kind: "some-future-op" }],
      explain: () => "future op",
    } as never);
    const r = validateStorageUpgrade("C", LAYOUT, LAYOUT);
    expect(r.ok).toBe(false);
  });

  it("passes only when OZ reports ok", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({
      ok: true,
      pass: true,
      ops: [],
      explain: () => "",
    } as never);
    expect(validateStorageUpgrade("C", LAYOUT, LAYOUT).ok).toBe(true);
  });

  it("passes the proxy kind and unsafeAllowRenames through to OZ", () => {
    vi.mocked(getStorageUpgradeReport).mockReturnValue({ ok: true, ops: [] } as never);
    validateStorageUpgrade("C", LAYOUT, LAYOUT, { kind: "uups", unsafeAllowRenames: true });
    expect(getStorageUpgradeReport).toHaveBeenCalledWith(
      LAYOUT,
      LAYOUT,
      expect.objectContaining({ kind: "uups", unsafeAllowRenames: true }),
    );
  });
});
