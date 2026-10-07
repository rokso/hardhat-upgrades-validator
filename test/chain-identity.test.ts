/**
 * The chain-id guard: an RPC for another chain than the deployments describe
 * must fail loudly, since nothing would be a proxy there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { assertSameChain } from "../src/plugin/internals/chain-identity.js";
import { markFullScan, updateProxyEntry } from "../src/core/onchain/store.js";
import { BaselineIntegrityError } from "../src/core/onchain/errors.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000cc";

let deploymentsDir: string;
const storeDir = () => join(deploymentsDir, ".storage-layouts");
const entry = (proxy: string, chainId: number) =>
  updateProxyEntry(storeDir(), {
    format: 1,
    proxy,
    chainId,
    implementation: "0x00000000000000000000000000000000000000bb",
    deployments: ["Box"],
    observedAtBlock: 1,
  });

beforeEach(async () => {
  deploymentsDir = join(await mkdtemp(join(tmpdir(), "hhuv-chainid-")), "mainnet");
  await mkdir(deploymentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(deploymentsDir, ".."), { recursive: true });
});

describe("assertSameChain", () => {
  it("passes when nothing records a chain id", async () => {
    await expect(assertSameChain(deploymentsDir, makeMockChain({ chainId: 5 }))).resolves.toBe(
      undefined,
    );
  });

  it("passes when every recorded chain id matches", async () => {
    await writeFile(join(deploymentsDir, ".chain"), JSON.stringify({ chainId: "1" }));
    await markFullScan(storeDir(), { format: 1, chainId: 1, firstFullScanAtBlock: 1 });
    await entry(PROXY, 1);
    await expect(assertSameChain(deploymentsDir, makeMockChain())).resolves.toBe(undefined);
  });

  it.each([
    [
      "hardhat-deploy's .chain file",
      () => writeFile(join(deploymentsDir, ".chain"), '{"chainId":"1"}'),
    ],
    [
      "the scan marker",
      () => markFullScan(storeDir(), { format: 1, chainId: 1, firstFullScanAtBlock: 1 }),
    ],
    ["a proxy index entry", () => entry(PROXY, 1)],
  ])("throws when %s records another chain", async (_, record) => {
    await record();
    await expect(
      assertSameChain(deploymentsDir, makeMockChain({ chainId: 11155111 })),
    ).rejects.toThrow(BaselineIntegrityError);
  });

  it("with an address, reads only that proxy's index entry", async () => {
    await entry(OTHER, 5);
    await expect(
      assertSameChain(deploymentsDir, makeMockChain(), { address: PROXY }),
    ).resolves.toBe(undefined);
    await expect(
      assertSameChain(deploymentsDir, makeMockChain(), { address: OTHER }),
    ).rejects.toThrow(/records chain 5/);
  });

  it("ignores a .chain file it cannot read a chain id from", async () => {
    await writeFile(join(deploymentsDir, ".chain"), "not json");
    await expect(assertSameChain(deploymentsDir, makeMockChain())).resolves.toBe(undefined);
  });

  it("reads hardhat-deploy's older .chainId file when there is no .chain", async () => {
    await writeFile(join(deploymentsDir, ".chainId"), "1\n");
    await expect(assertSameChain(deploymentsDir, makeMockChain({ chainId: 5 }))).rejects.toThrow(
      /\.chainId records chain 1/,
    );
  });

  it("is skipped in hardhat-deploy's fork mode, whose chain id is the fork's own", async () => {
    await writeFile(join(deploymentsDir, ".chain"), JSON.stringify({ chainId: "1" }));
    vi.stubEnv("HARDHAT_FORK", "mainnet");
    try {
      await expect(
        assertSameChain(deploymentsDir, makeMockChain({ chainId: 31337 })),
      ).resolves.toBe(undefined);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
