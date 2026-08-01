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

    it('uses an explicit source-configured RPC URL without changing P2P or ZMQ service routing', () => {
      expect(resolveDogecoinKubernetesEndpoints({
        kubernetes: {
          rpcUrl: 'https://shadowfork.example.com/rpc?api_key=test',
          serviceName: 'dogecoin-testnet',
        },
        network: 'testnet',
      })).to.include({
        p2pPort: 44_556,
        rpcPort: 44_555,
        rpcUrl: 'https://shadowfork.example.com/rpc?api_key=test',
        serviceName: 'dogecoin-testnet',
        zmqRawBlockUrl: 'tcp://dogecoin-testnet:28332',
      });
    });

    it('rejects a non-http RPC URL override', () => {
      expect(() => resolveDogecoinKubernetesEndpoints({
        kubernetes: { rpcUrl: 'file:///tmp/dogecoin.sock' },
        network: 'testnet',
      })).to.throw('kubernetes.rpcUrl must be a valid http(s) URL')
    })
  });
});
