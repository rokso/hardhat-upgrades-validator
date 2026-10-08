/**
 * getContractBuildData must fail closed: once a contract is found in the
 * ValidationData, a failure in OZ's safety check propagates instead of
 * turning into "no safety errors".
 */

import { describe, it, expect, vi } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@openzeppelin/upgrades-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@openzeppelin/upgrades-core")>();
  return {
    ...orig,
    getErrors: vi.fn(() => {
      throw new Error("getErrors exploded");
    }),
  };
});

import {
  getContractBuildData,
  createBuildInfoOutputCache,
} from "../src/plugin/internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../src/plugin/internals/validations-cache.js";
import { makeFixtureArtifacts } from "./helpers/fixture-artifacts.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("getContractBuildData fails closed", () => {
  it("propagates a failure in OZ's getErrors", async () => {
    const validations = await loadValidationsFromDisk(join(FIXTURES_DIR, "cache"));
    expect(validations).toBeDefined();
    await expect(
      getContractBuildData(
        "V1",
        makeFixtureArtifacts(FIXTURES_DIR),
        validations,
        createBuildInfoOutputCache(),
      ),
    ).rejects.toThrow("getErrors exploded");
  });
});
