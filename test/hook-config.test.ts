/**
 * The config hook asks every compiler for the solc outputs validation needs,
 * adding to whatever the user configured rather than replacing it.
 */
import { describe, it, expect } from "vitest";
import type { SolidityConfig } from "hardhat/types/config";
import { requestValidationOutputs } from "../src/plugin/hooks/config.js";

const shared = { "*": { "*": ["abi"], "": ["ast"] } };

function config(): SolidityConfig {
  return {
    profiles: {
      default: {
        isolated: false,
        preferWasm: false,
        compilers: [
          { version: "0.8.28", settings: {} },
          { version: "0.8.24", settings: { outputSelection: shared } },
        ],
        overrides: {
          "contracts/A.sol": {
            version: "0.8.20",
            settings: { outputSelection: { "contracts/A.sol": { A: ["metadata"] } } },
          },
        },
      },
      production: {
        isolated: true,
        preferWasm: false,
        compilers: [{ version: "0.8.28", settings: { optimizer: { enabled: true } } }],
        overrides: {},
      },
    },
    npmFilesToBuild: [],
    registeredCompilerTypes: ["solc"],
    splitTestsCompilation: false,
  } as unknown as SolidityConfig;
}

const selectionOf = (c: { settings: { outputSelection?: unknown } }) =>
  c.settings.outputSelection as Record<string, Record<string, string[]>>;

describe("requestValidationOutputs", () => {
  it("adds storageLayout and ast to every compiler in every profile, overrides included", () => {
    const solidity = config();
    requestValidationOutputs(solidity);

    const compilers = Object.values(solidity.profiles).flatMap((p) => [
      ...p.compilers,
      ...Object.values(p.overrides),
    ]);
    expect(compilers).toHaveLength(4);
    for (const c of compilers) {
      expect(selectionOf(c)["*"]["*"]).toContain("storageLayout");
      expect(selectionOf(c)["*"][""]).toContain("ast");
    }
  });

  it("keeps the user's selections and settings", () => {
    const solidity = config();
    requestValidationOutputs(solidity);

    const [, second] = solidity.profiles.default.compilers;
    expect(selectionOf(second)["*"]["*"]).toEqual(["abi", "storageLayout"]);
    expect(selectionOf(second)["*"][""]).toEqual(["ast"]);
    const override = solidity.profiles.default.overrides["contracts/A.sol"];
    expect(selectionOf(override)["contracts/A.sol"]).toEqual({ A: ["metadata"] });
    expect(solidity.profiles.production.compilers[0].settings.optimizer).toEqual({
      enabled: true,
    });
  });

  it("never mutates a selection object that may be shared", () => {
    requestValidationOutputs(config());
    expect(shared).toEqual({ "*": { "*": ["abi"], "": ["ast"] } });
  });

  it("is idempotent", () => {
    const solidity = config();
    requestValidationOutputs(solidity);
    requestValidationOutputs(solidity);
    expect(selectionOf(solidity.profiles.default.compilers[0])["*"]["*"]).toEqual([
      "storageLayout",
    ]);
  });
});
