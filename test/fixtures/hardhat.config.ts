import type { HardhatUserConfig } from "hardhat/types/config";
import plugin from "../../dist/index.js";

const config: HardhatUserConfig = {
  plugins: [plugin],
  solidity: {
    version: "0.8.24",
  },
};

export default config;
