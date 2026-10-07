/**
 * Verified-source lookup against an Etherscan-compatible explorer API.
 *
 * Only standard-json verifications are accepted. Flattened and multi-file
 * verifications do not record every compiler setting (`viaIR` among them), so
 * rebuilding from them means guessing; the bytecode proof would reject a wrong
 * guess, but refusing up front gives a clearer error.
 */

import type { SolcInput } from "@openzeppelin/upgrades-core";
import { BaselineUnavailableError } from "./errors.js";

export const ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api";

export interface ExplorerConfig {
  /** Etherscan-compatible endpoint. Defaults to Etherscan v2, which serves every chain it indexes. */
  apiUrl?: string;
  apiKey?: string;
}

export interface VerifiedSource {
  input: SolcInput;
  /** e.g. `0.8.25+commit.b61c2a91` */
  solcLongVersion: string;
  /** Simple contract name as verified. */
  contractName: string;
}

type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ExplorerResponse {
  status?: string;
  message?: string;
  result?: unknown;
}

interface SourceCodeEntry {
  SourceCode?: string;
  ContractName?: string;
  CompilerVersion?: string;
}

const RATE_LIMIT = /rate limit/i;
// Key problems are the user's to fix and must surface; anything else the
// explorer refuses (unsupported chain, outage) only means it cannot answer.
const KEY_ERROR = /api.?key/i;
const MAX_ATTEMPTS = 4;

/**
 * Etherscan needs a key; a custom Etherscan-compatible endpoint (e.g. a
 * Blockscout instance) may not.
 */
export function canQueryExplorer(config: ExplorerConfig): boolean {
  return Boolean(config.apiKey) || Boolean(config.apiUrl);
}

export async function fetchVerifiedSource(
  chainId: number,
  address: string,
  config: ExplorerConfig,
  fetchImpl: FetchLike = fetch,
): Promise<VerifiedSource> {
  if (!canQueryExplorer(config)) {
    throw new BaselineUnavailableError(
      `No explorer API key configured for chain ${chainId}; cannot fetch verified source for ${address}.`,
    );
  }

  const url = new URL(config.apiUrl ?? ETHERSCAN_V2_API_URL);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);
  if (config.apiKey) url.searchParams.set("apikey", config.apiKey);

  const entry = await requestWithRetry(url.toString(), fetchImpl);
  return parseSourceCodeEntry(entry, address);
}

async function requestWithRetry(url: string, fetchImpl: FetchLike): Promise<SourceCodeEntry> {
  for (let attempt = 1; ; attempt++) {
    const retry = attempt < MAX_ATTEMPTS;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      // Messages never include the URL, which carries the API key.
      throw new BaselineUnavailableError(`Explorer unreachable: ${(e as Error).message}`);
    }

    if (res.status === 429 && retry) {
      await backoff(attempt);
      continue;
    }
    if (!res.ok) {
      throw new BaselineUnavailableError(`Explorer request failed with HTTP ${res.status}.`);
    }
    const body = (await res.json()) as ExplorerResponse;

    if (body.status === "1" && Array.isArray(body.result) && body.result.length > 0) {
      return body.result[0] as SourceCodeEntry;
    }

    const detail =
      typeof body.result === "string" ? body.result : (body.message ?? "unknown error");
    if (RATE_LIMIT.test(detail) && retry) {
      await backoff(attempt);
      continue;
    }
    if (KEY_ERROR.test(detail)) throw new Error(`Explorer rejected the API key: ${detail}`);
    throw new BaselineUnavailableError(`Explorer could not answer: ${detail}`);
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 1000 * attempt));
}

/** Exported for tests. */
export function parseSourceCodeEntry(entry: SourceCodeEntry, address: string): VerifiedSource {
  const raw = entry.SourceCode ?? "";
  if (raw === "") {
    throw new BaselineUnavailableError(`Contract ${address} is not verified on the explorer.`);
  }

  const compilerVersion = entry.CompilerVersion ?? "";
  if (!compilerVersion.startsWith("v0.")) {
    throw new BaselineUnavailableError(
      `Contract ${address} was verified with "${compilerVersion}"; only Solidity is supported.`,
    );
  }

  const input = parseStandardJson(raw);
  if (input === undefined) {
    throw new BaselineUnavailableError(
      `Contract ${address} is verified as flattened or multi-file source, not standard-json. ` +
        `Its compiler settings cannot be reconstructed exactly.`,
    );
  }

  return {
    input,
    solcLongVersion: compilerVersion.slice(1),
    contractName: entry.ContractName ?? "",
  };
}

// Etherscan wraps standard-json in an extra pair of braces (`{{...}}`); some
// compatible explorers return it unwrapped.
function parseStandardJson(raw: string): SolcInput | undefined {
  const text = raw.startsWith("{{") && raw.endsWith("}}") ? raw.slice(1, -1) : raw;
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const candidate = parsed as Partial<SolcInput> & { language?: string };
  if (candidate.language !== "Solidity" || typeof candidate.sources !== "object") return undefined;
  return candidate as SolcInput;
}
