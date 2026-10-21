/**
 * The proxy helpers against a (mock) chain: the baseline is the implementation
 * the proxy runs, the proxy index is refreshed, and a proxy whose
 * implementation has no record fails instead of passing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const analyze = vi.hoisted(() => vi.fn());

vi.mock("../src/plugin/internals/build-analysis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/build-analysis.js")>()),
  createBuildAnalyzer: () => analyze,
}));

import { validateProxyUpgrade } from "../src/proxy/validate-proxy.js";
import { fakeAnalysis } from "./helpers/analysis.js";
import { readProxyEntry, writeLayoutRecord } from "../src/core/onchain/store.js";
import { codeSha256 } from "./helpers/code-hash.js";
import { makeMockChain } from "./helpers/mock-chain.js";
import { METADATA } from "./helpers/metadata.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const LOGIC_CODE = "0x6080604052" + "11".repeat(32) + METADATA;
const PROXY_CODE = "0x60806040" + "cd".repeat(16);
const layout = { storage: [], types: {}, namespaces: {} };

let tmpDir: string;
let deploymentsDir: string;
const storeDir = () => join(deploymentsDir, ".storage-layouts");

const chain = () =>
  makeMockChain({
    code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE },
    implementations: { [PROXY]: IMPL },
  });

function makeHre(provider: { send: unknown }) {
  return {
    globalOptions: { network: "mainnet" },
    config: { paths: { root: tmpDir, cache: join(tmpDir, "cache") } },
    artifacts: {},
    network: {
      create: vi.fn().mockResolvedValue({ provider, close: vi.fn().mockResolvedValue(undefined) }),
    },
  };
}

const record = () => ({
  format: 1 as const,
  address: IMPL,
  chainId: 1,
  codeSha256: codeSha256(LOGIC_CODE),
  contract: "src/Box.sol:Box",
  bytecodeMatch: "exact" as const,
  source: "local-compile" as const,
  recordedAt: "2026-01-01T00:00:00.000Z",
  layout: layout as never,
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-vpchain-"));
  deploymentsDir = join(tmpDir, "deployments", "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
  await writeFile(
    join(deploymentsDir, "Box.json"),
    JSON.stringify({
      address: PROXY,
      contractName: "Box",
      sourceName: "src/Box.sol",
      deployedBytecode: LOGIC_CODE,
      immutableReferences: {},
    }),
  );
  vi.clearAllMocks();
  analyze.mockResolvedValue(fakeAnalysis(layout));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

describe("validateProxyUpgrade on a chain", () => {
  it("validates against the implementation the proxy runs and refreshes the index", async () => {
    await writeLayoutRecord(storeDir(), {
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

    const result = await validateProxyUpgrade(makeHre(chain()) as never, "Box");

    expect(result.ok).toBe(true);
    expect(result.baseline).toMatchObject({ source: "chain", implementation: IMPL });
    expect(await readProxyEntry(storeDir(), PROXY)).toMatchObject({
      implementation: IMPL,
      deployments: ["Box"],
    });
  });

  it("checks the safety rules with the kind the running implementation's record holds", async () => {
    await writeLayoutRecord(storeDir(), { ...record(), kind: "uups" });
    // The new code alone reads as transparent: it lost its upgrade function.
    const next = fakeAnalysis(layout, { kind: "transparent" });
    analyze.mockResolvedValue(next);

    await validateProxyUpgrade(makeHre(chain()) as never, "Box");

    expect(next.safetyKinds).toEqual(["uups"]);
  });

  it("checks a beacon proxy as a beacon, whatever the record's code implies", async () => {
    const BEACON = "0x00000000000000000000000000000000000000cc";
    await writeLayoutRecord(storeDir(), { ...record(), kind: "uups" });
    const next = fakeAnalysis(layout);
    analyze.mockResolvedValue(next);
    const beaconChain = makeMockChain({
      code: { [PROXY]: PROXY_CODE, [IMPL]: LOGIC_CODE, [BEACON]: PROXY_CODE },
      beacons: { [PROXY]: BEACON },
      beaconImplementations: { [BEACON]: IMPL },
    });

    await validateProxyUpgrade(makeHre(beaconChain) as never, "Box");

    expect(next.safetyKinds).toEqual(["beacon"]);
  });

  it("falls back to the new code's kind for a record without one", async () => {
    await writeLayoutRecord(storeDir(), record());
    const next = fakeAnalysis(layout, { kind: "uups" });
    analyze.mockResolvedValue(next);

    await validateProxyUpgrade(makeHre(chain()) as never, "Box");

    expect(next.safetyKinds).toEqual(["uups"]);
  });

  it("throws when the implementation the proxy runs has no record and no explorer", async () => {
    await expect(validateProxyUpgrade(makeHre(chain()) as never, "Box")).rejects.toThrow(
      /runs implementation 0x0+bb, but its layout could not be obtained/,
    );
  });
});
