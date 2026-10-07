import { getStorageUpgradeReport, type StorageLayout } from "@openzeppelin/upgrades-core";
import {
  UNSAFE_ALLOW_KINDS,
  type BaselineInfo,
  type ValidationResult,
  type ValidationError,
  type ContractSafetyError,
  type UnsafeAllowKind,
  type ValidateOptions,
} from "../types/validation.js";
import { logger } from "../utils/logger.js";

const UNSAFE_ALLOW_KINDS_SET: ReadonlySet<string> = new Set(UNSAFE_ALLOW_KINDS);
const VALID_PROXY_KINDS_SET: ReadonlySet<string> = new Set(["transparent", "uups", "beacon"]);

export type { StorageLayout };
export type { ValidateOptions } from "../types/validation.js";

/**
 * Validates that `newLayout` is a safe upgrade from `oldLayout`.
 * Both layouts must be in OZ format (as returned by `getContractBuildData`
 * or stored in the deployment file under `upgradeStorageLayout`).
 *
 * Rename approvals are embedded in `newLayout.storage[].renamedFrom` —
 * no separate rename map is needed here.
 */
export function validateStorageUpgrade(
  contractName: string,
  oldLayout: StorageLayout | undefined,
  newLayout: StorageLayout,
  options: ValidateOptions = {},
): ValidationResult {
  if (options.unsafeAllow !== undefined) {
    const unknown = (options.unsafeAllow as string[]).filter((k) => !UNSAFE_ALLOW_KINDS_SET.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown unsafe-allow value(s): ${unknown.join(", ")}. ` +
          `Valid values: ${UNSAFE_ALLOW_KINDS.join(", ")}.`,
      );
    }
  }

  if (options.kind !== undefined && !VALID_PROXY_KINDS_SET.has(options.kind)) {
    throw new Error(
      `Invalid proxy kind: "${options.kind}". Valid values: transparent, uups, beacon.`,
    );
  }

  if (oldLayout === undefined) {
    return {
      ok: true,
      errors: [],
      safetyErrors: [],
      warnings: [{ kind: "no-baseline", contractName }],
    };
  }

  if (options.unsafeSkipStorageCheck) {
    logger.warn(
      `Storage layout validation SKIPPED for "${contractName}". ` +
        `unsafeSkipStorageCheck is set — you are responsible for storage correctness.`,
    );
    return {
      ok: true,
      errors: [],
      safetyErrors: [],
      warnings: [{ kind: "storage-check-skipped", contractName }],
    };
  }

  const unsafeAllow = options.unsafeAllow ?? [];
  const report = getStorageUpgradeReport(oldLayout, newLayout, {
    unsafeAllowRenames: unsafeAllow.includes("variable-renamed"),
    // Keep false; we handle type-changed suppression in mapAndFilter.
    unsafeAllowCustomTypes: false,
    unsafeSkipStorageCheck: false,
    unsafeAllowLinkedLibraries: false,
    unsafeAllow: [],
    kind: options.kind ?? "transparent",
  });

  const errors = mapAndFilter(
    report.ops,
    unsafeAllow,
    options.perVariableUnsafeAllow ?? new Map(),
    options.namespaceUnsafeAllow ?? new Map(),
  );

  return { ok: errors.length === 0, errors, safetyErrors: [], warnings: [] };
}

/**
 * Filters out safety errors whose kind is listed in `unsafeAllow`.
 */
export function filterSafetyErrors(
  errors: ContractSafetyError[],
  unsafeAllow: UnsafeAllowKind[],
): ContractSafetyError[] {
  if (unsafeAllow.length === 0) return errors;
  return errors.filter((e) => !unsafeAllow.includes(e.kind as UnsafeAllowKind));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatValidationResult(contractName: string, result: ValidationResult): string {
  const baseline = result.baseline
    ? `\n         baseline: ${describeBaseline(result.baseline)}`
    : "";
  if (result.ok && result.warnings.length === 0) {
    return `  [OK]   "${contractName}" — storage layout validation passed.${baseline}`;
  }

  const lines: string[] = [];

  if (result.ok && result.baseline) {
    lines.push(`  [OK]   "${contractName}" — storage layout validation passed.${baseline}`);
  }

  if (!result.ok) {
    lines.push(`StorageLayoutError: Storage layout validation failed for "${contractName}"`);
    if (result.baseline) lines.push(`  baseline: ${describeBaseline(result.baseline)}`);
    for (const err of result.errors) {
      lines.push(formatError(err));
    }
    for (const err of result.safetyErrors) {
      lines.push(formatSafetyError(err));
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

// ---------------------------------------------------------------------------
// OZ op → ValidationError mapping
// ---------------------------------------------------------------------------

function namespaceIdFromOp(op: unknown): string | undefined {
  const contract =
    (op as { original?: { contract?: string } }).original?.contract ??
    (op as { updated?: { contract?: string } }).updated?.contract;
  if (typeof contract !== "string") return undefined;
  const prefix = "namespace:";
  return contract.startsWith(prefix) ? contract.slice(prefix.length) : undefined;
}

function labelOf(field: unknown): string {
  return String((field as { label?: string }).label ?? "unknown");
}

function slotOf(field: unknown): string {
  const slot = (field as { slot?: string }).slot;
  return slot === undefined ? "0" : String(slot);
}

function typeLabelOf(field: unknown): string {
  // After OZ's getDetailedLayout, type is ParsedTypeDetailed: { item: { label } }
  const label = (field as { type?: { item?: { label?: string } } }).type?.item?.label;
  if (typeof label === "string" && label.length > 0) return label;
  const id = (field as { type?: { id?: string } }).type?.id;
  if (typeof id === "string" && id.length > 0) return id;
  return "unknown";
}

/**
 * Returns the storage size in bytes for a Solidity primitive type label,
 * or undefined for unknown/complex types (structs, dynamic arrays, etc.).
 */
function bytesFromTypeLabel(label: string): number | undefined {
  if (label === "address" || label === "address payable") return 20;
  if (label === "bool") return 1;
  const uintMatch = /^u?int(\d+)?$/.exec(label);
  if (uintMatch) {
    const bits = uintMatch[1] ? parseInt(uintMatch[1], 10) : 256;
    return bits / 8;
  }
  const bytesMatch = /^bytes(\d+)$/.exec(label);
  if (bytesMatch) return parseInt(bytesMatch[1], 10);
  return undefined;
}

// ---------------------------------------------------------------------------
// Known accepted deltas vs oz-core behavior
//
// 1. Middle-insertion: oz-core emits an extra `type-changed` op where
//    oldType === newType for the shifted tail variable. We emit only the
//    `variable-inserted` error and drop the spurious type-changed.
//
// 2. `variable-removed` type label: oz-core normalizes the type to a
//    human-readable label (e.g. "uint256") while a legacy baseline may
//    store a type id (e.g. "t_uint256"). Both are accepted; the label shown
//    in the error comes from oz-core and will be the normalized form.
// ---------------------------------------------------------------------------

function mapAndFilter(
  ozOps: Array<unknown>,
  globalUnsafeAllow: UnsafeAllowKind[],
  perVariableUnsafeAllow: Map<string, UnsafeAllowKind[]>,
  namespaceUnsafeAllow: Map<string, UnsafeAllowKind[]>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const op of ozOps) {
    const kind = (op as { kind?: string }).kind;
    const original = (op as { original?: unknown }).original;
    const updated = (op as { updated?: unknown }).updated;

    switch (kind) {
      case "delete": {
        errors.push({
          kind: "variable-removed",
          label: labelOf(original),
          slot: slotOf(original),
          type: typeLabelOf(original),
        });
        break;
      }
      case "insert": {
        errors.push({
          kind: "variable-inserted",
          label: labelOf(updated),
          slot: slotOf(updated),
        });
        break;
      }
      case "rename": {
        const nsId = namespaceIdFromOp(op);
        const newLabel = labelOf(updated);
        const oldLabel = labelOf(original);
        const slot = slotOf(original ?? updated);

        // Suppress if global unsafeAllow covers variable-renamed.
        if (globalUnsafeAllow.includes("variable-renamed")) {
          break;
        }

        // Suppress if namespace-level unsafeAllow covers variable-renamed.
        if (
          nsId !== undefined &&
          (namespaceUnsafeAllow.get(nsId) ?? []).includes("variable-renamed")
        ) {
          break;
        }
        // Suppress if per-variable unsafeAllow covers variable-renamed.
        if ((perVariableUnsafeAllow.get(newLabel) ?? []).includes("variable-renamed")) {
          break;
        }

        errors.push({ kind: "variable-renamed", oldLabel, newLabel, slot });
        break;
      }
      case "replace":
      case "typechange":
      case "layoutchange": {
        const nsId = namespaceIdFromOp(op);
        const label = labelOf(updated ?? original);
        const slot = slotOf(updated ?? original);

        // Suppress if global unsafeAllow covers type-changed.
        if (globalUnsafeAllow.includes("type-changed")) {
          break;
        }

        // Suppress if namespace-level unsafeAllow covers type-changed.
        if (nsId !== undefined && (namespaceUnsafeAllow.get(nsId) ?? []).includes("type-changed")) {
          break;
        }
        // Suppress if per-variable unsafeAllow covers type-changed.
        if ((perVariableUnsafeAllow.get(label) ?? []).includes("type-changed")) {
          break;
        }

        // For layoutchange: OZ emits this when retypedFrom is set but the baseline
        // namespace members lack slot/offset (record-baseline never runs namespaced
        // compilation). hasLayout(original) = false → uncertain: true → layoutchange.
        // Suppress only when we can verify same size from the type labels.
        if (kind === "layoutchange") {
          const change = (op as { change?: { uncertain?: boolean } }).change;
          const retypedFrom = (updated as { retypedFrom?: string } | undefined)?.retypedFrom;
          if (change?.uncertain === true && retypedFrom !== undefined) {
            const oldBytes = bytesFromTypeLabel(typeLabelOf(original));
            const newBytes = bytesFromTypeLabel(typeLabelOf(updated));
            if (oldBytes !== undefined && newBytes !== undefined && oldBytes === newBytes) {
              break;
            }
          }
        }

        errors.push({
          kind: "type-changed",
          label,
          slot,
          oldType: typeLabelOf(original),
          newType: typeLabelOf(updated),
        });
        break;
      }
      case "delete-namespace": {
        errors.push({
          kind: "namespace-removed",
          namespaceId: String((op as { namespace?: string }).namespace ?? "unknown"),
        });
        break;
      }
      default: {
        // Unknown op kind from a future oz-core version. We cannot classify
        // whether this change is safe or breaking, so we skip it rather than
        // falsely failing the user's upgrade. Plugin maintainers should add
        // explicit handling for any new op kind.
        logger.warn(
          `Unknown storage operation kind "${String(kind)}" ` +
            `from oz-core — plugin may need updating to fully validate this upgrade.`,
        );
        break;
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Error / warning formatters
// ---------------------------------------------------------------------------

function formatError(err: ValidationResult["errors"][number]): string {
  switch (err.kind) {
    case "variable-removed":
      return `  [ERROR] Variable "${err.label}" (${err.type}) was removed\n          Existing storage values at this slot will be misread or lost.`;
    case "variable-renamed":
      return `  [ERROR] Variable "${err.oldLabel}" was renamed to "${err.newLabel}"\n          Use @custom:upgrades-validator-renamed-from to approve intentional renames.`;
    case "type-changed": {
      const oldBytes = bytesFromTypeLabel(err.oldType);
      const newBytes = bytesFromTypeLabel(err.newType);
      const samePrimitiveSize =
        oldBytes !== undefined && newBytes !== undefined && oldBytes === newBytes;
      const hint = samePrimitiveSize
        ? `Use @custom:upgrades-validator-retyped-from to approve same-size retyping.`
        : `Existing values will be misread as the new type.`;
      return `  [ERROR] Variable "${err.label}" changed type: ${err.oldType} → ${err.newType}\n          ${hint}`;
    }
    case "variable-inserted":
      return `  [ERROR] Variable "${err.label}" was inserted in the middle of the layout\n          New variables must be appended at the end.`;
    case "invalid-gap":
      return `  [ERROR] Gap variable "${err.label}" at slot ${err.slot} is a dynamic array\n          Gaps must be fixed-size (e.g. uint256[50] __gap).`;
    case "namespace-removed":
      return `  [ERROR] Namespace "${err.namespaceId}" was removed\n          Existing namespaced storage values will be misread or lost.`;
    case "namespace-collision":
      return `  [ERROR] Namespace "${err.namespaceId}" is defined multiple times in the contract's inheritance chain\n          Use a unique namespace id for each @custom:storage-location struct.`;
  }
}

function formatSafetyError(err: ContractSafetyError): string {
  switch (err.kind) {
    case "constructor":
      return `  [ERROR] Contract "${err.contract}" has a constructor\n          Upgradeable contracts must not define constructors.`;
    case "delegatecall":
      return `  [ERROR] Contract uses delegatecall\n          Use of delegatecall in upgradeable contracts is unsafe.`;
    case "selfdestruct":
      return `  [ERROR] Contract uses selfdestruct\n          Use of selfdestruct in upgradeable contracts is unsafe.`;
    case "state-variable-immutable":
      return `  [ERROR] Immutable variable "${err.name}"\n          Upgradeable contracts must not use immutable variables.`;
    case "state-variable-assignment":
      return `  [ERROR] State variable "${err.name}" has an inline assignment\n          Upgradeable contracts must not assign state variables inline.`;
    case "external-library-linking":
      return `  [ERROR] External library linking for "${err.name}"\n          Upgradeable contracts must not link external libraries.`;
  }
}

function formatWarning(w: ValidationResult["warnings"][number]): string {
  switch (w.kind) {
    case "gap-shrunken":
      return `  [WARN] Gap variable "${w.label}" was reduced: ${w.oldSize} slots → ${w.newSize} slots`;
    case "no-baseline":
      return `  [INFO] No prior deployment found for "${w.contractName}" — skipping validation (first deployment).`;
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
