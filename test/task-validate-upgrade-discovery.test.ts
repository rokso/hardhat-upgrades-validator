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

vi.mock("../src/plugin/internals/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { readProxyEntry, writeLayoutRecord } from "../src/core/onchain/store.js";
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
  },
  Box_Proxy: {
    address: PROXY,
    contractName: "ERC1967Proxy",
    sourceName: "src/ERC1967Proxy.sol",
    deployedBytecode: PROXY_CODE,
  },
  Box_Implementation: {
    address: IMPL,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
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

const args = (over: Record<string, unknown>) => ({
  contract: undefined,
  all: false,
  unsafeAllow: "",
  unsafeSkipStorageCheck: false,
  proxyKind: "",
  network: "mainnet",
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

  it("offline without an index finds nothing to validate", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/No proxy deployments found/);
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
