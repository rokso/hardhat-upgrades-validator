import { readFile, readdir, writeFile } from "node:fs/promises";

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
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
  await writeFile(filePath, withNewline, "utf8");
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
