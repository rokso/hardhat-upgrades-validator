/**
 * OZ's own NatSpec tags work through our pipeline.
 *
 * OzV2 approves each change from OzV1 with an OZ tag (`oz-renamed-from`,
 * `oz-retyped-from`, `oz-upgrades-unsafe-allow`, `-reachable`). OzV2NoTags
 * makes the same changes without tags and must fail, so a pass on OzV2 means
 * the tags were honored, not that nothing was checked.
 *
 * Uses the compiled fixtures (real solc output and the compile hook's
 * ValidationData). Regenerate with `pnpm run fixtures`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import {
  getContractBuildData,
  createBuildInfoOutputCache,
} from "../src/plugin/internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../src/plugin/internals/validations-cache.js";
import { validateStorageUpgrade, withSafetyErrors } from "../src/core/validator.js";
import type { ProxyKind } from "../src/types/validation.js";
import { makeFixtureArtifacts } from "./helpers/fixture-artifacts.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const artifacts = makeFixtureArtifacts(FIXTURES_DIR);

let validations: ValidationDataCurrent | undefined;

beforeAll(async () => {
  validations = await loadValidationsFromDisk(join(FIXTURES_DIR, "cache"));
  if (!validations) {
    throw new Error("Fixture validations.json not found. Run `pnpm run fixtures` to generate it.");
  }
});

async function check(newContract: string) {
  const cache = createBuildInfoOutputCache();
  const old = await getContractBuildData("OzV1", artifacts, validations, cache);
  const next = await getContractBuildData(newContract, artifacts, validations, cache);
  return withSafetyErrors(
    validateStorageUpgrade(newContract, old.upgradeStorageLayout, next.upgradeStorageLayout!, {
      kind: next.proxyKind,
    }),
    next.safetyErrors,
  );
}

async function safetyKinds(contract: string, kind?: ProxyKind) {
  const data = await getContractBuildData(
    contract,
    artifacts,
    validations,
    createBuildInfoOutputCache(),
    { kind },
  );
  return data.safetyErrors.map((e) => e.kind);
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
    const data = await getContractBuildData(
      "UupsImpl",
      artifacts,
      validations,
      createBuildInfoOutputCache(),
    );
    expect(data.proxyKind).toBe("uups");
    expect(data.safetyErrors).toEqual([]);
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
    const data = await getContractBuildData(
      "contracts/InitChecks.sol:InitMissingCall",
      artifacts,
      validations,
      createBuildInfoOutputCache(),
      { unsafeAllow: ["missing-initializer-call"] },
    );
    expect(data.safetyErrors).toEqual([]);
  });
});
