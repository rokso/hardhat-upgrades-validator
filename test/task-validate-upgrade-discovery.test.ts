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

vi.mock("../src/plugin/internals/build-analysis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/build-analysis.js")>()),
  createBuildAnalyzer: vi.fn(),
}));

import validateUpgradeAction from "../src/plugin/tasks/validate-upgrade.js";
import { createBuildAnalyzer } from "../src/plugin/internals/build-analysis.js";
import { fakeAnalysis } from "./helpers/analysis.js";
import { readProxyEntry, writeLayoutRecord } from "../src/core/onchain/store.js";
import { codeSha256 } from "./helpers/code-hash.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";

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
  unsafeAllowRenames: false,
  unsafeSkipStorageCheck: false,
  proxyKind: "",
  ...over,
});

const analyze = vi.fn();

const validated = () => analyze.mock.calls.map(([artifactName]) => artifactName);

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
  vi.mocked(createBuildAnalyzer).mockReturnValue(analyze);
  analyze.mockResolvedValue(fakeAnalysis(layout as never));
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
    analyze.mockClear();
    logs = [];

    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(logs.join("\n")).toMatch(/as of block 100/);
  });

  it("an unreachable RPC falls back to the index and says so", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);
    analyze.mockClear();
    logs = [];

    await validateUpgradeAction(args({ all: true }), makeHre(makeDeadChain()) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    const out = logs.join("\n");
    expect(out).toMatch(/as of block 100/);
    expect(out).toMatch(/Could not read a chain baseline for "Box", fell back to an offline one/);
    // Passes on the offline index: nothing yet makes CI insist on the chain.
    expect(process.exitCode).toBeUndefined();
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
  });
});

describe("validate-upgrade without the new layout", () => {
  it("fails a proxy whose new code cannot be analyzed, instead of skipping it", async () => {
    analyze.mockRejectedValue(
      new Error("build info x lacks output: run `hardhat compile --force`."),
    );

    await validateUpgradeAction(args({ all: true }), makeHre(chain()) as never);

    expect(logs.join("\n")).toMatch(
      /\[ERROR\] "mainnet\/Box": build info x lacks output: run `hardhat compile --force`/,
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
    analyze.mockClear();
    logs = [];

    await validateUpgradeAction(args({ contract: "Box_Proxy" }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/the proxy index lists another deployment/);
  });
});

describe("proxies the chain or the index lost", () => {
  async function indexBox() {
    const { updateProxyEntry } = await import("../src/core/onchain/store.js");
    await updateProxyEntry(join(deploymentsDir, ".storage-layouts"), {
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      deployments: ["Box"],
      observedAtBlock: 7,
    });
  }

  it("--contract fails for an indexed proxy the chain no longer shows", async () => {
    await indexBox();
    const empty = makeMockChain({ code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE } });

    await validateUpgradeAction(args({ contract: "Box" }), makeHre(empty) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(
      /\[ERROR\] "mainnet\/Box": the proxy index has 0x0+aa as a proxy/,
    );
    expect(process.exitCode).toBe(1);
  });

  it("offline --all fails an index entry whose file was renamed", async () => {
    await indexBox();
    await rm(join(deploymentsDir, "Box.json"));
    await writeFile(join(deploymentsDir, "BoxRenamed.json"), JSON.stringify(files.Box), "utf8");

    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(logs.join("\n")).toMatch(/\[ERROR\] "mainnet" 0x0+aa .*no such file is at its address/);
    expect(process.exitCode).toBe(1);
  });

  it("offline --all names the deployments the index does not cover", async () => {
    await validateUpgradeAction(args({ all: true }), makeHre(undefined) as never);

    expect(logs.join("\n")).toMatch(
      /\[WARN\] "mainnet": offline, 3 deployment\(s\) the proxy index does not cover were not checked/,
    );
  });

  it("offline: says when it validated against the deprecated field", async () => {
    await writeFile(
      join(deploymentsDir, "Box.json"),
      JSON.stringify({ ...files.Box, upgradeStorageLayout: layout }),
      "utf8",
    );

    await validateUpgradeAction(args({ contract: "Box" }), makeHre(undefined) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(logs.join("\n")).toMatch(/deprecated upgradeStorageLayout field/);
  });
});

describe("validate-upgrade --contract", () => {
  it("online: validates the proxy's code against the chain and refreshes its index entry", async () => {
    await validateUpgradeAction(args({ contract: "Box" }), makeHre(chain()) as never);

    expect(validated()).toEqual(["src/Box.sol:Box"]);
    expect(await readProxyEntry(join(deploymentsDir, ".storage-layouts"), PROXY)).toMatchObject({
      implementation: IMPL,
      deployments: ["Box"],
    });
  });

  it("online: fails when the chain cannot classify the address", async () => {
    // A beacon proxy whose beacon has no implementation() to call.
    const provider = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE },
      beacons: { [PROXY]: "0x00000000000000000000000000000000000000ee" },
    });

    await validateUpgradeAction(args({ contract: "Box" }), makeHre(provider) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/\[ERROR\] "mainnet\/Box"/);
    expect(process.exitCode).toBe(1);
  });

  it("names a proxy whose only file describes the proxy contract itself", async () => {
    await rm(join(deploymentsDir, "Box.json"));

    await validateUpgradeAction(args({ contract: "Box_Proxy" }), makeHre(chain()) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/describes the proxy contract itself/);
    expect(logs.join("\n")).not.toMatch(/not a proxy/);
  });

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

  it("offline: fails a deployment the index does not know (it cannot be checked)", async () => {
    await validateUpgradeAction(args({ contract: "Box" }), makeHre(undefined) as never);

    expect(validated()).toEqual([]);
    expect(logs.join("\n")).toMatch(/\[ERROR\] "mainnet\/Box": no baseline/);
    expect(process.exitCode).toBe(1);
  });
});
