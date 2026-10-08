/**
 * Small guarantees of the chain core that other paths rely on: the proxy
 * index is rewritten whenever what it says changes, and an RPC error while
 * reading a proxy's slots propagates instead of meaning "not a proxy".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readProxyEntry, updateProxyEntry } from "../src/core/onchain/store.js";
import { readProxy } from "../src/core/onchain/implementation.js";
import type { ProxyIndexEntry } from "../src/core/onchain/types.js";

const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";
const BEACON = "0x00000000000000000000000000000000000000cc";

let storeDir: string;
beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "hhuv-store-"));
});
afterEach(async () => {
  await rm(storeDir, { recursive: true });
});

const entry = (over: Partial<ProxyIndexEntry> = {}): ProxyIndexEntry => ({
  format: 1,
  proxy: PROXY,
  chainId: 1,
  implementation: IMPL,
  deployments: ["Box"],
  observedAtBlock: 1,
  ...over,
});

describe("updateProxyEntry", () => {
  it("does not rewrite an entry whose state did not change", async () => {
    await updateProxyEntry(storeDir, entry());
    expect(await updateProxyEntry(storeDir, entry({ observedAtBlock: 99 }))).toBe(false);
  });

  it.each([
    ["the deployment names", { deployments: ["BoxRenamed"] }],
    ["the beacon", { beacon: BEACON }],
    ["the chain id", { chainId: 5 }],
    ["the implementation", { implementation: BEACON }],
  ])("rewrites the entry when %s change", async (_, change) => {
    await updateProxyEntry(storeDir, entry());
    expect(await updateProxyEntry(storeDir, entry({ ...change, observedAtBlock: 2 }))).toBe(true);
    expect(await readProxyEntry(storeDir, PROXY)).toMatchObject({ ...change, observedAtBlock: 2 });
  });
});

describe("readProxy", () => {
  it("propagates an RPC error on the beacon slot instead of returning 'not a proxy'", async () => {
    const zero = "0x" + "00".repeat(32);
    let reads = 0;
    const provider = {
      send: async (method: string) => {
        if (method === "eth_getStorageAt") {
          // The implementation slot (and its fallback) read as empty; the beacon slot read fails.
          reads++;
          if (reads <= 2) return zero;
          throw new Error("rpc down");
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await expect(readProxy(provider, PROXY)).rejects.toThrow(/rpc down/);
  });
});
