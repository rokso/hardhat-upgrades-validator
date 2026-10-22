import {
  getStorageUpgradeReport,
  withValidationDefaults,
  UpgradeableContractErrorReport,
  type StorageLayout,
} from "@openzeppelin/upgrades-core";
import { checkUpgrade, type NamespaceSlot, type SourceAnalysis, type UpgradeCheck } from "slotdiff";
import {
  UNSAFE_ALLOW_KINDS,
  PROXY_KINDS,
  type ProxyKind,
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
 * storage comparison alone. The verdict is OZ's: any operation it reports fails
 * the upgrade. Layout only: no safety rules, and ERC-7201 namespaces are matched
 * by annotation, not by the slot the code uses. The plugin's own checks (tasks,
 * hooks, proxy helpers) run `validateUpgrade`, which does both.
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

/** The "before" side of an upgrade: a layout, with what is known about the code behind it. */
export interface UpgradeBaseline {
  layout: StorageLayout;
  /** The slot each ERC-7201 namespace used; without it the namespaces are compared by annotation. */
  namespaces?: NamespaceSlot[];
  /** The kind of the proxy being upgraded, when the baseline knows it. */
  kind?: ProxyKind;
}

/**
 * The whole upgrade check for a proxy's new implementation, as slotdiff runs
 * it: OZ's storage comparison with ERC-7201 namespaces paired by the slot the
 * code uses, and OZ's safety rules. The proxy kind is `options.kind`, else the
 * baseline's, else the new code's; taking it from the new code alone would let
 * a UUPS implementation that lost its upgrade function pass.
 */
export function validateUpgrade(
  contractName: string,
  old: UpgradeBaseline | undefined,
  next: SourceAnalysis,
  options: ValidateOptions = {},
): ValidationResult {
  assertValidOptions(options);
  const kind = options.kind ?? old?.kind ?? next.kind;
  const unsafeAllow = options.unsafeAllow ?? [];

  if (old === undefined || options.unsafeSkipStorageCheck) {
    if (old !== undefined) {
      logger.warn(
        `Storage layout validation SKIPPED for "${contractName}". ` +
          `unsafeSkipStorageCheck is set; you are responsible for storage correctness.`,
      );
    }
    const safety = next.safety({ kind, unsafeAllow });
    return {
      ok: safety.ok,
      safetyErrors: safety.errors as SafetyError[],
      warnings: [
        old === undefined
          ? { kind: "no-baseline", contractName }
          : { kind: "storage-check-skipped", contractName },
      ],
    };
  }

  const check = checkUpgrade({ ...old, kind }, next, {
    unsafeAllow,
    unsafeAllowRenames: options.unsafeAllowRenames,
  });
  // An analysis lists every namespace of its layout: none of its slots is missing, only unread.
  const result = fromCheck(contractName, check, old, { analysis: true });
  if (options.kind === undefined && old.kind === undefined) {
    result.warnings.push({ kind: "kind-from-new-code", contractName, proxyKind: kind });
  }
  return result;
}

/**
 * The storage half of `validateUpgrade` between two recorded layouts (no
 * safety rules: a record has no source to check), for an upgrade that already
 * happened.
 */
export function validateRecordUpgrade(
  contractName: string,
  old: UpgradeBaseline,
  next: Omit<UpgradeBaseline, "kind">,
): ValidationResult {
  return fromCheck(contractName, checkUpgrade(old, next, { skipSafety: true }), old, next);
}

// An unread namespace is acceptable only when the record that lacks its slot
// has no slots at all (made before slots were recorded) and the deployed slot
// is not known to differ from the annotation: then it is compared by
// annotation, as before, with a warning. Anything else fails, since whether
// its storage moved cannot be known: a slot the code itself makes unreadable,
// a namespace missing from a record that has slots (such a record lists them
// all), or a deployed slot off its annotation with no new slot to compare.
function fromCheck(
  contractName: string,
  check: UpgradeCheck,
  old: Pick<UpgradeBaseline, "namespaces">,
  next: Pick<UpgradeBaseline, "namespaces"> | { analysis: true },
): ValidationResult {
  const oldRecorded = old.namespaces !== undefined;
  const nextRecorded =
    "analysis" in next || (next as Pick<UpgradeBaseline, "namespaces">).namespaces !== undefined;
  const unread = check.namespaces.pairs.filter((p) => p.problem === "unread");
  const unreadable = unread.filter(
    (p) =>
      (p.next?.status === "unread" && nextRecorded) ||
      (p.old !== undefined &&
        p.old.actual === undefined &&
        p.old.status !== "unused" &&
        oldRecorded) ||
      p.old?.status === "mismatch",
  );

  const result: ValidationResult = {
    ok: check.result === "pass" || (check.result === "unchecked" && unreadable.length === 0),
    storage: check.layout,
    namespaces: check.namespaces,
    safetyErrors: (check.safety?.errors ?? []) as SafetyError[],
    warnings: [],
  };
  if (result.ok && check.result === "unchecked") {
    const unlisted = !nextRecorded && unread.some((p) => p.next?.status === "unread");
    result.warnings.push({
      kind: "namespaces-unchecked",
      contractName,
      reason:
        `the ${unlisted ? "new implementation's record" : "baseline"} has no recorded ` +
        "namespace slots (a record made before 0.2.0, or the deprecated " +
        "upgradeStorageLayout field). Record it again with `record-baseline --force` (add " +
        "--from-chain if the local build has moved on).",
    });
  }
  return result;
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
    if (result.namespaces !== undefined && result.namespaces.result === "fail") {
      lines.push(indent(result.namespaces.explain(false)));
    }
    if (result.namespaces !== undefined && result.namespaces.result === "unchecked") {
      lines.push(indent(result.namespaces.explain(false)));
      lines.push(
        "  A namespace's slot is not known (the code does not show it, or a record with " +
          "slots does not list it), or the deployed slot is off its annotation and the new " +
          "one is not known. Whether its storage moved cannot be checked, so this fails " +
          "rather than pass unchecked.",
      );
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
    case "kind-from-new-code":
      return `  [WARN] The safety rules for "${w.contractName}" used the proxy kind of the new implementation (${w.proxyKind}), because its baseline does not record one: a UUPS implementation that lost its upgrade function would pass. Pass --proxy-kind (or kind), or record the baseline again with \`record-baseline --force\`.`;
    case "namespaces-unchecked":
      return `  [WARN] The ERC-7201 namespaces of "${w.contractName}" were compared by annotation only, not by the slot the code uses: ${w.reason}`;
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
