import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
}

export async function tryReadJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
  opts: { pretty?: boolean; trailingNewline?: boolean } = {},
): Promise<void> {
  const text = opts.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const withNewline = opts.trailingNewline ? text + "\n" : text;
  // Written beside the target and renamed over it, so a crash never leaves a
  // truncated file behind.
  // Unique per write: concurrent writes of the same file in one process must
  // not share a temporary file.
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, withNewline, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function listDirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export async function listSubdirsOrEmpty(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
