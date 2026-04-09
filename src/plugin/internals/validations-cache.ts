/**
 * Disk cache for oz-core ValidationData.
 *
 * Stores compiled validation results in `{cache}/hardhat-upgrades-validator/validations.json`
 * so that the deploy hook and CLI tasks can resolve storage layouts without
 * re-parsing build-info files after the compile step.
 *
 * File locking (proper-lockfile) is used on writes so parallel Hardhat workers
 * cannot corrupt the cache. Pattern adapted from @openzeppelin/hardhat-upgrades (MIT).
 */

import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { lock as lockfile } from "proper-lockfile";
import { type ValidationDataCurrent, isCurrentValidationData } from "@openzeppelin/upgrades-core";

export function validationsCachePath(hardhatCachePath: string): string {
  return join(hardhatCachePath, "hardhat-upgrades-validator", "validations.json");
}

export async function loadValidationsFromDisk(
  hardhatCachePath: string,
): Promise<ValidationDataCurrent | undefined> {
  try {
    const raw = await readFile(validationsCachePath(hardhatCachePath), "utf8");
    const data = JSON.parse(raw) as unknown;
    return isCurrentValidationData(data as never) ? (data as ValidationDataCurrent) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeValidationsToDisk(
  hardhatCachePath: string,
  data: ValidationDataCurrent,
): Promise<void> {
  const path = validationsCachePath(hardhatCachePath);
  await mkdir(dirname(path), { recursive: true });

  // Touch the file so proper-lockfile has a target to lock against.
  // open() with 'a' flag creates if absent, leaves existing content intact.
  await (await open(path, "a")).close();

  // Adapted from @openzeppelin/hardhat-upgrades (MIT)
  // https://github.com/OpenZeppelin/openzeppelin-upgrades
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lockfile(path, {
      retries: { minTimeout: 50, factor: 1.3 },
      realpath: false,
    });
    await writeFile(path, JSON.stringify(data), "utf8");
  } finally {
    await releaseLock?.();
  }
}
