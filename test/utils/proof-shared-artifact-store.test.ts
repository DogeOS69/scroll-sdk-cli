import {expect} from 'chai'

import {
  assertTopologyUsesSharedArtifactStore,
  sharedArtifactStoreFromDogeConfig,
} from '../../src/utils/proof-shared-artifact-store.js'

describe('shared DA/proof artifact store', () => {
  const dogeConfig = {
    ethereumDa: {
      blobArchive: {
        s3: {
          bucket: 'dogeos-da-archive',
          enabled: true,
          keyPrefix: 'rehearsal/batches',
          publicBaseUrl: 'https://dogeos-da-archive.s3.us-west-2.amazonaws.com',
          region: 'us-west-2',
        },
      },
    },
  }

  it('uses ethereumDa.blobArchive.s3 as the canonical shared namespace', () => {
    expect(sharedArtifactStoreFromDogeConfig(dogeConfig)).to.deep.equal({
      bucket: 'dogeos-da-archive',
      forcePathStyle: false,
      keyPrefix: 'rehearsal/batches',
      publicBaseUrl: 'https://dogeos-da-archive.s3.us-west-2.amazonaws.com',
      region: 'us-west-2',
    })
  })

  it('reports the exact mismatched field before compilation or provisioning', () => {
    const shared = sharedArtifactStoreFromDogeConfig(dogeConfig)
    expect(() => assertTopologyUsesSharedArtifactStore({
      bucket: 'separate-proof-bucket',
      keyPrefix: shared.keyPrefix,
      region: shared.region,
    }, shared, '.data/proof-aws.json')).to.throw(
      '.data/proof-aws.json artifact bucket (separate-proof-bucket) does not match canonical ethereumDa.blobArchive.s3',
    )
  })

  it('requires an enabled, non-empty canonical archive prefix', () => {
    expect(() => sharedArtifactStoreFromDogeConfig({ethereumDa: {blobArchive: {s3: {enabled: false}}}}))
      .to.throw('must be enabled')
    expect(() => sharedArtifactStoreFromDogeConfig({
      ethereumDa: {blobArchive: {s3: {bucket: 'dogeos-da', enabled: true, region: 'us-west-2'}}},
    })).to.throw('must define bucket, region, and a non-empty keyPrefix')
  })
})
