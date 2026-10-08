import "hardhat/types/config";

export interface UpgradesValidatorConfig {
  /**
   * Networks to validate during `hardhat compile`.
   *
   * - `"all"` (default): validate every network found under `deployments/`
   * - `string[]`: validate only the listed network names
   */
  networks?: string[] | "all";
  /**
   * Enable or disable the compile hook entirely.
   *
   * - `true` (default): runs the namespaced compilation pass, writes the
   *   ValidationData cache, and auto-validates all deployed baselines after
   *   each compile.
   * - `false`: compile hook is a no-op, and a build removes the ValidationData
   *   cache (Hardhat caches its jobs unvalidated). `validate-upgrade`,
   *   `record-baseline` and the proxy helpers then fail until you re-enable it
   *   and run `hardhat compile`.
   */
  enableCompileHook?: boolean;
}

declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    upgradesValidator?: UpgradesValidatorConfig;
  }
  interface HardhatConfig {
    upgradesValidator?: UpgradesValidatorConfig;
  }
}
