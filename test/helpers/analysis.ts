/**
 * A stand-in for one contract's slotdiff analysis (`ContractAnalysis`), for
 * tests that mock the build analyzer. `safety` filters by `unsafeAllow` as
 * OpenZeppelin does; the proxy kind it was called with is recorded.
 */
import type { NamespaceSlot, SafetyErrorKind, StorageLayout } from "slotdiff";
import type { ContractAnalysis } from "../../src/plugin/internals/build-analysis.js";

export interface FakeAnalysisOptions {
  kind?: "transparent" | "uups";
  namespaces?: NamespaceSlot[];
  /** Errors the safety check reports before `unsafeAllow`. */
  safetyErrors?: Array<{ kind: SafetyErrorKind; src: string }>;
}

export function fakeAnalysis(
  layout: StorageLayout,
  options: FakeAnalysisOptions = {},
): ContractAnalysis & { safetyKinds: string[] } {
  const safetyKinds: string[] = [];
  return {
    layout,
    kind: options.kind ?? "transparent",
    namespaces: options.namespaces ?? [],
    safetyKinds,
    safety({ kind, unsafeAllow = [] }) {
      safetyKinds.push(kind);
      const errors = (options.safetyErrors ?? []).filter((e) => !unsafeAllow.includes(e.kind));
      return {
        ok: errors.length === 0,
        errors,
        explain: () => errors.map((e) => `${e.src}: ${e.kind}`).join("\n"),
      };
    },
  };
}
