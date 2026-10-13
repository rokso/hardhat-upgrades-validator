/**
 * The compile hook validates a job only when its output is complete. A partial
 * output must be refused: validating it would silently leave contracts out of
 * the validation cache.
 */
import { describe, it, expect } from "vitest";
import { isFullSolcOutput } from "../src/plugin/internals/is-full-solc-output.js";

const full = () => ({
  contracts: { "contracts/A.sol": { A: { evm: { bytecode: { object: "6080" } } } } },
  sources: { "contracts/A.sol": { id: 0, ast: {} } },
});

describe("isFullSolcOutput", () => {
  it("accepts an output with bytecode for every contract and an AST and id for every source", () => {
    expect(isFullSolcOutput(full())).toBe(true);
  });

  it.each([
    ["no output", () => undefined],
    ["no contracts", () => ({ ...full(), contracts: undefined })],
    ["no sources", () => ({ ...full(), sources: undefined })],
    [
      "a file without contracts",
      () => ({ ...full(), contracts: { "contracts/A.sol": undefined } }),
    ],
    [
      "a contract without bytecode",
      () => ({ ...full(), contracts: { "contracts/A.sol": { A: { evm: {} } } } }),
    ],
    ["a source without an AST", () => ({ ...full(), sources: { "contracts/A.sol": { id: 0 } } })],
    ["a source without an id", () => ({ ...full(), sources: { "contracts/A.sol": { ast: {} } } })],
  ])("refuses %s", (_, output) => {
    expect(isFullSolcOutput(output() as never)).toBe(false);
  });
});
