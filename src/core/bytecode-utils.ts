/**
 * Bytecode helpers the validator keeps for itself. Comparing compiled code
 * with deployed code, and deciding what proves a layout, is slotdiff's.
 *
 * Solidity appends a CBOR-encoded metadata hash to the end of every compiled
 * contract's bytecode. The last two bytes encode the length of that metadata
 * section.
 */

export {
  compareDeployedBytecode,
  isProvingMatch,
  type DeployedBytecodeMatch,
  type ImmutableReferences,
  type ProvingMatch,
} from "slotdiff";
import type { ImmutableReferences } from "slotdiff";

export function stripBytecodeMetadata(bytecode: string): string {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const buf = Buffer.from(hex, "hex");

  if (buf.length < 2) return bytecode;

  const metadataLength = buf.readUInt16BE(buf.length - 2);

  if (metadataLength === 0 || metadataLength + 2 > buf.length) return bytecode;

  // solc's metadata is a CBOR map (major type 5). Without that marker the
  // tail is code (e.g. compiled with appendCBOR: false), and stripping it
  // would hide real differences.
  const start = buf.length - 2 - metadataLength;
  if (buf[start] >> 5 !== 5) return bytecode;

  const core = buf.subarray(0, start);
  return "0x" + core.toString("hex");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/^0x/, "");
}

// solc leaves `__$<34 hex>$__` (20 bytes) where an external library address is linked.
const LINK_PLACEHOLDER = /__\$[0-9a-fA-F]{34}\$__/g;

const PUSH1 = 0x60;
const PUSH32 = 0x7f;

/**
 * Immutable positions inferred from compiler output that does not list them,
 * e.g. prebuilt artifacts shipped without `immutableReferences`.
 *
 * solc reads every immutable with a PUSH32 whose operand it leaves zeroed in
 * the compiled code, and never emits PUSH32 for a zero constant (a shorter
 * push does), so each zero PUSH32 operand in the instruction stream is an
 * immutable. The walk stops at the CBOR metadata. Use the compiler's
 * `immutableReferences` whenever available; this is for classification, where
 * a wrong guess can only make two different codes look alike, never hide a
 * difference outside these spans.
 */
export function inferImmutableReferences(compiled: string): ImmutableReferences {
  const linked = normalize(compiled).replace(LINK_PLACEHOLDER, "0".repeat(40));
  const hex = stripBytecodeMetadata(linked).replace(/^0x/, "");
  const code = Buffer.from(hex, "hex");
  const spans: Array<{ start: number; length: number }> = [];
  for (let pc = 0; pc < code.length; pc++) {
    const op = code[pc];
    if (op < PUSH1 || op > PUSH32) continue;
    const size = op - PUSH1 + 1;
    if (op === PUSH32 && pc + 1 + size <= code.length) {
      if (code.subarray(pc + 1, pc + 1 + size).every((b) => b === 0)) {
        spans.push({ start: pc + 1, length: size });
      }
    }
    pc += size;
  }
  return spans.length === 0 ? {} : { inferred: spans };
}
