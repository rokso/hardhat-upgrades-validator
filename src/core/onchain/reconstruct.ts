/**
 * Rebuilds the storage layout of deployed code from its verified source, and
 * proves the source is the deployed code before trusting the layout.
 *
 * The layout comes out of the same oz-core pipeline the compile hook runs for
 * the local build (full compile, namespaced second pass, `validate()`,
 * `getStorageLayout`), so both sides of a comparison are extracted identically.
 */

import {
  getStorageLayout,
  isNamespaceSupported,
  makeNamespacedInput,
  solcInputOutputDecoder,
  trySanitizeNatSpec,
  validate,
  type SolcInput,
  type SolcOutput,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";
import { compareDeployedBytecode, isProvingMatch, type ProvingMatch } from "../bytecode-utils.js";
import { BaselineIntegrityError } from "./errors.js";
import type { VerifiedSource } from "./explorer.js";
import type { SolcRunner } from "./solc.js";

export interface ReconstructedLayout {
  /** Fully qualified name, `source.sol:Contract`. */
  contract: string;
  compiler: string;
  bytecodeMatch: ProvingMatch;
  layout: StorageLayout;
}

// validate() reads evm.bytecode for every contract, so codegen is requested
// for all of them. A verified input holds only the target's dependency graph.
const FULL_SELECTION = {
  "*": {
    "*": [
      "storageLayout",
      "evm.bytecode.object",
      "evm.bytecode.linkReferences",
      "evm.deployedBytecode.object",
      "evm.deployedBytecode.immutableReferences",
    ],
    "": ["ast"],
  },
};

// The namespaced pass only needs layouts and ASTs; skipping codegen keeps it cheap.
const LAYOUT_SELECTION = { "*": { "*": ["storageLayout"], "": ["ast"] } };

export async function reconstructLayout(
  source: VerifiedSource,
  solc: SolcRunner,
  onchainCode: string,
): Promise<ReconstructedLayout> {
  const input = withOutputSelection(source.input, FULL_SELECTION);
  const output = await compileOrThrow(solc, input, "verified source");

  const { contract, bytecodeMatch } = proveDeployedCode(output, source.contractName, onchainCode);

  return {
    contract,
    compiler: source.solcLongVersion,
    bytecodeMatch,
    layout: await extractLayout(input, output, solc, contract),
  };
}

/**
 * The layout of `contract` (`source.sol:Name`) in `input`, with no bytecode
 * proof. Only for sources whose provenance is already known, such as a
 * project's own build-info.
 */
export async function layoutFromSource(
  input: SolcInput,
  solc: SolcRunner,
  contract: string,
): Promise<StorageLayout> {
  const selected = withOutputSelection(input, FULL_SELECTION);
  const output = await compileOrThrow(solc, selected, "source");
  return extractLayout(selected, output, solc, contract);
}

async function extractLayout(
  input: SolcInput,
  output: SolcOutput,
  solc: SolcRunner,
  contract: string,
): Promise<StorageLayout> {
  const solcVersion = solc.longVersion.split("+")[0];

  let namespacedOutput: SolcOutput | undefined;
  if (isNamespaceSupported(solcVersion)) {
    let namespacedInput = makeNamespacedInput(input, output, solcVersion);
    namespacedInput = await trySanitizeNatSpec(namespacedInput, solcVersion);
    namespacedOutput = await compileOrThrow(
      solc,
      withOutputSelection(namespacedInput, LAYOUT_SELECTION),
      "namespaced pass",
    );
  }

  const runData = validate(
    output,
    solcInputOutputDecoder(input, output),
    solcVersion,
    input,
    namespacedOutput,
  );
  const version = runData[contract]?.version;
  if (version === undefined) {
    throw new BaselineIntegrityError(
      `${contract} compiled to no bytecode; cannot derive its layout.`,
    );
  }
  return getStorageLayout(runData, version);
}

/**
 * Finds the compiled contract that matches the deployed code. The verified
 * name narrows the search, but two files may define a contract with the same
 * name, so the bytecode decides, and the strongest match wins. Only a proving
 * match is accepted: `metadata-only` can hide a different storage layout.
 */
function proveDeployedCode(
  output: SolcOutput,
  contractName: string,
  onchainCode: string,
): { contract: string; bytecodeMatch: ProvingMatch } {
  let candidates = 0;
  let best: { contract: string; bytecodeMatch: ProvingMatch } | undefined;
  let weakOnly = false;
  for (const [sourcePath, contracts] of Object.entries(output.contracts ?? {})) {
    const compiled = contracts[contractName] as
      | {
          evm?: {
            deployedBytecode?: {
              object?: string;
              immutableReferences?: Record<string, Array<{ start: number; length: number }>>;
            };
          };
        }
      | undefined;
    const deployed = compiled?.evm?.deployedBytecode;
    if (deployed?.object === undefined) continue;
    candidates++;
    const match = compareDeployedBytecode(
      onchainCode,
      deployed.object,
      deployed.immutableReferences,
    );
    if (match === "metadata-only") weakOnly = true;
    if (!isProvingMatch(match)) continue;
    if (best === undefined || (match === "exact" && best.bytecodeMatch !== "exact")) {
      best = { contract: `${sourcePath}:${contractName}`, bytecodeMatch: match };
    }
  }
  if (best !== undefined) return best;

  if (candidates === 0) {
    throw new BaselineIntegrityError(`Verified source has no contract named "${contractName}".`);
  }
  throw new BaselineIntegrityError(
    weakOnly
      ? `Verified source for "${contractName}" matches the deployed code only after stripping ` +
          `metadata, so the compiler input differed. That does not prove the storage layout ` +
          `(unread variables and gap sizes never reach the bytecode). Refusing to trust it.`
      : `Verified source for "${contractName}" does not compile to the deployed code, ` +
          `even with immutables masked. Refusing to trust its layout.`,
  );
}

async function compileOrThrow(
  solc: SolcRunner,
  input: SolcInput,
  what: string,
): Promise<SolcOutput> {
  const output = await solc.compile(input);
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new BaselineIntegrityError(
      `solc ${solc.longVersion} failed to compile the ${what}: ${errors[0].formattedMessage}`,
    );
  }
  return output;
}

function withOutputSelection(input: SolcInput, outputSelection: unknown): SolcInput {
  return {
    ...input,
    settings: { ...input.settings, outputSelection },
  } as SolcInput;
}
