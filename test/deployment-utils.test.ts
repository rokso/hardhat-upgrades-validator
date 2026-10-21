import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripBytecodeMetadata, readDeployment } from "../src/plugin/internals/deployment-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fake bytecode:  <core_hex> + <cbor_blob> + <2_byte_length>
 * where cbor_blob is `cborLength` zero bytes.
 */
function makeBytecode(coreHex: string, cborLength: number): string {
  const core = Buffer.from(coreHex, "hex");
  const cbor = Buffer.alloc(cborLength, 0xaa); // fill with 0xaa to be recognizable
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(cborLength, 0);
  return "0x" + Buffer.concat([core, cbor, lenBuf]).toString("hex");
}

// ---------------------------------------------------------------------------
// readDeployment
// ---------------------------------------------------------------------------

describe("readDeployment", () => {
  it("returns null for a missing file", async () => {
    const result = await readDeployment("/non/existent/dir", "SomeContract");
    expect(result).toBeNull();
  });

  it("throws for corrupted JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "huv-test-"));
    try {
      await writeFile(join(dir, "Bad.json"), "{ not valid json }", "utf8");
      await expect(readDeployment(dir, "Bad")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("parses a valid deployment file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "huv-test-"));
    try {
      const deployment = {
        address: "0xabc",
        storageLayout: { storage: [], types: {} },
      };
      await writeFile(join(dir, "MyContract.json"), JSON.stringify(deployment), "utf8");
      const result = await readDeployment(dir, "MyContract");
      expect(result?.address).toBe("0xabc");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// stripBytecodeMetadata
// ---------------------------------------------------------------------------

describe("stripBytecodeMetadata", () => {
  it("removes the CBOR suffix and length bytes", () => {
    const coreHex = "deadbeef";
    const full = makeBytecode(coreHex, 10);
    const stripped = stripBytecodeMetadata(full);
    expect(stripped).toBe("0x" + coreHex);
  });

  it("handles bytecode without 0x prefix", () => {
    const coreHex = "cafebabe";
    const full = makeBytecode(coreHex, 4).slice(2); // remove 0x
    const stripped = stripBytecodeMetadata(full);
    expect(stripped).toBe("0x" + coreHex);
  });

  it("returns original when too short to contain metadata", () => {
    const short = "0x1234";
    // The length field would claim 0x1234 = 4660 bytes of metadata, but the
    // bytecode itself is only 2 bytes total; sanity check should kick in.
    const result = stripBytecodeMetadata(short);
    expect(result).toBe(short);
  });

  it("returns original for empty string", () => {
    expect(stripBytecodeMetadata("0x")).toBe("0x");
  });
});
