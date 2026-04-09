import chalk from "chalk";

const PREFIX = "[hardhat-upgrades-validator]";

/**
 * Colorizes bracket tags embedded in user-facing output lines.
 * Applied in logger.log — NOT in format functions, so thrown error
 * messages stay plain text.
 */
function colorizeInlineTags(msg: string): string {
  return msg
    .replace(/\[ERROR\]/g, chalk.red("[ERROR]"))
    .replace(/\[WARN\]/g, chalk.yellow("[WARN]"))
    .replace(/\[INFO\]/g, chalk.blue("[INFO]"))
    .replace(/\[SKIP\]/g, chalk.dim("[SKIP]"))
    .replace(/\[OK\]/g, chalk.green("[OK]"))
    .replace(/^StorageLayoutError:/m, chalk.red("StorageLayoutError:"))
    .replace(/^\[hardhat-upgrades-validator\]/m, chalk.dim("[hardhat-upgrades-validator]"));
}

export const logger = {
  /**
   * User-facing output (task results, per-contract lines).
   * Goes to stdout; bracket tags are colorized.
   */
  log(msg: string): void {
    console.log(colorizeInlineTags(msg));
  },

  /**
   * Internal plugin diagnostic warnings (bad config, ambiguous input, etc.).
   * Goes to stderr with the plugin prefix prepended.
   */
  warn(msg: string): void {
    console.warn(chalk.yellow(`${PREFIX} [WARN] `) + msg);
  },

  /**
   * Internal plugin errors (unexpected failures that degrade validation).
   * Goes to stderr with the plugin prefix prepended.
   */
  error(msg: string): void {
    console.error(chalk.red(`${PREFIX} [ERROR] `) + msg);
  },
};
