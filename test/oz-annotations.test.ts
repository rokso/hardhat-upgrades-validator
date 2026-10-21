/**
 * OZ's own NatSpec tags work through our pipeline.
 *
 * OzV2 approves each change from OzV1 with an OZ tag (`oz-renamed-from`,
 * `oz-retyped-from`, `oz-upgrades-unsafe-allow`, `-reachable`). OzV2NoTags
 * makes the same changes without tags and must fail, so a pass on OzV2 means
 * the tags were honored, not that nothing was checked.
 *
 * Uses the fixture project's build info (real solc output), analyzed as the
 * plugin does. Regenerate with `pnpm run fixtures`.
 */

import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpgrade } from "../src/core/validator.js";
import type { ProxyKind, UnsafeAllowKind } from "../src/types/validation.js";
import { makeFixtureAnalyzer } from "./helpers/fixture-artifacts.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const analyze = makeFixtureAnalyzer(FIXTURES_DIR);

// The deployed side, as a record made from its analysis holds it.
async function recorded(contract: string) {
  const { layout, namespaces, kind } = await analyze(contract);
  return { layout, namespaces, kind };
}

async function check(newContract: string) {
  return validateUpgrade(newContract, await recorded("OzV1"), await analyze(newContract));
}

async function safetyKinds(contract: string, kind?: ProxyKind, unsafeAllow?: UnsafeAllowKind[]) {
  const next = await analyze(contract);
  return next.safety({ kind: kind ?? next.kind, unsafeAllow }).errors.map((e) => e.kind);
}

describe("OZ-native tags", () => {
  it("OzV2 passes: every change is approved with an OZ tag", async () => {
    const result = await check("OzV2");
    expect(result.storage?.ok).toBe(true);
    expect(result.safetyErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("OzV2NoTags fails: the same changes without tags", async () => {
    const result = await check("OzV2NoTags");
    expect(result.ok).toBe(false);
    expect(result.storage?.ops.map((op) => op.kind).sort()).toEqual(["rename", "typechange"]);
    expect(result.safetyErrors.map((e) => e.kind).sort()).toEqual([
      "constructor",
      "delegatecall",
      "delegatecall",
      "state-variable-immutable",
    ]);
  });
});

// OZ's checks that alpha.1 silently dropped (it kept 6 of OZ's 14 error kinds).
describe("OZ checks beyond the original six", () => {
  it("fails a UUPS implementation without upgradeTo (missing-public-upgradeto)", async () => {
    expect(await safetyKinds("OzV1", "uups")).toEqual(["missing-public-upgradeto"]);
  });

  it("infers uups from an implementation that has upgradeToAndCall", async () => {
    const next = await analyze("UupsImpl");
    expect(next.kind).toBe("uups");
    expect(await safetyKinds("UupsImpl")).toEqual([]);
  });

  it("takes the proxy kind from the baseline: dropping upgradeTo from a UUPS proxy fails", async () => {
    // OzV1 has no upgrade function, so its own code reads as transparent and
    // would pass; the running implementation (UupsImpl) makes the proxy UUPS.
    const result = validateUpgrade("OzV1", await recorded("UupsImpl"), await analyze("OzV1"));
    expect(result.ok).toBe(false);
    expect(result.safetyErrors.map((e) => e.kind)).toContain("missing-public-upgradeto");
  });

  it("an explicit kind overrides the baseline's", async () => {
    const result = validateUpgrade("OzV1", await recorded("UupsImpl"), await analyze("OzV1"), {
      kind: "transparent",
    });
    expect(result.safetyErrors.map((e) => e.kind)).not.toContain("missing-public-upgradeto");
  });

  it("does not require upgradeTo for transparent proxies", async () => {
    expect(await safetyKinds("OzV1", "transparent")).toEqual([]);
  });

  it("fails an initializer that skips the parent's (missing-initializer-call)", async () => {
    expect(await safetyKinds("contracts/InitChecks.sol:InitMissingCall")).toEqual([
      "missing-initializer-call",
    ]);
  });

  it("passes an initializer that calls the parent's", async () => {
    expect(await safetyKinds("contracts/InitChecks.sol:InitCallsParent")).toEqual([]);
  });

  it("allows an OZ error kind through unsafeAllow", async () => {
    expect(
      await safetyKinds("contracts/InitChecks.sol:InitMissingCall", undefined, [
        "missing-initializer-call",
      ]),
    ).toEqual([]);
  });
});
