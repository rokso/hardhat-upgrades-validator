import type { ConfigHooks } from "hardhat/types/hooks";
import type { ConfigurationVariableResolver, SolidityConfig } from "hardhat/types/config";
import type {
  UpgradesValidatorConfig,
  UpgradesValidatorUserConfig,
} from "../../types/hardhat-type-extensions.js";

// What oz-core's validate() needs from solc beyond Hardhat's defaults.
const REQUIRED_CONTRACT_OUTPUTS = ["storageLayout", "devdoc"];
const REQUIRED_FILE_OUTPUTS = ["ast"];

export default async (): Promise<Partial<ConfigHooks>> => {
  return {
    async resolveUserConfig(userConfig, resolveConfigurationVariable, next) {
      const resolvedConfig = await next(userConfig, resolveConfigurationVariable);

      // Propagate our plugin's user config to the resolved config so it is
      // available on context.config inside hook handlers.
      const uvConfig = (
        userConfig as typeof userConfig & {
          upgradesValidator?: UpgradesValidatorUserConfig;
        }
      ).upgradesValidator;

      if (uvConfig !== undefined) {
        (
          resolvedConfig as typeof resolvedConfig & {
            upgradesValidator: UpgradesValidatorConfig;
          }
        ).upgradesValidator = resolveUpgradesValidatorConfig(
          uvConfig,
          resolveConfigurationVariable,
        );
      }

      requestValidationOutputs(resolvedConfig.solidity);
      return resolvedConfig;
    },
  };
};

/**
 * Asks every configured compiler for the outputs validation reads. Hardhat
 * merges a compiler's `outputSelection` with its own defaults when it builds
 * the solc input, so these are added, never replacing what the user set.
 */
export function requestValidationOutputs(solidity: SolidityConfig): void {
  for (const profile of Object.values(solidity.profiles)) {
    for (const compiler of [...profile.compilers, ...Object.values(profile.overrides)]) {
      const settings = (compiler.settings ??= {}) as {
        outputSelection?: Record<string, Record<string, string[]>>;
      };
      // A new object: the existing one may be shared with Hardhat's defaults.
      const selection: Record<string, Record<string, string[]>> = {};
      for (const [file, contracts] of Object.entries(settings.outputSelection ?? {})) {
        selection[file] = Object.fromEntries(
          Object.entries(contracts).map(([contract, outputs]) => [contract, [...outputs]]),
        );
      }
      const all = (selection["*"] ??= {});
      all["*"] = union(all["*"], REQUIRED_CONTRACT_OUTPUTS);
      all[""] = union(all[""], REQUIRED_FILE_OUTPUTS);
      settings.outputSelection = selection;
    }
  }
}

function union(existing: string[] | undefined, required: string[]): string[] {
  return [...new Set([...(existing ?? []), ...required])];
}

/**
 * A `configVariable(...)` API key becomes a resolved variable, read only when
 * used, so a missing secret never fails an unrelated command. Strings stay
 * as written: an empty one still means unset.
 */
export function resolveUpgradesValidatorConfig(
  config: UpgradesValidatorUserConfig,
  resolveConfigurationVariable: ConfigurationVariableResolver,
): UpgradesValidatorConfig {
  if (config.explorers === undefined) return config as UpgradesValidatorConfig;
  const explorers = Object.fromEntries(
    Object.entries(config.explorers)
      // A JS config may leave an entry undefined (`x ? {...} : undefined`).
      .filter(([, explorer]) => explorer !== undefined)
      .map(([network, { apiKey, ...rest }]) => [
        network,
        {
          ...rest,
          ...(apiKey === undefined
            ? {}
            : {
                apiKey: typeof apiKey === "string" ? apiKey : resolveConfigurationVariable(apiKey),
              }),
        },
      ]),
  );
  return { ...config, explorers };
}
