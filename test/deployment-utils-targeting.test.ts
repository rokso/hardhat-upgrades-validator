/**
 * OZ looks a contract up in ValidationData by bytecode version and takes the
 * first match. Built without a metadata hash, two contracts with different
 * layouts can compile to identical code, so the lookup must still land on the
 * artifact that was asked for. Real solc, no mocks of OZ.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  concatRunData,
  getStorageLayout,
  getUnlinkedBytecode,
  getVersion,
  solcInputOutputDecoder,
  validate,
  type SolcInput,
  type SolcOutput,
  type ValidationDataCurrent,
} from "@openzeppelin/upgrades-core";
import { getSolc } from "slotdiff";
import {
  createBuildInfoOutputCache,
  getContractBuildData,
  type ArtifactsReader,
} from "../src/plugin/internals/deployment-utils.js";

const SOLC = "0.8.24+commit.e11b9ed9";

// Alpha is listed first, so a first-match lookup for Box's code finds Alpha.
const INPUT = {
  language: "Solidity",
  sources: {
    "contracts/A.sol": {
      content: "pragma solidity 0.8.24; contract Alpha { uint256 public a; bytes32 private dep; }",
    },
    "contracts/Box.sol": {
      content: "pragma solidity 0.8.24; contract Box { uint256 public a; uint256 private dep; }",
    },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: "none" },
    outputSelection: {
      "*": {
        "*": [
          "storageLayout",
          "evm.bytecode.object",
          "evm.bytecode.linkReferences",
          "evm.deployedBytecode.object",
        ],
        "": ["ast"],
      },
    },
  },
} as unknown as SolcInput;

let validations: ValidationDataCurrent;
let boxBytecode: string;

beforeAll(async () => {
  const solc = await getSolc(SOLC);
  const output: SolcOutput = await solc.compile(INPUT);
  const runData = validate(output, solcInputOutputDecoder(INPUT, output), "0.8.24", INPUT);
  validations = concatRunData(runData, undefined);
  boxBytecode =
    "0x" +
    (
      output.contracts["contracts/Box.sol"].Box as unknown as {
        evm: { bytecode: { object: string } };
      }
    ).evm.bytecode.object;
}, 120_000);

const labels = (layout: { storage: Array<{ contract: string; label: string; type: string }> }) =>
  layout.storage.map((s) => `${s.contract}.${s.label}:${s.type}`);

describe("getContractBuildData with two contracts of identical code", () => {
  it("is a real collision: OZ's own lookup returns the other contract", () => {
    // Without this the test below would pass for the wrong reason.
    const version = getVersion(getUnlinkedBytecode(validations, boxBytecode), boxBytecode);
    expect(labels(getStorageLayout(validations, version))).toEqual([
      "Alpha.a:t_uint256",
      "Alpha.dep:t_bytes32",
    ]);
  });

  it("returns the layout of the artifact asked for", async () => {
    const artifacts: ArtifactsReader = {
      readArtifact: async () => ({ bytecode: boxBytecode, sourceName: "contracts/Box.sol" }),
      getBuildInfoId: async () => undefined,
      getBuildInfoOutputPath: async () => undefined,
    };
    const { upgradeStorageLayout } = await getContractBuildData(
      "contracts/Box.sol:Box",
      artifacts,
      validations,
      createBuildInfoOutputCache(),
    );
    expect(labels(upgradeStorageLayout!)).toEqual(["Box.a:t_uint256", "Box.dep:t_uint256"]);
  });
});
