/**
 * Proxy discovery: which deployments are proxies, and which file describes
 * the code behind each one, decided from the chain and file contents only.
 *
 * Fixtures are shaped as hardhat-deploy v2 writes a proxy deployment named
 * "Box": `Box` (proxy address, implementation artifact), `Box_Proxy` (proxy
 * address, proxy artifact), `Box_Implementation` (implementation address).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  classifyDeployment,
  discoverProxies,
  indexedRole,
  listProxyDeployments,
  type LocalCodeLookup,
} from "../src/plugin/internals/proxy-discovery.js";
import { readDeployments } from "../src/plugin/internals/deployment-files.js";
import { listProxyEntries, readProxyEntry, updateProxyEntry } from "../src/core/onchain/store.js";
import { makeMockChain, type MockChainState } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const PROXY2 = "0x00000000000000000000000000000000000000cc";
const BEACON = "0x00000000000000000000000000000000000000ee";
const PLAIN = "0x00000000000000000000000000000000000000ff";

const LOGIC_CODE = "0x6080604052" + "11".repeat(32);
// A proxy contract reading an immutable (e.g. an admin address) with a PUSH32
// whose operand, at byte 6, solc leaves zeroed.
const PROXY_COMPILED = "0x6080604052" + "7f" + "00".repeat(32) + "cd".repeat(8);
const PROXY_IMMUTABLES = { "3": [{ start: 6, length: 32 }] };
const PROXY_ONCHAIN = "0x6080604052" + "7f" + "00".repeat(12) + "99".repeat(20) + "cd".repeat(8);

const boxFiles = {
  Box: {
    address: PROXY,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
    immutableReferences: {},
  },
  Box_Proxy: {
    address: PROXY,
    contractName: "TransparentProxy",
    sourceName: "src/proxy/TransparentProxy.sol",
    deployedBytecode: PROXY_COMPILED,
    immutableReferences: PROXY_IMMUTABLES,
  },
  Box_Implementation: {
    address: IMPL,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
    immutableReferences: {},
  },
  Plain: {
    address: PLAIN,
    contractName: "Plain",
    sourceName: "src/Plain.sol",
    deployedBytecode: "0x00",
    immutableReferences: {},
  },
};

// The local build, as Hardhat artifacts would give it.
const localBuild: LocalCodeLookup = async (_name, d) =>
  d.contractName === "TransparentProxy"
    ? { deployedBytecode: PROXY_COMPILED, immutableReferences: PROXY_IMMUTABLES }
    : d.contractName === "Box"
      ? { deployedBytecode: LOGIC_CODE, immutableReferences: {} }
      : undefined;

function without<T extends object>(d: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...d };
  delete copy[key];
  return copy;
}

const chainState = (): MockChainState => ({
  blockNumber: 7,
  code: { [PROXY]: PROXY_ONCHAIN, [IMPL]: LOGIC_CODE, [PLAIN]: "0x00" },
  implementations: { [PROXY]: IMPL },
});

let tmpDir: string;
let deploymentsDir: string;
const storeDir = () => join(deploymentsDir, ".storage-layouts");

async function writeDeployments(files: Record<string, object>) {
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(deploymentsDir, `${name}.json`), JSON.stringify(data), "utf8");
  }
}

const discover = async (state = chainState(), localCode?: LocalCodeLookup) =>
  discoverProxies(makeMockChain(state), await readDeployments(deploymentsDir), { localCode });

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-discovery-"));
  deploymentsDir = join(tmpDir, "deployments", "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
  await writeDeployments(boxFiles);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true });
});

describe("discoverProxies", () => {
  it("finds the proxy and the file describing its code, not the proxy contract's own file", async () => {
    expect(await discover()).toEqual({
      proxies: [{ proxy: PROXY, implementation: IMPL, deployments: ["Box"] }],
      errors: [],
    });
  });

  it("does not rely on names: renamed files classify the same", async () => {
    await rm(deploymentsDir, { recursive: true });
    await mkdir(deploymentsDir, { recursive: true });
    await writeDeployments({
      Vault: boxFiles.Box,
      VaultFrontDoor: boxFiles.Box_Proxy,
      Box_Proxy: boxFiles.Box_Implementation, // a misleading name for the implementation
    });
    expect((await discover()).proxies).toEqual([
      { proxy: PROXY, implementation: IMPL, deployments: ["Vault"] },
    ]);
  });

  it("follows a beacon proxy to its beacon's implementation", async () => {
    const state = chainState();
    state.implementations = {};
    state.beacons = { [PROXY]: BEACON };
    state.beaconImplementations = { [BEACON]: IMPL };
    expect((await discover(state)).proxies).toEqual([
      { proxy: PROXY, implementation: IMPL, beacon: BEACON, deployments: ["Box"] },
    ]);
  });

  it("warns about a proxy whose only file describes the proxy contract itself", async () => {
    await rm(join(deploymentsDir, "Box.json"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await discover()).toEqual({ proxies: [], errors: [] });
    expect(warn.mock.calls.flat().join("\n")).toMatch(/no deployment describes the code behind it/);
  });

  it("reads only the requested addresses", async () => {
    const chain = makeMockChain(chainState());
    await discoverProxies(chain, await readDeployments(deploymentsDir), {
      only: new Set([PLAIN]),
    });
    const touched = chain.send.mock.calls.map(([, params]) => String((params as unknown[])[0]));
    expect(touched.every((a) => a === PLAIN)).toBe(true);
  });

  it("skips an address with a slot set but no code", async () => {
    const state = chainState();
    delete state.code![PROXY];
    expect(await discover(state)).toEqual({ proxies: [], errors: [] });
  });
});

describe("files missing code or immutable positions", () => {
  it("takes the proxy's immutable positions from the local build", async () => {
    await writeDeployments({ Box_Proxy: without(boxFiles.Box_Proxy, "immutableReferences") });
    const lookup = vi.fn(localBuild);
    expect((await discover(chainState(), lookup)).proxies).toEqual([
      { proxy: PROXY, implementation: IMPL, deployments: ["Box"] },
    ]);
    expect(lookup).toHaveBeenCalledWith("Box_Proxy", expect.anything());
  });

  it("infers immutable positions from zeroed PUSH32 operands when nothing lists them", async () => {
    // As hardhat-deploy v2 ships its prebuilt proxy artifacts.
    await writeDeployments({ Box_Proxy: without(boxFiles.Box_Proxy, "immutableReferences") });
    expect(await discover()).toEqual({
      proxies: [{ proxy: PROXY, implementation: IMPL, deployments: ["Box"] }],
      errors: [],
    });
  });

  it("takes missing code from the local build, which can show the file is the proxy's own", async () => {
    await writeDeployments({ Box_Proxy: without(boxFiles.Box_Proxy, "deployedBytecode") });
    expect((await discover(chainState(), localBuild)).proxies[0].deployments).toEqual(["Box"]);
  });

  it("treats a file with no code anywhere as describing the logic", async () => {
    await writeDeployments({ Box: { address: PROXY } });
    expect((await discover()).proxies[0].deployments).toEqual(["Box"]);
  });
});

describe("per-address failures", () => {
  it("reports a broken beacon for its address and still finds the other proxies", async () => {
    await writeDeployments({
      Other: { ...boxFiles.Box, address: PROXY2 },
    });
    const state = chainState();
    state.code![PROXY2] = PROXY_ONCHAIN;
    state.beacons = { [PROXY2]: BEACON }; // implementation() reverts: no beaconImplementations
    const { proxies, errors } = await discover(state);
    expect(proxies.map((p) => p.proxy)).toEqual([PROXY]);
    expect(errors).toEqual([
      { address: PROXY2, deployments: ["Other"], reason: expect.stringMatching(/beacon/) },
    ]);
  });

  it("reports an RPC failure at one address without failing the rest", async () => {
    await writeDeployments({ Other: { ...boxFiles.Box, address: PROXY2 } });
    const chain = makeMockChain(chainState());
    const send = chain.send.getMockImplementation()!;
    chain.send.mockImplementation(async (method: string, params: unknown[] = []) => {
      if (String(params[0]).toLowerCase() === PROXY2) throw new Error("rate limited");
      return send(method, params);
    });
    const { proxies, errors } = await discoverProxies(chain, await readDeployments(deploymentsDir));
    expect(proxies.map((p) => p.proxy)).toEqual([PROXY]);
    expect(errors.map((e) => [e.address, e.reason])).toEqual([[PROXY2, "rate limited"]]);
  });
});

describe("classifyDeployment", () => {
  it("tells the three roles apart", async () => {
    const chain = makeMockChain(chainState());
    expect(await classifyDeployment(chain, "Box", boxFiles.Box)).toEqual({
      role: "logic",
      proxy: PROXY,
      state: { implementation: IMPL },
    });
    expect(await classifyDeployment(chain, "Box_Proxy", boxFiles.Box_Proxy)).toEqual({
      role: "proxy-contract",
    });
    expect(
      await classifyDeployment(chain, "Box_Implementation", boxFiles.Box_Implementation),
    ).toEqual({ role: "not-proxy" });
    expect(await classifyDeployment(chain, "Plain", boxFiles.Plain)).toEqual({ role: "not-proxy" });
  });
});

describe("listProxyDeployments", () => {
  it("online: discovers from the chain and writes the proxy index", async () => {
    const { names } = await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
    expect(names).toEqual(["Box"]);
    expect(await readProxyEntry(storeDir(), PROXY)).toEqual({
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      deployments: ["Box"],
      observedAtBlock: 7,
    });
  });

  it("online: a failed index write is a warning, not a failed discovery", async () => {
    await mkdir(join(storeDir(), "proxies"), { recursive: true });
    await writeFile(join(storeDir(), "proxies", `${PROXY}.json`), JSON.stringify({ format: 2 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { names } = await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));

    expect(names).toEqual(["Box"]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/Could not update the proxy index/);
  });

  it("offline: lists what the index names, plus deprecated-field files at unindexed addresses", async () => {
    await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
    await writeDeployments({
      Legacy: { address: PLAIN, upgradeStorageLayout: { storage: [], types: {} } },
      // At an indexed proxy, but not one the index lists: never validated against its field.
      Box_Proxy: { ...boxFiles.Box_Proxy, upgradeStorageLayout: { storage: [], types: {} } },
    });

    expect((await listProxyDeployments(deploymentsDir)).names).toEqual(["Box", "Legacy"]);
  });

  it("offline: drops an indexed name whose file now points elsewhere", async () => {
    await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
    await writeDeployments({ Box: { ...boxFiles.Box, address: PLAIN } }); // redeployed

    expect((await listProxyDeployments(deploymentsDir)).names).toEqual([]);
  });

  it("offline with no index lists nothing but deprecated-field files", async () => {
    expect((await listProxyDeployments(deploymentsDir)).names).toEqual([]);
    expect(await listProxyEntries(storeDir())).toEqual([]);
  });
});

describe("indexedRole", () => {
  it("separates listed names, other names at an indexed address, and unknown addresses", async () => {
    await updateProxyEntry(storeDir(), {
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      deployments: ["Box"],
      observedAtBlock: 1,
    });
    expect(await indexedRole(deploymentsDir, "Box", boxFiles.Box)).toBe("logic");
    expect(await indexedRole(deploymentsDir, "Box_Proxy", boxFiles.Box_Proxy)).toBe("other");
    expect(await indexedRole(deploymentsDir, "Box", { ...boxFiles.Box, address: PLAIN })).toBe(
      "unknown",
    );
  });
});
