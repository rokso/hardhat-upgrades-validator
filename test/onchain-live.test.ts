/**
 * Live check against a real proxy with ERC-7201 storage on any chain.
 *
 * Opt-in, and target-agnostic: point it at a proxy whose implementation is
 * verified (standard-json) on an Etherscan-compatible explorer.
 *
 *   LIVE_RPC_URL=...  LIVE_PROXY=0x...  ETHERSCAN_API_KEY=... \
 *     pnpm vitest run test/onchain-live.test.ts
 *
 * Optional: LIVE_EXPLORER_URL for a non-Etherscan explorer.
 *
 * It reads whatever implementation the proxy runs at the time, then edits the
 * first namespaced struct of that implementation's own layout: inserting a
 * field at the start must fail, appending one must pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SolcInput } from "@openzeppelin/upgrades-core";

import { resolveChainBaseline, type ChainBaseline } from "../src/core/onchain/baseline.js";
import { fetchVerifiedSource, type ExplorerConfig } from "../src/core/onchain/explorer.js";
import { readChainId } from "../src/core/onchain/implementation.js";
import { layoutFromSource } from "../src/core/onchain/reconstruct.js";
import { getSolc } from "../src/core/onchain/solc.js";
import { validateStorageUpgrade } from "../src/core/validator.js";

const RPC = process.env.LIVE_RPC_URL;
const PROXY = process.env.LIVE_PROXY;
const EXPLORER: ExplorerConfig = {
  apiKey: process.env.ETHERSCAN_API_KEY,
  ...(process.env.LIVE_EXPLORER_URL ? { apiUrl: process.env.LIVE_EXPLORER_URL } : {}),
};

let id = 0;
const provider = {
  async send(method: string, params: unknown[] = []) {
    const res = await fetch(RPC!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  },
};

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.skipIf(!RPC || !PROXY || !(EXPLORER.apiKey || EXPLORER.apiUrl))(
  "live: proxy on a real chain",
  () => {
    let tmpDir: string;
    let baseline: ChainBaseline;
    let input: SolcInput;
    // The first namespaced struct of the live layout, located in its source file.
    let target: { file: string; open: RegExp; close: RegExp } | undefined;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "hhuv-live-"));
      baseline = await resolveChainBaseline(PROXY!, {
        provider,
        storeDir: tmpDir,
        explorer: EXPLORER,
      });
      const chainId = await readChainId(provider);
      input = (await fetchVerifiedSource(chainId, baseline.implementation, EXPLORER)).input;

      for (const namespace of Object.keys(baseline.record.layout.namespaces ?? {})) {
        const id = escape(namespace.replace(/^erc7201:/, ""));
        const head = `(@custom:storage-location erc7201:${id}\\s*\\n\\s*struct \\w+ \\{\\n)`;
        const open = new RegExp(head);
        const close = new RegExp(
          `(@custom:storage-location erc7201:${id}\\s*\\n\\s*struct \\w+ \\{[^}]*)(\\n\\s*\\})`,
        );
        const file = Object.keys(input.sources).find((f) =>
          open.test(input.sources[f].content ?? ""),
        );
        if (file !== undefined) {
          target = { file, open, close };
          break;
        }
      }
    }, 600_000);

    afterAll(async () => {
      await rm(tmpDir, { recursive: true });
    });

    function edited(transform: (content: string) => string): SolcInput {
      const content = input.sources[target!.file].content!;
      const changed = transform(content);
      expect(changed).not.toBe(content); // the edit must have landed
      return { ...input, sources: { ...input.sources, [target!.file]: { content: changed } } };
    }

    async function check(changed: SolcInput) {
      const solc = await getSolc(baseline.record.compiler!);
      const layout = await layoutFromSource(changed, solc, baseline.record.contract);
      return validateStorageUpgrade("live", baseline.record.layout, layout, { kind: "uups" });
    }

    it("locates a namespaced struct of the live layout in the verified source", (ctx) => {
      if (Object.keys(baseline.record.layout.namespaces ?? {}).length === 0) ctx.skip();
      // A layout with namespaces whose struct the edits cannot find would make the
      // insert/append checks below skip, so a green run would prove nothing.
      expect(target).toBeDefined();
    });

    it("proves the live implementation against its deployed code", () => {
      expect(["exact", "immutables-only"]).toContain(baseline.record.bytecodeMatch);
      expect(baseline.record.contract).toMatch(/:\w+$/);
    });

    it("validates the verified source against itself", async () => {
      const result = await check(input);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }, 600_000);

    it("passes a field appended to a namespace", async (ctx) => {
      if (target === undefined) ctx.skip(); // the target has no namespaced storage
      const result = await check(
        edited((c) => c.replace(target!.close, "$1\n        uint256 _appended;$2")),
      );
      expect(result.ok).toBe(true);
    }, 600_000);

    it("fails a field inserted at the start of a namespace", async (ctx) => {
      if (target === undefined) ctx.skip();
      const result = await check(
        edited((c) => c.replace(target!.open, "$1        uint256 _inserted;\n")),
      );
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result.errors)).toMatch(/inserted/);
    }, 600_000);
  },
);
