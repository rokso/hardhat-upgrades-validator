/**
 * Implementation layout records, one JSON file per implementation address.
 *
 * Kept under `deployments/<network>/.storage-layouts/` and meant to be
 * committed: records are reviewable in PRs and let CI validate without an
 * explorer key. hardhat-deploy only loads `*.json` directly inside the
 * network directory, so the dot-directory is never read as a deployment.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tryReadJsonFile, writeJsonFile } from "../../utils/io.js";
import type { ImplementationLayoutRecord } from "./types.js";

export const LAYOUT_STORE_DIRNAME = ".storage-layouts";

export function layoutStoreDir(deploymentsDir: string): string {
  return join(deploymentsDir, LAYOUT_STORE_DIRNAME);
}

export async function readLayoutRecord(
  storeDir: string,
  address: string,
): Promise<ImplementationLayoutRecord | undefined> {
  const record = await tryReadJsonFile<ImplementationLayoutRecord>(recordPath(storeDir, address));
  if (record === undefined) return undefined;
  if (record.format !== 1) {
    throw new Error(
      `Unsupported layout record format ${String(record.format)} for ${address}; upgrade hardhat-upgrades-validator.`,
    );
  }
  return record;
}

export async function writeLayoutRecord(
  storeDir: string,
  record: ImplementationLayoutRecord,
): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeJsonFile(recordPath(storeDir, record.address), record, {
    pretty: true,
    trailingNewline: true,
  });
}

function recordPath(storeDir: string, address: string): string {
  return join(storeDir, `${address.toLowerCase()}.json`);
}
