/**
 * The chain cannot supply a baseline: no RPC, no implementation behind the
 * slot, unverified source, an unsupported verification format, or no explorer
 * key. In `auto` mode callers fall back to an offline baseline.
 */
export class BaselineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineUnavailableError";
  }
}

/**
 * The chain answered but the answer cannot be trusted: reconstructed bytecode
 * does not match the deployed code, a stored record describes different code,
 * or compilation failed. Never falls back, since a silent fallback here would
 * validate against a layout nothing is running.
 */
export class BaselineIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineIntegrityError";
  }
}
