/**
 * Unit tests for the compile hook's invokeSolc handler.
 *
 * Verifies that the handler throws when namespaced compilation produces errors.
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

// validations-cache is used only in buildHandler, not invokeSolc — but
// compile.ts imports it statically, so provide a safe stub.
vi.mock("../src/plugin/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
  writeValidationsToDisk: vi.fn().mockResolvedValue(undefined),
}));

// deployment-utils is used only in buildHandler — stub it out.
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

const fakeSolcConfig = { version: "0.8.24", settings: {} };
const fakeCompiler = { version: "0.8.24" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let invokeSolcHandler: (
  ctx: unknown,
  compiler: unknown,
  input: unknown,
  config: unknown,
  next: (...args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

beforeEach(async () => {
  vi.clearAllMocks();
  const hooks = await compileHookFactory();
  invokeSolcHandler = hooks.invokeSolc as typeof invokeSolcHandler;
});

describe("namespaced compilation error handling", () => {
  function makeNext() {
    // First call → full output; second call → namespaced output with errors.
    return vi.fn().mockResolvedValueOnce(fakeFullOutput).mockResolvedValue(fakeNsOutputWithErrors);
  }

  it("throws when namespaced compilation produces errors", async () => {
    const ctx = { config: { upgradesValidator: {} } };
    const next = makeNext();

    await expect(
      invokeSolcHandler(ctx, fakeCompiler, fakeSolcInput, fakeSolcConfig, next),
    ).rejects.toThrow(/Namespaced compilation/);
  });

  it("throws when upgradesValidator config is absent", async () => {
    const ctx = { config: {} };
    const next = makeNext();

    await expect(
      invokeSolcHandler(ctx, fakeCompiler, fakeSolcInput, fakeSolcConfig, next),
    ).rejects.toThrow(/Namespaced compilation/);
  });
});
