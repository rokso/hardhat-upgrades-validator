/**
 * Unit tests for the validations cache (loadValidationsFromDisk / writeValidationsToDisk).
 *
 * Uses a real temp directory so file I/O is exercised without mocking fs.
 * Fixture validations.json is used as a real ValidationDataCurrent source for
 * roundtrip tests: it must pass isCurrentValidationData().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadValidationsFromDisk,
  writeValidationsToDisk,
  validationsCachePath,
} from "../src/plugin/internals/validations-cache.js";

const FIXTURE_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cache");

let tmpCacheDir: string;

beforeEach(async () => {
  tmpCacheDir = await mkdtemp(join(tmpdir(), "hhuv-cache-test-"));
});

afterEach(async () => {
  await rm(tmpCacheDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadValidationsFromDisk: error paths
// ---------------------------------------------------------------------------

describe("loadValidationsFromDisk: error paths", () => {
  it("returns undefined when file does not exist", async () => {
    const result = await loadValidationsFromDisk(tmpCacheDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined for corrupted JSON", async () => {
    const cachePath = validationsCachePath(tmpCacheDir);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, "{ this is not valid json }", "utf8");

    const result = await loadValidationsFromDisk(tmpCacheDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined for valid JSON that fails isCurrentValidationData", async () => {
    const cachePath = validationsCachePath(tmpCacheDir);
    await mkdir(dirname(cachePath), { recursive: true });
    // Valid JSON but wrong shape: not a ValidationDataCurrent
    await writeFile(cachePath, JSON.stringify({ not: "a validation data object" }), "utf8");

    const result = await loadValidationsFromDisk(tmpCacheDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty file", async () => {
    const cachePath = validationsCachePath(tmpCacheDir);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, "", "utf8");

    const result = await loadValidationsFromDisk(tmpCacheDir);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// loadValidationsFromDisk + writeValidationsToDisk: happy path
// ---------------------------------------------------------------------------

describe("loadValidationsFromDisk: happy path roundtrip", () => {
  it("reads back the same data that was written", async () => {
    const fixtureData = await loadValidationsFromDisk(FIXTURE_CACHE_DIR);
    expect(fixtureData).toBeDefined();

    await writeValidationsToDisk(tmpCacheDir, fixtureData!);
    const readBack = await loadValidationsFromDisk(tmpCacheDir);

    expect(readBack).toBeDefined();
    // Structural equality: same version + same contract set.
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(fixtureData));
  });
});

// ---------------------------------------------------------------------------
// writeValidationsToDisk: lifecycle
// ---------------------------------------------------------------------------

describe("writeValidationsToDisk", () => {
  it("creates nested directory structure when it does not exist", async () => {
    const fixtureData = await loadValidationsFromDisk(FIXTURE_CACHE_DIR);
    expect(fixtureData).toBeDefined();

    // tmpCacheDir exists but hardhat-upgrades-validator/ subdir does not
    await writeValidationsToDisk(tmpCacheDir, fixtureData!);

    const readBack = await loadValidationsFromDisk(tmpCacheDir);
    expect(readBack).toBeDefined();
  });

  it("second sequential write succeeds; lock is released after first write", async () => {
    const fixtureData = await loadValidationsFromDisk(FIXTURE_CACHE_DIR);
    expect(fixtureData).toBeDefined();

    // Two sequential writes: first write must release the lock so the second
    // can acquire it without timing out.
    await writeValidationsToDisk(tmpCacheDir, fixtureData!);
    await expect(writeValidationsToDisk(tmpCacheDir, fixtureData!)).resolves.toBeUndefined();

    const readBack = await loadValidationsFromDisk(tmpCacheDir);
    expect(readBack).toBeDefined();
  });
});
