/**
 * Bytecode comparison utilities.
 *
 * Solidity appends a CBOR-encoded metadata hash to the end of every compiled
 * contract's bytecode. The last two bytes encode the length of that metadata
 * section. Stripping it allows comparing contracts that are logically identical
 * but were compiled in different environments (different metadata).
 */

export function stripBytecodeMetadata(bytecode: string): string {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const buf = Buffer.from(hex, "hex");

  if (buf.length < 2) return bytecode;

  const metadataLength = buf.readUInt16BE(buf.length - 2);

  if (metadataLength + 2 > buf.length) return bytecode;

  const core = buf.subarray(0, buf.length - 2 - metadataLength);
  return "0x" + core.toString("hex");
}

export type BytecodeMatchResult =
  | { match: "exact" }
  | { match: "metadata-only" }
  | { match: "none" };

export function compareBytecode(a: string, b: string): BytecodeMatchResult {
  const normalise = (s: string) => s.toLowerCase().replace(/^0x/, "");
  if (normalise(a) === normalise(b)) return { match: "exact" };
  if (stripBytecodeMetadata(a) === stripBytecodeMetadata(b)) return { match: "metadata-only" };
  return { match: "none" };
}
