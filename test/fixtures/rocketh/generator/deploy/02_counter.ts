import {deployScript, artifacts} from '../rocketh/deploy.js';
const v2 = process.env.FIXTURE_V2 === '1';
export default deployScript(
  async ({deployViaProxy, namedAccounts}) => {
    const {deployer, admin} = namedAccounts;
    await deployViaProxy(
      'Counter',
      {account: deployer, artifact: v2 ? artifacts.CounterV2 : artifacts.Counter},
      {proxyContract: 'SharedAdminOptimizedTransparentProxy', owner: admin},
    );
  },
  {tags: ['Counter']},
);
