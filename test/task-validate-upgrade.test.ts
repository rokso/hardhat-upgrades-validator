/**
 * Unit tests for the validate-upgrade task action.
 *
 * Tests argument validation, unsafeAllow token parsing, and proxyKind
 * override logic using mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    listDeployedContractsWithLayout: vi.fn(),
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
    readDeployment: vi.fn(),
  };
});

vi.mock("../src/plugin/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/core/proxy-detection.js", () => ({
  detectProxy: vi.fn().mockReturnValue({ isProxy: true }),
  detectProxyOnchain: vi.fn().mockResolvedValue({ isProxy: true }),
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
import {
  listDeployedContractsWithLayout,
  getContractBuildData,
  readDeployment,
} from "../src/plugin/internals/deployment-utils.js";
import { validateStorageUpgrade } from "../src/core/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHre(root: string) {
  return {
    globalOptions: { network: "localhost" },
    config: { paths: { root, cache: join(root, "cache") } },
    network: {
      connect: vi.fn().mockImplementation(() => Promise.reject(new Error("no network"))),
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
  // Default stubs — individual tests override as needed.
  vi.mocked(listDeployedContractsWithLayout).mockResolvedValue([]);
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
          network: "localhost",
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
          network: "localhost",
        },
        hre as never,
      ),
    ).rejects.toThrow(/--contract|--all/);
  });

  it("returns early (no error) when --all is true but no deployments exist", async () => {
    const hre = makeHre(tmpDir);
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue([]);
    await expect(
      validateUpgradeAction(
        {
          contract: undefined,
          all: true,
          unsafeAllow: "",
          unsafeSkipStorageCheck: false,
          proxyKind: "",
          network: "localhost",
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
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue(["MyContract"]);
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
        network: "localhost",
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
        network: "localhost",
      },
      hre as never,
    );
    const call = vi.mocked(validateStorageUpgrade).mock.calls[0];
    const opts = call[3] as { unsafeAllow?: string[] };
    // Task does not filter — unknown tokens reach validateStorageUpgrade,
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
        network: "localhost",
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
        network: "localhost",
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
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue(["MyContract"]);
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
        network: "localhost",
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
        network: "localhost",
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
          network: "localhost",
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
        network: "localhost",
      },
      hre as never,
    );
    const [, , , , passedProxyKind] = vi.mocked(getContractBuildData).mock.calls[0];
    expect(passedProxyKind).toBeUndefined();
  });

  it("uses args.network when provided", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: undefined,
        all: true,
        unsafeAllow: "",
        unsafeSkipStorageCheck: false,
        proxyKind: "",
        network: "mainnet",
      },
      hre as never,
    );

    const calledWithDir = vi.mocked(listDeployedContractsWithLayout).mock.calls[0]?.[0];
    expect(calledWithDir).toContain(join("deployments", "mainnet"));
  });
});
