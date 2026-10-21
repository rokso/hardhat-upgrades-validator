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
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
    readDeployment: vi.fn(),
  };
});

vi.mock("../src/plugin/internals/build-analysis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/build-analysis.js")>()),
  createBuildAnalyzer: vi.fn(),
}));

vi.mock("../src/plugin/internals/proxy-discovery.js", () => ({
  listProxyDeployments: vi.fn(),
  artifactCodeLookup: vi.fn(),
  discoverProxies: vi.fn(),
  indexedRole: vi.fn().mockResolvedValue("unknown"),
  updateProxyIndex: vi.fn(),
}));

vi.mock("../src/core/validator.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/validator.js")>();
  return {
    ...orig,
    // The real check, recorded: tests read the options it was given.
    validateUpgrade: vi.fn().mockImplementation(orig.validateUpgrade),
    formatValidationResult: vi.fn().mockReturnValue("OK"),
  };
});

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import { readDeployment, ArtifactNotFoundError } from "../src/plugin/internals/deployment-utils.js";
import { createBuildAnalyzer } from "../src/plugin/internals/build-analysis.js";
import { validateUpgrade } from "../src/core/validator.js";
import { fakeAnalysis } from "./helpers/analysis.js";
import {
  listProxyDeployments,
  discoverProxies,
  indexedRole,
} from "../src/plugin/internals/proxy-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `--network` is a Hardhat global option: it arrives in hre.globalOptions,
// undefined when not passed, never in the task's own arguments.
function makeHre(root: string, ...network: [string?]) {
  return {
    globalOptions: { network: network.length > 0 ? network[0] : "localhost" },
    config: { paths: { root, cache: join(root, "cache") } },
    network: {
      create: vi.fn().mockImplementation(() => Promise.reject(new Error("no network"))),
    },
    artifacts: {},
  };
}

const analyze = vi.fn();

function defaultBuildData() {
  return fakeAnalysis({ storage: [], types: {}, namespaces: {} });
}

/** The options validate-upgrade passed to the upgrade check. */
const checkOptions = () =>
  vi.mocked(validateUpgrade).mock.calls[0]![3] as {
    unsafeAllow?: string[];
    unsafeAllowRenames?: boolean;
    kind?: string;
  };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-vutest-"));
  vi.clearAllMocks();
  vi.mocked(createBuildAnalyzer).mockReturnValue(analyze);
  // Default stubs; individual tests override as needed.
  vi.mocked(listProxyDeployments).mockResolvedValue({ names: [], errors: [], unindexed: [] });
  analyze.mockResolvedValue(defaultBuildData());
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
          unsafeAllowRenames: false,
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
          unsafeAllowRenames: false,
          unsafeSkipStorageCheck: false,
          proxyKind: "",
        },
        hre as never,
      ),
    ).rejects.toThrow(/--contract|--all/);
  });

  it("returns early (no error) when --all is true but no deployments exist", async () => {
    const hre = makeHre(tmpDir);
    vi.mocked(listProxyDeployments).mockResolvedValue({ names: [], errors: [], unindexed: [] });
    await expect(
      validateUpgradeAction(
        {
          contract: undefined,
          all: true,
          unsafeAllow: "",
          unsafeAllowRenames: false,
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
    vi.mocked(listProxyDeployments).mockResolvedValue({
      names: ["MyContract"],
      errors: [],
      unindexed: [],
    });
    vi.mocked(readDeployment).mockResolvedValue(null);
    analyze.mockResolvedValue(defaultBuildData());
  });

  async function run(unsafeAllow: string, unsafeAllowRenames = false) {
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow,
        unsafeAllowRenames,
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      makeHre(tmpDir) as never,
    );
  }

  it("passes OZ error kinds to the upgrade check", async () => {
    await run("constructor delegatecall");
    expect(checkOptions().unsafeAllow).toEqual(["constructor", "delegatecall"]);
  });

  it("accepts comma-separated tokens", async () => {
    await run("constructor,missing-initializer");
    expect(checkOptions().unsafeAllow).toEqual(["constructor", "missing-initializer"]);
  });

  it("rejects a token that is not an OZ error kind", async () => {
    await expect(run("constructor type-changed")).rejects.toThrow(
      /Invalid --unsafe-allow value\(s\): type-changed/,
    );
    expect(analyze).not.toHaveBeenCalled();
  });

  it("uses empty unsafeAllow when flag is empty string", async () => {
    await run("");
    expect(checkOptions().unsafeAllow).toEqual([]);
  });

  it("passes --unsafe-allow-renames to the upgrade check", async () => {
    await run("", true);
    expect(checkOptions().unsafeAllowRenames).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Safety errors
// ---------------------------------------------------------------------------

describe("contracts that cannot be checked fail", () => {
  const args = {
    contract: "MyContract",
    all: false,
    unsafeAllow: "",
    unsafeAllowRenames: false,
    unsafeSkipStorageCheck: false,
    proxyKind: "",
  };
  const baselined = {
    address: "0x1",
    upgradeStorageLayout: { storage: [], types: {}, namespaces: {} },
  };

  async function runTask() {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await validateUpgradeAction(args, makeHre(tmpDir) as never);
      return { exitCode: process.exitCode, out: logSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  }

  it("an error while analyzing the build", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    analyze.mockRejectedValue(new Error("getErrors exploded"));
    const { exitCode, out } = await runTask();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/\[ERROR\].*getErrors exploded/);
  });

  it("a baselined deployment whose artifact is missing", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    analyze.mockRejectedValue(new ArtifactNotFoundError("MyContract", new Error("HHE1000")));
    const { exitCode, out } = await runTask();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/\[ERROR\].*artifact MyContract not found/);
  });

  it("offline: validates a deployment the index does not know against its deprecated field", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    analyze.mockResolvedValue(defaultBuildData());
    await runTask();
    expect(indexedRole).toHaveBeenCalled();
    expect(validateUpgrade).toHaveBeenCalledTimes(1);
  });

  it("offline: an existing deployment with no baseline at all", async () => {
    // No reachable network (makeHre's network.create rejects) and no index entry.
    vi.mocked(readDeployment).mockResolvedValue({ address: "0x1" } as never);
    const { exitCode, out } = await runTask();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/\[ERROR\].*no baseline/);
  });

  it("online: skips a deployment the chain shows is not a proxy", async () => {
    vi.mocked(readDeployment).mockResolvedValue({ address: "0x1" } as never);
    vi.mocked(discoverProxies).mockResolvedValueOnce({ proxies: [], unvalidated: [], errors: [] });
    const hre = makeHre(tmpDir);
    (hre.network.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      provider: { send: vi.fn().mockResolvedValue("0x1") },
      close: vi.fn().mockResolvedValue(undefined),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await validateUpgradeAction(args, hre as never);
      expect(process.exitCode).toBeUndefined();
      expect(logSpy.mock.calls.flat().join("\n")).toMatch(/\[SKIP\].*not a proxy/);
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });
});

