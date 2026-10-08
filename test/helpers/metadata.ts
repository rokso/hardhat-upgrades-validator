/**
 * solc's CBOR metadata as default settings emit it: an ipfs hash of the
 * metadata (which covers every source), the compiler version, and the 2-byte
 * length suffix. slotdiff only accepts a bytecode match as proof of a layout
 * when the code carries such a hash, so fake test code needs one.
 */
export const METADATA = "a2646970667358221220" + "12".repeat(32) + "64736f6c6343000818" + "0033";
