/**
 * Guards against an RPC that answers for another chain than the one a
 * deployments directory describes, say a mainnet URL pointing at a testnet.
 * There no proxy slot is set, so every proxy would silently drop out of
 * validation.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BaselineIntegrityError } from "../../core/onchain/errors.js";
import { readChainId } from "../../core/onchain/implementation.js";
import {
  layoutStoreDir,
  listProxyEntries,
  readProxyEntry,
  readScanMarker,
} from "../../core/onchain/store.js";
import type { EthProvider } from "../../core/onchain/types.js";
import { tryReadJsonFile } from "../../utils/io.js";

/**
 * Throws `BaselineIntegrityError` when the provider's chain id differs from
 * one recorded for `deploymentsDir`: hardhat-deploy's `.chain` (or older
 * `.chainId`) file, the scan
 * marker, or the proxy index (every entry, or only `address`'s when given).
 */
export async function assertSameChain(
  deploymentsDir: string,
  provider: EthProvider,
  options: { address?: string } = {},
): Promise<void> {
  // hardhat-deploy's fork mode serves the network's deployments from a local
  // fork whose chain id is the fork network's own, by design.
  if (process.env.HARDHAT_FORK) return;
  const expected = await recordedChainIds(deploymentsDir, options.address);
  if (expected.length === 0) return;
  const actual = await readChainId(provider);
  const other = expected.find((e) => e.chainId !== actual);
  if (other !== undefined) {
    throw new BaselineIntegrityError(
      `The RPC answers for chain ${actual}, but ${other.source} records chain ${other.chainId}. ` +
        `Check that the network's URL points at the chain these deployments are on.`,
    );
  }
}

async function recordedChainIds(
  deploymentsDir: string,
  address: string | undefined,
): Promise<Array<{ source: string; chainId: number }>> {
  const found: Array<{ source: string; chainId: number }> = [];

  // hardhat-deploy writes `.chain`; it still reads the older `.chainId`
  // (plain text) until a deploy to the network replaces it.
  const chainFile = join(deploymentsDir, ".chain");
  const legacyFile = join(deploymentsDir, ".chainId");
  const chain = await tryReadJsonFile<{ chainId?: unknown }>(chainFile).catch(() => undefined);
  const legacy = await readFile(legacyFile, "utf8").catch(() => undefined);
  const fileChainId = parseChainId(chain?.chainId);
  const legacyChainId = parseChainId(legacy?.trim());
  if (fileChainId !== undefined) found.push({ source: chainFile, chainId: fileChainId });
  else if (legacyChainId !== undefined) found.push({ source: legacyFile, chainId: legacyChainId });

  const storeDir = layoutStoreDir(deploymentsDir);
  const marker = await readScanMarker(storeDir);
  if (marker !== undefined) {
    found.push({ source: join(storeDir, "scan.json"), chainId: marker.chainId });
  }

  const entries =
    address === undefined
      ? await listProxyEntries(storeDir)
      : [await readProxyEntry(storeDir, address)].filter((e) => e !== undefined);
  for (const entry of entries) {
    found.push({ source: `the proxy index entry for ${entry.proxy}`, chainId: entry.chainId });
  }
  return found;
}

// hardhat-deploy writes the chain id as a decimal string.
function parseChainId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