describe("safety errors", () => {
  it("fails (exit code 1) for a contract whose build info cannot be analyzed", async () => {
    vi.mocked(listProxyDeployments).mockResolvedValue({
      names: ["MyContract"],
      errors: [],
      unindexed: [],
    });
    vi.mocked(readDeployment).mockResolvedValue(null);
    analyze.mockRejectedValue(new Error("build info x lacks output the upgrade check needs"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await validateUpgradeAction(
        {
          contract: "MyContract",
          all: false,
          unsafeAllow: "",
          unsafeAllowRenames: false,
          unsafeSkipStorageCheck: false,
          proxyKind: "",
        },
        makeHre(tmpDir) as never,
      );
      expect(process.exitCode).toBe(1);
      expect(logSpy.mock.calls.flat().join("\n")).toMatch(/\[ERROR\].*lacks output/);
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("sets process.exitCode = 1 for an OZ safety error even when storage passes", async () => {
    vi.mocked(listProxyDeployments).mockResolvedValue({
      names: ["MyContract"],
      errors: [],
      unindexed: [],
    });
    vi.mocked(readDeployment).mockResolvedValue(null);
    analyze.mockResolvedValue(
      fakeAnalysis(
        { storage: [], types: {}, namespaces: {} },
        { safetyErrors: [{ kind: "missing-public-upgradeto", src: "contracts/A.sol:1" }] },
      ),
    );
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      makeHre(tmpDir) as never,
    );
    try {
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// proxyKind override parsing
// ---------------------------------------------------------------------------

describe("proxyKind override parsing", () => {
  beforeEach(() => {
    vi.mocked(listProxyDeployments).mockResolvedValue({
      names: ["MyContract"],
      errors: [],
      unindexed: [],
    });
    vi.mocked(readDeployment).mockResolvedValue(null);
    analyze.mockResolvedValue(defaultBuildData());
  });

  it("passes 'uups' proxyKind to the upgrade check", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "uups",
      },
      hre as never,
    );
    const passedProxyKind = checkOptions().kind;
    expect(passedProxyKind).toBe("uups");
  });

  it("passes 'transparent' proxyKind to the upgrade check", async () => {
    const hre = makeHre(tmpDir);
    await validateUpgradeAction(
      {
        contract: "MyContract",
        all: false,
        unsafeAllow: "",
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "transparent",
      },
      hre as never,
    );
    const passedProxyKind = checkOptions().kind;
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
          unsafeAllowRenames: false,
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
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );
    const passedProxyKind = checkOptions().kind;
    expect(passedProxyKind).toBeUndefined();
  });

  it("uses the global --network option", async () => {
    const hre = makeHre(tmpDir, "mainnet");
    await validateUpgradeAction(
      {
        contract: undefined,
        all: true,
        unsafeAllow: "",
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      hre as never,
    );

    const calledWithDir = vi.mocked(listProxyDeployments).mock.calls[0]?.[0];
    expect(calledWithDir).toContain(join("deployments", "mainnet"));
  });

  it("scans every network directory when --network is not passed", async () => {
    await mkdir(join(tmpDir, "deployments", "a"), { recursive: true });
    await mkdir(join(tmpDir, "deployments", "b"), { recursive: true });
    vi.mocked(listProxyDeployments).mockResolvedValue({ names: [], errors: [], unindexed: [] });
    await validateUpgradeAction(
      {
        contract: undefined,
        all: true,
        unsafeAllow: "",
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "",
      },
      makeHre(tmpDir, undefined) as never, // as Hardhat does without --network
    );
    const dirs = vi.mocked(listProxyDeployments).mock.calls.map((c) => c[0]);
    expect(dirs).toEqual([join(tmpDir, "deployments", "a"), join(tmpDir, "deployments", "b")]);
  });
});
