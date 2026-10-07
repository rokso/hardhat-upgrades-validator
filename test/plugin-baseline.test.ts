/**
 * Baseline mode selection: which layout a deployment is compared against,
 * and which failures may fall back versus must surface.
 *
 * The rule under test: an offline baseline is used only while the chain
 * cannot say which implementation the proxy runs. Once it has named one,
 * only that implementation's layout is acceptable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

vi.mock("../src/core/onchain/baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/onchain/baseline.js")>();
  return { ...orig, resolveImplementationLayout: vi.fn() };
});

import {
  explorerConfig,
  resolveBaseline,
  type BaselineContext,
} from "../src/plugin/internals/baseline.js";
import { resolveImplementationLayout } from "../src/core/onchain/baseline.js";
import { BaselineIntegrityError, BaselineUnavailableError } from "../src/core/onchain/errors.js";
import { updateProxyEntry, writeLayoutRecord } from "../src/core/onchain/store.js";
import { codeSha256 } from "../src/core/onchain/implementation.js";
import type { ImplementationLayoutRecord } from "../src/core/onchain/types.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const LIVE = "0x00000000000000000000000000000000000000bb"; // what the proxy runs
const NEWER = "0x00000000000000000000000000000000000000cc"; // deployed, upgrade pending

const liveLayout = { storage: [], types: {}, namespaces: { "erc7201:live": [] } };
const newerLayout = { storage: [], types: {}, namespaces: { "erc7201:newer": [] } };
const fieldLayout = { storage: [], types: {}, namespaces: { "erc7201:field": [] } };

function record(address: string, layout: object): ImplementationLayoutRecord {
  return {
    format: 1,
    address,
    chainId: 1,
    codeSha256: "00",
    contract: "a.sol:A",
    bytecodeMatch: "immutables-only",
    source: "local-compile",
    recordedAt: "2026-01-01T00:00:00.000Z",
    layout: layout as never,
  };
}

// The proxy index says PROXY ran `implementation` as of block 42.
async function indexAt(implementation: string, deployments = ["MyContract"]) {
  await updateProxyEntry(storeDir(), {
    format: 1,
    proxy: PROXY,
    chainId: 1,
    implementation,
    deployments,
    observedAtBlock: 42,
  });
}

let tmpDir: string;
let deploymentsDir: string;
const storeDir = () => join(deploymentsDir, ".storage-layouts");
const chain = () => makeMockChain({ implementations: { [PROXY]: LIVE } });

function ctx(overrides: Partial<BaselineContext> = {}): BaselineContext {
  return {
    name: "MyContract",
    deployment: { address: PROXY },
    deploymentsDir,
    networkName: "mainnet",
    mode: "auto",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-baseline-"));
  deploymentsDir = join(tmpDir, "deployments", "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

describe("resolveBaseline", () => {
  it("treats a missing deployment as a first deploy in every mode", async () => {
    for (const mode of ["auto", "chain", "deployment"] as const) {
      const r = await resolveBaseline(ctx({ mode, deployment: null }));
      expect(r.layout).toBeUndefined();
      expect(r.info.source).toBe("none");
    }
  });

  it("auto: uses the layout of the implementation the chain reports", async () => {
    vi.mocked(resolveImplementationLayout).mockResolvedValue({
      implementation: LIVE,
      origin: "store",
      record: record(LIVE, liveLayout),
    });
    const r = await resolveBaseline(ctx({ provider: chain() }));

    expect(vi.mocked(resolveImplementationLayout).mock.calls[0][0]).toBe(LIVE);
    expect(r.layout).toEqual(liveLayout);
    expect(r.info).toEqual({
      source: "chain",
      implementation: LIVE,
      bytecodeMatch: "immutables-only",
      origin: "store",
    });
    expect(r.warnings).toEqual([]);
  });

  it("follows a beacon proxy to its beacon's implementation", async () => {
    const beacon = "0x00000000000000000000000000000000000000dd";
    vi.mocked(resolveImplementationLayout).mockResolvedValue({
      implementation: LIVE,
      origin: "store",
      record: record(LIVE, liveLayout),
    });
    const provider = makeMockChain({
      beacons: { [PROXY]: beacon },
      beaconImplementations: { [beacon]: LIVE },
    });
    await resolveBaseline(ctx({ provider }));
    expect(vi.mocked(resolveImplementationLayout).mock.calls[0][0]).toBe(LIVE);
  });

  it("auto: never substitutes another implementation's record once the chain has named one", async () => {
    // A record and a stale index entry exist only for the newer, not-yet-active implementation.
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await indexAt(NEWER);
    vi.mocked(resolveImplementationLayout).mockRejectedValue(
      new BaselineUnavailableError(`No layout record for implementation ${LIVE}.`),
    );
    const err = await resolveBaseline(
      ctx({
        provider: chain(),
        deployment: { address: PROXY, upgradeStorageLayout: fieldLayout as never },
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BaselineUnavailableError);
    expect((err as Error).message).toContain(LIVE);
    expect((err as Error).message).toMatch(/No other baseline is used/);
  });

  it("auto: an unreachable RPC falls back to the indexed implementation's record, with a warning", async () => {
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await indexAt(NEWER);
    const r = await resolveBaseline(ctx({ provider: makeDeadChain() }));
    expect(r.layout).toEqual(newerLayout);
    expect(r.info).toEqual({
      source: "offline-record",
      implementation: NEWER,
      bytecodeMatch: "immutables-only",
      observedAtBlock: 42,
    });
    expect(r.warnings[0]).toMatchObject({ kind: "chain-baseline-unavailable" });
    expect(vi.mocked(resolveImplementationLayout)).not.toHaveBeenCalled();
  });

  it("offline: refuses a record that rests on a metadata-only match", async () => {
    await writeLayoutRecord(storeDir(), {
      ...record(NEWER, newerLayout),
      bytecodeMatch: "metadata-only" as never,
    });
    await indexAt(NEWER);
    await expect(resolveBaseline(ctx())).rejects.toThrow(BaselineIntegrityError);
  });

  it("auto: no provider means offline without a warning", async () => {
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await indexAt(NEWER);
    const r = await resolveBaseline(ctx());
    expect(r.info.source).toBe("offline-record");
    expect(r.warnings).toEqual([]);
  });

  it("offline: ignores records the index does not point at", async () => {
    // Deployed but never activated (a discarded multisig upgrade): never read.
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await writeLayoutRecord(storeDir(), record(LIVE, liveLayout));
    await indexAt(LIVE);
    const r = await resolveBaseline(ctx());
    expect(r.layout).toEqual(liveLayout);
  });

  it("offline: an indexed implementation without a record fails, never using the deprecated field", async () => {
    await indexAt(LIVE);
    await expect(
      resolveBaseline(
        ctx({ deployment: { address: PROXY, upgradeStorageLayout: fieldLayout as never } }),
      ),
    ).rejects.toThrow(
      new BaselineUnavailableError(
        `No baseline for "MyContract": no layout record for ${LIVE}, the implementation as of ` +
          `block 42. Run record-baseline or validate-upgrade with a reachable network.`,
      ),
    );
  });

  it("auto: an unreachable RPC with an unrecorded indexed implementation fails, saying why", async () => {
    await indexAt(LIVE);
    await expect(resolveBaseline(ctx({ provider: makeDeadChain() }))).rejects.toThrow(
      /no layout record for 0x0+bb.* The chain was not used: RPC unreachable/,
    );
  });

  it("offline: a file the index does not list for its proxy gets no baseline, not its deprecated field", async () => {
    // e.g. this file describes the proxy contract itself.
    await writeLayoutRecord(storeDir(), record(LIVE, liveLayout));
    await indexAt(LIVE, ["OtherName"]);
    await expect(
      resolveBaseline(
        ctx({ deployment: { address: PROXY, upgradeStorageLayout: fieldLayout as never } }),
      ),
    ).rejects.toThrow(/lists "OtherName"/);
  });

  it("auto: with no proxy slot on-chain, falls back to the deprecated field, flagged", async () => {
    const r = await resolveBaseline(
      ctx({
        provider: makeMockChain(),
        deployment: { address: PROXY, upgradeStorageLayout: fieldLayout as never },
      }),
    );
    expect(r.layout).toEqual(fieldLayout);
    expect(r.info.source).toBe("deployment-file");
    expect(r.warnings.map((w) => w.kind)).toEqual([
      "chain-baseline-unavailable",
      "deprecated-baseline",
    ]);
  });

  it("auto: never falls back on an integrity failure", async () => {
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await indexAt(NEWER);
    vi.mocked(resolveImplementationLayout).mockRejectedValue(
      new BaselineIntegrityError("does not compile to the deployed code"),
    );
    await expect(resolveBaseline(ctx({ provider: chain() }))).rejects.toThrow(
      BaselineIntegrityError,
    );
  });

  it("chain: refuses to fall back when the chain is unavailable", async () => {
    await writeLayoutRecord(storeDir(), record(NEWER, newerLayout));
    await indexAt(NEWER);
    await expect(
      resolveBaseline(ctx({ mode: "chain", provider: makeDeadChain() })),
    ).rejects.toThrow(BaselineUnavailableError);
    await expect(resolveBaseline(ctx({ mode: "chain" }))).rejects.toThrow(/network connection/);
  });

  it("deployment: reads only the deprecated field and never touches the chain", async () => {
    const provider = chain();
    const r = await resolveBaseline(
      ctx({
        mode: "deployment",
        provider,
        deployment: { address: PROXY, upgradeStorageLayout: fieldLayout as never },
      }),
    );
    expect(r.layout).toEqual(fieldLayout);
    expect(r.warnings.map((w) => w.kind)).toEqual(["deprecated-baseline"]);
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("resolveBaseline chain identity", () => {
  it("fails when the RPC answers for another chain than the proxy's index entry", async () => {
    await writeLayoutRecord(storeDir(), record(LIVE, liveLayout));
    await indexAt(LIVE);
    // Everything else lines up, so only the chain id can fail it.
    const code = "0x6080";
    await writeLayoutRecord(storeDir(), {
      ...record(LIVE, liveLayout),
      codeSha256: codeSha256(code),
    });
    const other = makeMockChain({
      chainId: 5,
      code: { [LIVE]: code },
      implementations: { [PROXY]: LIVE },
    });
    await expect(resolveBaseline(ctx({ provider: other }))).rejects.toThrow(
      new BaselineIntegrityError(
        `The RPC answers for chain 5, but the proxy index entry for ${PROXY} records chain 1. ` +
          `Check that the network's URL points at the chain these deployments are on.`,
      ),
    );
  });
});

describe("explorerConfig", () => {
  const withEnvKey = async (fn: () => Promise<void>) => {
    const prev = process.env.ETHERSCAN_API_KEY;
    process.env.ETHERSCAN_API_KEY = "ENVKEY";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.ETHERSCAN_API_KEY;
      else process.env.ETHERSCAN_API_KEY = prev;
    }
  };

  it("uses ETHERSCAN_API_KEY for Etherscan", () =>
    withEnvKey(async () => {
      expect(await explorerConfig(undefined, "mainnet")).toEqual({ apiKey: "ENVKEY" });
      expect(
        await explorerConfig(
          { explorers: { mainnet: { apiUrl: "https://api.etherscan.io/v2/api" } } },
          "mainnet",
        ),
      ).toEqual({ apiKey: "ENVKEY", apiUrl: "https://api.etherscan.io/v2/api" });
    }));

  it("treats an empty key as unset, as CI passes for a missing secret", async () => {
    const prev = process.env.ETHERSCAN_API_KEY;
    process.env.ETHERSCAN_API_KEY = "";
    try {
      expect(await explorerConfig(undefined, "mainnet")).toEqual({});
      expect(
        await explorerConfig({ explorers: { mainnet: { apiKey: "", apiUrl: "" } } }, "mainnet"),
      ).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.ETHERSCAN_API_KEY;
      else process.env.ETHERSCAN_API_KEY = prev;
    }
  });

  it("does not send ETHERSCAN_API_KEY over plain http", () =>
    withEnvKey(async () => {
      expect(
        await explorerConfig(
          { explorers: { mainnet: { apiUrl: "http://api.etherscan.io/v2/api" } } },
          "mainnet",
        ),
      ).toEqual({ apiUrl: "http://api.etherscan.io/v2/api" });
    }));

  it("never sends ETHERSCAN_API_KEY to a third-party explorer", () =>
    withEnvKey(async () => {
      expect(
        await explorerConfig(
          { explorers: { l2: { apiUrl: "https://blockscout.example/api" } } },
          "l2",
        ),
      ).toEqual({ apiUrl: "https://blockscout.example/api" });
    }));

  it("uses a key configured for the third-party explorer", () =>
    withEnvKey(async () => {
      expect(
        await explorerConfig(
          { explorers: { l2: { apiUrl: "https://blockscout.example/api", apiKey: "OWN" } } },
          "l2",
        ),
      ).toEqual({ apiUrl: "https://blockscout.example/api", apiKey: "OWN" });
    }));

  it("reads a configVariable key only when asked, and fails when it cannot be read", async () => {
    const get = vi.fn().mockResolvedValue("FROMVAR");
    const key = { _type: "ResolvedConfigurationVariable", get } as never;
    const config = { explorers: { mainnet: { apiKey: key } } };
    expect(get).not.toHaveBeenCalled();
    expect(await explorerConfig(config, "mainnet")).toEqual({ apiKey: "FROMVAR" });

    get.mockRejectedValue(new Error("HHE7: Configuration Variable not found"));
    await expect(explorerConfig(config, "mainnet")).rejects.toThrow(
      /Could not read the explorer API key: HHE7/,
    );
  });

  it("resolveBaseline leaves reading a configVariable key to the rebuild, if any", async () => {
    const get = vi.fn().mockResolvedValue("FROMVAR");
    const config = { explorers: { mainnet: { apiKey: { get } as never } } };
    vi.mocked(resolveImplementationLayout).mockResolvedValue({
      implementation: LIVE,
      record: record(LIVE, liveLayout),
      origin: "store",
    });

    await resolveBaseline(ctx({ provider: chain(), config }));

    expect(get).not.toHaveBeenCalled();
    const { explorer } = vi.mocked(resolveImplementationLayout).mock.calls[0][1];
    expect(typeof explorer).toBe("function");
    expect(await (explorer as () => Promise<unknown>)()).toEqual({ apiKey: "FROMVAR" });
  });
});
