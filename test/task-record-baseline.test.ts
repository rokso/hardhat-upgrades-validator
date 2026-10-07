/**
 * Unit tests for the record-baseline task action.
 *
 * record-baseline writes address-keyed layout records for the implementation
 * each proxy runs on-chain. The local-build path must prove the chain runs
 * that build; --force only overwrites, it never skips the proof.
 *
 * Uses a real tmpdir and a mock chain; getContractBuildData is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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

vi.mock("../src/plugin/internals/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/core/onchain/baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/onchain/baseline.js")>();
  return { ...orig, resolveImplementationLayout: vi.fn() };
});

import recordBaselineAction from "../src/plugin/tasks/record-baseline.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { resolveImplementationLayout } from "../src/core/onchain/baseline.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const STALE_IMPL = "0x00000000000000000000000000000000000000cc";

// Compiler output: a 32-byte immutable at byte 5, zeroed.
const COMPILED = "0x6080604052" + "00".repeat(32) + "fe";
const IMMUTABLES = { "7": [{ start: 5, length: 32 }] };
// The same code on-chain, immutable filled in.
const DEPLOYED = "0x6080604052" + "ab".repeat(32) + "fe";
// What runs at the proxy address: unrelated to the implementation's code.
const PROXY_CODE = "0x60806040" + "cd".repeat(16);

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

async function readRecord(address: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(
      join(deploymentsDir, ".storage-layouts", "implementations", `${address.toLowerCase()}.json`),
      "utf8",
    );
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function makeHre(provider: { send: unknown } | undefined, config: Record<string, unknown> = {}) {
  return {
    globalOptions: { network: "localhost" },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") }, upgradesValidator: config },
    artifacts: {
      readArtifact: vi.fn().mockResolvedValue({
        contractName: "MyContract",
        sourceName: "contracts/MyContract.sol",
        deployedBytecode: COMPILED,
        immutableReferences: IMMUTABLES,
      }),
    },
    network: {
      create: vi
        .fn()
        .mockImplementation(() =>
          provider === undefined
            ? Promise.reject(new Error("no network"))
            : Promise.resolve({ provider, close: vi.fn().mockResolvedValue(undefined) }),
        ),
    },
  };
}

const baseArgs = { contract: "MyContract", all: false, force: false, network: "localhost" };

let logs: string[];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-rbtest-"));
  deploymentsDir = join(tmpDir, "deployments", "localhost");
  await mkdir(deploymentsDir, { recursive: true });
  vi.clearAllMocks();
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: testLayout,
  } as never);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
  await writeDeployment("MyContract", { address: PROXY, implementation: IMPL });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Local build
// ---------------------------------------------------------------------------

describe("local build", () => {
  it("records the live implementation's layout when the chain runs the local build", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    const record = await readRecord(IMPL);
    expect(record).toMatchObject({
      format: 1,
      address: IMPL,
      contract: "contracts/MyContract.sol:MyContract",
      bytecodeMatch: "immutables-only",
      source: "local-compile",
      layout: testLayout,
    });
  });

  it("never writes the deprecated upgradeStorageLayout field", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    const deployment = JSON.parse(
      await readFile(join(deploymentsDir, "MyContract.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(deployment.upgradeStorageLayout).toBeUndefined();
  });

  it("ignores an implementation address in the deployment file; the chain decides", async () => {
    await writeDeployment("MyContract", { address: PROXY, implementation: STALE_IMPL });
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeDefined();
    expect(await readRecord(STALE_IMPL)).toBeUndefined();
  });

  it("refuses to record when the chain runs different code, and points at --from-chain", async () => {
    const other = "0x6080604052" + "ab".repeat(32) + "ff";
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: other },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/--from-chain/);
  });

  it("does not record a metadata-only match, which does not prove the layout", async () => {
    // Same code, different CBOR metadata tail (0xa2 map marker, other hash bytes).
    const compiled = "0x6080604052" + "00".repeat(32) + "fe" + "a2" + "11".repeat(9) + "000a";
    const deployed = "0x6080604052" + "ab".repeat(32) + "fe" + "a2" + "22".repeat(9) + "000a";
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: deployed },
      implementations: { [PROXY]: IMPL },
    });
    const hre = makeHre(chain);
    hre.artifacts.readArtifact.mockResolvedValue({
      contractName: "MyContract",
      sourceName: "contracts/MyContract.sol",
      deployedBytecode: compiled,
      immutableReferences: IMMUTABLES,
    });

    await recordBaselineAction(baseArgs, hre as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/does not prove its storage layout/);
  });

  it("--force does not bypass the bytecode proof", async () => {
    const other = "0x6080604052" + "ab".repeat(32) + "ff";
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: other },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction({ ...baseArgs, force: true }, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
  });

  it("skips when the artifact is not found", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    vi.mocked(getContractBuildData).mockRejectedValue(new Error("artifact not found"));

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/artifact not found/);
  });
});

// ---------------------------------------------------------------------------
// Proxy index and discovery
// ---------------------------------------------------------------------------

describe("proxy index", () => {
  it("indexes the proxy it recorded for", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
      blockNumber: 55,
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    const entry = JSON.parse(
      await readFile(join(deploymentsDir, ".storage-layouts", "proxies", `${PROXY}.json`), "utf8"),
    );
    expect(entry).toEqual({
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      deployments: ["MyContract"],
      observedAtBlock: 55,
    });
  });

  it("refuses the file describing the proxy contract itself, naming the right one", async () => {
    await writeDeployment("MyContract_Proxy", { address: PROXY, deployedBytecode: PROXY_CODE });
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(
      { ...baseArgs, contract: "MyContract_Proxy" },
      makeHre(chain) as never,
    );

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/proxy contract itself.*\(MyContract\)/);
  });

  it("marks the network fully scanned only after --all", async () => {
    const chain = () =>
      makeMockChain({
        code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
        implementations: { [PROXY]: IMPL },
      });
    const scan = join(deploymentsDir, ".storage-layouts", "scan.json");

    await recordBaselineAction(baseArgs, makeHre(chain()) as never);
    await expect(readFile(scan, "utf8")).rejects.toThrow(/ENOENT/);

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(chain()) as never,
    );
    expect(JSON.parse(await readFile(scan, "utf8"))).toMatchObject({ format: 1, chainId: 1 });
  });

  it("says so when the only file at a proxy describes the proxy contract itself", async () => {
    await writeDeployment("MyContract", { address: PROXY, deployedBytecode: PROXY_CODE });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(logs.join("\n")).toMatch(
      /"MyContract": describes the proxy contract itself, and no deployment describes the code behind it/,
    );
  });

  it("--all records once per proxy, skipping the proxy contract's file", async () => {
    await writeDeployment("MyContract_Proxy", { address: PROXY, deployedBytecode: PROXY_CODE });
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(chain) as never,
    );

    expect(await readRecord(IMPL)).toBeDefined();
    expect(vi.mocked(getContractBuildData).mock.calls.map(([n]) => n)).toEqual(["MyContract"]);
  });
});

describe("discovery failures", () => {
  const PROXY2 = "0x00000000000000000000000000000000000000dd";

  it("reports a failing address as an error and still records the others", async () => {
    await writeDeployment("Broken", { address: PROXY2 });
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED, [PROXY2]: PROXY_CODE },
      implementations: { [PROXY]: IMPL },
      beacons: { [PROXY2]: "0x00000000000000000000000000000000000000ee" }, // implementation() reverts
    });

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(chain) as never,
    );

    expect(await readRecord(IMPL)).toBeDefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\] 0x0+dd \("Broken"\)/);
    expect(process.exitCode).toBe(1);
  });

  it("records even when the proxy index cannot be written", async () => {
    await mkdir(join(deploymentsDir, ".storage-layouts", "proxies"), { recursive: true });
    await writeFile(
      join(deploymentsDir, ".storage-layouts", "proxies", `${PROXY}.json`),
      JSON.stringify({ format: 2 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeDefined();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/Could not update the proxy index/);
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Existing records
// ---------------------------------------------------------------------------

describe("existing record", () => {
  it("skips without --force and overwrites with --force", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    await recordBaselineAction(baseArgs, makeHre(chain) as never);
    const first = await readRecord(IMPL);

    const changed = { ...testLayout, storage: [] };
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: changed,
    } as never);

    await recordBaselineAction(baseArgs, makeHre(chain) as never);
    expect(await readRecord(IMPL)).toEqual(first);
    expect(logs.join("\n")).toMatch(/already recorded/);

    await recordBaselineAction({ ...baseArgs, force: true }, makeHre(chain) as never);
    expect((await readRecord(IMPL))?.layout).toEqual(changed);
  });
});

// ---------------------------------------------------------------------------
// Chain availability
// ---------------------------------------------------------------------------

describe("chain availability", () => {
  it("skips the network when the RPC cannot be reached", async () => {
    await recordBaselineAction(baseArgs, makeHre(makeDeadChain()) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/no reachable RPC/);
  });

  it("skips the network when it cannot be connected", async () => {
    await recordBaselineAction(baseArgs, makeHre(undefined) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/no reachable RPC/);
  });

  it("skips a deployment that is not a proxy on this chain", async () => {
    const chain = makeMockChain({ code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED } });

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/no ERC-1967 implementation/);
  });
});

// ---------------------------------------------------------------------------
// --from-chain
// ---------------------------------------------------------------------------

describe("--from-chain", () => {
  it("rebuilds from verified source with the configured explorer, refreshing on --force", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    vi.mocked(resolveImplementationLayout).mockResolvedValue({
      implementation: IMPL,
      origin: "explorer",
      record: { contract: "a.sol:A", bytecodeMatch: "immutables-only" },
    } as never);
    const hre = makeHre(chain, {
      explorers: { localhost: { apiKey: "KEY", apiUrl: "https://x" } },
    });

    await recordBaselineAction({ ...baseArgs, fromChain: true, force: true }, hre as never);

    const [impl, opts] = vi.mocked(resolveImplementationLayout).mock.calls[0];
    expect(impl).toBe(IMPL);
    expect(opts).toMatchObject({
      explorer: { apiKey: "KEY", apiUrl: "https://x" },
      refresh: true,
    });
    expect(vi.mocked(getContractBuildData)).not.toHaveBeenCalled();
  });

  it("reports an explorer failure as an error without aborting other contracts", async () => {
    await writeDeployment("Other", { address: PROXY, implementation: IMPL });
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    vi.mocked(resolveImplementationLayout)
      .mockRejectedValueOnce(new Error("Explorer rejected the request: Invalid API Key"))
      .mockResolvedValueOnce({
        implementation: IMPL,
        origin: "explorer",
        record: { contract: "a.sol:A", bytecodeMatch: "exact" },
      } as never);

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true, fromChain: true },
      makeHre(chain) as never,
    );

    expect(vi.mocked(resolveImplementationLayout)).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).toMatch(/Invalid API Key/);
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Network selection
// ---------------------------------------------------------------------------

describe("network override", () => {
  it("only touches the requested network directory", async () => {
    const mainnetDir = join(tmpDir, "deployments", "mainnet");
    await mkdir(mainnetDir, { recursive: true });
    await writeFile(
      join(mainnetDir, "MyContract.json"),
      JSON.stringify({ address: PROXY, implementation: IMPL }),
      "utf8",
    );
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    const hre = makeHre(chain);

    await recordBaselineAction({ ...baseArgs, network: "mainnet" }, hre as never);

    expect(hre.network.create).toHaveBeenCalledWith("mainnet");
    expect(await readRecord(IMPL)).toBeUndefined(); // localhost untouched
    const mainnetRecord = await readFile(
      join(mainnetDir, ".storage-layouts", "implementations", `${IMPL}.json`),
      "utf8",
    );
    expect(JSON.parse(mainnetRecord).address).toBe(IMPL);
  });
});
