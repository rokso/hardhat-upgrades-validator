import type { getErrors, getStorageUpgradeReport } from "@openzeppelin/upgrades-core";

// Re-export OZ's StorageLayout as the canonical layout type used throughout
// this package. Consumers who need the layout shape can import it from here.
export type { StorageLayout } from "@openzeppelin/upgrades-core";

// ---------------------------------------------------------------------------
// OZ types
//
// Validation is delegated to @openzeppelin/upgrades-core. Its error and report
// types are not all exported by name, so they are derived from its functions.
// ---------------------------------------------------------------------------

/** An upgrade-safety error from OZ's `getErrors` (constructor, delegatecall, initializers, ...). */
export type SafetyError = ReturnType<typeof getErrors>[number];

/** OZ's storage layout comparison. `ok` is the verdict; `explain()` describes each problem. */
export type StorageReport = ReturnType<typeof getStorageUpgradeReport>;

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  /**
   * OZ's storage comparison against the baseline. Undefined when there is no
   * baseline or the storage check was skipped.
   */
  storage?: StorageReport;
  safetyErrors: SafetyError[];
  warnings: ValidationWarning[];
}

export type ValidationWarning =
  | { kind: "no-baseline"; contractName: string }
  | { kind: "storage-check-skipped"; contractName: string };

// ---------------------------------------------------------------------------
// Validation options
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** OZ error kinds to allow (same values as OZ's `unsafeAllow`). */
  unsafeAllow?: UnsafeAllowKind[];
  /** Allow renamed variables without `@custom:oz-renamed-from` (OZ's `unsafeAllowRenames`). */
  unsafeAllowRenames?: boolean;
  /**
   * Skip all storage layout validation for this upgrade.
   * For emergency use only.
   */
  unsafeSkipStorageCheck?: boolean;
  /**
   * Proxy kind to use for validation rules.
   * Defaults to "transparent" when not provided.
   */
  kind?: ProxyKind;
}

// ---------------------------------------------------------------------------
// Proxy kind
// ---------------------------------------------------------------------------

export type ProxyKind = "transparent" | "uups" | "beacon";

export const PROXY_KINDS: readonly ProxyKind[] = ["transparent", "uups", "beacon"];

// ---------------------------------------------------------------------------
// Unsafe-allow escape hatch: OZ's error kinds
// ---------------------------------------------------------------------------

export type UnsafeAllowKind = SafetyError["kind"];

/**
 * OZ's error kinds (`errorKinds` in upgrades-core, not exported from its
 * index). A test keeps this list in sync with the installed version.
 */
export const UNSAFE_ALLOW_KINDS: readonly UnsafeAllowKind[] = [
  "state-variable-assignment",
  "state-variable-immutable",
  "external-library-linking",
  "struct-definition",
  "enum-definition",
  "constructor",
  "delegatecall",
  "selfdestruct",
  "missing-public-upgradeto",
  "internal-function-storage",
  "missing-initializer",
  "missing-initializer-call",
  "duplicate-initializer-call",
  "incorrect-initializer-order",
];
