/**
 * The layout store, under `deployments/<network>/.storage-layouts/`:
 *
 * - `implementations/<address>.json`: one layout record per implementation.
 * - `proxies/<address>.json`: one index entry per proxy, naming the
 *   implementation it ran when last observed.
 *
 * Meant to be committed: records are reviewable in PRs and let CI validate
 * without an explorer key. One file per address keeps unrelated upgrades from
 * conflicting in git. hardhat-deploy only loads `*.json` directly inside the
 * network directory, so the dot-directory is never read as a deployment.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listDirOrEmpty, tryReadJsonFile, writeJsonFile } from "../../utils/io.js";
import { isProvingMatch } from "../bytecode-utils.js";
import { BaselineIntegrityError } from "./errors.js";
import type { ImplementationLayoutRecord, ProxyIndexEntry } from "./types.js";

export const LAYOUT_STORE_DIRNAME = ".storage-layouts";
const IMPLEMENTATIONS_DIRNAME = "implementations";
const PROXIES_DIRNAME = "proxies";

export function layoutStoreDir(deploymentsDir: string): string {
  return join(deploymentsDir, LAYOUT_STORE_DIRNAME);
}

export async function readLayoutRecord(
  storeDir: string,
  address: string,
): Promise<ImplementationLayoutRecord | undefined> {
  const record = await tryReadJsonFile<ImplementationLayoutRecord>(
    entryPath(storeDir, IMPLEMENTATIONS_DIRNAME, address),
  );
  if (record === undefined) return undefined;
  checkFormat(record.format, `layout record for ${address}`);
  // Checked here so offline readers refuse weak records too, not just the chain path.
  if (!isProvingMatch(record.bytecodeMatch)) {
    throw new BaselineIntegrityError(
      `The layout record for ${address} rests on a "${String(record.bytecodeMatch)}" match, which ` +
        `does not prove a storage layout. Delete it, or re-run record-baseline with --force.`,
    );
  }
  return record;
}

export async function writeLayoutRecord(
  storeDir: string,
  record: ImplementationLayoutRecord,
): Promise<void> {
  await writeEntry(storeDir, IMPLEMENTATIONS_DIRNAME, record.address, record);
}

export async function readProxyEntry(
  storeDir: string,
  proxy: string,
): Promise<ProxyIndexEntry | undefined> {
  const entry = await tryReadJsonFile<ProxyIndexEntry>(entryPath(storeDir, PROXIES_DIRNAME, proxy));
  if (entry !== undefined) checkFormat(entry.format, `proxy index entry for ${proxy}`);
  return entry;
}

export async function listProxyEntries(storeDir: string): Promise<ProxyIndexEntry[]> {
  const files = await listDirOrEmpty(join(storeDir, PROXIES_DIRNAME));
  const entries: ProxyIndexEntry[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const entry = await readProxyEntry(storeDir, file.slice(0, -5));
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * Writes the entry only when what it says changed, so re-observing the same
 * state never churns the committed file. Returns whether it wrote.
 */
export async function updateProxyEntry(storeDir: string, entry: ProxyIndexEntry): Promise<boolean> {
  const proxy = entry.proxy.toLowerCase();
  const next: ProxyIndexEntry = {
    ...entry,
    proxy,
    implementation: entry.implementation.toLowerCase(),
    ...(entry.beacon !== undefined ? { beacon: entry.beacon.toLowerCase() } : {}),
    deployments: [...new Set(entry.deployments)].sort(),
  };
  const current = await readProxyEntry(storeDir, proxy);
  if (current !== undefined && sameState(current, next)) return false;
  await writeEntry(storeDir, PROXIES_DIRNAME, proxy, next);
  return true;
}

function sameState(a: ProxyIndexEntry, b: ProxyIndexEntry): boolean {
  return (
    a.chainId === b.chainId &&
    a.implementation === b.implementation &&
    a.beacon === b.beacon &&
    a.deployments.join("\n") === b.deployments.join("\n")
  );
}

function checkFormat(format: unknown, what: string): void {
  if (format !== 1) {
    throw new Error(
      `Unsupported format ${String(format)} in the ${what}; upgrade hardhat-upgrades-validator.`,
    );
  }
}

async function writeEntry(
  storeDir: string,
  kind: string,
  address: string,
  data: unknown,
): Promise<void> {
  await mkdir(join(storeDir, kind), { recursive: true });
  await writeJsonFile(entryPath(storeDir, kind, address), data, {
    pretty: true,
    trailingNewline: true,
  });
}

function entryPath(storeDir: string, kind: string, address: string): string {
  return join(storeDir, kind, `${address.toLowerCase()}.json`);
}
