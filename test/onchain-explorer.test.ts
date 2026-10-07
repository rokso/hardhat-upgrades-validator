import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchVerifiedSource,
  parseSourceCodeEntry,
  ETHERSCAN_V2_API_URL,
} from "../src/core/onchain/explorer.js";
import { BaselineUnavailableError } from "../src/core/onchain/errors.js";

const ADDRESS = "0x00000000000000000000000000000000000000bb";
const STANDARD = {
  language: "Solidity",
  sources: { "contracts/A.sol": { content: "contract A {}" } },
  settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
};

function entry(sourceCode: string, compiler = "v0.8.25+commit.b61c2a91") {
  return { SourceCode: sourceCode, ContractName: "A", CompilerVersion: compiler };
}

function okResponse(result: unknown) {
  return { ok: true, status: 200, json: async () => ({ status: "1", message: "OK", result }) };
}

function errorResponse(result: string) {
  return { ok: true, status: 200, json: async () => ({ status: "0", message: "NOTOK", result }) };
}

describe("parseSourceCodeEntry", () => {
  it("unwraps Etherscan's double-brace standard-json", () => {
    const parsed = parseSourceCodeEntry(entry(`{${JSON.stringify(STANDARD)}}`), ADDRESS);
    expect(parsed.input).toEqual(STANDARD);
    expect(parsed.solcLongVersion).toBe("0.8.25+commit.b61c2a91");
    expect(parsed.contractName).toBe("A");
  });

  it("accepts unwrapped standard-json from compatible explorers", () => {
    const parsed = parseSourceCodeEntry(entry(JSON.stringify(STANDARD)), ADDRESS);
    expect(parsed.input.settings).toEqual(STANDARD.settings);
  });

  it("reports an unverified contract as unavailable", () => {
    expect(() => parseSourceCodeEntry(entry(""), ADDRESS)).toThrow(BaselineUnavailableError);
  });

  it("rejects flattened source as unavailable", () => {
    expect(() =>
      parseSourceCodeEntry(entry("pragma solidity 0.8.25; contract A {}"), ADDRESS),
    ).toThrow(/flattened or multi-file/);
  });

  it("rejects multi-file (non-standard) json as unavailable", () => {
    const multi = JSON.stringify({ "A.sol": { content: "contract A {}" } });
    expect(() => parseSourceCodeEntry(entry(multi), ADDRESS)).toThrow(BaselineUnavailableError);
  });

  it("rejects Vyper", () => {
    expect(() =>
      parseSourceCodeEntry(entry(JSON.stringify(STANDARD), "vyper:0.3.10"), ADDRESS),
    ).toThrow(/only Solidity/);
  });
});

describe("fetchVerifiedSource", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unavailable without an API key, and makes no request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchVerifiedSource(1, ADDRESS, {}, fetchImpl)).rejects.toThrow(
      BaselineUnavailableError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries Etherscan v2 with the chain id by default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse([entry(`{${JSON.stringify(STANDARD)}}`)]));
    await fetchVerifiedSource(8453, ADDRESS, { apiKey: "KEY" }, fetchImpl);

    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(ETHERSCAN_V2_API_URL);
    expect(url.searchParams.get("chainid")).toBe("8453");
    expect(url.searchParams.get("action")).toBe("getsourcecode");
    expect(url.searchParams.get("address")).toBe(ADDRESS);
    expect(url.searchParams.get("apikey")).toBe("KEY");
  });

  it("uses a configured apiUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([entry(JSON.stringify(STANDARD))]));
    await fetchVerifiedSource(
      43111,
      ADDRESS,
      { apiKey: "KEY", apiUrl: "https://explorer.example/api" },
      fetchImpl,
    );
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/explorer\.example\/api\?/);
  });

  it("retries on rate limiting", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Max rate limit reached"))
      .mockResolvedValueOnce(okResponse([entry(JSON.stringify(STANDARD))]));

    const pending = fetchVerifiedSource(1, ADDRESS, { apiKey: "KEY" }, fetchImpl);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ contractName: "A" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected key as a configuration error, not a missing baseline", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse("Invalid API Key"));
    const err = await fetchVerifiedSource(1, ADDRESS, { apiKey: "BAD" }, fetchImpl).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BaselineUnavailableError);
    expect((err as Error).message).toMatch(/Invalid API Key/);
  });
});
