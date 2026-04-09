/**
 * Integration tests for the annotation pipeline.
 *
 * Uses committed compilation output from test/fixtures/ (real solc AST and
 * ValidationData) to verify getContractBuildData, extractAnnotationMaps,
 * embedAnnotations, and validateStorageUpgrade together.
 *
 * To regenerate the fixture output after changing contracts:
 *   pnpm run fixtures
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import {
  getContractBuildData,
  extractAnnotationMaps,
  createBuildInfoOutputCache,
  type BuildInfoParsed,
} from "../src/plugin/internals/deployment-utils.js";
import { loadValidationsFromDisk } from "../src/plugin/internals/validations-cache.js";
import { validateStorageUpgrade } from "../src/core/validator.js";
import { makeFixtureArtifacts } from "./helpers/fixture-artifacts.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CACHE_DIR = join(FIXTURES_DIR, "cache");

const artifacts = makeFixtureArtifacts(FIXTURES_DIR);

let validations: ValidationDataCurrent | undefined;

beforeAll(async () => {
  validations = await loadValidationsFromDisk(CACHE_DIR);
  if (!validations) {
    throw new Error("Fixture validations.json not found. Run `pnpm run fixtures` to generate it.");
  }
});

// ---------------------------------------------------------------------------
// getContractBuildData
// ---------------------------------------------------------------------------

describe("getContractBuildData", () => {
  it("resolves V1 storage layout with all namespace members", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V1", artifacts, validations, cache);

    const ns = data.upgradeStorageLayout?.namespaces?.["erc7201:upgrades.test.v1"];
    expect(ns).toBeDefined();
    expect(ns?.map((m) => m.label)).toEqual(
      expect.arrayContaining(["value", "counter", "rawOwner", "active"]),
    );
  });

  it("embeds renamedFrom on namespace member", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2", artifacts, validations, cache);

    const ns = data.upgradeStorageLayout?.namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "newValue");
    expect(member?.renamedFrom).toBe("value");
    expect(member?.retypedFrom).toBeUndefined();
  });

  it("embeds retypedFrom on namespace member", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2", artifacts, validations, cache);

    const ns = data.upgradeStorageLayout?.namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "counter");
    expect(member?.retypedFrom).toBe("uint256");
    expect(member?.renamedFrom).toBeUndefined();
  });

  it("embeds both renamedFrom and retypedFrom on a stacked namespace member", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2", artifacts, validations, cache);

    const ns = data.upgradeStorageLayout?.namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "owner");
    expect(member?.renamedFrom).toBe("rawOwner");
    expect(member?.retypedFrom).toBe("uint160");
  });

  it("embeds renamedFrom on a regular state variable", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2", artifacts, validations, cache);

    const item = data.upgradeStorageLayout?.storage.find((s) => s.label === "data");
    expect(item?.renamedFrom).toBe("legacyData");
  });

  it("embeds retypedFrom on a regular state variable", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2", artifacts, validations, cache);

    const item = data.upgradeStorageLayout?.storage.find((s) => s.label === "rawConfig");
    expect(item?.retypedFrom).toBe("uint256");
    expect(item?.renamedFrom).toBeUndefined();
  });

  it("leaves annotations undefined when no annotation is present", async () => {
    const cache = createBuildInfoOutputCache();
    const data = await getContractBuildData("V2Broken", artifacts, validations, cache);

    const ns = data.upgradeStorageLayout?.namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "newValue");
    expect(member?.renamedFrom).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateStorageUpgrade
// ---------------------------------------------------------------------------

describe("validateStorageUpgrade", () => {
  it("accepts V1→V2 upgrade when unannotated rename is globally allowed", async () => {
    const cache = createBuildInfoOutputCache();
    const v1 = await getContractBuildData("V1", artifacts, validations, cache);
    const v2 = await getContractBuildData("V2", artifacts, validations, cache);

    const result = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        unsafeAllow: ["variable-renamed"],
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects V1→V2Broken upgrade when rename annotation is missing", async () => {
    const cache = createBuildInfoOutputCache();
    const v1 = await getContractBuildData("V1", artifacts, validations, cache);
    const v2 = await getContractBuildData("V2Broken", artifacts, validations, cache);

    const result = validateStorageUpgrade("V1", v1.upgradeStorageLayout!, v2.upgradeStorageLayout!);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "variable-renamed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractAnnotationMaps — cross-file inheritance
// ---------------------------------------------------------------------------

async function loadParsedBuildInfo(contractName: string): Promise<{
  parsed: BuildInfoParsed;
  winnerSource: string;
}> {
  const artifact = await artifacts.readArtifact(contractName);
  const buildInfoId = await artifacts.getBuildInfoId(contractName);
  if (!buildInfoId) throw new Error(`No buildInfoId for ${contractName}`);
  const outputPath = await artifacts.getBuildInfoOutputPath(buildInfoId);
  if (!outputPath) throw new Error(`No build-info output for ${buildInfoId}`);

  const rawBuildInfo = JSON.parse(await readFile(outputPath, "utf8")) as {
    output?: { contracts?: unknown; sources?: unknown };
  };

  const parsed: BuildInfoParsed = {
    contracts: (rawBuildInfo.output?.contracts ?? {}) as BuildInfoParsed["contracts"],
    sources: (rawBuildInfo.output?.sources ?? {}) as BuildInfoParsed["sources"],
  };

  const artifactSource = artifact.sourceName;
  const winnerSource =
    Object.keys(parsed.contracts).find(
      (k) => k === artifactSource || k.endsWith("/" + artifactSource),
    ) ?? artifactSource;

  return { parsed, winnerSource };
}

describe("extractAnnotationMaps", () => {
  it("discovers struct annotation from a base contract defined in a different file", async () => {
    const { parsed, winnerSource } = await loadParsedBuildInfo("Multi");
    const maps = extractAnnotationMaps(parsed, "Multi", winnerSource);

    // BaseStorage is defined in MultiBase.sol, not Multi.sol.
    // Multi inherits MultiBase, so its linearizedBaseContracts includes
    // MultiBase's AST id. The AST deref must resolve that across files.
    const baseRenameMap = maps.namespaceMemberRenameAnnotations.get("erc7201:upgrades.test.base");
    expect(baseRenameMap).toBeDefined();
    expect(baseRenameMap?.get("baseNumber")).toBe("baseNum");
  });

  it("does not fabricate rename annotations for unannotated namespaces", async () => {
    const { parsed, winnerSource } = await loadParsedBuildInfo("Multi");
    const maps = extractAnnotationMaps(parsed, "Multi", winnerSource);

    // Multi.Storage has @custom:storage-location but no rename annotations.
    const multiRenameMap = maps.namespaceMemberRenameAnnotations.get("erc7201:upgrades.test.multi");
    expect(multiRenameMap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unsafe-allow annotations
// ---------------------------------------------------------------------------

describe("unsafe-allow annotations", () => {
  it("extracts per-variable unsafe-allow annotations", async () => {
    const cache = createBuildInfoOutputCache();
    const v2 = await getContractBuildData("V2", artifacts, validations, cache);

    expect(v2.perVariableUnsafeAllow.get("unsafeRenameTarget")).toEqual(["variable-renamed"]);
    expect(v2.perVariableUnsafeAllow.get("unsafeRenameTarget2")).toBeUndefined();
    expect(v2.perVariableUnsafeAllow.get("unsafeTypeSource")).toEqual(["type-changed"]);
  });

  it("applies variable-level unsafe-allow only to the annotated variable", async () => {
    const cache = createBuildInfoOutputCache();
    const v1 = await getContractBuildData("V1", artifacts, validations, cache);
    const v2 = await getContractBuildData("V2", artifacts, validations, cache);

    const withoutUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        perVariableUnsafeAllow: new Map(),
        namespaceUnsafeAllow: new Map(),
      },
    );
    expect(withoutUnsafeAllow.ok).toBe(false);
    expect(withoutUnsafeAllow.errors.some((e) => e.kind === "variable-renamed")).toBe(true);
    expect(withoutUnsafeAllow.errors.some((e) => e.kind === "type-changed")).toBe(true);

    const withUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(withUnsafeAllow.ok).toBe(false);

    const renameErrors = withUnsafeAllow.errors.filter((e) => e.kind === "variable-renamed");
    expect(renameErrors).toHaveLength(1);
    expect(renameErrors[0]).toMatchObject({
      kind: "variable-renamed",
      oldLabel: "unsafeRenameSource2",
      newLabel: "unsafeRenameTarget2",
    });

    expect(
      renameErrors.some(
        (e) => e.kind === "variable-renamed" && e.newLabel === "unsafeRenameTarget",
      ),
    ).toBe(false);
  });

  it("applies contract-level unsafe-allow type-changed to all type changes in the contract", async () => {
    const cache = createBuildInfoOutputCache();
    const v1 = await getContractBuildData("V1", artifacts, validations, cache);
    const v2 = await getContractBuildData(
      "V2ContractLevelAllowTypeChange",
      artifacts,
      validations,
      cache,
    );

    expect(v2.unsafeAllowFromAnnotation).toEqual(["type-changed"]);

    // Without passing the annotation-derived allow — type change must error.
    const withoutContractUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(withoutContractUnsafeAllow.ok).toBe(false);
    expect(withoutContractUnsafeAllow.errors.some((e) => e.kind === "type-changed")).toBe(true);

    // With the contract-level annotation applied — all type changes suppressed.
    const withContractUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        unsafeAllow: v2.unsafeAllowFromAnnotation,
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(withContractUnsafeAllow.ok).toBe(true);
    expect(withContractUnsafeAllow.errors.filter((e) => e.kind === "type-changed")).toHaveLength(0);
  });

  it("applies contract-level unsafe-allow to all renames in the contract", async () => {
    const cache = createBuildInfoOutputCache();
    const v1 = await getContractBuildData("V1", artifacts, validations, cache);
    const v2 = await getContractBuildData(
      "V2ContractLevelAllowRename",
      artifacts,
      validations,
      cache,
    );

    expect(v2.unsafeAllowFromAnnotation).toEqual(["variable-renamed"]);

    const withoutContractUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(withoutContractUnsafeAllow.ok).toBe(false);
    expect(withoutContractUnsafeAllow.errors.some((e) => e.kind === "variable-renamed")).toBe(true);

    const withContractUnsafeAllow = validateStorageUpgrade(
      "V1",
      v1.upgradeStorageLayout!,
      v2.upgradeStorageLayout!,
      {
        unsafeAllow: v2.unsafeAllowFromAnnotation,
        perVariableUnsafeAllow: v2.perVariableUnsafeAllow,
        namespaceUnsafeAllow: v2.namespaceUnsafeAllow,
      },
    );
    expect(withContractUnsafeAllow.ok).toBe(true);
    expect(withContractUnsafeAllow.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractAnnotationMaps — canonicalization edge cases (synthetic data)
// ---------------------------------------------------------------------------

describe("extractAnnotationMaps - canonicalization edge cases", () => {
  it("returns all-empty maps when winnerSource is absent from parsed.contracts", () => {
    const parsed: BuildInfoParsed = { contracts: {}, sources: {} };
    const maps = extractAnnotationMaps(parsed, "Token", "contracts/Token.sol");

    expect(maps.renameAnnotations.size).toBe(0);
    expect(maps.retypeAnnotations.size).toBe(0);
    expect(maps.perVariableUnsafeAllow.size).toBe(0);
    expect(maps.unsafeAllowFromAnnotation).toHaveLength(0);
    expect(maps.namespaceMemberRenameAnnotations.size).toBe(0);
    expect(maps.structMemberRenameAnnotations.size).toBe(0);
  });

  it("extracts devdoc annotations but returns empty namespace maps when sources have no AST", () => {
    const parsed: BuildInfoParsed = {
      contracts: {
        "contracts/Token.sol": {
          Token: {
            devdoc: {
              stateVariables: {
                value: { "custom:upgrades-validator-renamed-from": "oldValue" },
              },
            },
          },
        },
      },
      sources: {
        "contracts/Token.sol": {
          // no ast field — sourcesWithAst will be empty
        },
      },
    };

    const maps = extractAnnotationMaps(parsed, "Token", "contracts/Token.sol");

    // devdoc-based rename is still extracted
    expect(maps.renameAnnotations.get("value")).toBe("oldValue");
    // AST-based namespace and struct maps are empty
    expect(maps.namespaceMemberRenameAnnotations.size).toBe(0);
    expect(maps.structMemberRenameAnnotations.size).toBe(0);
  });

  it("skips unresolvable base contract IDs without throwing", () => {
    // linearizedBaseContracts includes ID 9999 which does not exist in the AST.
    // astDereferencer throws on lookup; the catch block should continue cleanly.
    const parsed: BuildInfoParsed = {
      contracts: { "contracts/Token.sol": { Token: {} } },
      sources: {
        "contracts/Token.sol": {
          ast: {
            nodeType: "SourceUnit",
            src: "0:100:0",
            id: 0,
            nodes: [
              {
                nodeType: "ContractDefinition",
                name: "Token",
                id: 1,
                src: "0:100:0",
                linearizedBaseContracts: [1, 9999],
                nodes: [],
              },
            ],
          },
        },
      },
    };

    expect(() => extractAnnotationMaps(parsed, "Token", "contracts/Token.sol")).not.toThrow();

    const maps = extractAnnotationMaps(parsed, "Token", "contracts/Token.sol");
    expect(maps.namespaceMemberRenameAnnotations.size).toBe(0);
    expect(maps.structMemberRenameAnnotations.size).toBe(0);
  });
});
