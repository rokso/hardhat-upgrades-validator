import { describe, it, expect } from "vitest";
import {
  compareDeployedBytecode,
  inferImmutableReferences,
  stripBytecodeMetadata,
} from "../src/core/bytecode-utils.js";
import { METADATA } from "./helpers/metadata.js";

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

describe("inferImmutableReferences", () => {
  const zero32 = "00".repeat(32);

  it("finds each zeroed PUSH32 operand", () => {
    // PUSH1 0x80, PUSH32 0, POP, PUSH32 0
    const code = "0x6080" + "7f" + zero32 + "50" + "7f" + zero32;
    expect(inferImmutableReferences(code)).toEqual({
      inferred: [
        { start: 3, length: 32 },
        { start: 37, length: 32 },
      ],
    });
  });

  it("ignores PUSH32 constants and 0x7f bytes inside other pushes' data", () => {
    // PUSH32 <non-zero>, then PUSH2 0x7f00 followed by 32 zero bytes of STOPs.
    const code = "0x7f" + "11".repeat(32) + "617f00" + zero32;
    expect(inferImmutableReferences(code)).toEqual({});
  });

  it("does not read into the CBOR metadata", () => {
    const metadata = "a2" + "7f" + zero32 + "0022"; // a CBOR map whose bytes look like a PUSH32
    expect(inferImmutableReferences("0x6080" + metadata)).toEqual({});
  });

  it("makes a proxy with an immutable compare equal to its on-chain code", () => {
    const compiled = "0x6080604052" + "7f" + zero32 + "cd".repeat(8) + METADATA;
    const onchain =
      "0x6080604052" + "7f" + "00".repeat(12) + "99".repeat(20) + "cd".repeat(8) + METADATA;
    expect(compareDeployedBytecode(onchain, compiled)).toBe("none");
    expect(compareDeployedBytecode(onchain, compiled, inferImmutableReferences(compiled))).toBe(
      "immutables-only",
    );
  });
});
