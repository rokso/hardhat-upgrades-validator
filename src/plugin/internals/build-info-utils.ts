// src/plugin/build-info-utils.ts
// Utilities for loading and caching build-info output (AST only)

import { readJsonFile } from "../../utils/io.js";
import type { ArtifactsReader } from "./deployment-utils.js";

// Types for build-info output. Only source ASTs are read (struct NatSpec).
export type BuildInfoContracts = Record<string, Record<string, unknown>>;

export type BuildInfoSources = Record<string, { ast?: unknown }>;

export type BuildInfoParsed = {
  contracts: BuildInfoContracts;
  sources: BuildInfoSources;
};

export type BuildInfoOutputCache = Map<string, BuildInfoParsed | null>;

export function createBuildInfoOutputCache(): BuildInfoOutputCache {
  return new Map();
}

export async function loadBuildInfo(
  buildInfoId: string,
  artifacts: ArtifactsReader,
  cache: BuildInfoOutputCache,
): Promise<BuildInfoParsed | null> {
  if (cache.has(buildInfoId)) return cache.get(buildInfoId)!;

  const outputPath = await artifacts.getBuildInfoOutputPath(buildInfoId);
  if (outputPath === undefined) {
    cache.set(buildInfoId, null);
    return null;
  }

  try {
    const parsed = await readJsonFile<{
      output?: { contracts?: BuildInfoContracts; sources?: BuildInfoSources };
    }>(outputPath);
    const result: BuildInfoParsed = {
      contracts: parsed.output?.contracts ?? {},
      sources: parsed.output?.sources ?? {},
    };
    cache.set(buildInfoId, result);
    return result;
  } catch {
    cache.set(buildInfoId, null);
    return null;
  }
}
