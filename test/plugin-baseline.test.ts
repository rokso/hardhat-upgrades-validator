/**
 * Baseline mode selection: which layout a deployment is compared against,
 * and which failures may fall back (unavailable) versus must surface
 * (integrity).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

vi.mock("../src/core/onchain/baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/core/onchain/baseline.js")>();
  return { ...orig, resolveChainBaseline: vi.fn() };
});

import { resolveBaseline, type BaselineContext } from "../src/plugin/internals/baseline.js";
import { resolveChainBaseline } from "../src/core/onchain/baseline.js";
import { BaselineIntegrityError, BaselineUnavailableError } from "../src/core/onchain/errors.js";
import { writeLayoutRecord } from "../src/core/onchain/store.js";
import type { ImplementationLayoutRecord } from "../src/core/onchain/types.js";
import { makeDeadChain, makeMockChain } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";

const layoutA = { storage: [], types: {}, namespaces: { "erc7201:a": [] } };
const layoutB = { storage: [], types: {}, namespaces: { "erc7201:b": [] } };
const fieldLayout = { storage: [], types: {}, namespaces: { "erc7201:field": [] } };

function record(layout: object): ImplementationLayoutRecord {
  return {
    format: 1,
    address: IMPL,
    chainId: 1,
    codeSha256: "00",
    contract: "a.sol:A",
    bytecodeMatch: "immutables-only",
    source: "local-compile",
    recordedAt: "2026-01-01T00:00:00.000Z",
    layout: layout as never,
  };
}

let tmpDir: string;
let deploymentsDir: string;

function ctx(overrides: Partial<BaselineContext> = {}): BaselineContext {
  return {
    name: "MyContract",
    deployment: { address: PROXY, implementation: IMPL },
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

  it("auto: uses the chain when reachable", async () => {
    vi.mocked(resolveChainBaseline).mockResolvedValue({
      implementation: IMPL,
      origin: "store",
      record: record(layoutA),
    });
    const r = await resolveBaseline(ctx({ provider: makeMockChain() }));
    expect(r.layout).toEqual(layoutA);
    expect(r.info).toEqual({
      source: "chain",
      implementation: IMPL,
      bytecodeMatch: "immutables-only",
      origin: "store",
    });
    expect(r.warnings).toEqual([]);
  });

  it("auto: prefers the chain over a stale offline record and the deprecated field", async () => {
    await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), record(layoutB));
    vi.mocked(resolveChainBaseline).mockResolvedValue({
      implementation: IMPL,
      origin: "store",
      record: record(layoutA),
    });
    const r = await resolveBaseline(
      ctx({
        provider: makeMockChain(),
        deployment: {
          address: PROXY,
          implementation: IMPL,
          upgradeStorageLayout: fieldLayout as never,
        },
      }),
    );
    expect(r.layout).toEqual(layoutA);
  });

  it("auto: an unreachable RPC falls back to the offline record, with a warning", async () => {
    await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), record(layoutB));
    const r = await resolveBaseline(ctx({ provider: makeDeadChain() }));
    expect(r.layout).toEqual(layoutB);
    expect(r.info.source).toBe("offline-record");
    expect(r.warnings[0]).toMatchObject({ kind: "chain-baseline-unavailable" });
    expect(vi.mocked(resolveChainBaseline)).not.toHaveBeenCalled();
  });

  it("auto: no provider means offline without a warning", async () => {
    await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), record(layoutB));
    const r = await resolveBaseline(ctx());
    expect(r.info.source).toBe("offline-record");
    expect(r.warnings).toEqual([]);
  });

  it("auto: falls back to the deprecated field, flagged", async () => {
    vi.mocked(resolveChainBaseline).mockRejectedValue(new BaselineUnavailableError("not verified"));
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
    await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), record(layoutB));
    vi.mocked(resolveChainBaseline).mockRejectedValue(
      new BaselineIntegrityError("does not compile to the deployed code"),
    );
    await expect(resolveBaseline(ctx({ provider: makeMockChain() }))).rejects.toThrow(
      BaselineIntegrityError,
    );
  });

  it("chain: refuses to fall back when the chain is unavailable", async () => {
    await writeLayoutRecord(join(deploymentsDir, ".storage-layouts"), record(layoutB));
    await expect(
      resolveBaseline(ctx({ mode: "chain", provider: makeDeadChain() })),
    ).rejects.toThrow(BaselineUnavailableError);
    await expect(resolveBaseline(ctx({ mode: "chain" }))).rejects.toThrow(/network connection/);
  });

  it("deployment: reads only the deprecated field and never touches the chain", async () => {
    const provider = makeMockChain();
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

  it("passes the per-network explorer config, falling back to ETHERSCAN_API_KEY", async () => {
    vi.mocked(resolveChainBaseline).mockResolvedValue({
      implementation: IMPL,
      origin: "explorer",
      record: record(layoutA),
    });
    const prev = process.env.ETHERSCAN_API_KEY;
    process.env.ETHERSCAN_API_KEY = "ENVKEY";
    try {
      await resolveBaseline(ctx({ provider: makeMockChain() }));
      expect(vi.mocked(resolveChainBaseline).mock.calls[0][1].explorer).toEqual({
        apiKey: "ENVKEY",
      });

      await resolveBaseline(
        ctx({
          provider: makeMockChain(),
          config: { explorers: { mainnet: { apiUrl: "https://x/api" } } },
        }),
      );
      expect(vi.mocked(resolveChainBaseline).mock.calls[1][1].explorer).toEqual({
        apiKey: "ENVKEY",
        apiUrl: "https://x/api",
      });
    } finally {
      if (prev === undefined) delete process.env.ETHERSCAN_API_KEY;
      else process.env.ETHERSCAN_API_KEY = prev;
    }
  });
});
