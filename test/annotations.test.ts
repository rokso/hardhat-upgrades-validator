/**
 * Integration tests for rename/retype annotations.
 *
 * State variables use OZ's own tags (`@custom:oz-renamed-from`,
 * `@custom:oz-retyped-from`), which OZ extracts. Struct members use our one
 * extension (`@custom:upgrades-validator-renamed-from <old> <member>` and
 * `-retyped-from <oldType> <member>` on the struct), for both ERC-7201
 * namespace structs and plain structs.
 *
 * Uses committed compilation output from test/fixtures/ (real solc AST and
 * ValidationData). To regenerate the fixture output after changing contracts:
 *   pnpm run fixtures
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageLayout, ValidationDataCurrent } from "@openzeppelin/upgrades-core";
import {
  getContractBuildData,
  createBuildInfoOutputCache,
  type BuildInfoParsed,
} from "../src/plugin/internals/deployment-utils.js";
import { extractStructMemberAnnotations } from "../src/plugin/internals/annotation-utils.js";
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

async function layoutOf(contract: string): Promise<StorageLayout> {
  const data = await getContractBuildData(
    contract,
    artifacts,
    validations,
    createBuildInfoOutputCache(),
  );
  return data.upgradeStorageLayout!;
}

function structMembers(l: StorageLayout, structName: string) {
  const type = Object.values(l.types).find((t) => t.label === `struct ${structName}`);
  return (type as { members?: Array<{ label: string; renamedFrom?: string }> }).members ?? [];
}

// ---------------------------------------------------------------------------
// getContractBuildData
// ---------------------------------------------------------------------------

describe("getContractBuildData", () => {
  it("resolves V1 storage layout with all namespace members", async () => {
    const ns = (await layoutOf("V1")).namespaces?.["erc7201:upgrades.test.v1"];
    expect(ns?.map((m) => m.label)).toEqual(
      expect.arrayContaining(["value", "counter", "rawOwner", "active"]),
    );
  });

  it("embeds renamedFrom on a namespace member", async () => {
    const ns = (await layoutOf("V2")).namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "newValue");
    expect(member?.renamedFrom).toBe("value");
    expect(member?.retypedFrom).toBeUndefined();
  });

  it("embeds retypedFrom on a namespace member", async () => {
    const ns = (await layoutOf("V2")).namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "counter");
    expect(member?.retypedFrom).toBe("uint256");
    expect(member?.renamedFrom).toBeUndefined();
  });

  it("embeds both renamedFrom and retypedFrom on a stacked namespace member", async () => {
    const ns = (await layoutOf("V2")).namespaces?.["erc7201:upgrades.test.v1"];
    const member = ns?.find((m) => m.label === "owner");
    expect(member?.renamedFrom).toBe("rawOwner");
    expect(member?.retypedFrom).toBe("uint160");
  });

  it("embeds renamedFrom and retypedFrom on plain struct members", async () => {
    const members = structMembers(await layoutOf("V2"), "V2.Position") as Array<{
      label: string;
      renamedFrom?: string;
      retypedFrom?: string;
    }>;
    expect(members.find((m) => m.label === "height")?.renamedFrom).toBe("y");
    expect(members.find((m) => m.label === "x")?.renamedFrom).toBeUndefined();
    expect(members.find((m) => m.label === "x")?.retypedFrom).toBe("uint256");
  });

  it("has OZ's renamedFrom on a state variable tagged oz-renamed-from", async () => {
    const item = (await layoutOf("V2")).storage.find((s) => s.label === "data");
    expect(item?.renamedFrom).toBe("legacyData");
  });

  it("has OZ's retypedFrom on a state variable tagged oz-retyped-from", async () => {
    const item = (await layoutOf("V2")).storage.find((s) => s.label === "rawConfig");
    expect(item?.retypedFrom).toBe("uint256");
    expect(item?.renamedFrom).toBeUndefined();
  });

  it("leaves annotations undefined when no annotation is present", async () => {
    const l = await layoutOf("V2Broken");
    const member = l.namespaces?.["erc7201:upgrades.test.v1"]?.find((m) => m.label === "newValue");
    expect(member?.renamedFrom).toBeUndefined();
    const height = structMembers(l, "V2Broken.Position").find((m) => m.label === "height");
    expect(height?.renamedFrom).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateStorageUpgrade with real layouts
// ---------------------------------------------------------------------------

describe("validateStorageUpgrade", () => {
  it("accepts V1 -> V2: every change is tagged", async () => {
    const result = validateStorageUpgrade("V2", await layoutOf("V1"), await layoutOf("V2"));
    expect(result.storage?.explain(false)).toBe("");
    expect(result.ok).toBe(true);
  });

  it("rejects V1 -> V2Broken: namespace and plain struct member renames are untagged", async () => {
    const result = validateStorageUpgrade(
      "V2Broken",
      await layoutOf("V1"),
      await layoutOf("V2Broken"),
    );
    expect(result.ok).toBe(false);
    const text = result.storage!.explain(false);
    expect(text).toContain("newValue");
    expect(text).toContain("height");
  });
});

// ---------------------------------------------------------------------------
// extractStructMemberAnnotations
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

describe("extractStructMemberAnnotations", () => {
  it("discovers struct annotation from a base contract defined in a different file", async () => {
    const { parsed, winnerSource } = await loadParsedBuildInfo("Multi");
    const maps = extractStructMemberAnnotations(parsed, "Multi", winnerSource);

    // BaseStorage is defined in MultiBase.sol, not Multi.sol. The AST deref
    // must resolve Multi's linearizedBaseContracts across files.
    const baseRenameMap = maps.namespaceMemberRename.get("erc7201:upgrades.test.base");
    expect(baseRenameMap?.get("baseNumber")).toBe("baseNum");
  });

  it("does not fabricate rename annotations for unannotated namespaces", async () => {
    const { parsed, winnerSource } = await loadParsedBuildInfo("Multi");
    const maps = extractStructMemberAnnotations(parsed, "Multi", winnerSource);
    expect(maps.namespaceMemberRename.get("erc7201:upgrades.test.multi")).toBeUndefined();
  });

  it("keys a plain struct by canonical name, not as a namespace", async () => {
    const { parsed, winnerSource } = await loadParsedBuildInfo("V2");
    const maps = extractStructMemberAnnotations(parsed, "V2", winnerSource);
    expect(maps.structMemberRename.get("V2.Position")?.get("height")).toBe("y");
    expect(maps.namespaceMemberRename.has("V2.Position")).toBe(false);
  });

  it("returns empty maps when winnerSource is absent", () => {
    const parsed: BuildInfoParsed = { contracts: {}, sources: {} };
    const maps = extractStructMemberAnnotations(parsed, "Token", "contracts/Token.sol");
    expect(maps.namespaceMemberRename.size).toBe(0);
    expect(maps.structMemberRename.size).toBe(0);
  });

  it("returns empty maps when sources have no AST", () => {
    const parsed: BuildInfoParsed = {
      contracts: { "contracts/Token.sol": { Token: {} } },
      sources: { "contracts/Token.sol": {} },
    };
    const maps = extractStructMemberAnnotations(parsed, "Token", "contracts/Token.sol");
    expect(maps.namespaceMemberRename.size).toBe(0);
    expect(maps.structMemberRename.size).toBe(0);
  });

  it("skips unresolvable base contract IDs without throwing", () => {
    // linearizedBaseContracts includes ID 9999, which does not exist in the AST.
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

    const maps = extractStructMemberAnnotations(parsed, "Token", "contracts/Token.sol");
    expect(maps.namespaceMemberRename.size).toBe(0);
    expect(maps.structMemberRename.size).toBe(0);
  });
});
