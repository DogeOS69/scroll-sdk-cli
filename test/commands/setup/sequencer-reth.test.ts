/* eslint-disable @typescript-eslint/no-explicit-any -- YAML helper tests use dynamic values objects */
import { expect } from 'chai'

import {
  applySequencerRethValues,
  deriveSequencerRethEnodeUrl,
  getSequencerRethDefaultKmsAlias,
  getSequencerRethDefaultKmsRoleName,
  getSequencerRethKmsIdentityPromptDefaults,
  getSequencerRethValuesFileName,
  normalizeRethNodekey,
  normalizeRethSignerPrivateKey,
  parseSequencerRethKmsAlias,
  shouldReuseExistingSequencerRethKmsKey,
  shouldReuseExistingSequencerRethRoleArn,
} from '../../../src/commands/setup/sequencer-reth.js'

describe('setup sequencer-reth', () => {
  it('normalizes reth nodekey and signer private key formats', () => {
    expect(normalizeRethNodekey('0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD')).to.equal(
      'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    )
    expect(normalizeRethSignerPrivateKey('abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')).to.equal(
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    )
    expect(getSequencerRethValuesFileName(2)).to.equal('l2-reth-sequencer-production-2.yaml')
    expect(deriveSequencerRethEnodeUrl('abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd', 2)).to.match(
      /^enode:\/\/[\da-f]+@l2-reth-sequencer-2:30303$/
    )
  })

  it('derives AWS KMS prompt defaults from existing sequencer-reth signer config', () => {
    expect(parseSequencerRethKmsAlias('alias/dogeos/testnet/dogeos-testnet-cluster/sequencer-reth-1', 1)).to.deep.equal({
      eksCluster: 'dogeos-testnet-cluster',
      networkAlias: 'testnet',
    })
    expect(parseSequencerRethKmsAlias('alias/dogeos/testnet/dogeos-testnet-cluster/sequencer-reth-2', 1)).to.equal(undefined)

    expect(getSequencerRethKmsIdentityPromptDefaults({
      index: 1,
      signer: {
        backend: 'aws_kms',
        kmsKeyId: 'alias/dogeos/testnet/dogeos-testnet-cluster/sequencer-reth-1',
        kmsRegion: 'us-west-2',
        namespace: 'rollup',
      },
    }, 1)).to.deep.equal({
      awsRegion: 'us-west-2',
      eksCluster: 'dogeos-testnet-cluster',
      namespace: 'rollup',
      networkAlias: 'testnet',
    })

    expect(getSequencerRethKmsIdentityPromptDefaults({
      index: 1,
      signer: {
        backend: 'aws_kms',
        eksCluster: 'configured-cluster',
        kmsKeyId: 'alias/dogeos/testnet/dogeos-testnet-cluster/sequencer-reth-1',
        kmsRegion: 'ap-northeast-1',
        namespace: 'configured-namespace',
        networkAlias: 'configured-alias',
      },
    }, 1)).to.deep.equal({
      awsRegion: 'ap-northeast-1',
      eksCluster: 'configured-cluster',
      namespace: 'configured-namespace',
      networkAlias: 'configured-alias',
    })
  })

  it('only reuses existing KMS resources when they match the resolved identity', () => {
    const identity = {
      awsRegion: 'us-east-1',
      eksCluster: 'dogeos-devnet-cluster',
      namespace: 'default',
      networkAlias: 'devnet0',
    }
    const matchingAlias = 'alias/dogeos/devnet0/dogeos-devnet-cluster/sequencer-reth-0'
    const oldAlias = 'alias/dogeos/shutest/dogeos-devnet-cluster/sequencer-reth-0'
    const matchingRoleArn = 'arn:aws:iam::123456789012:role/dogeos-devnet0-dogeos-devnet-cluster-sequencer-reth-0-kms'
    const oldRoleArn = 'arn:aws:iam::123456789012:role/dogeos-shutest-dogeos-devnet-cluster-sequencer-reth-0-kms'

    expect(getSequencerRethDefaultKmsAlias(0, identity)).to.equal(matchingAlias)
    expect(getSequencerRethDefaultKmsRoleName(0, identity)).to.equal('dogeos-devnet0-dogeos-devnet-cluster-sequencer-reth-0-kms')
    expect(shouldReuseExistingSequencerRethKmsKey(matchingAlias, 0, identity)).to.equal(true)
    expect(shouldReuseExistingSequencerRethKmsKey(oldAlias, 0, identity)).to.equal(false)
    expect(shouldReuseExistingSequencerRethRoleArn(matchingRoleArn, 0, identity)).to.equal(true)
    expect(shouldReuseExistingSequencerRethRoleArn(oldRoleArn, 0, identity)).to.equal(false)
  })

  it('writes plain local key material as a mounted Secret and removes external secret references', () => {
    const values: any = {
      command: ['/bin/sh', '-ec', 'old command'],
      env: [],
      envFrom: [{ secretRef: { name: 'l2-reth-sequencer-2-secret-env' } }],
      externalSecrets: {
        'l2-reth-sequencer-2-secret-env': { provider: 'aws' },
      },
      persistence: {
        keys: { enabled: true, mountPath: '/keys', type: 'emptyDir' },
      },
      reth: {
        nodeKey: {
          generatedPath: '/data/nodekey',
          path: '/keys/nodekey',
          secretKey: 'RETH_NODEKEY',
          secretName: 'l2-reth-sequencer-2-secret-env',
        },
      },
    }

    applySequencerRethValues(values, {
      index: 2,
      nodekey: '1111111111111111111111111111111111111111111111111111111111111111',
      secretMode: 'plain',
      secretName: 'l2-reth-sequencer-2-secret-env',
      signer: {
        address: '0x1234567890123456789012345678901234567890',
        backend: 'local',
        privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
      },
    })

    expect(values.envFrom.some((item: any) => item.configMapRef)).to.equal(false)
    expect(values.envFrom.some((item: any) => item.secretRef)).to.equal(false)
    expect(values.externalSecrets).to.equal(undefined)
    expect(values.env.some((item: any) => item.name === 'RETH_NODEKEY')).to.equal(false)
    expect(values.env.some((item: any) => item.name === 'RETH_SEQUENCER_SIGNER_PRIVATE_KEY')).to.equal(false)
    expect(values.reth.nodeKey).to.deep.equal({
      generatedPath: '/data/nodekey',
      path: '/keys/nodekey',
      secretKey: 'RETH_NODEKEY',
      secretName: 'l2-reth-sequencer-2-secret-env',
    })
    expect(values.reth.signer.type).to.equal('localFile')
    expect(values.reth.signer.localFile).to.deep.equal({})
    expect(values.secrets['secret-env'].stringData).to.deep.equal({
      RETH_NODEKEY: '1111111111111111111111111111111111111111111111111111111111111111',
      RETH_SEQUENCER_SIGNER_PRIVATE_KEY: '0x2222222222222222222222222222222222222222222222222222222222222222',
    })
    expect(values.configMaps).to.equal(undefined)
    expect(values.command).to.equal(undefined)
    expect(values.persistence.keys).to.equal(undefined)
  })

  it('writes externalSecret references for local signer and nodekey', () => {
    const values: any = { env: [] }

    applySequencerRethValues(values, {
      index: 1,
      nodekey: '1111111111111111111111111111111111111111111111111111111111111111',
      secretMode: 'external-secret',
      secretName: 'l2-reth-sequencer-1-secret-env',
      signer: {
        address: '0x1234567890123456789012345678901234567890',
        backend: 'local',
        privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
      },
    })

    expect(values.envFrom.some((item: any) => item.secretRef)).to.equal(false)
    expect(values.env.some((item: any) => item.name === 'RETH_NODEKEY')).to.equal(false)
    expect(values.reth.nodeKey).to.equal(undefined)
    expect(values.reth.signer.type).to.equal('localFile')
    expect(values.reth.signer.localFile).to.deep.equal({})
    expect(values.externalSecrets['l2-reth-sequencer-1-secret-env'].data.map((item: any) => item.secretKey)).to.deep.equal([
      'RETH_NODEKEY',
      'RETH_SEQUENCER_SIGNER_PRIVATE_KEY',
    ])
    expect(values.command).to.equal(undefined)
  })

  it('writes KMS signer env and service account without local signer private key secret', () => {
    const values: any = { env: [] }

    applySequencerRethValues(values, {
      index: 3,
      nodekey: '1111111111111111111111111111111111111111111111111111111111111111',
      secretMode: 'external-secret',
      secretName: 'l2-reth-sequencer-3-secret-env',
      signer: {
        address: '0x1234567890123456789012345678901234567890',
        backend: 'aws_kms',
        kmsKeyId: 'alias/dogeos/test/l2/sequencer-reth-3',
        kmsRegion: 'us-west-2',
        serviceAccountName: 'l2-reth-sequencer-3',
        serviceAccountRoleArn: 'arn:aws:iam::123456789012:role/l2-reth-sequencer-3',
      },
    })

    expect(values.configMaps).to.equal(undefined)
    expect(values.reth.nodeKey).to.equal(undefined)
    expect(values.reth.signer.type).to.equal('awsKms')
    expect(values.reth.signer.awsKmsKeyId).to.equal('alias/dogeos/test/l2/sequencer-reth-3')
    expect(values.externalSecrets['l2-reth-sequencer-3-secret-env'].data.map((item: any) => item.secretKey)).to.deep.equal([
      'RETH_NODEKEY',
    ])
    expect(values.serviceAccount.name).to.equal('l2-reth-sequencer-3')
    expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).to.equal('arn:aws:iam::123456789012:role/l2-reth-sequencer-3')
    expect(values.command).to.equal(undefined)
  })
})
