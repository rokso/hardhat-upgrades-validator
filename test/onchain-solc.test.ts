import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getSolc } from "../src/core/onchain/solc.js";
import { BaselineIntegrityError, BaselineUnavailableError } from "../src/core/onchain/errors.js";

// A version no cache holds, so getSolc must go to the (mocked) download.
const UNCACHED = "0.0.1+commit.00000000";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "hhuv-solc-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true });
});

function listing(sha256: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ builds: [{ path: "solc-x", longVersion: UNCACHED, sha256 }] }),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe("getSolc", () => {
  it("treats an unreachable download host as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(
      BaselineUnavailableError,
    );
  });

  it("treats a version with no native build as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ builds: [] }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(
      BaselineUnavailableError,
    );
  });

  it("refuses a binary that fails its checksum, as an integrity failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(listing("0x" + "00".repeat(32)))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("not solc").buffer,
      });
    await expect(getSolc(UNCACHED, { cacheDir }, fetchImpl)).rejects.toThrow(
      BaselineIntegrityError,
    );
  });

  it("rejects instead of crashing when the compiler exits before reading its input", async () => {
    const solc = await getSolc(UNCACHED, { resolvePath: () => "/usr/bin/true" });
    const big = { language: "Solidity", sources: { "a.sol": { content: "x".repeat(8_000_000) } } };
    await expect(solc.compile(big as never)).rejects.toThrow();
  });
});
