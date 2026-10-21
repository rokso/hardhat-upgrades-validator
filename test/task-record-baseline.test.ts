/**
 * Unit tests for the record-baseline task action.
 *
 * record-baseline writes address-keyed layout records for the implementation
 * each proxy runs on-chain. The local-build path must prove the chain runs
 * that build; --force only overwrites, it never skips the proof.
 *
 * Uses a real tmpdir and a mock chain; the build analyzer is mocked.
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
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
  };
});

vi.mock("../src/plugin/internals/build-analysis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/build-analysis.js")>()),
  createBuildAnalyzer: vi.fn(),
}));

vi.mock("../src/core/onchain/baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/onchain/baseline.js")>();
  return { ...orig, resolveImplementationLayout: vi.fn() };
});

import recordBaselineAction from "../src/plugin/tasks/record-baseline.js";
import { ArtifactNotFoundError } from "../src/plugin/internals/deployment-utils.js";
import { createBuildAnalyzer } from "../src/plugin/internals/build-analysis.js";
import { fakeAnalysis } from "./helpers/analysis.js";
import { resolveImplementationLayout } from "../src/core/onchain/baseline.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";
import { METADATA } from "./helpers/metadata.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const STALE_IMPL = "0x00000000000000000000000000000000000000cc";

// Compiler output: a 32-byte immutable at byte 5, zeroed.
const COMPILED = "0x6080604052" + "00".repeat(32) + "fe" + METADATA;
const IMMUTABLES = { "7": [{ start: 5, length: 32 }] };
// The same code on-chain, immutable filled in.
const DEPLOYED = "0x6080604052" + "ab".repeat(32) + "fe" + METADATA;
// What runs at the proxy address: unrelated to the implementation's code.
const PROXY_CODE = "0x60806040" + "cd".repeat(16);

const analyze = vi.fn();

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

const baseArgs = { contract: "MyContract", all: false, force: false };

let logs: string[];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-rbtest-"));
  deploymentsDir = join(tmpDir, "deployments", "localhost");
  await mkdir(deploymentsDir, { recursive: true });
  vi.clearAllMocks();
  vi.mocked(createBuildAnalyzer).mockReturnValue(analyze);
  analyze.mockResolvedValue(fakeAnalysis(testLayout));
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

  it("records the proxy kind and each namespace's slot from the local build", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    const slot = "0x" + "ab".repeat(32);
    const namespaced = {
      ...testLayout,
      namespaces: { "erc7201:my.ns": [{ ...testLayout.storage[0]!, slot: "0" }] },
    };
    const namespaces = [
      { namespace: "erc7201:my.ns", expected: slot, actual: slot, status: "match" as const },
    ];
    analyze.mockResolvedValue(fakeAnalysis(namespaced, { kind: "uups", namespaces }));

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toMatchObject({ kind: "uups", namespaces });
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

  it("does not record a build without a metadata hash, and does not point at --from-chain", async () => {
    // bytecodeHash: "none": the CBOR tail carries only the compiler version.
    const tail = "a164736f6c6343000818000a";
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: "0x6080604052" + "ab".repeat(32) + "fe" + tail },
      implementations: { [PROXY]: IMPL },
    });
    const hre = makeHre(chain);
    hre.artifacts.readArtifact.mockResolvedValue({
      contractName: "MyContract",
      sourceName: "contracts/MyContract.sol",
      deployedBytecode: "0x6080604052" + "00".repeat(32) + "fe" + tail,
      immutableReferences: IMMUTABLES,
    });

    await recordBaselineAction(baseArgs, hre as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toMatch(/embeds no metadata hash/);
    expect(out).not.toMatch(/moved on|--from-chain/);
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

  it("fails, recording nothing, when the build info cannot be analyzed", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    analyze.mockRejectedValue(
      new Error("build info x lacks output: run `hardhat compile --force`."),
    );

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\] "MyContract": build info x lacks output/);
    expect(process.exitCode).toBe(1);
  });

  it("skips when the artifact is not found", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    analyze.mockRejectedValue(new ArtifactNotFoundError("MyContract", new Error("HHE1000")));

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[SKIP\].*artifact not found/);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails on any other error while analyzing the build", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    analyze.mockRejectedValue(new Error("getErrors exploded"));

    await recordBaselineAction(baseArgs, makeHre(chain) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\].*getErrors exploded/);
    expect(process.exitCode).toBe(1);
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
    expect(analyze.mock.calls.map(([n]) => n)).toEqual(["MyContract"]);
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

  it("--all reports an indexed proxy the chain no longer shows", async () => {
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });
    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(chain) as never,
    );
    logs = [];

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(makeMockChain()) as never,
    );

    expect(logs.join("\n")).toMatch(/\[ERROR\] 0x0+aa .*the chain shows no proxy there now/);
    expect(process.exitCode).toBe(1);
  });

  it("fails, recording nothing, when the RPC answers for another chain", async () => {
    await writeFile(join(deploymentsDir, ".chain"), JSON.stringify({ chainId: "5" }));
    const chain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED },
      implementations: { [PROXY]: IMPL },
    });

    await recordBaselineAction(
      { ...baseArgs, contract: undefined, all: true },
      makeHre(chain) as never,
    );

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\] "localhost": The RPC answers for chain 1/);
    expect(process.exitCode).toBe(1);
  });

  it("records even when the proxy index cannot be written", async () => {
    // A file where the index directory should be: every write fails.
    await mkdir(join(deploymentsDir, ".storage-layouts"), { recursive: true });
    await writeFile(join(deploymentsDir, ".storage-layouts", "proxies"), "");
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
    analyze.mockResolvedValue(fakeAnalysis(changed));

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

describe("arguments", () => {
  it("asks for --contract or --all when given neither", async () => {
    await expect(
      recordBaselineAction({ ...baseArgs, contract: undefined }, makeHre(undefined) as never),
    ).rejects.toThrow(/Provide --contract <name> to record a single contract, or --all/);
  });
});

describe("chain availability", () => {
  it("fails (exit code 1) when the RPC cannot be reached: nothing can be recorded", async () => {
    await recordBaselineAction(baseArgs, makeHre(makeDeadChain()) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\].*no reachable RPC/);
    expect(process.exitCode).toBe(1);
  });

  it("fails (exit code 1) when the network cannot be connected", async () => {
    await recordBaselineAction(baseArgs, makeHre(undefined) as never);

    expect(await readRecord(IMPL)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/\[ERROR\].*no reachable RPC/);
    expect(process.exitCode).toBe(1);
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
    expect(opts.refresh).toBe(true);
    expect(await (opts.explorer as () => Promise<unknown>)()).toEqual({
      apiKey: "KEY",
      apiUrl: "https://x",
    });
    expect(analyze).not.toHaveBeenCalled();
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
    hre.globalOptions.network = "mainnet";

    await recordBaselineAction(baseArgs, hre as never);

    expect(hre.network.create).toHaveBeenCalledWith("mainnet");
    expect(await readRecord(IMPL)).toBeUndefined(); // localhost untouched
    const mainnetRecord = await readFile(
      join(mainnetDir, ".storage-layouts", "implementations", `${IMPL}.json`),
      "utf8",
    );
    expect(JSON.parse(mainnetRecord).address).toBe(IMPL);
  });
});
