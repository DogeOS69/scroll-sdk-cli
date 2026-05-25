import { expect } from 'chai';

import { resolveDogecoinKubernetesEndpoints } from '../../src/utils/kubernetes-endpoints.js';

describe('kubernetes-endpoints', () => {
  describe('resolveDogecoinKubernetesEndpoints', () => {
    it('uses Dogecoin default RPC and P2P ports by network', () => {
      expect(resolveDogecoinKubernetesEndpoints({ network: 'mainnet' })).to.include({
        p2pPort: 22_556,
        rpcPort: 22_555,
        rpcUrl: 'http://dogecoin:22555',
      });

      expect(resolveDogecoinKubernetesEndpoints({ network: 'testnet' })).to.include({
        p2pPort: 44_556,
        rpcPort: 44_555,
        rpcUrl: 'http://dogecoin:44555',
      });

      expect(resolveDogecoinKubernetesEndpoints({ network: 'regtest' })).to.include({
        p2pPort: 18_444,
        rpcPort: 18_332,
        rpcUrl: 'http://dogecoin:18332',
      });
    });
  });
});
