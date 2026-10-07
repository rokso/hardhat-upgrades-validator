// Adapted from @openzeppelin/hardhat-upgrades (MIT)
// https://github.com/OpenZeppelin/openzeppelin-upgrades
import type { SolcOutput } from "@openzeppelin/upgrades-core";

type RecursivePartial<T> = { [k in keyof T]?: RecursivePartial<T[k]> };
type MaybeSolcOutput = RecursivePartial<SolcOutput>;

/**
 * Returns true only when the solc output is a full compilation result, i.e.
 * it contains compiled contracts with bytecode and sources with ASTs.
 *
 * Hardhat may return a partial/cached output for unchanged files. Passing such
 * an output to oz-core's validate() would silently produce incomplete
 * ValidationData, so we skip processing whenever this returns false.
 */
export function isFullSolcOutput(output: MaybeSolcOutput | undefined): boolean {
  if (output?.contracts == undefined || output?.sources == undefined) {
    return false;
  }

  for (const file of Object.values(output.contracts)) {
    if (file == undefined) {
      return false;
    }
    for (const contract of Object.values(file)) {
      if (contract?.evm?.bytecode == undefined) {
        return false;
      }
    }
  }

  for (const file of Object.values(output.sources)) {
    if (file?.ast == undefined || file?.id == undefined) {
      return false;
    }
  }

  return true;
}
