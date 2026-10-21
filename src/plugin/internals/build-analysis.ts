/**
 * The new side of an upgrade: a contract's layout, ERC-7201 slots, proxy kind
 * and OpenZeppelin safety check, from the build info Hardhat already wrote.
 *
 * slotdiff's `analyzeBuild` does the analysis without compiling the build
 * again (one extra namespaced pass per build). Build info is read from disk
 * when a check runs, so contracts Hardhat kept from an earlier build count as
 * much as freshly compiled ones. One analysis per build-info id, per analyzer.
 *
 * Struct-member rename/retype tags are ours (OpenZeppelin cannot read them,
 * since solc exposes no NatSpec on struct members); they are applied to the
 * layout slotdiff returns.
 */

import {
  analyzeBuild,
  IncompleteBuildError,
  type BuildAnalysis,
  type SolcInput,
  type SolcOutput,
  type SourceAnalysis,
} from "slotdiff";
import type { SolidityBuildInfo } from "hardhat/types/solidity";
import { readJsonFile } from "../../utils/io.js";
import {
  embedStructMemberAnnotations,
  extractStructMemberAnnotations,
} from "./annotation-utils.js";

/** The parts of Hardhat's artifact manager the analysis reads. */
export interface BuildArtifacts {
  readArtifact(name: string): Promise<{ sourceName: string; contractName: string }>;
  getBuildInfoId(name: string): Promise<string | undefined>;
  getBuildInfoPath(id: string): Promise<string | undefined>;
  getBuildInfoOutputPath(id: string): Promise<string | undefined>;
}

/** Hardhat's build system, for the namespaced pass. */
export interface BuildCompilerHost {
  compileBuildInfo(buildInfo: SolidityBuildInfo, options?: { quiet?: boolean }): Promise<unknown>;
}

/** A contract's analysis, with our struct-member tags applied to its layout. */
export type ContractAnalysis = SourceAnalysis;

export type BuildAnalyzer = (artifactName: string) => Promise<ContractAnalysis>;

/** The compiled artifact for a deployment does not exist (not compiled, or renamed/removed). */
export class ArtifactNotFoundError extends Error {
  constructor(artifactName: string, cause: unknown) {
    super(`artifact ${artifactName} not found. Has the contract been compiled?`, { cause });
    this.name = "ArtifactNotFoundError";
  }
}

interface LoadedBuild {
  analysis: BuildAnalysis;
  userSourceNameMap: Record<string, string>;
  output: SolcOutput;
}

export function createBuildAnalyzer(
  artifacts: BuildArtifacts,
  solidity: BuildCompilerHost,
): BuildAnalyzer {
  const builds = new Map<string, Promise<LoadedBuild>>();

  return async (artifactName) => {
    let artifact: { sourceName: string; contractName: string };
    try {
      artifact = await artifacts.readArtifact(artifactName);
    } catch (err) {
      throw new ArtifactNotFoundError(artifactName, err);
    }

    const id = await artifacts.getBuildInfoId(artifactName);
    if (id === undefined) {
      throw new Error(`no build info for ${artifactName}. Run \`hardhat compile\`.`);
    }
    let build = builds.get(id);
    if (build === undefined) {
      build = loadBuild(artifacts, solidity, id);
      builds.set(id, build);
    }
    const { analysis, userSourceNameMap, output } = await build;

    // Hardhat 3 compiles project sources as `project/<path>`.
    const sourceName = userSourceNameMap[artifact.sourceName] ?? artifact.sourceName;
    const contract = analysis.contract(`${sourceName}:${artifact.contractName}`);

    // slotdiff builds a fresh layout on every call, so adding our tags to it
    // cannot reach another caller's (a test pins this).
    const { layout } = contract;
    embedStructMemberAnnotations(
      layout,
      extractStructMemberAnnotations(
        { contracts: output.contracts ?? {}, sources: output.sources ?? {} },
        artifact.contractName,
        sourceName,
      ),
    );
    return contract;
  };
}

async function loadBuild(
  artifacts: BuildArtifacts,
  solidity: BuildCompilerHost,
  id: string,
): Promise<LoadedBuild> {
  const [infoPath, outputPath] = await Promise.all([
    artifacts.getBuildInfoPath(id),
    artifacts.getBuildInfoOutputPath(id),
  ]);
  if (infoPath === undefined || outputPath === undefined) {
    throw new Error(`build info ${id} is missing on disk. Run \`hardhat compile\`.`);
  }
  const [info, { output }] = await Promise.all([
    readJsonFile<SolidityBuildInfo>(infoPath),
    readJsonFile<{ output: SolcOutput }>(outputPath),
  ]);

  const compiler = {
    longVersion: info.solcLongVersion,
    // Hardhat's compiler for this build, through its build system: no hooks,
    // no cache. It downloads solc by version (a configured `path` is ignored).
    compile: async (input: SolcInput) =>
      (await solidity.compileBuildInfo(
        {
          _format: "hh3-sol-build-info-1",
          id: `${id}-namespaced`,
          solcVersion: info.solcVersion,
          solcLongVersion: info.solcLongVersion,
          ...(info.compilerType !== undefined ? { compilerType: info.compilerType } : {}),
          userSourceNameMap: {},
          input: input as unknown as SolidityBuildInfo["input"],
        },
        { quiet: true },
      )) as SolcOutput,
  };

  let analysis: BuildAnalysis;
  try {
    analysis = await analyzeBuild(info.input as unknown as SolcInput, output, compiler);
  } catch (err) {
    if (err instanceof IncompleteBuildError) {
      throw new Error(
        `build info ${id} lacks output the upgrade check needs (${err.message}). It was ` +
          `written before this plugin requested it: run \`hardhat compile --force\`.`,
        { cause: err },
      );
    }
    throw err;
  }
  return { analysis, userSourceNameMap: info.userSourceNameMap ?? {}, output };
}
