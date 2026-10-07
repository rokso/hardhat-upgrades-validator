/**
 * The validations cache across builds. Hardhat caches a compilation job
 * before getCompilationJobErrors validates it, and never recompiles a cached
 * job, so a build whose validation failed must leave no cache behind: its
 * absence forces the next build to recompile, and so validate, everything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

vi.mock("@openzeppelin/upgrades-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@openzeppelin/upgrades-core")>();
  return {
    ...orig,
    isNamespaceSupported: vi.fn().mockReturnValue(false),
    solcInputOutputDecoder: vi.fn().mockReturnValue(() => ""),
    validate: vi.fn(),
  };
});

import { isNamespaceSupported, validate } from "@openzeppelin/upgrades-core";
import compileHookFactory from "../src/plugin/hooks/compile.js";
import {
  loadValidationsFromDisk,
  writeValidationsToDisk,
} from "../src/plugin/internals/validations-cache.js";

const fullOutput = {
  contracts: { "contracts/A.sol": { A: { evm: { bytecode: { object: "6080" } } } } },
  sources: { "contracts/A.sol": { ast: { nodeType: "SourceUnit", nodes: [] }, id: 0 } },
};

const job = {
  solcConfig: { version: "0.8.24", settings: {} },
  solcLongVersion: "0.8.24+commit.e11b9ed9",
  getSolcInput: vi.fn().mockResolvedValue({ language: "Solidity", sources: {}, settings: {} }),
  getBuildId: vi.fn().mockResolvedValue("build"),
};

const run = (name: string) => ({ [name]: { src: name } }) as never;
const oldData = { version: "3.4", log: [run("Old")] } as never;

let tmpDir: string;
let hooks: Awaited<ReturnType<typeof compileHookFactory>>;
const cache = () => join(tmpDir, "cache");
// The project's contract roots are A.sol and B.sol.
const ROOTS = ["contracts/A.sol", "contracts/B.sol"];
const context = () => ({
  config: { paths: { root: tmpDir, cache: cache() } },
  artifacts: {},
  solidity: {
    compileBuildInfo: vi.fn().mockRejectedValue(new Error("solc download failed")),
    getRootFilePaths: vi.fn().mockResolvedValue(ROOTS),
  },
});

// A build in which `jobs` compilation jobs compile, each validated by the
// job handler the way Hardhat calls it; the rest are cache hits.
function building(jobs: number) {
  return vi.fn().mockImplementation(async (ctx: unknown) => {
    for (let i = 0; i < jobs; i++) {
      await hooks.getCompilationJobErrors(
        ctx as never,
        job as never,
        fullOutput as never,
        vi.fn().mockResolvedValue([]),
      );
    }
    return new Map();
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-build-cache-"));
  vi.clearAllMocks();
  vi.mocked(validate).mockReturnValue(run("New"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  hooks = await compileHookFactory();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true });
});

describe("validations cache", () => {
  it("adds what compiled to what was cached, newest first", async () => {
    await writeValidationsToDisk(cache(), oldData);
    await hooks.build(context() as never, ROOTS, undefined, building(1));
    expect((await loadValidationsFromDisk(cache()))?.log).toEqual([run("New"), run("Old")]);
  });

  it("keeps the cache when every job was a cache hit", async () => {
    await writeValidationsToDisk(cache(), oldData);
    const next = building(0);
    await hooks.build(context() as never, ROOTS, undefined, next);
    expect(await loadValidationsFromDisk(cache())).toEqual(oldData);
    expect(next.mock.calls[0][2]?.force).toBeUndefined();
  });

  it("forces a full build when there is no cache", async () => {
    const next = building(0);
    await hooks.build(context() as never, ROOTS, undefined, next);
    expect(next.mock.calls[0][2]).toMatchObject({ force: true });
  });

  it("after a build whose job handler threw, leaves no cache, so the next build recompiles all", async () => {
    await writeValidationsToDisk(cache(), oldData);
    // The namespaced pass fails (its compiler cannot run), so the handler throws.
    vi.mocked(isNamespaceSupported).mockReturnValueOnce(true);
    await expect(hooks.build(context() as never, ROOTS, undefined, building(1))).rejects.toThrow(
      /Namespaced compilation failed.*solc download failed/,
    );

    expect(await loadValidationsFromDisk(cache())).toBeUndefined();
    const next = building(1);
    await hooks.build(context() as never, ROOTS, undefined, next);
    expect(next.mock.calls[0][2]).toMatchObject({ force: true });
  });

  it("does not save a cache missing a job whose validation threw, and says so", async () => {
    await writeValidationsToDisk(cache(), oldData);
    vi.mocked(validate).mockImplementationOnce(() => {
      throw new Error("layout at clash");
    });
    await hooks.build(context() as never, ROOTS, undefined, building(2));

    expect(await loadValidationsFromDisk(cache())).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(
      /Upgrade checks are off until this is fixed.*validate-upgrade fails for every proxy/s,
    );
  });

  it("saves the cache again on the next clean build after one whose validation threw", async () => {
    vi.mocked(validate).mockImplementationOnce(() => {
      throw new Error("layout at clash");
    });
    await hooks.build(context() as never, ROOTS, undefined, building(1));
    expect(await loadValidationsFromDisk(cache())).toBeUndefined();

    await hooks.build(context() as never, ROOTS, undefined, building(1));
    expect((await loadValidationsFromDisk(cache()))?.log).toEqual([run("New")]);
  });

  it("without a cache, does not start one from a build of only some contracts", async () => {
    await hooks.build(context() as never, ["contracts/A.sol"], undefined, building(1));
    expect(await loadValidationsFromDisk(cache())).toBeUndefined();

    await hooks.build(context() as never, ROOTS, { scope: "tests" } as never, building(1));
    expect(await loadValidationsFromDisk(cache())).toBeUndefined();

    await hooks.build(context() as never, ROOTS, undefined, building(1));
    expect(await loadValidationsFromDisk(cache())).toBeDefined();
  });

  it("with a cache, adds what a partial build compiled", async () => {
    await writeValidationsToDisk(cache(), oldData);
    await hooks.build(context() as never, ["contracts/A.sol"], undefined, building(1));
    expect((await loadValidationsFromDisk(cache()))?.log).toEqual([run("New"), run("Old")]);
  });
});
