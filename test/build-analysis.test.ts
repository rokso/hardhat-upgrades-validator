/**
 * The build analyzer against real solc output laid out as Hardhat 3 writes
 * it (`<id>.json` with the input, `<id>.output.json` with the output, project
 * sources under `project/`). No mocks of slotdiff or OpenZeppelin.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSolc, type SolcInput, type SolcOutput } from "slotdiff";
import {
  ArtifactNotFoundError,
  createBuildAnalyzer,
  type BuildArtifacts,
} from "../src/plugin/internals/build-analysis.js";
import { nativeSolc } from "./helpers/fixture-artifacts.js";

const SOLC = "0.8.24+commit.e11b9ed9";
const ID = "solc-0_8_24-test";

// Alpha is listed first: a lookup by bytecode, as OZ's is, finds Alpha for Box.
const SOURCES = {
  "project/contracts/A.sol":
    "pragma solidity 0.8.24; contract Alpha { uint256 public a; bytes32 private dep; }",
  "project/contracts/Box.sol":
    "pragma solidity 0.8.24; contract Box { uint256 public a; uint256 private dep; }",
};

const INPUT = {
  language: "Solidity",
  sources: Object.fromEntries(Object.entries(SOURCES).map(([k, content]) => [k, { content }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Without the hash, Alpha and Box compile to identical code.
    metadata: { bytecodeHash: "none" },
    outputSelection: {
      "*": {
        "*": [
          "storageLayout",
          "metadata",
          "evm.bytecode.object",
          "evm.bytecode.linkReferences",
          "evm.deployedBytecode.object",
        ],
        "": ["ast"],
      },
    },
  },
} as unknown as SolcInput;

let dir: string;
let output: SolcOutput;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hhuv-analysis-"));
  output = await (await getSolc(SOLC)).compile(INPUT);
  await writeBuild(ID, output);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true });
});

async function writeBuild(id: string, out: SolcOutput) {
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      _format: "hh3-sol-build-info-1",
      id,
      solcVersion: "0.8.24",
      solcLongVersion: SOLC,
      userSourceNameMap: {
        "contracts/A.sol": "project/contracts/A.sol",
        "contracts/Box.sol": "project/contracts/Box.sol",
      },
      input: INPUT,
    }),
  );
  await writeFile(join(dir, `${id}.output.json`), JSON.stringify({ id, output: out }));
}

const ARTIFACTS: Record<string, { sourceName: string; contractName: string }> = {
  Alpha: { sourceName: "contracts/A.sol", contractName: "Alpha" },
  Box: { sourceName: "contracts/Box.sol", contractName: "Box" },
};

function artifacts(id: string | null = ID): BuildArtifacts {
  return {
    readArtifact: async (name) => {
      const a = ARTIFACTS[name];
      if (a === undefined) throw new Error(`HHE1000: artifact ${name} not found`);
      return a;
    },
    getBuildInfoId: async () => id ?? undefined,
    getBuildInfoPath: async (i) => join(dir, `${i}.json`),
    getBuildInfoOutputPath: async (i) => join(dir, `${i}.output.json`),
  };
}

const labels = (layout: { storage: Array<{ contract: string; label: string; type: string }> }) =>
  layout.storage.map((s) => `${s.contract}.${s.label}:${s.type}`);

describe("build analysis", () => {
  it("is a real collision: the two contracts compile to identical code", () => {
    const code = (f: string, c: string) =>
      (output.contracts[f]![c] as unknown as { evm: { bytecode: { object: string } } }).evm.bytecode
        .object;
    expect(code("project/contracts/Box.sol", "Box")).toBe(code("project/contracts/A.sol", "Alpha"));
  });

  it("returns the layout of the contract asked for, whatever compiles to the same code", async () => {
    const analyze = createBuildAnalyzer(artifacts(), nativeSolc);
    expect(labels((await analyze("Box")).layout)).toEqual(["Box.a:t_uint256", "Box.dep:t_uint256"]);
    expect(labels((await analyze("Alpha")).layout)).toEqual([
      "Alpha.a:t_uint256",
      "Alpha.dep:t_bytes32",
    ]);
  });

  it("analyzes each build info once, with Hardhat's compiler for the namespaced pass", async () => {
    const host = { compileBuildInfo: vi.fn(nativeSolc.compileBuildInfo) };
    const analyze = createBuildAnalyzer(artifacts(), host);
    await analyze("Box");
    const calls = host.compileBuildInfo.mock.calls.length;
    await analyze("Alpha");
    await analyze("Box");
    expect(host.compileBuildInfo.mock.calls).toHaveLength(calls);
    for (const [buildInfo, options] of host.compileBuildInfo.mock.calls) {
      expect(buildInfo).toMatchObject({
        _format: "hh3-sol-build-info-1",
        solcVersion: "0.8.24",
        solcLongVersion: SOLC,
      });
      expect(buildInfo).not.toHaveProperty("compilerType");
      expect(options).toEqual({ quiet: true });
    }
  });

  it("returns a copy of the layout, so a caller's change does not reach the next one", async () => {
    const analyze = createBuildAnalyzer(artifacts(), nativeSolc);
    const first = (await analyze("Box")).layout;
    first.storage.pop();
    for (const type of Object.values(first.types)) type.label = "changed";
    const again = (await analyze("Box")).layout;
    expect(again.storage).toHaveLength(2);
    expect(Object.values(again.types).map((t) => t.label)).not.toContain("changed");
  });
});

describe("build analysis failures", () => {
  it("a missing artifact is an ArtifactNotFoundError", async () => {
    await expect(createBuildAnalyzer(artifacts(), nativeSolc)("Gone")).rejects.toThrow(
      ArtifactNotFoundError,
    );
  });

  it("an artifact without build info says to compile", async () => {
    await expect(createBuildAnalyzer(artifacts(null), nativeSolc)("Box")).rejects.toThrow(
      /no build info for Box. Run `hardhat compile`/,
    );
  });

  it("build info missing on disk says to compile", async () => {
    await expect(createBuildAnalyzer(artifacts("gone"), nativeSolc)("Box")).rejects.toThrow();
  });

  it("output without the metadata the check needs says to compile with --force", async () => {
    const stripped = structuredClone(output);
    for (const file of Object.values(stripped.contracts)) {
      for (const contract of Object.values(file))
        delete (contract as { metadata?: string }).metadata;
    }
    await writeBuild("stripped", stripped);
    await expect(createBuildAnalyzer(artifacts("stripped"), nativeSolc)("Box")).rejects.toThrow(
      /lacks output the upgrade check needs.*hardhat compile --force/,
    );
  });
});
