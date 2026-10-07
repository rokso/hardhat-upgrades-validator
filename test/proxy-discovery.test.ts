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
  isIndexedLogic,
  listProxyDeployments,
} from "../src/plugin/internals/proxy-discovery.js";
import { readDeployments } from "../src/plugin/internals/deployment-files.js";
import { listProxyEntries, readProxyEntry, updateProxyEntry } from "../src/core/onchain/store.js";
import { makeMockChain, type MockChainState } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const BEACON = "0x00000000000000000000000000000000000000ee";
const PLAIN = "0x00000000000000000000000000000000000000ff";

const LOGIC_CODE = "0x6080604052" + "11".repeat(32);
// A proxy contract with an immutable (e.g. an admin address) at byte 4.
const PROXY_COMPILED = "0x60806040" + "00".repeat(20) + "cd".repeat(8);
const PROXY_IMMUTABLES = { "3": [{ start: 4, length: 20 }] };
const PROXY_ONCHAIN = "0x60806040" + "99".repeat(20) + "cd".repeat(8);

const boxFiles = {
  Box: {
    address: PROXY,
    contractName: "Box",
    sourceName: "src/Box.sol",
    deployedBytecode: LOGIC_CODE,
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
  },
  Plain: {
    address: PLAIN,
    contractName: "Plain",
    sourceName: "src/Plain.sol",
    deployedBytecode: "0x00",
  },
};

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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-discovery-"));
  deploymentsDir = join(tmpDir, "deployments", "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
  await writeDeployments(boxFiles);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

describe("discoverProxies", () => {
  it("finds the proxy and the file describing its code, not the proxy contract's own file", async () => {
    const found = await discoverProxies(
      makeMockChain(chainState()),
      await readDeployments(deploymentsDir),
    );
    expect(found).toEqual([{ proxy: PROXY, implementation: IMPL, deployments: ["Box"] }]);
  });

  it("does not rely on names: renamed files classify the same", async () => {
    await rm(deploymentsDir, { recursive: true });
    await mkdir(deploymentsDir, { recursive: true });
    await writeDeployments({
      Vault: boxFiles.Box,
      VaultFrontDoor: boxFiles.Box_Proxy,
      Box_Proxy: boxFiles.Box_Implementation, // a misleading name for the implementation
    });
    const found = await discoverProxies(
      makeMockChain(chainState()),
      await readDeployments(deploymentsDir),
    );
    expect(found).toEqual([{ proxy: PROXY, implementation: IMPL, deployments: ["Vault"] }]);
  });

  it("follows a beacon proxy to its beacon's implementation", async () => {
    const state = chainState();
    state.implementations = {};
    state.beacons = { [PROXY]: BEACON };
    state.beaconImplementations = { [BEACON]: IMPL };
    const found = await discoverProxies(
      makeMockChain(state),
      await readDeployments(deploymentsDir),
    );
    expect(found).toEqual([
      { proxy: PROXY, implementation: IMPL, beacon: BEACON, deployments: ["Box"] },
    ]);
  });

  it("treats a file without code at a proxy address as describing the logic", async () => {
    await writeDeployments({ Box: { address: PROXY } });
    const found = await discoverProxies(
      makeMockChain(chainState()),
      await readDeployments(deploymentsDir),
    );
    expect(found[0].deployments).toEqual(["Box"]);
  });

  it("reads only the requested addresses", async () => {
    const chain = makeMockChain(chainState());
    await discoverProxies(chain, await readDeployments(deploymentsDir), new Set([PLAIN]));
    const touched = chain.send.mock.calls.map(([, params]) => String((params as unknown[])[0]));
    expect(touched.every((a) => a === PLAIN)).toBe(true);
  });

  it("warns about a proxy whose only file describes the proxy contract itself", async () => {
    await rm(join(deploymentsDir, "Box.json"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const found = await discoverProxies(
      makeMockChain(chainState()),
      await readDeployments(deploymentsDir),
    );
    expect(found).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/no deployment describes the code behind it/);
    warn.mockRestore();
  });

  it("skips an address with a slot set but no code", async () => {
    const state = chainState();
    delete state.code![PROXY];
    const found = await discoverProxies(
      makeMockChain(state),
      await readDeployments(deploymentsDir),
    );
    expect(found).toEqual([]);
  });
});

describe("classifyDeployment", () => {
  it("tells the three roles apart", async () => {
    const chain = makeMockChain(chainState());
    expect(await classifyDeployment(chain, boxFiles.Box)).toEqual({
      role: "logic",
      proxy: PROXY,
      state: { implementation: IMPL },
    });
    expect(await classifyDeployment(chain, boxFiles.Box_Proxy)).toEqual({ role: "proxy-contract" });
    expect(await classifyDeployment(chain, boxFiles.Box_Implementation)).toEqual({
      role: "not-proxy",
    });
    expect(await classifyDeployment(chain, boxFiles.Plain)).toEqual({ role: "not-proxy" });
  });
});

describe("listProxyDeployments", () => {
  it("online: discovers from the chain and writes the proxy index", async () => {
    const names = await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
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

  it("offline: lists what the index names, plus files with the deprecated field", async () => {
    await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
    await writeDeployments({
      Legacy: { address: PLAIN, upgradeStorageLayout: { storage: [], types: {} } },
    });

    expect(await listProxyDeployments(deploymentsDir)).toEqual(["Box", "Legacy"]);
  });

  it("offline: drops an indexed name whose file now points elsewhere", async () => {
    await listProxyDeployments(deploymentsDir, makeMockChain(chainState()));
    await writeDeployments({ Box: { ...boxFiles.Box, address: PLAIN } }); // redeployed

    expect(await listProxyDeployments(deploymentsDir)).toEqual([]);
  });

  it("offline with no index lists nothing but deprecated-field files", async () => {
    expect(await listProxyDeployments(deploymentsDir)).toEqual([]);
    expect(await listProxyEntries(storeDir())).toEqual([]);
  });
});

describe("isIndexedLogic", () => {
  it("is true only for a name the index lists for that address", async () => {
    await updateProxyEntry(storeDir(), {
      format: 1,
      proxy: PROXY,
      chainId: 1,
      implementation: IMPL,
      deployments: ["Box"],
      observedAtBlock: 1,
    });
    expect(await isIndexedLogic(deploymentsDir, "Box", boxFiles.Box)).toBe(true);
    expect(await isIndexedLogic(deploymentsDir, "Box_Proxy", boxFiles.Box_Proxy)).toBe(false);
    expect(await isIndexedLogic(deploymentsDir, "Box", { ...boxFiles.Box, address: PLAIN })).toBe(
      false,
    );
  });
});
