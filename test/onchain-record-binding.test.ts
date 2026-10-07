/**
 * A stored layout record is bound to the code it was proven against: one
 * copied from another chain, or left over from different code at the same
 * address, is refused rather than served.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { resolveImplementationLayout } from "../src/core/onchain/baseline.js";
import { BaselineIntegrityError } from "../src/core/onchain/errors.js";
import { codeSha256 } from "../src/core/onchain/implementation.js";
import { writeLayoutRecord } from "../src/core/onchain/store.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const IMPL = "0x00000000000000000000000000000000000000bb";
const PROVEN = "0x6080604052" + "11".repeat(32);
const OTHER = "0x6080604052" + "22".repeat(32);

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "hhuv-binding-"));
  await writeLayoutRecord(storeDir, {
    format: 1,
    address: IMPL,
    chainId: 1,
    codeSha256: codeSha256(PROVEN),
    contract: "a.sol:A",
    bytecodeMatch: "exact",
    source: "local-compile",
    recordedAt: "2026-01-01T00:00:00.000Z",
    layout: { storage: [], types: {} } as never,
  });
});

afterEach(async () => {
  await rm(storeDir, { recursive: true });
});

describe("stored record binding", () => {
  it("serves the record when the chain has the code it was proven against", async () => {
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    const { origin } = await resolveImplementationLayout(IMPL, { provider, storeDir });
    expect(origin).toBe("store");
  });

  it("refuses the record when the chain has other code at that address", async () => {
    const provider = makeMockChain({ code: { [IMPL]: OTHER } });
    await expect(resolveImplementationLayout(IMPL, { provider, storeDir })).rejects.toThrow(
      BaselineIntegrityError,
    );
    await expect(resolveImplementationLayout(IMPL, { provider, storeDir })).rejects.toThrow(
      /proven against different code/,
    );
  });

  it("asks for the explorer config only when no record serves the implementation", async () => {
    const explorer = vi.fn().mockResolvedValue({});
    const provider = makeMockChain({ code: { [IMPL]: PROVEN } });
    await resolveImplementationLayout(IMPL, { provider, storeDir, explorer });
    expect(explorer).not.toHaveBeenCalled();

    const missing = "0x00000000000000000000000000000000000000cc";
    await expect(
      resolveImplementationLayout(missing, {
        provider: makeMockChain({ code: { [missing]: PROVEN } }),
        storeDir,
        explorer,
      }),
    ).rejects.toThrow(/no explorer configured/);
    expect(explorer).toHaveBeenCalledTimes(1);
  });
});
