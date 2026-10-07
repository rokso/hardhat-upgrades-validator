/**
 * End-to-end chain baseline with a real solc: a mock chain runs compiled code
 * (immutables filled in, as on a real chain), a stubbed explorer serves the
 * verified standard-json, and the full pipeline must prove, extract, record
 * and then validate upgrades against it.
 *
 * Nothing in the pipeline is mocked except the two network endpoints.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SolcInput } from "@openzeppelin/upgrades-core";

import { resolveChainBaseline } from "../src/core/onchain/baseline.js";
import { getSolc, type SolcRunner } from "../src/core/onchain/solc.js";
import { layoutFromSource } from "../src/core/onchain/reconstruct.js";
import { BaselineIntegrityError } from "../src/core/onchain/errors.js";
import { validateStorageUpgrade } from "../src/core/validator.js";
import { makeMockChain } from "./helpers/mock-chain.js";

const SOLC = "0.8.24+commit.e11b9ed9";
const PROXY = "0x00000000000000000000000000000000000000aa";
const IMPL = "0x00000000000000000000000000000000000000bb";

function source(structBody: string, extraVar = ""): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract Box {
    /// @custom:storage-location erc7201:box.main
    struct MainStorage {
${structBody}
    }

    address private immutable self = address(this);
    uint256 public version;
${extraVar}
    function getSelf() external view returns (address) {
        return self;
    }
}
`;
}

const V1 = source("        uint256 value;\n        address owner;\n        bool active;");
const V2_APPEND = source(
  "        uint256 value;\n        address owner;\n        bool active;\n        uint256 added;",
  "    uint256 public extra;",
);
const V2_INSERT = source(
  "        uint256 inserted;\n        uint256 value;\n        address owner;\n        bool active;",
);
const V2_RETYPE = source("        uint128 value;\n        address owner;\n        bool active;");

function input(content: string): SolcInput {
  return {
    language: "Solidity",
    sources: { "contracts/Box.sol": { content } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi"] } },
    },
  } as SolcInput;
}

let solc: SolcRunner;
let tmpDir: string;

// Deployed runtime code of `content`, immutables filled the way a constructor would.
async function deployedCode(content: string): Promise<string> {
  const out = await solc.compile({
    ...input(content),
    settings: {
      ...input(content).settings,
      outputSelection: {
        "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] },
      },
    },
  } as SolcInput);
  const deployed = (
    out.contracts["contracts/Box.sol"].Box as unknown as {
      evm: {
        deployedBytecode: {
          object: string;
          immutableReferences: Record<string, Array<{ start: number; length: number }>>;
        };
      };
    }
  ).evm.deployedBytecode;
  const buf = Buffer.from(deployed.object, "hex");
  const spans = Object.values(deployed.immutableReferences).flat();
  expect(spans.length).toBeGreaterThan(0); // the test is meaningless without one
  for (const { start, length } of spans) {
    Buffer.from(IMPL.slice(2).padStart(length * 2, "0"), "hex").copy(buf, start);
  }
  return "0x" + buf.toString("hex");
}

function explorerServing(content: string) {
  const sourceCode = `{${JSON.stringify(input(content))}}`;
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: "1",
      result: [{ SourceCode: sourceCode, ContractName: "Box", CompilerVersion: `v${SOLC}` }],
    }),
  }));
}

// The "new" side: the same extraction pipeline, applied to the local source.
async function localLayout(content: string) {
  return layoutFromSource(input(content), solc, "contracts/Box.sol:Box");
}

beforeAll(async () => {
  // Resolves from Hardhat's compiler cache, populated by `pnpm fixtures`.
  solc = await getSolc(SOLC);
}, 120_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hhuv-e2e-"));
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function chainBaselineFor(served: string, running: string) {
  const chain = makeMockChain({
    code: { [IMPL]: await deployedCode(running) },
    implementations: { [PROXY]: IMPL },
  });
  vi.stubGlobal("fetch", explorerServing(served));
  return resolveChainBaseline(PROXY, {
    provider: chain,
    storeDir: join(tmpDir, ".storage-layouts"),
    explorer: { apiKey: "KEY" },
  });
}

describe("chain baseline end to end", () => {
  it("proves, records, and serves the layout of the running implementation", async () => {
    const first = await chainBaselineFor(V1, V1);

    expect(first.origin).toBe("explorer");
    expect(first.implementation).toBe(IMPL);
    expect(first.record.bytecodeMatch).toBe("immutables-only");
    expect(first.record.contract).toBe("contracts/Box.sol:Box");
    expect(first.record.layout.storage.map((s) => s.label)).toEqual(["version"]);
    const ns = first.record.layout.namespaces?.["erc7201:box.main"];
    expect(ns?.map((i) => `${i.label}@${i.slot}/${i.offset}`)).toEqual([
      "value@0/0",
      "owner@1/0",
      "active@1/20", // packed: the namespaced pass supplies real offsets
    ]);

    const onDisk = JSON.parse(
      await readFile(join(tmpDir, ".storage-layouts", `${IMPL}.json`), "utf8"),
    );
    expect(onDisk.layout).toEqual(first.record.layout);

    const second = await chainBaselineFor(V1, V1);
    expect(second.origin).toBe("store");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  }, 120_000);

  it("refuses verified source that does not compile to the deployed code", async () => {
    await expect(chainBaselineFor(V2_APPEND, V1)).rejects.toThrow(BaselineIntegrityError);
  }, 120_000);

  it("passes an append-only upgrade", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = validateStorageUpgrade("Box", record.layout, await localLayout(V2_APPEND), {
      kind: "uups",
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  }, 120_000);

  it("fails an insertion at the start of the namespace, naming the field", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = validateStorageUpgrade("Box", record.layout, await localLayout(V2_INSERT), {
      kind: "uups",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/inserted/);
  }, 120_000);

  it("fails a narrowing type change inside the namespace", async () => {
    const { record } = await chainBaselineFor(V1, V1);
    const result = validateStorageUpgrade("Box", record.layout, await localLayout(V2_RETYPE), {
      kind: "uups",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type-changed")).toBe(true);
  }, 120_000);
});
