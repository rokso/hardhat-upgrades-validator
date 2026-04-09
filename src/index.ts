/**
 * hardhat-upgrades-validator
 *
 * Default export: the Hardhat v3 plugin object.
 * Named exports: the core validator functions for use in deploy scripts.
 */

import "./types/hardhat-type-extensions.js";
export { default } from "./plugin/plugin.js";

export { validateStorageUpgrade, formatValidationResult } from "./core/validator.js";

export { StorageLayoutError } from "./proxy/validate-proxy.js";

export type {
  StorageLayout,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  UnsafeAllowKind,
  ValidateOptions,
} from "./types/validation.js";
