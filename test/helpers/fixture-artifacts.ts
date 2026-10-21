/**
 * Thin mock of Hardhat's ArtifactManager for use in Layer 2 tests.
 *
 * Reads from the committed fixture output in test/fixtures/artifacts/.
 * Four methods mirror HardhatRuntimeEnvironment["artifacts"]:
 *   - readArtifact(name)          → { bytecode, sourceName, contractName }
 *   - getBuildInfoId(name)        → string | undefined
 *   - getBuildInfoPath(id)        → absolute path to the build-info .json file
 *   - getBuildInfoOutputPath(id)  → absolute path to the .output.json file
 *
 * `makeFixtureAnalyzer` analyzes that build info as the plugin does, with
 * slotdiff's native solc standing in for Hardhat's build system.
 *
 * Artifact path structure (Hardhat v3):
 *   artifacts/{sourceName}/{contractName}.json
 *   artifacts/build-info/{id}.output.json
 *
 * The artifact JSON contains a `buildInfoId` field referencing the build-info.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSolc, type SolcInput } from "slotdiff";
import {
  createBuildAnalyzer,
  type BuildAnalyzer,
  type BuildArtifacts,
  type BuildCompilerHost,
} from "../../src/plugin/internals/build-analysis.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface FixtureArtifact {
  contractName: string;
  sourceName: string;
  bytecode: string;
  buildInfoId?: string;
}

/**
 * Resolves the artifact file path from a bare or fully qualified name.
 *
 * Bare name:            "V1"                         → artifacts/**\/V1.json (first match)
 * Fully qualified name: "contracts/V1.sol:V1"        → artifacts/contracts/V1.sol/V1.json
 */
function artifactPath(fixturesDir: string, contractNameOrFQN: string): string {
  const colonIdx = contractNameOrFQN.indexOf(":");
  if (colonIdx !== -1) {
    const sourceName = contractNameOrFQN.slice(0, colonIdx);
    const contractName = contractNameOrFQN.slice(colonIdx + 1);
    return join(fixturesDir, "artifacts", sourceName, `${contractName}.json`);
  }
  // Bare name: assume contracts/{name}.sol/{name}.json
  const name = contractNameOrFQN;
  return join(fixturesDir, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
}

export function makeFixtureArtifacts(
  fixturesDir: string = FIXTURES_DIR,
): BuildArtifacts & { readArtifact(name: string): Promise<FixtureArtifact> } {
  const artifactCache = new Map<string, FixtureArtifact>();

  async function loadArtifact(name: string): Promise<FixtureArtifact> {
    if (artifactCache.has(name)) return artifactCache.get(name)!;
    const path = artifactPath(fixturesDir, name);
    const raw = await readFile(path, "utf8");
    const artifact = JSON.parse(raw) as FixtureArtifact;
    artifactCache.set(name, artifact);
    return artifact;
  }

  return {
    async readArtifact(name) {
      return loadArtifact(name);
    },

    async getBuildInfoId(name) {
      const artifact = await loadArtifact(name);
      return artifact.buildInfoId;
    },

    async getBuildInfoPath(buildInfoId) {
      return join(fixturesDir, "artifacts", "build-info", `${buildInfoId}.json`);
    },

    async getBuildInfoOutputPath(buildInfoId) {
      const outputPath = join(fixturesDir, "artifacts", "build-info", `${buildInfoId}.output.json`);
      // Return the path unconditionally; tests commit the output files.
      return outputPath;
    },
  };
}

/** Compiles a build info with slotdiff's native solc, as Hardhat's `compileBuildInfo` would. */
export const nativeSolc: BuildCompilerHost = {
  async compileBuildInfo(buildInfo) {
    const solc = await getSolc(buildInfo.solcLongVersion);
    return solc.compile(buildInfo.input as unknown as SolcInput);
  },
};

export function makeFixtureAnalyzer(fixturesDir: string = FIXTURES_DIR): BuildAnalyzer {
  return createBuildAnalyzer(makeFixtureArtifacts(fixturesDir), nativeSolc);
}
