/**
 * Unit tests for the deploy hook's upgradeStorageLayout stamping behavior.
 *
 * Cases:
 *  - stamps upgradeStorageLayout when artifact bytecode matches deployment
 *  - skips when artifact bytecode does not match
 *  - skips when the artifact is not found (getContractBuildData throws)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks (partial; keeps compareBytecode and readDeployment real)
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

vi.mock("../src/plugin/hooks/compile.js", () => ({
  getInMemoryValidations: vi.fn().mockReturnValue(null),
}));

import deployOverride from "../src/plugin/hooks/deploy.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";

// ---------------------------------------------------------------------------
// Bytecode helpers
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
      getBuildInfoId: vi.fn().mockResolvedValue(undefined),
      getBuildInfoOutputPath: vi.fn().mockResolvedValue(undefined),
    },
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-deploytest-"));
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
// Tests
// ---------------------------------------------------------------------------

describe("upgradeStorageLayout stamping", () => {
  it("stamps upgradeStorageLayout when artifact bytecode matches deployment", async () => {
    const bytecode = makeBytecode("60806040", 10);
    await writeDeployment("MyContract", {
      address: "0x1",
      deployedBytecode: bytecode,
    });
    const hre = makeHre(bytecode);

    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });

  it("stamps when bytecodes match with metadata-only diff", async () => {
    const coreHex = "60806040";
    const deployedBytecode = makeBytecode(coreHex, 10);
    const coreBuf = Buffer.from(coreHex, "hex");
    const cborBuf = Buffer.alloc(10, 0xbb); // different CBOR fill
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(10, 0);
    const artifactBytecode = "0x" + Buffer.concat([coreBuf, cborBuf, lenBuf]).toString("hex");

    await writeDeployment("MyContract", { address: "0x1", deployedBytecode });
    const hre = makeHre(artifactBytecode);

    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });

  it("skips when artifact bytecode does not match deployment bytecode", async () => {
    const deployedBytecode = makeBytecode("deadbeef", 10);
    const artifactBytecode = makeBytecode("cafebabe", 10); // different core
    await writeDeployment("MyContract", { address: "0x1", deployedBytecode });
    const hre = makeHre(artifactBytecode);

    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });

  it("skips when getContractBuildData throws (artifact not found)", async () => {
    const bytecode = makeBytecode("60806040", 10);
    await writeDeployment("MyContract", {
      address: "0x1",
      deployedBytecode: bytecode,
    });
    vi.mocked(getContractBuildData).mockRejectedValue(new Error("artifact not found"));
    const hre = makeHre(bytecode);

    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });

  it("skips deployments without deployedBytecode", async () => {
    await writeDeployment("MyContract", { address: "0x1" }); // no deployedBytecode
    const hre = makeHre(makeBytecode("60806040", 10));

    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toBeUndefined();
  });

  it("only updates the selected network directory", async () => {
    const bytecode = makeBytecode("60806040", 10);

    // localhost deployment (should be updated)
    await writeDeployment("MyContract", {
      address: "0x1",
      deployedBytecode: bytecode,
    });

    // mainnet deployment (should remain untouched)
    const mainnetDir = join(tmpDir, "deployments", "mainnet");
    await mkdir(mainnetDir, { recursive: true });
    await writeFile(
      join(mainnetDir, "MyContract.json"),
      JSON.stringify({ address: "0x2", deployedBytecode: bytecode }, null, 2),
      "utf8",
    );

    const hre = makeHre(bytecode);
    await deployOverride(
      { network: "localhost" },
      hre as never,
      vi.fn().mockResolvedValue(undefined),
    );

    const localhostResult = await readDeploymentFile("MyContract");
    expect(localhostResult.upgradeStorageLayout).toEqual(testLayout);

    const mainnetRaw = await readFile(join(mainnetDir, "MyContract.json"), "utf8");
    const mainnetResult = JSON.parse(mainnetRaw) as Record<string, unknown>;
    expect(mainnetResult.upgradeStorageLayout).toBeUndefined();
  });

  it("uses Hardhat global --network when task args omit network", async () => {
    const bytecode = makeBytecode("60806040", 10);
    await writeDeployment("MyContract", {
      address: "0x1",
      deployedBytecode: bytecode,
    });
    const hre = makeHre(bytecode);

    await deployOverride({}, hre as never, vi.fn().mockResolvedValue(undefined));

    const result = await readDeploymentFile("MyContract");
    expect(result.upgradeStorageLayout).toEqual(testLayout);
  });
});

describe("runs that must not stamp", () => {
  it("does not crash and stamps nothing without --network (Hardhat leaves it undefined)", async () => {
    const bytecode = makeBytecode("60806040", 10);
    await writeDeployment("MyContract", { address: "0x1", deployedBytecode: bytecode });
    const hre = { ...makeHre(bytecode), globalOptions: { network: undefined } };
    const runSuper = vi.fn().mockResolvedValue("deployed");

    await expect(deployOverride({}, hre as never, runSuper)).resolves.toBe("deployed");
    expect((await readDeploymentFile("MyContract")).upgradeStorageLayout).toBeUndefined();
  });

  it("stamps nothing under hardhat-deploy's fork mode (HARDHAT_FORK)", async () => {
    const bytecode = makeBytecode("60806040", 10);
    await writeDeployment("MyContract", { address: "0x1", deployedBytecode: bytecode });
    vi.stubEnv("HARDHAT_FORK", "mainnet");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await deployOverride({}, makeHre(bytecode) as never, vi.fn().mockResolvedValue(undefined));
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
    expect((await readDeploymentFile("MyContract")).upgradeStorageLayout).toBeUndefined();
  });
});

// hardhat-deploy rewrites a proxy's file on upgrade from the proxy record and
// the new artifact, dropping upgradeStorageLayout. runSuper simulates that.
describe("in-place upgrades are checked against the pre-deploy baseline", () => {
  const otherLayout = {
    storage: [
      {
        label: "renamed",
        slot: "0",
        offset: 0,
        type: "t_uint256",
        contract: "MyContract",
        src: "",
      },
    ],
    types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
  };
  const appendedLayout = {
    storage: [
      ...testLayout.storage,
      { label: "extra", slot: "1", offset: 0, type: "t_uint256", contract: "MyContract", src: "" },
    ],
    types: testLayout.types,
  };

  function upgradeTo(address: string, bytecode: string) {
    return vi.fn().mockImplementation(async () => {
      await writeDeployment("MyContract", { address, deployedBytecode: bytecode });
    });
  }

  async function run(newLayout: unknown, newAddress: string) {
    const bytecode = makeBytecode("60806041", 10);
    await writeDeployment("MyContract", {
      address: "0xProxy",
      deployedBytecode: makeBytecode("60806040", 10),
      upgradeStorageLayout: testLayout,
    });
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: newLayout,
      safetyErrors: [],
      proxyKind: undefined,
    } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deployOverride({}, makeHre(bytecode) as never, upgradeTo(newAddress, bytecode));
      return err.mock.calls.flat().join("\n");
    } finally {
      err.mockRestore();
    }
  }

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("keeps the old baseline and exits 1 when the upgrade is incompatible", async () => {
    const errors = await run(otherLayout, "0xproxy"); // same address, other case
    expect((await readDeploymentFile("MyContract")).upgradeStorageLayout).toEqual(testLayout);
    expect(process.exitCode).toBe(1);
    expect(errors).toMatch(/not storage-compatible with its previous baseline/);
  });

  it("stamps the new layout when the upgrade is compatible", async () => {
    await run(appendedLayout, "0xProxy");
    expect((await readDeploymentFile("MyContract")).upgradeStorageLayout).toEqual(appendedLayout);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not compare a deployment at a new address (a fresh contract)", async () => {
    await run(otherLayout, "0xNew");
    expect((await readDeploymentFile("MyContract")).upgradeStorageLayout).toEqual(otherLayout);
    expect(process.exitCode).toBeUndefined();
  });
});
