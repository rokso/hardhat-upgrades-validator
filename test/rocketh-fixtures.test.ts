/**
 * Discovery and the deploy hook against real hardhat-deploy v2 output
 * (test/fixtures/rocketh, see its README): the deployment files rocketh
 * writes and the chain state they were deployed to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { cp, mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

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

vi.mock("../src/plugin/internals/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

import deployOverride from "../src/plugin/hooks/deploy.js";
import { getContractBuildData } from "../src/plugin/internals/deployment-utils.js";
import { readDeployments, type DeploymentFile } from "../src/plugin/internals/deployment-files.js";
import { discoverProxies } from "../src/plugin/internals/proxy-discovery.js";
import { compareDeployedBytecode } from "../src/core/bytecode-utils.js";
import { readLayoutRecord, readProxyEntry } from "../src/core/onchain/store.js";
import { makeMockChain, type MockChainState } from "./helpers/mock-chain.js";

type Snapshot = "fresh" | "upgraded" | "queued";

const FIXTURES = join(import.meta.dirname, "fixtures", "rocketh");
const layout = { storage: [], types: {}, namespaces: {} };

async function chain(snapshot: Snapshot) {
  const state = JSON.parse(
    await readFile(join(FIXTURES, `${snapshot}.chain.json`), "utf8"),
  ) as MockChainState;
  return makeMockChain(state);
}

async function files(snapshot: Snapshot): Promise<Map<string, DeploymentFile>> {
  return readDeployments(join(FIXTURES, snapshot));
}

function addressOf(deployments: Map<string, DeploymentFile>, name: string): string {
  return deployments.get(name)!.address!.toLowerCase();
}

describe("discovery on real hardhat-deploy v2 output", () => {
  it("finds each proxy and the file describing its code, for all three proxy kinds", async () => {
    const deployments = await files("fresh");
    const { proxies, errors } = await discoverProxies(await chain("fresh"), deployments);

    expect(errors).toEqual([]);
    expect(proxies.map((p) => [p.deployments, p.implementation]).sort()).toEqual(
      [
        [["Counter"], addressOf(deployments, "Counter_Implementation")],
        [["Ledger"], addressOf(deployments, "Ledger_Implementation")],
        [["Vault"], addressOf(deployments, "Vault_Implementation")],
      ].sort(),
    );
  });

  it("needs the inferred immutables: rocketh's transparent proxy file lists none", async () => {
    const deployments = await files("fresh");
    const proxyFile = deployments.get("Counter_Proxy")!;
    const state = JSON.parse(
      await readFile(join(FIXTURES, "fresh.chain.json"), "utf8"),
    ) as MockChainState;

    expect(proxyFile.immutableReferences).toBeUndefined();
    // Without inference this file would look like the code behind the proxy.
    expect(
      compareDeployedBytecode(
        state.code![proxyFile.address!.toLowerCase()],
        proxyFile.deployedBytecode!,
      ),
    ).toBe("none");
  });

  it("after executed upgrades, each proxy runs its V2 implementation", async () => {
    const deployments = await files("upgraded");
    const { proxies } = await discoverProxies(await chain("upgraded"), deployments);

    for (const name of ["Counter", "Ledger", "Vault"]) {
      const proxy = proxies.find((p) => p.deployments.includes(name))!;
      expect(proxy.implementation).toBe(addressOf(deployments, `${name}_Implementation`));
      expect(deployments.get(name)!.contractName).toBe(`${name}V2`);
    }
  });

  it("with an upgrade pending, the proxy still runs V1 while the implementation file names V2", async () => {
    const deployments = await files("queued");
    const { proxies } = await discoverProxies(await chain("queued"), deployments);

    const vault = proxies.find((p) => p.deployments.includes("Vault"))!;
    expect(vault.implementation).not.toBe(addressOf(deployments, "Vault_Implementation"));
    expect(deployments.get("Vault")!.contractName).toBe("Vault");
    expect(deployments.get("Vault_Implementation")!.contractName).toBe("VaultV2");
  });
});

describe("deploy hook on real hardhat-deploy v2 output", () => {
  let tmpDir: string;
  let deploymentsDir: string;
  const storeDir = () => join(deploymentsDir, ".storage-layouts");

  // Artifacts as the local build would give them: the code the files describe.
  async function hre(snapshot: Snapshot) {
    const byName = new Map<string, DeploymentFile>();
    for (const d of (await files(snapshot)).values()) {
      byName.set(`${d.sourceName}:${d.contractName}`, d);
    }
    const provider = await chain(snapshot);
    return {
      globalOptions: { network: "localhost" },
      config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
      artifacts: {
        readArtifact: vi.fn().mockImplementation(async (name: string) => {
          const d = byName.get(name);
          if (d === undefined) throw new Error(`artifact ${name} not found`);
          return d;
        }),
      },
      network: {
        create: vi.fn().mockResolvedValue({
          provider,
          networkConfig: { type: "http" },
          close: vi.fn().mockResolvedValue(undefined),
        }),
      },
    };
  }

  // A deploy that leaves the deployments directory as `snapshot` has it.
  const deployingTo = (snapshot: Snapshot) =>
    vi.fn().mockImplementation(async () => {
      for (const f of await readdir(join(FIXTURES, snapshot))) {
        await cp(join(FIXTURES, snapshot, f), join(deploymentsDir, f));
      }
      return "deploy-result";
    });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hhuv-rocketh-"));
    deploymentsDir = join(tmpDir, "deployments", "localhost");
    await mkdir(deploymentsDir, { recursive: true });
    vi.clearAllMocks();
    vi.mocked(getContractBuildData).mockResolvedValue({ upgradeStorageLayout: layout } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true });
  });

  it("first deploy: indexes all three proxies and records what they run", async () => {
    await deployOverride({}, (await hre("fresh")) as never, deployingTo("fresh"));

    const deployments = await files("fresh");
    for (const name of ["Counter", "Ledger", "Vault"]) {
      const impl = addressOf(deployments, `${name}_Implementation`);
      expect(await readProxyEntry(storeDir(), addressOf(deployments, name))).toMatchObject({
        implementation: impl,
        deployments: [name],
      });
      expect(await readLayoutRecord(storeDir(), impl)).toMatchObject({
        contract: expect.stringMatching(new RegExp(`:${name}$`)),
      });
    }
    // Vault's logic has an immutable: proven with it masked.
    expect(
      (await readLayoutRecord(storeDir(), addressOf(deployments, "Vault_Implementation")))
        ?.bytecodeMatch,
    ).toBe("immutables-only");
  });

  it("executed upgrades: the index moves to V2 and V2 is recorded", async () => {
    await deployOverride({}, (await hre("fresh")) as never, deployingTo("fresh"));
    await deployOverride({}, (await hre("upgraded")) as never, deployingTo("upgraded"));

    const deployments = await files("upgraded");
    for (const name of ["Counter", "Ledger", "Vault"]) {
      const impl = addressOf(deployments, `${name}_Implementation`);
      expect(await readProxyEntry(storeDir(), addressOf(deployments, name))).toMatchObject({
        implementation: impl,
      });
      expect(await readLayoutRecord(storeDir(), impl)).toMatchObject({
        contract: expect.stringMatching(new RegExp(`:${name}V2$`)),
      });
    }
  });

  it("pending upgrade to a renamed contract: the index stays on V1, V2 waits until it runs", async () => {
    // The queued snapshot's chain also holds the V1 deployment it started from.
    const queued = await files("queued");
    const v1 = (await chain("queued")).send;
    const vaultProxy = addressOf(queued, "Vault");
    const runningV1 = (
      (await v1("eth_getStorageAt", [
        vaultProxy,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        "latest",
      ])) as string
    ).replace(/^0x0{24}/, "0x");

    await deployOverride({}, (await hre("queued")) as never, deployingTo("queued"));

    expect((await readProxyEntry(storeDir(), vaultProxy))?.implementation).toBe(runningV1);
    // Nothing but the names links VaultV2 to the Vault proxy before the upgrade
    // runs, so it is recorded later (by a deploy, record-baseline or validation
    // once the proxy runs it). Same-name pending upgrades are recorded at once.
    expect(await readLayoutRecord(storeDir(), addressOf(queued, "Vault_Implementation"))).toBe(
      undefined,
    );
    expect(await readLayoutRecord(storeDir(), runningV1)).toMatchObject({
      contract: expect.stringMatching(/:Vault$/),
    });
  });
});
