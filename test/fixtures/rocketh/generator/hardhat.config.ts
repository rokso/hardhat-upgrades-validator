import {defineConfig} from 'hardhat/config';
import HardhatDeploy from 'hardhat-deploy';

export default defineConfig({
  plugins: [HardhatDeploy],
  solidity: {version: '0.8.28', settings: {optimizer: {enabled: true, runs: 200}}},
  networks: {
    localhost: {type: 'http', url: 'http://127.0.0.1:8545'},
  },
});
