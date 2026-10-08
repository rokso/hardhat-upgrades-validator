import {deployScript, artifacts} from '../rocketh/deploy.js';
const v2 = process.env.FIXTURE_V2 === '1';
export default deployScript(
  async ({deployViaProxy, namedAccounts}) => {
    const {deployer} = namedAccounts;
    await deployViaProxy(
      'Ledger',
      {account: deployer, artifact: v2 ? artifacts.LedgerV2 : artifacts.Ledger},
      {owner: deployer},
    );
  },
  {tags: ['Ledger']},
);
