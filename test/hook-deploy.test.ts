/**
 * Unit tests for the deploy hook's implementation-layout recording.
 *
 * After a deploy, the hook writes an address-keyed record for every
 * implementation a proxy deployment points at, but only when the chain runs
 * the local build. It never writes the deprecated upgradeStorageLayout field.
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

vi.mock("../src/plugin/hooks/compile.js", () => ({
  getInMemoryValidations: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/plugin/internals/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

import deployOverride from "../src/plugin/hooks/deploy.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";

const COMPILED = "0x6080604052" + "00".repeat(32) + "fe";
const IMMUTABLES = { "7": [{ start: 5, length: 32 }] };
const DEPLOYED = "0x6080604052" + "ab".repeat(32) + "fe";

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

async function writeDeployment(dir: string, name: string, data: Record<string, unknown>) {
  await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2), "utf8");
}

async function readRecord(dir: string, address: string) {
  try {
    return JSON.parse(
      await readFile(join(dir, ".storage-layouts", `${address}.json`), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function makeHre(provider: { send: unknown } | undefined) {
  return {
    globalOptions: { network: "localhost" },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
    artifacts: {
      readArtifact: vi.fn().mockResolvedValue({
        contractName: "MyContract",
        sourceName: "contracts/MyContract.sol",
        deployedBytecode: COMPILED,
        immutableReferences: IMMUTABLES,
      }),
      getBuildInfoId: vi.fn().mockResolvedValue(undefined),
      getBuildInfoOutputPath: vi.fn().mockResolvedValue(undefined),
    },
    network: {
      connect: vi
        .fn()
        .mockImplementation(() =>
          provider === undefined
            ? Promise.reject(new Error("no network"))
            : Promise.resolve({ provider, close: vi.fn().mockResolvedValue(undefined) }),
        ),
    },
  };
}

const liveChain = () => makeMockChain({ code: { [IMPL]: DEPLOYED } });
const runSuper = () => vi.fn().mockResolvedValue("deploy-result");

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-deploytest-"));
  deploymentsDir = join(tmpDir, "deployments", "localhost");
  await mkdir(deploymentsDir, { recursive: true });
  vi.clearAllMocks();
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: testLayout,
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await writeDeployment(deploymentsDir, "MyContract", { address: PROXY, implementation: IMPL });
  await writeDeployment(deploymentsDir, "MyContract_Implementation", {
    address: IMPL,
    deployedBytecode: COMPILED,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("implementation layout recording", () => {
  it("records a freshly deployed implementation once the chain runs it", async () => {
    const result = await deployOverride({}, makeHre(liveChain()) as never, runSuper());

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toMatchObject({
      address: IMPL,
      bytecodeMatch: "immutables-only",
      source: "local-compile",
      contract: "contracts/MyContract.sol:MyContract",
      layout: testLayout,
    });
  });

  it("never writes the deprecated upgradeStorageLayout field", async () => {
    await deployOverride({}, makeHre(liveChain()) as never, runSuper());

    for (const name of ["MyContract", "MyContract_Implementation"]) {
      const raw = JSON.parse(await readFile(join(deploymentsDir, `${name}.json`), "utf8"));
      expect(raw.upgradeStorageLayout).toBeUndefined();
    }
  });

  it("does not record when the chain runs different code", async () => {
    const chain = makeMockChain({ code: { [IMPL]: "0x6080604052" + "ab".repeat(32) + "ff" } });

    await deployOverride({}, makeHre(chain) as never, runSuper());

    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("ignores deployments no proxy points at", async () => {
    await writeDeployment(deploymentsDir, "MyContract", { address: PROXY });

    await deployOverride({}, makeHre(liveChain()) as never, runSuper());

    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("keeps an existing record untouched", async () => {
    await mkdir(join(deploymentsDir, ".storage-layouts"));
    const existing = { format: 1, address: IMPL, marker: "keep" };
    await writeFile(
      join(deploymentsDir, ".storage-layouts", `${IMPL}.json`),
      JSON.stringify(existing),
    );

    await deployOverride({}, makeHre(liveChain()) as never, runSuper());

    expect(await readRecord(deploymentsDir, IMPL)).toEqual(existing);
  });

  it("skips recording when no RPC is reachable, without failing the deploy", async () => {
    const result = await deployOverride({}, makeHre(makeDeadChain()) as never, runSuper());

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("does not fail the deploy when recording throws", async () => {
    // No code at the implementation address: readCode throws.
    const result = await deployOverride({}, makeHre(makeMockChain({})) as never, runSuper());

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("only touches the --network deployment directory", async () => {
    const mainnetDir = join(tmpDir, "deployments", "mainnet");
    await mkdir(mainnetDir, { recursive: true });
    await writeDeployment(mainnetDir, "MyContract", { address: PROXY, implementation: IMPL });
    await writeDeployment(mainnetDir, "MyContract_Implementation", {
      address: IMPL,
      deployedBytecode: COMPILED,
    });

    await deployOverride({}, makeHre(liveChain()) as never, runSuper());

    expect(await readRecord(deploymentsDir, IMPL)).toBeDefined();
    expect(await readRecord(mainnetDir, IMPL)).toBeUndefined();
  });
});
