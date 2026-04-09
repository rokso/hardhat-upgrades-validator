/**
 * Unit tests for the compile hook's buildHandler (the solidity.build hook).
 *
 * Focuses on runAutoValidation behavior:
 *   - scans all deployments/* network directories
 *   - validates each contract that has an upgradeStorageLayout baseline
 *   - sets process.exitCode = 1 when any validation fails
 *   - skips validation when build scope is not "contracts"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
  };
});

vi.mock("../src/plugin/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
  writeValidationsToDisk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/core/validator.js", () => ({
  validateStorageUpgrade: vi.fn().mockReturnValue({
    ok: true,
    errors: [],
    safetyErrors: [],
    warnings: [],
  }),
  formatValidationResult: vi.fn().mockReturnValue("OK"),
  filterSafetyErrors: vi.fn().mockReturnValue([]),
}));

import compileHookFactory from "../src/plugin/hooks/compile.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { validateStorageUpgrade } from "../src/core/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testLayout = {
  storage: [
    {
      label: "value",
      slot: "0",
      offset: 0,
      type: "t_uint256",
      contract: "A",
      src: "",
    },
  ],
  types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
};

let tmpDir: string;
let deploymentsBase: string;

async function writeDeployment(network: string, name: string, data: Record<string, unknown>) {
  const dir = join(deploymentsBase, network);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2), "utf8");
}

function makeContext() {
  return {
    config: {
      paths: { root: tmpDir, cache: join(tmpDir, "cache") },
    },
    artifacts: {},
  };
}

/** next() returns a successful empty Map — noFailures = true, scope = "contracts" by default. */
const makeNext = () => vi.fn().mockResolvedValue(new Map());

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "huv-build-test-"));
  deploymentsBase = join(tmpDir, "deployments");
  vi.clearAllMocks();
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: testLayout,
    unsafeAllowFromAnnotation: [],
    perVariableUnsafeAllow: new Map(),
    namespaceUnsafeAllow: new Map(),
    safetyErrors: [],
    proxyKind: undefined,
  } as never);
  vi.mocked(validateStorageUpgrade).mockReturnValue({
    ok: true,
    errors: [],
    safetyErrors: [],
    warnings: [],
  });
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Network scan behavior
// ---------------------------------------------------------------------------

describe("auto-validation network scan", () => {
  it("validates contracts across all network directories", async () => {
    await writeDeployment("localhost", "ContractA", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });
    await writeDeployment("mainnet", "ContractB", {
      address: "0x2",
      upgradeStorageLayout: testLayout,
    });

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    // getContractBuildData called once per contract (one per network)
    expect(vi.mocked(getContractBuildData).mock.calls).toHaveLength(2);
    const names = vi.mocked(getContractBuildData).mock.calls.map((c) => c[0]);
    expect(names).toContain("ContractA");
    expect(names).toContain("ContractB");
  });

  it("skips contracts without an upgradeStorageLayout baseline", async () => {
    // Contract with no baseline — listDeployedContractsWithLayout should skip it
    await writeDeployment("localhost", "NoBaseline", { address: "0x1" });

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    expect(vi.mocked(getContractBuildData)).not.toHaveBeenCalled();
  });

  it("does nothing when deployments directory does not exist", async () => {
    // No deployments/ dir created — should return without error
    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    expect(vi.mocked(getContractBuildData)).not.toHaveBeenCalled();
  });

  it("does not scan when build scope is not 'contracts'", async () => {
    await writeDeployment("localhost", "MyContract", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], { scope: "scripts" } as never, makeNext());

    expect(vi.mocked(getContractBuildData)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upgradesValidator.networks config
// ---------------------------------------------------------------------------

describe("upgradesValidator.networks config", () => {
  it("validates only listed networks when networks is a string array", async () => {
    await writeDeployment("mainnet", "ContractA", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });
    await writeDeployment("localhost", "ContractB", {
      address: "0x2",
      upgradeStorageLayout: testLayout,
    });

    const ctx = {
      ...makeContext(),
      config: {
        ...makeContext().config,
        upgradesValidator: { networks: ["mainnet"] },
      },
    };
    const hooks = await compileHookFactory();
    await hooks.build(ctx as never, [], undefined, makeNext());

    expect(vi.mocked(getContractBuildData).mock.calls).toHaveLength(1);
    expect(vi.mocked(getContractBuildData).mock.calls[0]![0]).toBe("ContractA");
  });

  it("validates all networks when networks is 'all'", async () => {
    await writeDeployment("mainnet", "ContractA", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });
    await writeDeployment("localhost", "ContractB", {
      address: "0x2",
      upgradeStorageLayout: testLayout,
    });

    const ctx = {
      ...makeContext(),
      config: {
        ...makeContext().config,
        upgradesValidator: { networks: "all" },
      },
    };
    const hooks = await compileHookFactory();
    await hooks.build(ctx as never, [], undefined, makeNext());

    expect(vi.mocked(getContractBuildData).mock.calls).toHaveLength(2);
  });

  it("does nothing when networks list has no overlap with deployment dirs", async () => {
    await writeDeployment("localhost", "ContractA", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });

    const ctx = {
      ...makeContext(),
      config: {
        ...makeContext().config,
        upgradesValidator: { networks: ["mainnet"] },
      },
    };
    const hooks = await compileHookFactory();
    await hooks.build(ctx as never, [], undefined, makeNext());

    expect(vi.mocked(getContractBuildData)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// process.exitCode on validation failure
// ---------------------------------------------------------------------------

describe("process.exitCode on validation failure", () => {
  it("sets process.exitCode = 1 when a contract fails validation", async () => {
    await writeDeployment("localhost", "BadContract", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });
    vi.mocked(validateStorageUpgrade).mockReturnValue({
      ok: false,
      errors: [{ kind: "variable-removed", label: "x", slot: "0", type: "uint256" }],
      safetyErrors: [],
      warnings: [],
    });

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    expect(process.exitCode).toBe(1);
  });

  it("does NOT set process.exitCode when all contracts pass", async () => {
    await writeDeployment("localhost", "GoodContract", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    expect(process.exitCode).toBeUndefined();
  });

  it("sets process.exitCode = 1 when getContractBuildData throws for any contract", async () => {
    await writeDeployment("localhost", "Broken", {
      address: "0x1",
      upgradeStorageLayout: testLayout,
    });
    vi.mocked(getContractBuildData).mockRejectedValue(new Error("artifact not found"));

    const hooks = await compileHookFactory();
    await hooks.build(makeContext() as never, [], undefined, makeNext());

    expect(process.exitCode).toBe(1);
  });
});
