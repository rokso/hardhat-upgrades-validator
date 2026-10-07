import "hardhat/types/config";

export interface UpgradesValidatorConfig {
  /**
   * Networks to validate during `hardhat compile`.
   *
   * - `"all"` (default) — validate every network found under `deployments/`
   * - `string[]` — validate only the listed network names
   */
  networks?: string[] | "all";
  /**
   * Enable or disable the compile hook entirely.
   *
   * - `true` (default) — runs the namespaced compilation pass, writes the
   *   ValidationData cache, and auto-validates all deployed baselines after
   *   each compile.
   * - `false` — compile hook is a no-op. The ValidationData cache will not be
   *   written, so `validate-upgrade` and `record-baseline` tasks will skip
   *   contracts until you re-enable and run `hardhat compile`.
   */
  enableCompileHook?: boolean;
  /**
   * Explorer used to rebuild a chain baseline from verified source when no
   * record exists yet, keyed by network name (the `deployments/` directory).
   * `apiKey` falls back to the `ETHERSCAN_API_KEY` environment variable and
   * `apiUrl` to Etherscan v2, which covers every chain Etherscan indexes; set
   * `apiUrl` for an Etherscan-compatible explorer such as Blockscout.
   */
  explorers?: Record<string, { apiKey?: string; apiUrl?: string }>;
  /**
   * Compiler cache for rebuilding verified sources. Defaults to
   * `<os cache>/hardhat-upgrades-validator/compilers`; Hardhat's own compiler
   * cache is checked first either way.
   */
  solcCacheDir?: string;
}

declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    upgradesValidator?: UpgradesValidatorConfig;
  }
  interface HardhatConfig {
    upgradesValidator?: UpgradesValidatorConfig;
  }
}
