import {expect} from 'chai'

import {ProofAwsDiscovery} from '../../src/utils/proof-aws-discovery.js'

describe('proof AWS wizard discovery', () => {
  it('prefers the AWS region environment without invoking the CLI', () => {
    const aws = {
      json(): never {
        throw new Error('unexpected json call')
      },
      text(): never {
        throw new Error('unexpected text call')
      },
    }
    const discovery = new ProofAwsDiscovery(undefined, aws, {AWS_REGION: 'ap-northeast-1'})

    expect(discovery.configuredRegion()).to.equal('ap-northeast-1')
  })

  it('falls back to the configured AWS CLI region and normalizes EKS choices', () => {
    const aws = {
      json(args: string[]): unknown {
        expect(args).to.deep.equal(['eks', 'list-clusters'])
        return {clusters: ['z-cluster', 'a-cluster', 'a-cluster', '']}
      },
      text(args: string[]): string {
        expect(args).to.deep.equal(['configure', 'get', 'region'])
        return 'us-east-1'
      },
    }
    const discovery = new ProofAwsDiscovery(undefined, aws, {})

    expect(discovery.configuredRegion()).to.equal('us-east-1')
    expect(discovery.eksClusters('us-east-1')).to.deep.equal(['a-cluster', 'z-cluster'])
  })

  it('leaves the region unresolved when the AWS CLI has no configured default', () => {
    const aws = {
      json(): unknown {
        return {}
      },
      text(): never {
        throw new Error('region not configured')
      },
    }

    expect(new ProofAwsDiscovery(undefined, aws, {}).configuredRegion()).to.equal(undefined)
  })
})
