import {expect} from 'chai'

import {
  artifactStoreFromDogeConfig,
  assertTopologyUsesProofArtifactStore,
  proofArtifactStoreFromDogeConfig,
} from '../../src/utils/artifact-stores.js'

describe('deployment artifact stores', () => {
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
    proofArtifacts: {s3: {bucket: 'dogeos-proof-artifacts', keyPrefix: 'rehearsal/proofs', region: 'us-west-2'}},
    snapshots: {s3: {bucket: 'dogeos-snapshots', keyPrefix: 'rehearsal/history', region: 'us-west-2'}},
  }

  it('resolves the proof store from proofArtifacts.s3, separate from the DA archive', () => {
    expect(proofArtifactStoreFromDogeConfig(dogeConfig)).to.deep.equal({
      bucket: 'dogeos-proof-artifacts',
      forcePathStyle: false,
      keyPrefix: 'rehearsal/proofs',
      region: 'us-west-2',
    })
    expect(artifactStoreFromDogeConfig(dogeConfig, 'da')).to.deep.equal({
      bucket: 'dogeos-da-archive',
      forcePathStyle: false,
      keyPrefix: 'rehearsal/batches',
      publicBaseUrl: 'https://dogeos-da-archive.s3.us-west-2.amazonaws.com',
      region: 'us-west-2',
    })
    expect(artifactStoreFromDogeConfig(dogeConfig, 'snapshot').bucket).to.equal('dogeos-snapshots')
  })

  it('reports the exact mismatched field before compilation or provisioning', () => {
    const store = proofArtifactStoreFromDogeConfig(dogeConfig)
    expect(() => assertTopologyUsesProofArtifactStore({
      bucket: 'dogeos-da-archive',
      keyPrefix: store.keyPrefix,
      region: store.region,
    }, store, '.data/proof-aws.json')).to.throw(
      '.data/proof-aws.json artifact bucket (dogeos-da-archive) does not match canonical proofArtifacts.s3',
    )
  })

  it('requires each store to be configured with a non-empty prefix', () => {
    expect(() => artifactStoreFromDogeConfig({ethereumDa: {blobArchive: {s3: {enabled: false}}}}, 'da'))
      .to.throw('must be enabled')
    expect(() => proofArtifactStoreFromDogeConfig({proofArtifacts: {s3: {bucket: 'dogeos-proofs', region: 'us-west-2'}}}))
      .to.throw('proofArtifacts.s3 must define bucket, region, and a non-empty keyPrefix')
    expect(() => artifactStoreFromDogeConfig({}, 'snapshot')).to.throw('snapshots.s3 must define')
  })

  it('rejects shared buckets when reading either store despite separate prefixes', () => {
    const config = structuredClone(dogeConfig)
    config.proofArtifacts.s3.bucket = config.ethereumDa.blobArchive.s3.bucket
    for (const kind of ['da', 'proof'] as const) {
      expect(() => artifactStoreFromDogeConfig(config, kind)).to.throw('separate prefixes do not provide separate buckets')
    }
  })
})
