/**
 * Unit tests for the compile hook's getCompilationJobErrors handler.
 *
 * Verifies the namespaced compilation runs through Hardhat's compileBuildInfo
 * and that the handler throws when it fails or produces errors.
 *
 * oz-core functions that would require a real solc output are mocked so the
 * test controls when the namespaced compilation "fails".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock oz-core so we can control isNamespaceSupported and the NS input
// construction without a real compiler output.
vi.mock("@openzeppelin/upgrades-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@openzeppelin/upgrades-core")>();
  return {
    ...orig,
    isNamespaceSupported: vi.fn().mockReturnValue(true),
    makeNamespacedInput: vi.fn().mockImplementation((input: unknown) => input),
    trySanitizeNatSpec: vi.fn().mockImplementation(async (input: unknown) => input),
    solcInputOutputDecoder: vi.fn().mockReturnValue(() => ""),
    validate: vi.fn().mockReturnValue([]),
    concatRunData: vi.fn().mockImplementation((a: unknown) => a),
  };
});

// deployment-utils is used only in buildHandler; stub it out.
vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    listDeployedContractsWithLayout: vi.fn().mockResolvedValue([]),
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
    readDeployment: vi.fn().mockResolvedValue(null),
  };
});

import compileHookFactory from "../src/plugin/hooks/compile.js";

// ---------------------------------------------------------------------------
// Fake solc outputs
// ---------------------------------------------------------------------------

/**
 * A minimal "full" solc output that satisfies isFullSolcOutput:
 * has contracts with evm.bytecode AND sources with ast + id.
 */
const fakeFullOutput = {
  contracts: {
    "contracts/Test.sol": {
      Test: { evm: { bytecode: { object: "6080" } } },
    },
  },
  sources: {
    "contracts/Test.sol": { ast: { nodeType: "SourceUnit", nodes: [] }, id: 0 },
  },
};

/** A namespaced compilation output containing a compiler error. */
const fakeNsOutputWithErrors = {
  errors: [{ severity: "error", message: "Namespaced compilation failed" }],
  contracts: {},
  sources: {},
};

const fakeSolcInput = {
  language: "Solidity",
  sources: {},
  settings: { outputSelection: { "*": { "*": [] } } },
};

const solcConfig = { version: "0.8.24", settings: {} };

function makeJob() {
  return {
    solcConfig,
    solcLongVersion: "0.8.24+commit.e11b9ed9",
    getSolcInput: vi.fn().mockResolvedValue(fakeSolcInput),
    getBuildId: vi.fn().mockResolvedValue("solc-0_8_24-abc"),
  };
}

function makeContext(nsOutput: unknown, config: unknown = { upgradesValidator: {} }) {
  return {
    config,
    solidity: { compileBuildInfo: vi.fn().mockResolvedValue(nsOutput) },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type JobErrorsHandler = (
  ctx: unknown,
  job: unknown,
  output: unknown,
  next: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

let jobErrorsHandler: JobErrorsHandler;
const next = () => vi.fn().mockResolvedValue([]);

beforeEach(async () => {
  vi.clearAllMocks();
  const hooks = await compileHookFactory();
  jobErrorsHandler = hooks.getCompilationJobErrors as unknown as JobErrorsHandler;
});

describe("namespaced compilation", () => {
  it("compiles the namespaced input through Hardhat's compileBuildInfo with the job's version", async () => {
    const ctx = makeContext(fakeFullOutput);

    await jobErrorsHandler(ctx, makeJob(), fakeFullOutput, next());

    expect(ctx.solidity.compileBuildInfo).toHaveBeenCalledTimes(1);
    const [buildInfo, options] = ctx.solidity.compileBuildInfo.mock.calls[0];
    expect(buildInfo).toMatchObject({
      _format: "hh3-sol-build-info-1",
      solcVersion: "0.8.24",
      solcLongVersion: "0.8.24+commit.e11b9ed9",
      input: fakeSolcInput,
    });
    expect(buildInfo).not.toHaveProperty("compilerType");
    expect(options).toEqual({ quiet: true });
  });

  it("passes the namespaced output to OZ's validate()", async () => {
    const { validate } = await import("@openzeppelin/upgrades-core");
    const nsOutput = { ...fakeFullOutput, errors: [] };
    await jobErrorsHandler(makeContext(nsOutput), makeJob(), fakeFullOutput, next());
    expect(vi.mocked(validate).mock.calls[0]![4]).toBe(nsOutput);
  });

  it("returns the job's errors unchanged", async () => {
    const errors = [{ severity: "warning", message: "w" }];
    const result = await jobErrorsHandler(
      makeContext(fakeFullOutput),
      makeJob(),
      fakeFullOutput,
      vi.fn().mockResolvedValue(errors),
    );
    expect(result).toBe(errors);
  });

  it("throws when namespaced compilation produces errors", async () => {
    await expect(
      jobErrorsHandler(makeContext(fakeNsOutputWithErrors), makeJob(), fakeFullOutput, next()),
    ).rejects.toThrow(/Namespaced compilation produced errors/);
  });

  it("throws when the namespaced compiler cannot run", async () => {
    const ctx = makeContext(undefined);
    ctx.solidity.compileBuildInfo.mockRejectedValue(new Error("download failed"));
    await expect(jobErrorsHandler(ctx, makeJob(), fakeFullOutput, next())).rejects.toThrow(
      /Namespaced compilation failed.*download failed/,
    );
  });

  it("runs with the default config, when upgradesValidator is absent", async () => {
    await expect(
      jobErrorsHandler(makeContext(fakeNsOutputWithErrors, {}), makeJob(), fakeFullOutput, next()),
    ).rejects.toThrow(/Namespaced compilation/);
  });

  it("does nothing for a failed or partial output, or when disabled", async () => {
    const partial = makeContext(fakeFullOutput);
    await jobErrorsHandler(partial, makeJob(), { errors: [] }, next());
    expect(partial.solidity.compileBuildInfo).not.toHaveBeenCalled();

    const disabled = makeContext(fakeFullOutput, {
      upgradesValidator: { enableCompileHook: false },
    });
    await jobErrorsHandler(disabled, makeJob(), fakeFullOutput, next());
    expect(disabled.solidity.compileBuildInfo).not.toHaveBeenCalled();
  });
});
