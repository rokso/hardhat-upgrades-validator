/**
 * Native solc acquisition and invocation, independent of Hardhat's compiler
 * manager so the core stays usable outside a Hardhat runtime.
 *
 * Lookup order: explicit override, our cache, Hardhat's compiler caches (v3
 * then v2, so a project that already compiled with that version pays nothing),
 * then a download from binaries.soliditylang.org verified against the
 * published sha256.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SolcInput, SolcOutput } from "@openzeppelin/upgrades-core";
import { BaselineIntegrityError, BaselineUnavailableError } from "./errors.js";

const BINARIES_URL = "https://binaries.soliditylang.org";

export interface SolcRunner {
  longVersion: string;
  path: string;
  compile(input: SolcInput): Promise<SolcOutput>;
}

export interface SolcOptions {
  /** Where downloaded compilers are kept. Defaults to `<os cache>/hardhat-upgrades-validator/compilers`. */
  cacheDir?: string;
  /** Explicit binary for a version, e.g. on platforms with no official native build. */
  resolvePath?: (longVersion: string) => string | undefined;
}

type FetchBinary = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export async function getSolc(
  longVersion: string,
  options: SolcOptions = {},
  fetchImpl: FetchBinary = fetch,
): Promise<SolcRunner> {
  const path = await locateSolc(longVersion, options, fetchImpl);
  return { longVersion, path, compile: (input) => runSolc(path, input) };
}

async function locateSolc(
  longVersion: string,
  options: SolcOptions,
  fetchImpl: FetchBinary,
): Promise<string> {
  const explicit = options.resolvePath?.(longVersion);
  if (explicit !== undefined) return explicit;

  const platform = nativePlatform();
  const cacheDir =
    options.cacheDir ?? join(osCacheDir(), "hardhat-upgrades-validator", "compilers");
  const ext = platform === "windows-amd64" ? ".exe" : "";
  const ours = join(cacheDir, platform, `solc-${platform}-v${longVersion}${ext}`);

  const hardhatCache = join(osCacheDir(), "hardhat-nodejs");
  const candidates = [ours];
  for (const dir of ["compilers-v3", "compilers-v2"]) {
    candidates.push(join(hardhatCache, dir, platform, `solc-${platform}-v${longVersion}${ext}`));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  await download(platform, longVersion, ours, fetchImpl);
  return ours;
}

async function download(
  platform: string,
  longVersion: string,
  dest: string,
  fetchImpl: FetchBinary,
): Promise<void> {
  // Failing to obtain a compiler means the baseline cannot be rebuilt, not
  // that it is wrong; only a checksum mismatch is an integrity problem.
  const listRes = await fetchOrUnavailable(fetchImpl, `${BINARIES_URL}/${platform}/list.json`);
  if (!listRes.ok) {
    throw new BaselineUnavailableError(
      `Could not fetch the solc build list (HTTP ${listRes.status}).`,
    );
  }
  const list = (await listRes.json()) as {
    builds: Array<{ path: string; longVersion: string; sha256: string }>;
  };
  const build = list.builds.find((b) => b.longVersion === longVersion);
  if (build === undefined) {
    throw new BaselineUnavailableError(`solc ${longVersion} has no native ${platform} build.`);
  }

  const binRes = await fetchOrUnavailable(fetchImpl, `${BINARIES_URL}/${platform}/${build.path}`);
  if (!binRes.ok) {
    throw new BaselineUnavailableError(
      `Could not download solc ${longVersion} (HTTP ${binRes.status}).`,
    );
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (`0x${actual}` !== build.sha256.toLowerCase()) {
    throw new BaselineIntegrityError(
      `solc ${longVersion} download failed its sha256 check; refusing to run it.`,
    );
  }

  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await chmod(tmp, 0o755);
  await rename(tmp, dest);
}

function runSolc(path: string, input: SolcInput): Promise<SolcOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["--standard-json"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    // A compiler that exits before reading all input closes the pipe; reject
    // instead of crashing the process with an unhandled EPIPE.
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`solc exited with code ${code}: ${Buffer.concat(err).toString()}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString()) as SolcOutput);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function nativePlatform(): string {
  const { platform, arch } = process;
  if (platform === "darwin") return "macosx-amd64"; // universal binaries for recent versions
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw new BaselineUnavailableError(
    `No official native solc build for ${platform}/${arch}; pass a compiler path via solc.resolvePath.`,
  );
}

async function fetchOrUnavailable(fetchImpl: FetchBinary, url: string) {
  try {
    return await fetchImpl(url);
  } catch (e) {
    throw new BaselineUnavailableError(`Could not reach ${BINARIES_URL}: ${(e as Error).message}`);
  }
}

function osCacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
