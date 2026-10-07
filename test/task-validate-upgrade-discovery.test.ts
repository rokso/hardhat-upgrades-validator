/**
 * validate-upgrade against hardhat-deploy v2 deployment files, with real
 * proxy discovery: only the code behind a proxy is validated, the proxy
 * contract's own file and bare implementations are skipped, and offline runs
 * rely on the proxy index rather than file names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
  };
});

vi.mock("../src/plugin/internals/validations-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/validations-cache.js")>()),
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { readProxyEntry, readScanMarker, writeLayoutRecord } from "../src/core/onchain/store.js";
import { codeSha256 } from "../src/core/onchain/implementation.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const LOGIC_CODE = "0x6080604052" + "11".repeat(32);
const PROXY_CODE = "0x60806040" + "cd".repeat(16);

const layout = { storage: [], types: {}, namespaces: {} };

const files = {
  Box: {
    address: PROXY,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
    immutableReferences: {},
  },
  Box_Proxy: {
    address: PROXY,
    contractName: "ERC1967Proxy",
    sourceName: "src/ERC1967Proxy.sol",
    deployedBytecode: PROXY_CODE,
    immutableReferences: {},
  },
  Box_Implementation: {
    address: IMPL,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
    immutableReferences: {},
  },
};

let tmpDir: string;
let deploymentsDir: string;
let logs: string[];

const chain = () =>
  makeMockChain({
    code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE },
    implementations: { [PROXY]: IMPL },
  });

function makeHre(provider: { send: unknown } | undefined) {
  return {
    globalOptions: { network: "mainnet" },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
    artifacts: {},
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

const args = (over: Record<string, unknown>) => ({
  contract: undefined,
  all: false,
  unsafeAllow: "",
  unsafeSkipStorageCheck: false,
  proxyKind: "",
  ...over,
});

const validated = () =>
  vi.mocked(getContractBuildData).mock.calls.map(([artifactName]) => artifactName);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-vudisc-"));
  deploymentsDir = join(tmpDir, "deployments", "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(deploymentsDir, `${name}.json`), JSON.stringify(data), "utf8");
  }
  await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), {
    format: 1,
    address: IMPL,
    chainId: 1,
    codeSha256: codeSha256(LOGIC_CODE),
    contract: "src/Box.sol:Box",
    bytecodeMatch: "exact",
    source: "local-compile",
    recordedAt: "2026-01-01T00:00:00.000Z",
    layout: layout as never,
  });
  vi.clearAllMocks();
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: layout,
    unsafeAllowFromAnnotation: [],
    perVariableUnsafeAllow: new Map(),
    namespaceUnsafeAllow: new Map(),
    safetyErrors: [],
    proxyKind: undefined,
  } as never);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(tmpDir, { recursive: true });
});

describe("validate-upgrade --all", () => {
  it("online: validates only the deployment describing the proxy's code, and indexes it", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(logs.join("\n")).toMatch(/mainnet\/Box/);
    expect(logs.join("\n")).not.toMatch(/Box_Proxy|Box_Implementation/);
    expect(await readProxyEntry(join(deploymentsDir, ".storage-layouts"), PROXY)).toMatchObject({
      implementation: IMPL,
      deployments: ["Box"],
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("offline: validates what the index lists, against the indexed implementation's record", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    vi.mocked(getContractBuildData).mockClear();
    logs = [];

    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(logs.join("\n")).toMatch(/as of block 100/);
  });

  it("offline: fails an indexed proxy whose implementation has no record, instead of skipping it", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    await rm(join(deploymentsDir, ".storage-layouts", "implementations"), { recursive: true });
    logs = [];

    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(logs.join("\n")).toMatch(
      /\[ERROR\] "mainnet\/Box": No baseline for "Box": no layout record for 0x0+bb/,
    );
    expect(process.exitCode).toBe(1);
  });

  it("offline without an index finds nothing to validate", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/No proxy deployments found/);
  });
});

describe("validate-upgrade --all discovery errors", () => {
  it("reports a failing address as an error and validates the rest", async () => {
    const BROKEN = "0x00000000000000000000000000000000000000dd";
    await writeFile(
      join(deploymentsDir, "Broken.json"),
      JSON.stringify({ address: BROKEN }),
      "utf8",
    );
    const provider = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE, [BROKEN]: PROXY_CODE },
      implementations: { [PROXY]: IMPL },
      beacons: { [BROKEN]: "0x00000000000000000000000000000000000000ee" },
    });

    await validateUpgradeAction(args({ all: true }), makeHre(provider) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(logs.join("\n")).toMatch(/\[ERROR\] "mainnet" 0x0+dd \("Broken"\)/);
    expect(process.exitCode).toBe(1);
    // Not a complete scan, so later deploys keep classifying everything.
    expect(await readScanMarker(join(deploymentsDir, ".storage-layouts"))).toBeUndefined();
  });
});

describe("validate-upgrade without the new layout", () => {
  it("fails a proxy whose new layout is missing, instead of skipping it", async () => {
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: undefined,
      unsafeAllowFromAnnotation: [],
      perVariableUnsafeAllow: new Map(),
      namespaceUnsafeAllow: new Map(),
      safetyErrors: [],
      proxyKind: undefined,
    } as never);

    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);

    expect(logs.join("\n")).toMatch(
      /\[ERROR\] "mainnet\/Box": the validation cache is missing.*hardhat compile/,
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("validate-upgrade on the wrong chain", () => {
  // An RPC for another chain: nothing is a proxy there.
  const otherChain = () => makeMockChain({ chainId: 11155111 });

  it("fails when the RPC's chain differs from the recorded one, instead of finding no proxies", async () => {
    await writeFile(join(deploymentsDir, ".chain"), JSON.stringify({ chainId: "1" }));

    await validateUpgradeAction(args({ all: true }), makeHre(otherChain()) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/\[ERROR\] "mainnet": The RPC answers for chain 11155111/);
    expect(logs.join("\n")).not.toMatch(/No proxy deployments found/);
    expect(process.exitCode).toBe(1);
  });

  it("fails for a single contract too, before deciding it is not a proxy", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    logs = [];

    await validateUpgradeAction(args({ contract: "Box" }), makeHre(otherChain()) as never);

    expect(logs.join("\n")).toMatch(/records chain 1/);
    expect(logs.join("\n")).not.toMatch(/\[SKIP\]/);
    expect(process.exitCode).toBe(1);
  });

  it("reports an indexed proxy the chain no longer shows, even with no chain id recorded elsewhere", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    logs = [];
    // Same chain id, but the proxy is gone (say, a node reset under the files).
    await validateUpgradeAction(args({ all: true }), makeHre(makeMockChain()) as never);

    expect(logs.join("\n")).toMatch(
      /\[ERROR\] "mainnet" 0x0+aa \("Box"\): the proxy index has it as a proxy running 0x0+bb/,
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("validate-upgrade messages", () => {
  it("does not claim the network has no proxies when discovery failed for some", async () => {
    await rm(join(deploymentsDir, "Box.json"));
    const provider = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE },
      beacons: { [PROXY]: "0x00000000000000000000000000000000000000ee" },
    });

    await validateUpgradeAction(args({ all: true }), makeHre(provider) as never);

    const out = logs.join("\n");
    expect(out).toMatch(/\[ERROR\]/);
    expect(out).toMatch(/No other proxy deployments found/);
    expect(process.exitCode).toBe(1);
  });

  it("offline: skips a file the index does not list for its proxy, even with the deprecated field", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    await writeFile(
      join(deploymentsDir, "Box_Proxy.json"),
      JSON.stringify({ ...files.Box_Proxy, upgradeStorageLayout: layout }),
      "utf8",
    );
    vi.mocked(getContractBuildData).mockClear();
    logs = [];

    await validateUpgradeAction(args({ contract: "Box_Proxy" }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/the proxy index lists another deployment/);
  });
});

describe("validate-upgrade --contract", () => {
  it("skips the file that describes the proxy contract itself", async () => {
    await validateUpgradeAction(args({ contract: "Box_Proxy" }), makeHre(chain()) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/describes the proxy contract itself/);
  });

  it("skips a bare implementation, which is not a proxy", async () => {
    await validateUpgradeAction(
      args({ contract: "Box_Implementation" }),
      makeHre(chain()) as never,
    );

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/not a proxy on this chain/);
  });

  it("offline: skips a deployment the index does not know", async () => {
    await validateUpgradeAction(args({ contract: "Box" }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/not known as a proxy's code offline/);
  });
});
