/**
 * Unit tests for the validate-upgrade task action.
 *
 * Tests argument validation, unsafeAllow token parsing, and proxyKind
 * override logic using mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    readDeployment: vi.fn(),
  };
});

vi.mock("../src/plugin/internals/proxy-discovery.js", () => ({
  listProxyDeployments: vi.fn(),
  artifactCodeLookup: vi.fn(),
  classifyDeployment: vi.fn(),
  indexedRole: vi.fn(),
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

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import { getContractBuildData, readDeployment } from "../src/plugin/internals/deployment-utils.js";
import { listProxyDeployments } from "../src/plugin/internals/proxy-discovery.js";
import { validateStorageUpgrade } from "../src/core/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHre(root: string) {
  return {
    globalOptions: { network: "localhost" as string | undefined },
    config: { paths: { root, cache: join(root, "cache") } },
    network: {
      create: vi.fn().mockImplementation(() => Promise.reject(new Error("no network"))),
    },
    artifacts: {},
  };
}

function defaultBuildData() {
  return {
    upgradeStorageLayout: { storage: [], types: {}, namespaces: {} },
    unsafeAllowFromAnnotation: [] as string[],
    perVariableUnsafeAllow: new Map<string, string[]>(),
    namespaceUnsafeAllow: new Map<string, string[]>(),
    safetyErrors: [],
    proxyKind: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-vutest-"));
  vi.clearAllMocks();
  // Default stubs: individual tests override as needed.
  vi.mocked(listProxyDeployments).mockResolvedValue({ names: [], errors: [] });
  vi.mocked(getContractBuildData).mockResolvedValue(defaultBuildData() as never);
  vi.mocked(readDeployment).mockResolvedValue(null);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("argument validation", () => {
  it("throws when neither --contract nor --all is provided", async () => {
    const hre = makeHre(tmpDir);
    await expect(
      validateUpgradeAction(
        {
          contract: undefined,
          all: false,
          unsafeAllow: "",
          unsafeSkipStorageCheck: false,
          proxyKind: "",
        },
        hre as never,
      ),
    ).rejects.toThrow(/--contract|--all/);
  });

  it("throws when --contract is an empty string and --all is false", async () => {
    const hre = makeHre(tmpDir);
    await expect(
      validateUpgradeAction(
        {
          contract: "",
          all: false,
          unsafeAllow: "",
          unsafeSkipStorageCheck: false,
          proxyKind: "",
        },
        hre as never,
      ),
    ).rejects.toThrow(/--contract|--all/);
  });

  it("returns early (no error) when --all is true but no deployments exist", async () => {
    const hre = makeHre(tmpDir);
    vi.mocked(listProxyDeployments).mockResolvedValue({ names: [], errors: [] });
    await expect(
      validateUpgradeAction(
        {
          contract: undefined,
          all: true,
          unsafeAllow: "",
          unsafeSkipStorageCheck: false,
          proxyKind: "",
        },
        hre as never,
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unsafeAllow token parsing
// ---------------------------------------------------------------------------

describe("unsafeAllow token parsing", () => {
  beforeEach(() => {
    vi.mocked(listProxyDeployments).mockResolvedValue({ names: ["MyContract"], errors: [] });
    vi.mocked(readDeployment).mockResolvedValue(null);
    vi.mocked(getContractBuildData).mockResolvedValue(defaultBuildData() as never);
  });

  it("passes valid tokens to validateStorageUpgrade", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "variable-renamed type-changed",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const call = vi.mocked(validateStorageUpgrade).mock.calls[0];
    const opts = call[3] as { unsafeAllow?: string[] };
    expect(opts.unsafeAllow).toContain("variable-renamed");
    expect(opts.unsafeAllow).toContain("type-changed");
  });

  it("passes unknown tokens through to validateStorageUpgrade without filtering", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "variable-renamed unknown-kind",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const call = vi.mocked(validateStorageUpgrade).mock.calls[0];
    const opts = call[3] as { unsafeAllow?: string[] };
    // Task does not filter; unknown tokens reach validateStorageUpgrade,
    // which is the single validation point (tested in validate-proxy.test.ts).
    expect(opts.unsafeAllow).toContain("variable-renamed");
    expect(opts.unsafeAllow).toContain("unknown-kind");
  });

  it("uses empty unsafeAllow when flag is empty string", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const call = vi.mocked(validateStorageUpgrade).mock.calls[0];
    const opts = call[3] as { unsafeAllow?: string[] };
    // unsafeAllowFromAnnotation is [] in defaultBuildData, so result is []
    expect(opts.unsafeAllow).toEqual([]);
  });

  it("accepts comma-separated tokens", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "variable-renamed,type-changed",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const call = vi.mocked(validateStorageUpgrade).mock.calls[0];
    const opts = call[3] as { unsafeAllow?: string[] };
    expect(opts.unsafeAllow).toContain("variable-renamed");
    expect(opts.unsafeAllow).toContain("type-changed");
  });
});

// ---------------------------------------------------------------------------
// proxyKind override parsing
// ---------------------------------------------------------------------------

describe("proxyKind override parsing", () => {
  beforeEach(() => {
    vi.mocked(listProxyDeployments).mockResolvedValue({ names: ["MyContract"], errors: [] });
    vi.mocked(readDeployment).mockResolvedValue(null);
    vi.mocked(getContractBuildData).mockResolvedValue(defaultBuildData() as never);
  });

  it("passes 'uups' proxyKind to getContractBuildData", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "uups",
      },
      hre as never,
    );
    const [, , , , passedProxyKind] = vi.mocked(getContractBuildData).mock.calls[0];
    expect(passedProxyKind).toBe("uups");
  });

  it("passes 'transparent' proxyKind to getContractBuildData", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "transparent",
      },
      hre as never,
    );
    const [, , , , passedProxyKind] = vi.mocked(getContractBuildData).mock.calls[0];
    expect(passedProxyKind).toBe("transparent");
  });

  it("throws when proxyKind is not a valid value", async () => {
    const hre = makeHre(tmpDir);
    await expect(
      validateUpgradeAction(
        {
          contract: "MyContract",
          all: false,
          unsafeAllow: "",
          unsafeSkipStorageCheck: false,
          proxyKind: "not-a-valid-kind",
        },
        hre as never,
      ),
    ).rejects.toThrow(/not-a-valid-kind/);
  });

  it("maps empty proxyKind to undefined", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const [, , , , passedProxyKind] = vi.mocked(getContractBuildData).mock.calls[0];
    expect(passedProxyKind).toBeUndefined();
  });

  it("reads Hardhat's global --network option", async () => {
    const hre = makeHre(tmpDir);
    hre.globalOptions.network = "mainnet";
    await validateUpgradeAction(
      {
        contract: undefined,
        all: true,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );

    const dirs = vi.mocked(listProxyDeployments).mock.calls.map(([dir]) => dir);
    expect(dirs).toEqual([join(tmpDir, "deployments", "mainnet")]);
  });

  it("without --network, validates every network directory", async () => {
    await mkdir(join(tmpDir, "deployments", "alpha"), { recursive: true });
    await mkdir(join(tmpDir, "deployments", "beta"), { recursive: true });
    const hre = makeHre(tmpDir);
    hre.globalOptions.network = undefined;
    await validateUpgradeAction(
      {
        contract: undefined,
        all: true,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );

    const dirs = vi.mocked(listProxyDeployments).mock.calls.map(([dir]) => dir);
    expect(dirs.sort()).toEqual([
      join(tmpDir, "deployments", "alpha"),
      join(tmpDir, "deployments", "beta"),
    ]);
  });
});
