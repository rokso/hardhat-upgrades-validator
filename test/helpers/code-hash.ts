import { createHash } from "node:crypto";

/** The code hash a slotdiff layout record carries: sha256 of the runtime code bytes, hex. */
export function codeSha256(code: string): string {
  return createHash("sha256")
    .update(Buffer.from(code.replace(/^0x/, ""), "hex"))
    .digest("hex");
}
