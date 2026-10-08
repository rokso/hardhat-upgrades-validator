/**
 * JSON files (deployment files included) are written whole or not at all,
 * and a damaged one is named.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// writeFile is wrapped so a test can make one write fail part way.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

import { writeFile as mockedWriteFile } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../src/utils/io.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hhuv-io-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true });
});

describe("writeJsonFile", () => {
  it("replaces the file and leaves no temporary file behind", async () => {
    const file = join(dir, "a.json");
    await writeJsonFile(file, { v: 1 });
    await writeJsonFile(file, { v: 2 }, { pretty: true, trailingNewline: true });
    expect(await readJsonFile(file)).toEqual({ v: 2 });
    expect(await readdir(dir)).toEqual(["a.json"]);
  });

  it("keeps the old file whole when a write fails part way", async () => {
    const file = join(dir, "a.json");
    await writeJsonFile(file, { v: 1 });
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(mockedWriteFile).mockImplementationOnce(async (path, data) => {
      await fs.writeFile(path as string, String(data).slice(0, 5));
      throw new Error("disk full");
    });
    await expect(writeJsonFile(file, { v: 2, pad: "x".repeat(100) })).rejects.toThrow("disk full");
    expect(await readJsonFile(file)).toEqual({ v: 1 });
    expect(await readdir(dir)).toEqual(["a.json"]);
  });

  it("survives concurrent writes of the same file in one process", async () => {
    const file = join(dir, "a.json");
    await Promise.all([writeJsonFile(file, { v: 1 }), writeJsonFile(file, { v: 1 })]);
    expect(await readJsonFile(file)).toEqual({ v: 1 });
    expect(await readdir(dir)).toEqual(["a.json"]);
  });

  it("cleans up its temporary file when the final rename fails", async () => {
    // A non-empty directory where the file should go: the rename fails.
    await mkdir(join(dir, "a.json"));
    await writeFile(join(dir, "a.json", "x"), "");
    await expect(writeJsonFile(join(dir, "a.json"), { v: 1 })).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["a.json"]);
  });
});

describe("readJsonFile", () => {
  it("names the file that is not valid JSON", async () => {
    const file = join(dir, "broken.json");
    await writeFile(file, "{ truncated");
    await expect(readJsonFile(file)).rejects.toThrow(`${file} is not valid JSON`);
  });
});
