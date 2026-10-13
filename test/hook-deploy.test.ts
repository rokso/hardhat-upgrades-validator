/**
 * Unit tests for the deploy hook's implementation-layout recording.
 *
 * After a deploy, the hook looks only at deployment files the deploy created
 * or changed, refreshes the proxy index from the chain, and writes an
 * address-keyed record for the implementation a changed proxy runs, or for a
 * freshly deployed implementation of a known proxy's contract, but only when
 * the chain runs the local build. Files are shaped as hardhat-deploy v2
 * writes them: `X` (proxy address, implementation artifact), `X_Proxy`,
 * `X_Implementation`; nothing relies on those names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks (partial: keeps readDeployments and resolveArtifactName real)
// ---------------------------------------------------------------------------

vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
  };
});

vi.mock("../src/plugin/hooks/compile.js", () => ({
  getInMemoryValidations: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/plugin/internals/validations-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/validations-cache.js")>()),
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

import deployOverride from "../src/plugin/hooks/deploy.js";
import { updateProxyEntry, writeLayoutRecord } from "../src/core/onchain/store.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { makeDeadChain, makeMockChain, type MockChainState } from "./helpers/mock-chain.js";
import { METADATA } from "./helpers/metadata.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const NEW_IMPL = "0x00000000000000000000000000000000000000cc";
const OTHER = "0x00000000000000000000000000000000000000dd";

const COMPILED = "0x6080604052" + "00".repeat(32) + "fe" + METADATA;
const IMMUTABLES = { "7": [{ start: 5, length: 32 }] };
const DEPLOYED = "0x6080604052" + "ab".repeat(32) + "fe" + METADATA;
const PROXY_CODE = "0x60806040" + "cd".repeat(16);
const LOGIC_FQN = "contracts/MyContract.sol:MyContract";
const STANDALONE_FQN = "contracts/Standalone.sol:Standalone";

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

const logicArtifact = {
  contractName: "MyContract",
  sourceName: "contracts/MyContract.sol",
  deployedBytecode: COMPILED,
  immutableReferences: IMMUTABLES,
};

// What hardhat-deploy v2 writes for a proxy deployment named "MyContract".
const proxyFiles = (impl: string) => ({
  MyContract: { address: PROXY, ...logicArtifact },
  MyContract_Proxy: {
    address: PROXY,
    contractName: "ERC1967Proxy",
    sourceName: "proxy/ERC1967Proxy.sol",
    deployedBytecode: PROXY_CODE,
    immutableReferences: {},
  },
  MyContract_Implementation: { address: impl, ...logicArtifact },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let deploymentsDir: string;

async function writeDeployments(dir: string, files: Record<string, object>) {
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify(data, null, 2), "utf8");
  }
}

async function readStore(dir: string, kind: string, address: string) {
  try {
    return JSON.parse(
      await readFile(join(dir, ".storage-layouts", kind, `${address}.json`), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const readRecord = (dir: string, address: string) => readStore(dir, "implementations", address);
const readIndex = (dir: string, address: string) => readStore(dir, "proxies", address);

function makeHre(provider: { send: unknown } | undefined, type = "http") {
  return {
    globalOptions: { network: "localhost" as string | undefined },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
    artifacts: {
      readArtifact: vi.fn().mockImplementation(async (name: string) => {
        if (name === LOGIC_FQN) return logicArtifact;
        if (name === STANDALONE_FQN) {
          return {
            ...logicArtifact,
            contractName: "Standalone",
            sourceName: "contracts/Standalone.sol",
          };
        }
        throw new Error(`HHE1000: artifact ${name} not found`);
      }),
      getBuildInfoId: vi.fn().mockResolvedValue(undefined),
      getBuildInfoOutputPath: vi.fn().mockResolvedValue(undefined),
    },
    network: {
      create: vi.fn().mockImplementation(() =>
        provider === undefined
          ? Promise.reject(new Error("no network"))
          : Promise.resolve({
              provider,
              networkConfig: { type },
              close: vi.fn().mockResolvedValue(undefined),
            }),
      ),
    },
  };
}

const chainState = (impl: string): MockChainState => ({
  code: { [PROXY]: PROXY_CODE, [IMPL]: DEPLOYED, [NEW_IMPL]: DEPLOYED },
  implementations: { [PROXY]: impl },
});
const liveChain = () => makeMockChain(chainState(IMPL));

// A deploy that writes the given files, as hardhat-deploy would.
const deploying = (files: Record<string, object>, dir = () => deploymentsDir) =>
  vi.fn().mockImplementation(async () => {
    await writeDeployments(dir(), files);
    return "deploy-result";
  });

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
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fresh proxy deployment", () => {
  it("records the implementation the new proxy runs and indexes the proxy", async () => {
    const result = await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying(proxyFiles(IMPL)),
    );

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toMatchObject({
      address: IMPL,
      bytecodeMatch: "immutables-only",
      source: "local-compile",
      contract: LOGIC_FQN,
      layout: testLayout,
    });
    expect(await readIndex(deploymentsDir, PROXY)).toEqual({
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      // The file describing the proxy contract itself is told apart by its code, not its name.
      deployments: ["MyContract"],
      observedAtBlock: 100,
    });
  });

  it("never writes the deprecated upgradeStorageLayout field", async () => {
    await deployOverride({}, makeHre(liveChain()) as never, deploying(proxyFiles(IMPL)));

    for (const name of Object.keys(proxyFiles(IMPL))) {
      const raw = JSON.parse(await readFile(join(deploymentsDir, `${name}.json`), "utf8"));
      expect(raw.upgradeStorageLayout).toBeUndefined();
    }
  });

  it("indexes the proxy but records nothing when the chain runs different code", async () => {
    const state = chainState(IMPL);
    state.code![IMPL] = "0x6080604052" + "ab".repeat(32) + "ff" + METADATA;

    await deployOverride({}, makeHre(makeMockChain(state)) as never, deploying(proxyFiles(IMPL)));

    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ implementation: IMPL });
  });

  it("says why it records nothing for a build without a metadata hash", async () => {
    const tail = "a164736f6c6343000818000a";
    const state = chainState(IMPL);
    state.code![IMPL] = "0x6080604052" + "ab".repeat(32) + "fe" + tail;
    const hre = makeHre(makeMockChain(state));
    hre.artifacts.readArtifact.mockResolvedValue({
      ...logicArtifact,
      deployedBytecode: "0x6080604052" + "00".repeat(32) + "fe" + tail,
    });

    await deployOverride({}, hre as never, deploying(proxyFiles(IMPL)));

    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(
      /Did not record MyContract.*embeds no metadata hash/,
    );
  });
});

describe("upgrades", () => {
  beforeEach(async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await deployOverride({}, makeHre(liveChain()) as never, deploying({}));
    // The first run saw no change, so it neither indexed nor recorded.
    expect(await readIndex(deploymentsDir, PROXY)).toBeUndefined();
    await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying({ MyContract: { ...proxyFiles(IMPL).MyContract, receipt: {} } }),
    );
    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ implementation: IMPL });
  });

  it("records a new implementation whose upgrade is queued, and leaves the index alone", async () => {
    // Queued in a multisig: only the implementation file changes; the proxy still runs IMPL.
    await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying({ MyContract_Implementation: proxyFiles(NEW_IMPL).MyContract_Implementation }),
    );

    expect(await readRecord(deploymentsDir, NEW_IMPL)).toMatchObject({ address: NEW_IMPL });
    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ implementation: IMPL });
  });

  it("moves the index once the upgrade has executed", async () => {
    await deployOverride(
      {},
      makeHre(makeMockChain(chainState(NEW_IMPL))) as never,
      deploying(proxyFiles(NEW_IMPL)),
    );

    expect(await readRecord(deploymentsDir, NEW_IMPL)).toBeDefined();
    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ implementation: NEW_IMPL });
  });

  it("does not rewrite an index entry whose state did not change", async () => {
    const chain = makeMockChain({ ...chainState(IMPL), blockNumber: 999 });
    await deployOverride(
      {},
      makeHre(chain) as never,
      deploying({ MyContract: { ...proxyFiles(IMPL).MyContract, receipt: { again: true } } }),
    );

    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ observedAtBlock: 100 });
  });
});

describe("what gets recorded", () => {
  it("does not record a changed contract no proxy's deployment describes", async () => {
    const state = chainState(IMPL);
    state.code![OTHER] = DEPLOYED;

    await deployOverride(
      {},
      makeHre(makeMockChain(state)) as never,
      deploying({
        Standalone: {
          address: OTHER,
          contractName: "Standalone",
          sourceName: "contracts/Standalone.sol",
          deployedBytecode: COMPILED,
        },
      }),
    );

    expect(await readRecord(deploymentsDir, OTHER)).toBeUndefined();
  });

  it("does nothing when the deploy changed no file", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    const chain = liveChain();

    await deployOverride({}, makeHre(chain) as never, deploying({}));

    // The chain is read before the deploy, but nothing is recorded or indexed.
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(await readIndex(deploymentsDir, PROXY)).toBeUndefined();
  });

  it("keeps an existing record untouched", async () => {
    await mkdir(join(deploymentsDir, ".storage-layouts", "implementations"), { recursive: true });
    const existing = { format: 1, address: IMPL, bytecodeMatch: "exact", marker: "keep" };
    await writeFile(
      join(deploymentsDir, ".storage-layouts", "implementations", `${IMPL}.json`),
      JSON.stringify(existing),
    );

    await deployOverride({}, makeHre(liveChain()) as never, deploying(proxyFiles(IMPL)));

    expect(await readRecord(deploymentsDir, IMPL)).toEqual(existing);
  });
});

describe("failure handling", () => {
  it("still deploys when reading the deployment files before it fails", async () => {
    // A directory where a deployment file should be: hashing it throws.
    await mkdir(join(deploymentsDir, "Broken.json"));
    const run = deploying(proxyFiles(IMPL));

    const result = await deployOverride({}, makeHre(liveChain()) as never, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toBe("deploy-result");
  });

  it("deploys without --network, whose value Hardhat leaves undefined, and records nothing", async () => {
    const hre = makeHre(liveChain());
    hre.globalOptions.network = undefined;
    const run = deploying(proxyFiles(IMPL));

    const result = await deployOverride({}, hre as never, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toBe("deploy-result");
    expect(hre.network.create).not.toHaveBeenCalled();
  });

  it("skips recording when no RPC is reachable, without failing the deploy", async () => {
    const result = await deployOverride(
      {},
      makeHre(makeDeadChain()) as never,
      deploying(proxyFiles(IMPL)),
    );

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("does not fail the deploy when discovery throws", async () => {
    const chain = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    chain.send.mockResolvedValueOnce("0x1"); // the reachability probe

    const result = await deployOverride({}, makeHre(chain) as never, deploying(proxyFiles(IMPL)));

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
  });

  it("skips hardhat-deploy's fork mode, whose deployments exist only on the fork", async () => {
    const chain = liveChain();
    vi.stubEnv("HARDHAT_FORK", "mainnet");
    try {
      await deployOverride({}, makeHre(chain) as never, deploying(proxyFiles(IMPL)));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(await readIndex(deploymentsDir, PROXY)).toBeUndefined();
    expect(chain.send).not.toHaveBeenCalled();
  });

  it("skips recording when the RPC answers for another chain than the deployments", async () => {
    await writeFile(join(deploymentsDir, ".chain"), JSON.stringify({ chainId: "5" }));
    const warn = vi.mocked(console.warn);

    const result = await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying(proxyFiles(IMPL)),
    );

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(await readIndex(deploymentsDir, PROXY)).toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/answers for chain 1/);
  });

  it("skips in-process networks, whose fresh chain cannot hold what was deployed", async () => {
    const chain = liveChain();
    const result = await deployOverride(
      {},
      makeHre(chain, "edr-simulated") as never,
      deploying(proxyFiles(IMPL)),
    );

    expect(result).toBe("deploy-result");
    expect(await readRecord(deploymentsDir, IMPL)).toBeUndefined();
    expect(chain.send).not.toHaveBeenCalled();
  });

  it("does not fail the deploy when an existing record is malformed", async () => {
    await mkdir(join(deploymentsDir, ".storage-layouts", "implementations"), { recursive: true });
    await writeFile(
      join(deploymentsDir, ".storage-layouts", "implementations", `${IMPL}.json`),
      "{ not json",
    );

    const result = await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying(proxyFiles(IMPL)),
    );

    expect(result).toBe("deploy-result");
  });

  it("only touches the --network deployment directory", async () => {
    const mainnetDir = join(tmpDir, "deployments", "mainnet");
    await mkdir(mainnetDir, { recursive: true });

    await deployOverride(
      {},
      makeHre(liveChain()) as never,
      deploying(proxyFiles(IMPL), () => mainnetDir),
    );

    expect(await readRecord(mainnetDir, IMPL)).toBeUndefined();
    expect(await readIndex(mainnetDir, PROXY)).toBeUndefined();
  });

  it("handles a first deploy to a network with no deployments directory yet", async () => {
    await rm(deploymentsDir, { recursive: true });
    const run = vi.fn().mockImplementation(async () => {
      await mkdir(deploymentsDir, { recursive: true });
      await writeDeployments(deploymentsDir, proxyFiles(IMPL));
      return "deploy-result";
    });

    await deployOverride({}, makeHre(liveChain()) as never, run);

    expect(await readRecord(deploymentsDir, IMPL)).toBeDefined();
  });
});

// A proxy this run moved to another implementation must be storage-compatible
// with the one it ran before. The deploy already happened: report and exit 1.
describe("in-place upgrades", () => {
  const renamedLayout = {
    ...testLayout,
    storage: [{ ...testLayout.storage[0]!, label: "renamed" }],
  };
  const appendedLayout = {
    ...testLayout,
    storage: [...testLayout.storage, { ...testLayout.storage[0]!, label: "extra", slot: "1" }],
  };

  async function indexedAt(impl: string) {
    const store = join(deploymentsDir, ".storage-layouts");
    await writeLayoutRecord(store, {
      format: 1,
      address: impl,
      chainId: 1,
      codeSha256: "00".repeat(32),
      contract: LOGIC_FQN,
      bytecodeMatch: "exact",
      source: "local-compile",
      recordedAt: "2026-01-01T00:00:00.000Z",
      layout: testLayout,
    });
    await updateProxyEntry(store, {
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: impl,
      deployments: ["MyContract"],
      observedAtBlock: 1,
    });
  }

  // The chain runs IMPL until the deploy, then NEW_IMPL, as a real upgrade does.
  async function upgradeTo(newLayout: unknown, deployFiles = true) {
    vi.mocked(getContractBuildData).mockResolvedValue({ upgradeStorageLayout: newLayout } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let current = makeMockChain(chainState(IMPL));
    const provider = { send: vi.fn((m: string, p?: unknown[]) => current.send(m, p)) };
    const deploy = vi.fn().mockImplementation(async () => {
      current = makeMockChain(chainState(NEW_IMPL));
      if (deployFiles) {
        await writeDeployments(deploymentsDir, {
          MyContract: { ...proxyFiles(NEW_IMPL).MyContract, receipt: { upgraded: true } },
          MyContract_Implementation: proxyFiles(NEW_IMPL).MyContract_Implementation,
        });
      } else {
        await writeDeployments(deploymentsDir, { Unrelated: { address: OTHER, receipt: 1 } });
      }
    });
    await deployOverride({}, makeHre(provider) as never, deploy);
    return err.mock.calls.flat().join("\n");
  }

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("exits 1 with OZ's report when the new implementation is incompatible", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await indexedAt(IMPL);
    const errors = await upgradeTo(renamedLayout);
    expect(process.exitCode).toBe(1);
    expect(errors).toMatch(/not storage-compatible with the one it replaced/);
    expect(errors).toContain(`It replaced ${IMPL}; if nothing has written`);
    expect(errors).toContain(`upgrading back to ${IMPL} restores it.`);
    expect(await readIndex(deploymentsDir, PROXY)).toMatchObject({ implementation: NEW_IMPL });
  });

  it("passes a compatible upgrade", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await indexedAt(IMPL);
    expect(await upgradeTo(appendedLayout)).toBe("");
    expect(process.exitCode).toBeUndefined();
    expect(await readRecord(deploymentsDir, NEW_IMPL)).toMatchObject({ address: NEW_IMPL });
  });

  it("without an index, checks against the deprecated field at the proxy's address", async () => {
    await writeDeployments(deploymentsDir, {
      ...proxyFiles(IMPL),
      MyContract: { ...proxyFiles(IMPL).MyContract, upgradeStorageLayout: testLayout },
    });
    const errors = await upgradeTo(renamedLayout);
    expect(process.exitCode).toBe(1);
    expect(errors).toMatch(/not storage-compatible/);
  });

  it("checks against what the chain ran before the deploy, not a stale index", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    // The index still names OTHER (upgraded outside these tools since); the chain runs IMPL.
    await indexedAt(IMPL);
    await updateProxyEntry(join(deploymentsDir, ".storage-layouts"), {
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: OTHER,
      deployments: ["MyContract"],
      observedAtBlock: 1,
    });
    const errors = await upgradeTo(renamedLayout);
    expect(errors).toMatch(/not storage-compatible with the one it replaced/);
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when the previous implementation has no layout record", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    const errors = await upgradeTo(appendedLayout);
    expect(errors).toMatch(/has no layout record, so the upgrade was not checked/);
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 when the new implementation's layout cannot be recorded", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await indexedAt(IMPL);
    vi.mocked(getContractBuildData).mockResolvedValue({ upgradeStorageLayout: undefined } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let current = makeMockChain(chainState(IMPL));
    const provider = { send: vi.fn((m: string, p?: unknown[]) => current.send(m, p)) };
    await deployOverride(
      {},
      makeHre(provider) as never,
      vi.fn().mockImplementation(async () => {
        current = makeMockChain(chainState(NEW_IMPL));
        await writeDeployments(deploymentsDir, {
          MyContract: { ...proxyFiles(NEW_IMPL).MyContract, receipt: { upgraded: true } },
        });
      }),
    );
    expect(err.mock.calls.flat().join("\n")).toMatch(/could not be recorded.*not checked/);
    expect(process.exitCode).toBe(1);
  });

  it("checks a proxy the chain moved even when its file did not change (e.g. a beacon)", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await indexedAt(IMPL);
    const errors = await upgradeTo(renamedLayout, false);
    expect(errors).toMatch(/not storage-compatible/);
    expect(process.exitCode).toBe(1);
  });

  it("one proxy's unreadable record does not hide another's result", async () => {
    await writeDeployments(deploymentsDir, proxyFiles(IMPL));
    await indexedAt(IMPL);
    await writeFile(
      join(deploymentsDir, ".storage-layouts", "implementations", `${IMPL}.json`),
      "<<<<<<< HEAD\n",
    );
    const errors = await upgradeTo(renamedLayout);
    expect(errors).toMatch(/could not check the upgrade this run made/);
    expect(process.exitCode).toBe(1);
  });

  it("does not compare a new proxy against an old field at another address", async () => {
    await writeDeployments(deploymentsDir, {
      MyContract: { address: OTHER, ...logicArtifact, upgradeStorageLayout: testLayout },
    });
    // The deploy puts MyContract at PROXY, a first deployment there.
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: renamedLayout,
    } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await deployOverride({}, makeHre(liveChain()) as never, deploying(proxyFiles(IMPL)));
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
