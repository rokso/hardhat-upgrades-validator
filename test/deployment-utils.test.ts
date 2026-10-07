import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stripBytecodeMetadata,
  compareBytecode,
  parseUnsafeAllowAnnotation,
  readDeployment,
  resolveWinnerSource,
} from "../src/plugin/internals/deployment-utils.js";

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
// parseUnsafeAllowAnnotation
// ---------------------------------------------------------------------------

describe("parseUnsafeAllowAnnotation", () => {
  it("returns [] for undefined", () => {
    expect(parseUnsafeAllowAnnotation(undefined)).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(parseUnsafeAllowAnnotation(null)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseUnsafeAllowAnnotation("")).toEqual([]);
  });

  it("parses a single known kind", () => {
    expect(parseUnsafeAllowAnnotation("variable-renamed")).toEqual(["variable-renamed"]);
  });

  it("parses multiple space-separated kinds", () => {
    expect(parseUnsafeAllowAnnotation("variable-renamed type-changed")).toEqual([
      "variable-renamed",
      "type-changed",
    ]);
  });

  it("parses comma-separated kinds", () => {
    expect(parseUnsafeAllowAnnotation("variable-renamed,type-changed")).toEqual([
      "variable-renamed",
      "type-changed",
    ]);
  });

  it("filters out unknown kinds silently when no context is given", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseUnsafeAllowAnnotation("variable-renamed not-a-kind type-changed")).toEqual([
      "variable-renamed",
      "type-changed",
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when all kinds are unknown (no context)", () => {
    expect(parseUnsafeAllowAnnotation("foo bar baz")).toEqual([]);
  });

  it("emits console.warn listing unknown tokens when context is provided", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseUnsafeAllowAnnotation(
      "variable-renamed typo-kind type-changed",
      `contract MyContract, variable "myVar"`,
    );
    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("typo-kind");
    expect(msg).toContain(`contract MyContract, variable "myVar"`);
    expect(msg).toContain("variable-renamed");
    warn.mockRestore();
  });

  it("does not warn when all tokens are valid even with context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseUnsafeAllowAnnotation("variable-renamed type-changed", "contract MyContract");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

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
    // bytecode itself is only 2 bytes total: sanity check should kick in.
    const result = stripBytecodeMetadata(short);
    expect(result).toBe(short);
  });

  it("returns original for empty string", () => {
    expect(stripBytecodeMetadata("0x")).toBe("0x");
  });
});

// ---------------------------------------------------------------------------
// compareBytecode
// ---------------------------------------------------------------------------

describe("compareBytecode", () => {
  const coreHex = "60806040";

  it("returns 'exact' for identical bytecode", () => {
    const b = makeBytecode(coreHex, 8);
    expect(compareBytecode(b, b).match).toBe("exact");
  });

  it("returns 'exact' regardless of 0x prefix or case", () => {
    const b = makeBytecode(coreHex, 8);
    const bUpper = b.toUpperCase();
    expect(compareBytecode(b, bUpper).match).toBe("exact");
    expect(compareBytecode(b.slice(2), b).match).toBe("exact"); // one without 0x
  });

  it("returns 'metadata-only' when only the CBOR suffix differs", () => {
    const a = makeBytecode(coreHex, 8); // cbor filled with 0xaa
    // Same core, different cbor content
    const core = Buffer.from(coreHex, "hex");
    const cbor = Buffer.alloc(8, 0xbb); // different fill
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(8, 0);
    const b = "0x" + Buffer.concat([core, cbor, lenBuf]).toString("hex");

    expect(compareBytecode(a, b).match).toBe("metadata-only");
  });

  it("returns 'none' when the core code differs", () => {
    const a = makeBytecode("deadbeef", 8);
    const b = makeBytecode("cafebabe", 8);
    expect(compareBytecode(a, b).match).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// resolveWinnerSource
// ---------------------------------------------------------------------------

describe("resolveWinnerSource", () => {
  it("returns an exact match when artifact source matches a key directly", () => {
    const result = resolveWinnerSource(
      ["contracts/Token.sol", "lib/Token.sol"],
      "contracts/Token.sol",
      "Token",
    );
    expect(result).toBe("contracts/Token.sol");
  });

  it("returns a suffix match when artifact source is a bare filename", () => {
    const result = resolveWinnerSource(["contracts/Token.sol"], "Token.sol", "Token");
    expect(result).toBe("contracts/Token.sol");
  });

  it("returns first match and warns once when multiple keys match the artifact source", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = resolveWinnerSource(
      ["contracts/Token.sol", "lib/Token.sol"],
      "Token.sol",
      "Token",
    );

    expect(result).toBe("contracts/Token.sol");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("Ambiguous source");
    expect(warn.mock.calls[0]![0]).toContain("Token.sol");

    warn.mockRestore();
  });

  it("does not warn when exactly one key matches", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    resolveWinnerSource(["contracts/Token.sol"], "Token.sol", "Token");

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to artifactSource when no key matches", () => {
    const result = resolveWinnerSource(["contracts/Other.sol"], "Token.sol", "Token");
    expect(result).toBe("Token.sol");
  });
});
