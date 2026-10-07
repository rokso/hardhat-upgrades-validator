import {deployScript, artifacts} from '../rocketh/deploy.js';
const v2 = process.env.FIXTURE_V2 === '1';
export default deployScript(
  async ({deployViaProxy, namedAccounts}) => {
    const {deployer} = namedAccounts;
    await deployViaProxy(
      'Vault',
      {account: deployer, artifact: v2 ? artifacts.VaultV2 : artifacts.Vault},
      {proxyContract: 'UUPS', owner: deployer, execute: {init: {methodName: 'initialize', args: [process.env.FIXTURE_VAULT_OWNER ?? deployer]}}},
    );
  },
  {tags: ['Vault']},
);
