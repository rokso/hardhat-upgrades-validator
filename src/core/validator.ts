import {
  getStorageUpgradeReport,
  withValidationDefaults,
  UpgradeableContractErrorReport,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";
import {
  UNSAFE_ALLOW_KINDS,
  PROXY_KINDS,
  type ValidationResult,
  type SafetyError,
  type ValidateOptions,
  type BaselineInfo,
} from "../types/validation.js";
import { logger } from "../utils/logger.js";

export type { StorageLayout };
export type { ValidateOptions } from "../types/validation.js";

/**
 * Validates that `newLayout` is a safe upgrade from `oldLayout`, using OZ's
 * storage comparison. The verdict is OZ's: any operation it reports fails the
 * upgrade.
 *
 * Rename and retype approvals are embedded in `newLayout` (`renamedFrom` and
 * `retypedFrom`), as OZ's extraction and our struct-member tags set them.
 */
export function validateStorageUpgrade(
  contractName: string,
  oldLayout: StorageLayout | undefined,
  newLayout: StorageLayout,
  options: ValidateOptions = {},
): ValidationResult {
  assertValidOptions(options);

  if (oldLayout === undefined) {
    return {
      ok: true,
      safetyErrors: [],
      warnings: [{ kind: "no-baseline", contractName }],
    };
  }

  if (options.unsafeSkipStorageCheck) {
    logger.warn(
      `Storage layout validation SKIPPED for "${contractName}". ` +
        `unsafeSkipStorageCheck is set; you are responsible for storage correctness.`,
    );
    return {
      ok: true,
      safetyErrors: [],
      warnings: [{ kind: "storage-check-skipped", contractName }],
    };
  }

  const storage = getStorageUpgradeReport(
    oldLayout,
    newLayout,
    withValidationDefaults({
      kind: options.kind,
      unsafeAllowRenames: options.unsafeAllowRenames,
    }),
  );

  return { ok: storage.ok, storage, safetyErrors: [], warnings: [] };
}

/**
 * Adds OZ upgrade-safety errors (already filtered by OZ's `getErrors` for the
 * proxy kind and `unsafeAllow`) to a storage result. Any error fails it.
 */
export function withSafetyErrors(
  result: ValidationResult,
  safetyErrors: SafetyError[],
): ValidationResult {
  return {
    ...result,
    ok: result.ok && safetyErrors.length === 0,
    safetyErrors: [...result.safetyErrors, ...safetyErrors],
  };
}

function assertValidOptions(options: ValidateOptions): void {
  if (options.unsafeAllow !== undefined) {
    const unknown = options.unsafeAllow.filter(
      (k) => !(UNSAFE_ALLOW_KINDS as readonly string[]).includes(k),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Unknown unsafe-allow value(s): ${unknown.join(", ")}. ` +
          `Valid values: ${UNSAFE_ALLOW_KINDS.join(", ")}.`,
      );
    }
  }

  if (options.kind !== undefined && !PROXY_KINDS.includes(options.kind)) {
    throw new Error(
      `Invalid proxy kind: "${options.kind}". Valid values: ${PROXY_KINDS.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Formatting: OZ's own explanations under our header
// ---------------------------------------------------------------------------

export function formatValidationResult(contractName: string, result: ValidationResult): string {
  const baseline = result.baseline
    ? `\n         baseline: ${describeBaseline(result.baseline)}`
    : "";
  const passed = `  [OK]   "${contractName}": storage layout validation passed.${baseline}`;
  if (result.ok && result.warnings.length === 0) return passed;

  const lines: string[] = [];

  if (result.ok && result.baseline) lines.push(passed);

  if (!result.ok) {
    lines.push(`StorageLayoutError: Storage layout validation failed for "${contractName}"`);
    if (result.baseline) lines.push(`  baseline: ${describeBaseline(result.baseline)}`);
    if (result.storage !== undefined && !result.storage.ok) {
      lines.push(indent(result.storage.explain(false)));
    }
    if (result.safetyErrors.length > 0) {
      lines.push(indent(new UpgradeableContractErrorReport(result.safetyErrors).explain(false)));
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const w of result.warnings) {
      lines.push(formatWarning(w));
    }
  }

  return "\n" + lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

function formatWarning(w: ValidationResult["warnings"][number]): string {
  switch (w.kind) {
    case "no-baseline":
      return `  [INFO] No prior deployment found for "${w.contractName}"; skipping validation (first deployment).`;
    case "storage-check-skipped":
      return `  [WARN] Storage layout validation was skipped for "${w.contractName}" (unsafeSkipStorageCheck). You are responsible for storage correctness.`;
    case "deprecated-baseline":
      return `  [WARN] "${w.contractName}" was validated against the deprecated upgradeStorageLayout field, which can describe code the proxy is not running. Run record-baseline with a network to replace it.`;
    case "chain-baseline-unavailable":
      return `  [WARN] Could not read a chain baseline for "${w.contractName}", fell back to an offline one: ${w.reason}`;
  }
}

function describeBaseline(b: BaselineInfo): string {
  switch (b.source) {
    case "chain":
      return `chain, implementation ${b.implementation} (${b.bytecodeMatch}, ${b.origin === "store" ? "stored record" : "rebuilt from explorer"})`;
    case "offline-record":
      return `offline record for ${b.implementation}, the implementation as of block ${b.observedAtBlock} (${b.bytecodeMatch}); not checked against the chain`;
    case "deployment-file":
      return "deployment file upgradeStorageLayout (deprecated)";
    case "none":
      return "none";
  }
}
