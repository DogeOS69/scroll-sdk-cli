import {expect} from 'chai'

import type {ProofTopologySpec} from '../../src/types/deployment-spec.js'

import {buildProofAwsConfig} from '../../src/utils/proof-aws-config.js'
import {assertProofAwsMatchesTopology} from '../../src/utils/proof-kubernetes-reconciler.js'

describe('proof Kubernetes reconciler preflight', () => {
  it('rejects dormant S3 profiles that disagree with provisioned AWS facts', () => {
    const proofAws = buildProofAwsConfig({
      coordinatorServiceAccount: 'proof-coordinator',
      identity: {
        awsRegion: 'us-west-2',
        eksCluster: 'test',
        namespace: 'default',
        networkAlias: 'testnet',
      },
      keyPrefix: 'proof-topology',
      provisioned: {
        artifactReadTransport: {mode: 'external', status: 'operator-managed-unverified'},
        bucket: 'provisioned-proof-bucket',
        bucketCreated: false,
        coordinatorRoleArn: 'arn:aws:iam::123456789012:role/proof-coordinator',
        secretAction: 'reused',
        secretName: 'scroll/proof-coordinator-secrets',
        withdrawalRoleArn: 'arn:aws:iam::123456789012:role/withdrawal-processor',
      },
      withdrawalServiceAccount: 'withdrawal-processor',
    })
    const topology = {
      compiler: {
        image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'compiler'},
      },
      mode: 'disabled',
      production: {
        artifactStore: {
          bucket: 'different-bucket',
          keyPrefix: 'proof-topology',
          kind: 's3_compatible',
          region: 'us-west-2',
        },
      },
    } as unknown as ProofTopologySpec

    expect(() => assertProofAwsMatchesTopology(topology, proofAws))
      .to.throw('production.artifactStore.bucket')
  })

  it('accepts staged profiles that match provisioned AWS facts', () => {
    const proofAws = buildProofAwsConfig({
      coordinatorServiceAccount: 'proof-coordinator',
      identity: {
        awsRegion: 'us-west-2',
        eksCluster: 'test',
        namespace: 'default',
        networkAlias: 'testnet',
      },
      keyPrefix: 'proof-topology',
      provisioned: {
        artifactReadTransport: {mode: 'external', status: 'operator-managed-unverified'},
        bucket: 'proof-bucket',
        bucketCreated: false,
        coordinatorRoleArn: 'arn:aws:iam::123456789012:role/proof-coordinator',
        secretAction: 'reused',
        secretName: 'scroll/proof-coordinator-secrets',
        withdrawalRoleArn: 'arn:aws:iam::123456789012:role/withdrawal-processor',
      },
      withdrawalServiceAccount: 'withdrawal-processor',
    })
    const topology = {
      compiler: {
        image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'compiler'},
      },
      mock: {
        artifactStore: {
          bucket: 'proof-bucket',
          keyPrefix: 'proof-topology',
          kind: 's3_compatible',
          region: 'us-west-2',
        },
      },
      mode: 'disabled',
    } as unknown as ProofTopologySpec

    expect(() => assertProofAwsMatchesTopology(topology, proofAws)).not.to.throw()
  })
})
