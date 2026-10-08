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
    listDeployedContractsWithLayout: vi.fn(),
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
    readDeployment: vi.fn(),
  };
});

vi.mock("../src/core/proxy-detection.js", () => ({
  detectProxy: vi.fn().mockReturnValue({ isProxy: true }),
  detectProxyOnchain: vi.fn().mockResolvedValue({ isProxy: true }),
}));

vi.mock("../src/core/validator.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/validator.js")>();
  return {
    ...orig,
    validateStorageUpgrade: vi.fn().mockReturnValue({
      ok: true,
      safetyErrors: [],
      warnings: [],
    }),
    formatValidationResult: vi.fn().mockReturnValue("OK"),
  };
});

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import {
  listDeployedContractsWithLayout,
  getContractBuildData,
  readDeployment,
  ArtifactNotFoundError,
} from "../src/plugin/internals/deployment-utils.js";
import { validateStorageUpgrade } from "../src/core/validator.js";
import { detectProxy, detectProxyOnchain } from "../src/core/proxy-detection.js";

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

function defaultBuildData() {
  return {
    upgradeStorageLayout: { storage: [], types: {}, namespaces: {} },
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
  // Default stubs; individual tests override as needed.
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
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue([]);
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
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue(["MyContract"]);
    vi.mocked(readDeployment).mockResolvedValue(null);
    vi.mocked(getContractBuildData).mockResolvedValue(defaultBuildData() as never);
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

  it("passes OZ error kinds to OZ's getErrors and to validateStorageUpgrade", async () => {
    await run("constructor delegatecall");
    const buildOpts = vi.mocked(getContractBuildData).mock.calls[0]![4] as {
      unsafeAllow?: string[];
    };
    expect(buildOpts.unsafeAllow).toEqual(["constructor", "delegatecall"]);
    const opts = vi.mocked(validateStorageUpgrade).mock.calls[0]![3] as {
      unsafeAllow?: string[];
    };
    expect(opts.unsafeAllow).toEqual(["constructor", "delegatecall"]);
  });

  it("accepts comma-separated tokens", async () => {
    await run("constructor,missing-initializer");
    const buildOpts = vi.mocked(getContractBuildData).mock.calls[0]![4] as {
      unsafeAllow?: string[];
    };
    expect(buildOpts.unsafeAllow).toEqual(["constructor", "missing-initializer"]);
  });

  it("rejects a token that is not an OZ error kind", async () => {
    await expect(run("constructor type-changed")).rejects.toThrow(
      /Invalid --unsafe-allow value\(s\): type-changed/,
    );
    expect(getContractBuildData).not.toHaveBeenCalled();
  });

  it("uses empty unsafeAllow when flag is empty string", async () => {
    await run("");
    const opts = vi.mocked(validateStorageUpgrade).mock.calls[0]![3] as {
      unsafeAllow?: string[];
    };
    expect(opts.unsafeAllow).toEqual([]);
  });

  it("passes --unsafe-allow-renames to validateStorageUpgrade", async () => {
    await run("", true);
    const opts = vi.mocked(validateStorageUpgrade).mock.calls[0]![3] as {
      unsafeAllowRenames?: boolean;
    };
    expect(opts.unsafeAllowRenames).toBe(true);
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

  it("an error from OZ while reading build data", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    vi.mocked(getContractBuildData).mockRejectedValue(new Error("getErrors exploded"));
    const { exitCode, out } = await runTask();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/\[ERROR\].*getErrors exploded/);
  });

  it("a baselined deployment whose artifact is missing", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    vi.mocked(getContractBuildData).mockRejectedValue(
      new ArtifactNotFoundError("MyContract", new Error("HHE1000")),
    );
    const { exitCode, out } = await runTask();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/\[ERROR\].*artifact MyContract not found/);
  });

  it("validates a baselined deployment without asking whether it is a proxy", async () => {
    vi.mocked(readDeployment).mockResolvedValue(baselined as never);
    vi.mocked(getContractBuildData).mockResolvedValue(defaultBuildData() as never);
    await runTask();
    expect(detectProxy).not.toHaveBeenCalled();
    expect(detectProxyOnchain).not.toHaveBeenCalled();
    expect(validateStorageUpgrade).toHaveBeenCalledTimes(1);
  });

  it("an existing deployment without a baseline when proxy status is unknown", async () => {
    // No reachable network (makeHre's network.create rejects), not a proxy offline.
    vi.mocked(readDeployment).mockResolvedValue({ address: "0x1" } as never);
    vi.mocked(detectProxy).mockReturnValueOnce({ isProxy: false });
    const { exitCode, out } = await runTask();
    expect(detectProxyOnchain).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(out).toMatch(/no upgradeStorageLayout.*could not be confirmed not to be a proxy/);
  });

  it("skips an existing deployment without a baseline that the chain shows is not a proxy", async () => {
    vi.mocked(readDeployment).mockResolvedValue({ address: "0x1" } as never);
    vi.mocked(detectProxy).mockReturnValueOnce({ isProxy: false });
    vi.mocked(detectProxyOnchain).mockResolvedValueOnce({ isProxy: false });
    const hre = makeHre(tmpDir);
    (hre.network.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      provider: {},
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
  it("fails (exit code 1) for a contract missing from the validation cache", async () => {
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue(["MyContract"]);
    vi.mocked(readDeployment).mockResolvedValue(null);
    vi.mocked(getContractBuildData).mockResolvedValue({
      ...defaultBuildData(),
      upgradeStorageLayout: undefined,
    } as never);
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
      expect(logSpy.mock.calls.flat().join("\n")).toMatch(/\[ERROR\].*validation cache/);
    } finally {
      process.exitCode = undefined;
      logSpy.mockRestore();
    }
  });

  it("sets process.exitCode = 1 for an OZ safety error even when storage passes", async () => {
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue(["MyContract"]);
    vi.mocked(readDeployment).mockResolvedValue(null);
    vi.mocked(getContractBuildData).mockResolvedValue({
      ...defaultBuildData(),
      safetyErrors: [{ kind: "missing-public-upgradeto", src: "contracts/A.sol:1" }],
    } as never);
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
        unsafeAllowRenames: false,
        unsafeSkipStorageCheck: false,
        proxyKind: "uups",
      },
      hre as never,
    );
    const passedProxyKind = (vi.mocked(getContractBuildData).mock.calls[0]![4] as { kind?: string })
      .kind;
    expect(passedProxyKind).toBe("uups");
  });

  it("passes 'transparent' proxyKind to getContractBuildData", async () => {
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
    const passedProxyKind = (vi.mocked(getContractBuildData).mock.calls[0]![4] as { kind?: string })
      .kind;
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
    const passedProxyKind = (vi.mocked(getContractBuildData).mock.calls[0]![4] as { kind?: string })
      .kind;
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

    const calledWithDir = vi.mocked(listDeployedContractsWithLayout).mock.calls[0]?.[0];
    expect(calledWithDir).toContain(join("deployments", "mainnet"));
  });

  it("scans every network directory when --network is not passed", async () => {
    await mkdir(join(tmpDir, "deployments", "a"), { recursive: true });
    await mkdir(join(tmpDir, "deployments", "b"), { recursive: true });
    vi.mocked(listDeployedContractsWithLayout).mockResolvedValue([]);
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
    const dirs = vi.mocked(listDeployedContractsWithLayout).mock.calls.map((c) => c[0]);
    expect(dirs).toEqual([join(tmpDir, "deployments", "a"), join(tmpDir, "deployments", "b")]);
  });
});
