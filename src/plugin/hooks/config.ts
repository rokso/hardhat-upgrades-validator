import type { ConfigHooks } from "hardhat/types/hooks";
import type { UpgradesValidatorConfig } from "../../types/hardhat-type-extensions.js";

export default async (): Promise<Partial<ConfigHooks>> => {
  return {
    async resolveUserConfig(userConfig, resolveConfigurationVariable, next) {
      const resolvedConfig = await next(userConfig, resolveConfigurationVariable);

      // Propagate our plugin's user config to the resolved config so it is
      // available on context.config inside hook handlers.
      const uvConfig = (
        userConfig as typeof userConfig & {
          upgradesValidator?: UpgradesValidatorConfig;
        }
      ).upgradesValidator;

      if (uvConfig !== undefined) {
        (
          resolvedConfig as typeof resolvedConfig & {
            upgradesValidator: UpgradesValidatorConfig;
          }
        ).upgradesValidator = uvConfig;
      }

      return resolvedConfig;
    },
  };
};
