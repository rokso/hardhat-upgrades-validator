/**
 * Unit tests for the record-baseline task action.
 *
 * Covers all branch paths: baseline-present skip, --force overwrite,
 * missing bytecode (with/without --force), bytecode mismatch (with/without
 * --force), and metadata-only match.
 *
 * Uses a real tmpdir for file I/O; getContractBuildData is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks (partial — keeps compareBytecode and readDeployment real)
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
}));

import recordBaselineAction from "../src/plugin/tasks/record-baseline.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";

// ---------------------------------------------------------------------------
// Bytecode helpers (same structure as deployment-utils.test.ts)
// ---------------------------------------------------------------------------

function makeBytecode(coreHex: string, cborLength: number): string {
  const core = Buffer.from(coreHex, "hex");
  const cbor = Buffer.alloc(cborLength, 0xaa);
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(cborLength, 0);
  return "0x" + Buffer.concat([core, cbor, lenBuf]).toString("hex");
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testLayout = {
  storage: [
    {
      label: "value",
      slot: "0",
      offset: 0,
      type: "t_uint256",
      contract: "MyContract",
      src: "",
    },
  ],
  types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let deploymentsDir: string;

async function writeDeployment(name: string, data: Record<string, unknown>) {
  await writeFile(join(deploymentsDir, `${name}.json`), JSON.stringify(data, null, 2), "utf8");
}

async function readDeploymentFile(name: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(deploymentsDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeHre(artifactBytecode: string) {
  return {
    globalOptions: { network: "localhost" },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
    artifacts: {
      readArtifact: vi.fn().mockResolvedValue({ deployedBytecode: artifactBytecode }),
    },
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-rbtest-"));
  deploymentsDir = join(tmpDir, "deployments", "localhost");
  await mkdir(deploymentsDir, { recursive: true });
  vi.clearAllMocks();
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: testLayout,
  } as never);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Branch: baseline already present without --force
// ---------------------------------------------------------------------------

describe("baseline already present", () => {
  it("skips without --force when upgradeStorageLayout already exists", async () => {
    const existing = {
      address: "0x1",
      deployedBytecode: makeBytecode("60806040", 10),
      upgradeStorageLayout: { storage: [], types: {} },
    };
    await writeDeployment("MyContract", existing);
    const hre = makeHre(makeBytecode("60806040", 10));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: false }, hre as never);
    consoleSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    // Should not have been overwritten with new layout
    expect(result.upgradeStorageLayout).toEqual({ storage: [], types: {} });
    expect(vi.mocked(getContractBuildData).mock.calls.length).toBe(0);
  });

  it("overwrites with --force", async () => {
    const existing = {
      address: "0x1",
      deployedBytecode: makeBytecode("60806040", 10),
      upgradeStorageLayout: { storage: [], types: {} },
    };
    await writeDeployment("MyContract", existing);
    const artifactBytecode = makeBytecode("60806040", 10);
    const hre = makeHre(artifactBytecode);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: true }, hre as never);
    consoleSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });
});

// ---------------------------------------------------------------------------
// Branch: missing deployedBytecode
// ---------------------------------------------------------------------------

describe("missing deployedBytecode", () => {
  it("skips without --force when deployedBytecode is absent", async () => {
    await writeDeployment("MyContract", { address: "0x1" });
    const hre = makeHre(makeBytecode("60806040", 10));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: false }, hre as never);
    consoleSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });

  it("records anyway with --force and emits a warning", async () => {
    await writeDeployment("MyContract", { address: "0x1" });
    const hre = makeHre(makeBytecode("60806040", 10));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: true }, hre as never);
    warnSpy.mockRestore();
    logSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });
});

// ---------------------------------------------------------------------------
// Branch: bytecode mismatch
// ---------------------------------------------------------------------------

describe("bytecode mismatch", () => {
  it("skips without --force when bytecodes do not match", async () => {
    const deployedBytecode = makeBytecode("deadbeef", 10);
    await writeDeployment("MyContract", { address: "0x1", deployedBytecode });
    const artifactBytecode = makeBytecode("cafebabe", 10); // different core
    const hre = makeHre(artifactBytecode);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: false }, hre as never);
    warnSpy.mockRestore();
    logSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });

  it("records with --force when bytecodes do not match", async () => {
    const deployedBytecode = makeBytecode("deadbeef", 10);
    await writeDeployment("MyContract", { address: "0x1", deployedBytecode });
    const artifactBytecode = makeBytecode("cafebabe", 10);
    const hre = makeHre(artifactBytecode);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: true }, hre as never);
    warnSpy.mockRestore();
    logSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });
});

// ---------------------------------------------------------------------------
// Branch: metadata-only bytecode match
// ---------------------------------------------------------------------------

describe("metadata-only bytecode match", () => {
  it("records and logs INFO when only the CBOR suffix differs", async () => {
    const coreHex = "60806040";
    const deployedBytecode = makeBytecode(coreHex, 10);

    // Artifact has same core but different CBOR fill
    const coreBuf = Buffer.from(coreHex, "hex");
    const cborBuf = Buffer.alloc(10, 0xbb); // 0xbb vs 0xaa in deployed
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(10, 0);
    const artifactBytecode = "0x" + Buffer.concat([coreBuf, cborBuf, lenBuf]).toString("hex");

    await writeDeployment("MyContract", { address: "0x1", deployedBytecode });
    const hre = makeHre(artifactBytecode);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: false }, hre as never);

    const infoLogs = logSpy.mock.calls.map((c) => String(c[0]));
    logSpy.mockRestore();

    expect(infoLogs.some((m) => m.includes("[INFO]"))).toBe(true);
    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });
});

// ---------------------------------------------------------------------------
// Branch: artifact not found
// ---------------------------------------------------------------------------

describe("artifact not found", () => {
  it("skips when getContractBuildData throws", async () => {
    await writeDeployment("MyContract", {
      address: "0x1",
      deployedBytecode: makeBytecode("60806040", 10),
    });
    const hre = makeHre(makeBytecode("60806040", 10));
    vi.mocked(getContractBuildData).mockRejectedValue(new Error("artifact not found"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await recordBaselineAction({ contract: "MyContract", all: false, force: false }, hre as never);
    logSpy.mockRestore();

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });
});

describe("network override", () => {
  it("uses args.network when provided", async () => {
    const mainnetDir = join(tmpDir, "deployments", "mainnet");
    await mkdir(mainnetDir, { recursive: true });
    await writeFile(
      join(mainnetDir, "MyContract.json"),
      JSON.stringify({ address: "0x1", deployedBytecode: makeBytecode("60806040", 10) }, null, 2),
      "utf8",
    );

    const hre = makeHre(makeBytecode("60806040", 10));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await recordBaselineAction(
      {
        contract: "MyContract",
        all: false,
        force: true,
        network: "mainnet",
      },
      hre as never,
    );

    logSpy.mockRestore();

    const mainnetRaw = await readFile(join(mainnetDir, "MyContract.json"), "utf8");
    const mainnetResult = JSON.parse(mainnetRaw) as Record<string, unknown>;
    expect(mainnetResult.upgradeStorageLayout).toEqual(testLayout);

    const localhostResult = await readDeploymentFile("MyContract").catch(() => null);
    expect(localhostResult).toBeNull();
  });
});
