import { describe, it, expect } from "vitest";
import { compareDeployedBytecode, stripBytecodeMetadata } from "../src/core/bytecode-utils.js";

// 5-byte prefix, 32-byte immutable at byte 5, 1-byte suffix, then CBOR metadata.
function code(immutable: string, body = "fe", cbor = "aa".repeat(10)) {
  return "0x6080604052" + immutable + body + cbor + "000a";
}
const ZERO = "00".repeat(32);
const FILLED = "ab".repeat(32);
const REFS = { "273": [{ start: 5, length: 32 }] };

describe("compareDeployedBytecode", () => {
  it("is exact when byte-identical", () => {
    expect(compareDeployedBytecode(code(ZERO), code(ZERO), REFS)).toBe("exact");
  });

  it("is case- and prefix-insensitive", () => {
    expect(
      compareDeployedBytecode(code(ZERO).toUpperCase().replace("0X", "0x"), code(ZERO).slice(2)),
    ).toBe("exact");
  });

  it("is immutables-only when only immutable spans differ", () => {
    expect(compareDeployedBytecode(code(FILLED), code(ZERO), REFS)).toBe("immutables-only");
  });

  it("is none for the same difference when the span is not declared immutable", () => {
    expect(compareDeployedBytecode(code(FILLED), code(ZERO), {})).toBe("none");
  });

  it("is none when a byte outside the immutable spans differs", () => {
    expect(compareDeployedBytecode(code(FILLED, "ff"), code(ZERO, "fe"), REFS)).toBe("none");
  });

  it("is metadata-only when immutables and the CBOR suffix both differ", () => {
    const live = code(FILLED, "fe", "bb".repeat(10));
    expect(compareDeployedBytecode(live, code(ZERO), REFS)).toBe("metadata-only");
  });

  it("is none when a span lies outside the code", () => {
    const refs = { "1": [{ start: 500, length: 32 }] };
    expect(compareDeployedBytecode(code(FILLED), code(ZERO), refs)).toBe("none");
  });

  it("is none when lengths differ", () => {
    expect(compareDeployedBytecode(code(FILLED) + "00", code(ZERO), REFS)).toBe("none");
  });

  it("masks library link placeholders", () => {
    const placeholder = "__$" + "1".repeat(34) + "$__";
    const compiled = "0x60806040" + placeholder + "fe";
    const live = "0x60806040" + "cd".repeat(20) + "fe";
    expect(compareDeployedBytecode(live, compiled)).toBe("immutables-only");
  });
});

describe("stripBytecodeMetadata", () => {
  it("strips a CBOR map tail", () => {
    // 0xa2 is a two-entry CBOR map, as solc emits.
    const full = "0x6080" + "a2" + "00".repeat(9) + "000a";
    expect(stripBytecodeMetadata(full)).toBe("0x6080");
  });

  it("leaves code alone when the tail is not CBOR (appendCBOR: false)", () => {
    const code = "0x6080604052" + "5b".repeat(10) + "000a";
    expect(stripBytecodeMetadata(code)).toBe(code);
  });

  it("does not report metadata-only for code that differs in a non-CBOR tail", () => {
    const a = "0x6080604052" + "5b".repeat(10) + "000a";
    const b = "0x6080604052" + "5c".repeat(10) + "000a";
    expect(compareDeployedBytecode(a, b)).toBe("none");
  });
});
