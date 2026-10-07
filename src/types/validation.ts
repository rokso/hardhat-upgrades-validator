// Re-export OZ's StorageLayout as the canonical layout type used throughout
// this package. Consumers who need the layout shape can import it from here.
export type { StorageLayout } from "@openzeppelin/upgrades-core";

// ---------------------------------------------------------------------------
// Contract-level safety errors (constructor, delegatecall, etc.)
// ---------------------------------------------------------------------------

export type ContractSafetyError =
  | { kind: "constructor"; contract: string; src: string }
  | { kind: "delegatecall"; src: string }
  | { kind: "selfdestruct"; src: string }
  | { kind: "state-variable-immutable"; name: string; src: string }
  | { kind: "state-variable-assignment"; name: string; src: string }
  | { kind: "external-library-linking"; name: string; src: string };

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  safetyErrors: ContractSafetyError[];
  warnings: ValidationWarning[];
  /** Which layout the new build was compared against. Set by the plugin entry points. */
  baseline?: BaselineInfo;
}

/**
 * Provenance of the "before" layout, printed with every result so a reader
 * never has to guess what was compared.
 *
 * - `chain`: the implementation the proxy runs now, read from the chain.
 * - `offline-record`: a stored record for the implementation named in the
 *   deployment file; correct unless the proxy and the file have drifted apart.
 * - `deployment-file`: the deprecated `upgradeStorageLayout` field.
 * - `none`: no baseline available.
 */
export type BaselineInfo =
  | {
      source: "chain";
      implementation: string;
      bytecodeMatch: string;
      origin: "store" | "explorer";
    }
  | { source: "offline-record"; implementation: string; bytecodeMatch: string }
  | { source: "deployment-file" }
  | { source: "none" };

/**
 * - `auto`: the chain when reachable, otherwise an offline baseline.
 * - `chain`: the chain only; fails when it cannot supply one.
 * - `deployment`: the deployment file only (pre-0.1.0-alpha.2 behavior).
 */
export type BaselineMode = "auto" | "chain" | "deployment";
export const BASELINE_MODES: readonly BaselineMode[] = ["auto", "chain", "deployment"];

export type ValidationError =
  | { kind: "variable-removed"; label: string; slot: string; type: string }
  | {
      kind: "variable-renamed";
      oldLabel: string;
      newLabel: string;
      slot: string;
    }
  | {
      kind: "type-changed";
      label: string;
      slot: string;
      oldType: string;
      newType: string;
    }
  | { kind: "variable-inserted"; label: string; slot: string }
  | { kind: "invalid-gap"; label: string; slot: string }
  | { kind: "namespace-removed"; namespaceId: string }
  | { kind: "namespace-collision"; namespaceId: string };

export type ValidationWarning =
  | { kind: "gap-shrunken"; label: string; oldSize: number; newSize: number }
  | { kind: "no-baseline"; contractName: string }
  | { kind: "storage-check-skipped"; contractName: string }
  | { kind: "deprecated-baseline"; contractName: string }
  | { kind: "chain-baseline-unavailable"; contractName: string; reason: string };

// ---------------------------------------------------------------------------
// Validation options
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /**
   * Global unsafe-allow escape hatches.
   */
  unsafeAllow?: UnsafeAllowKind[];
  /**
   * Per-variable unsafe-allow overrides from
   * `@custom:upgrades-validator-unsafe-allow` NatSpec on individual state
   * variables. Map of `label -> UnsafeAllowKind[]`.
   */
  perVariableUnsafeAllow?: Map<string, UnsafeAllowKind[]>;
  /**
   * Per-namespace unsafe-allow overrides from
   * `@custom:upgrades-validator-unsafe-allow` NatSpec on namespace structs.
   * Map of `namespaceId -> UnsafeAllowKind[]`.
   */
  namespaceUnsafeAllow?: Map<string, UnsafeAllowKind[]>;
  /**
   * Skip all storage layout validation for this upgrade.
   * For emergency use only.
   */
  unsafeSkipStorageCheck?: boolean;
  /**
   * Proxy kind to use for storage layout validation rules.
   * Defaults to "transparent" when not provided.
   */
  kind?: ProxyKind;
}

// ---------------------------------------------------------------------------
// Proxy kind
// ---------------------------------------------------------------------------

export type ProxyKind = "transparent" | "uups" | "beacon";

// ---------------------------------------------------------------------------
// Unsafe-allow escape hatch
// ---------------------------------------------------------------------------

export const UNSAFE_ALLOW_KINDS = [
  // Storage layout kinds
  "variable-renamed",
  "type-changed",
  // Contract-level safety kinds
  "constructor",
  "delegatecall",
  "selfdestruct",
  "state-variable-immutable",
  "state-variable-assignment",
  "external-library-linking",
] as const;

export type UnsafeAllowKind = (typeof UNSAFE_ALLOW_KINDS)[number];
