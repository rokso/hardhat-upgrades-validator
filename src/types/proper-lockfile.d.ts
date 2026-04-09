// Minimal type declaration for proper-lockfile (no @types package available).
// Only the lock() function is declared since that is all we use.
declare module "proper-lockfile" {
  interface LockOptions {
    retries?: {
      minTimeout?: number;
      factor?: number;
    };
    realpath?: boolean;
  }

  /** Acquires a lock on `file`. Returns a release function. */
  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
}
