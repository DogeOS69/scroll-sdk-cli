/* eslint-disable @typescript-eslint/no-explicit-any -- YAML helper tests use dynamic values objects */
import { expect } from 'chai'

import {
  applyBootnodeRethValues,
  deriveBootnodeRethEnodeUrl,
  getBootnodeRethValuesFileName,
} from '../../../src/commands/setup/l2-bootnode-reth.js'

describe('setup l2-bootnode-reth', () => {
  const nodekey = '1111111111111111111111111111111111111111111111111111111111111111'

  it('derives filenames and enode URLs', () => {
    expect(getBootnodeRethValuesFileName(2)).to.equal('l2-reth-bootnode-production-2.yaml')
    expect(deriveBootnodeRethEnodeUrl(nodekey, 2)).to.match(/^enode:\/\/[\da-f]+@l2-reth-bootnode-2:30303$/)
  })

  it('writes plain nodekey material as a mounted Secret and removes external secret references', () => {
    const values: any = {
      command: ['/bin/sh', '-ec', 'old command'],
      env: [],
      envFrom: [
        { configMapRef: { name: 'l2-reth-bootnode-2-env' } },
        { configMapRef: { name: 'shared-observability-env' } },
        { secretRef: { name: 'l2-reth-bootnode-2-secret-env' } },
      ],
      externalSecrets: {
        'l2-reth-bootnode-2-secret-env': { provider: 'aws' },
      },
      global: {
        nameOverride: 'operator-bootnode-name',
      },
      persistence: {
        keys: { enabled: true, mountPath: '/keys', type: 'emptyDir' },
      },
      reth: {
        nodeKey: {
          generatedPath: '/data/nodekey',
          path: '/keys/nodekey',
          secretKey: 'RETH_NODEKEY',
          secretName: 'l2-reth-bootnode-2-secret-env',
        },
      },
    }

    applyBootnodeRethValues(values, {
      enodeUrl: deriveBootnodeRethEnodeUrl(nodekey, 2),
      index: 2,
      nodekey,
      secretMode: 'plain',
      secretName: 'l2-reth-bootnode-2-secret-env',
    })

    expect(values.global).to.deep.equal({nameOverride: 'operator-bootnode-name'})
    expect(values.envFrom).to.deep.equal([{ configMapRef: { name: 'shared-observability-env' } }])
    expect(values.externalSecrets).to.equal(undefined)
    expect(values.env.some((item: any) => item.name === 'RETH_NODEKEY')).to.equal(false)
    expect(values.reth.nodeKey).to.deep.equal({
      generatedPath: '/data/nodekey',
      path: '/keys/nodekey',
      secretKey: 'RETH_NODEKEY',
    })
    expect(values.secrets['secret-env'].stringData).to.deep.equal({
      RETH_NODEKEY: nodekey,
    })
    expect(values.command).to.equal(undefined)
    expect(values.persistence.keys).to.equal(undefined)
  })

  it('writes externalSecret references for nodekey', () => {
    const values: any = { env: [] }

    applyBootnodeRethValues(values, {
      enodeUrl: deriveBootnodeRethEnodeUrl(nodekey, 1),
      index: 1,
      nodekey,
      secretMode: 'external-secret',
      secretName: 'l2-reth-bootnode-1-secret-env',
    })

    expect(values.envFrom.some((item: any) => item.secretRef)).to.equal(false)
    expect(values.env.some((item: any) => item.name === 'RETH_NODEKEY')).to.equal(false)
    expect(values.reth).to.equal(undefined)
    expect(values.externalSecrets['secret-env'].data.map((item: any) => item.secretKey)).to.deep.equal([
      'RETH_NODEKEY',
    ])
    expect(values.command).to.equal(undefined)
    expect(values.externalSecrets['secret-env'].data[0].remoteRef.key).to.equal('dogeos/l2-reth-bootnode-1-secret-env')
  })

  for (const name of ['secret-env', 'l2-reth-bootnode-1-secret-env']) {
    it(`preserves custom remote paths across regeneration (${name})`, () => {
      const remoteKey = 'dogeos/custom-instance/bootnode-key'
      const values: any = {externalSecrets: {[name]: {data: [
        {secretKey: 'RETH_NODEKEY', remoteRef: {key: remoteKey}},
      ]}}}
      for (let pass = 0; pass < 2; pass++) {
        applyBootnodeRethValues(values, {
          enodeUrl: deriveBootnodeRethEnodeUrl(nodekey, 1), index: 1, nodekey,
          secretMode: 'external-secret', secretName: 'l2-reth-bootnode-1-secret-env',
        })
        expect(values.externalSecrets['secret-env'].data[0].remoteRef.key).to.equal(remoteKey)
      }
    })
  }

  it('removes plain Secret fields when switching back to ExternalSecret mode', () => {
    const values: any = {
      env: [],
      secrets: {
        'secret-env': {
          enabled: true,
          nameOverride: 'secret-env',
          stringData: {
            RETH_NODEKEY: nodekey,
          },
        },
      },
    }

    applyBootnodeRethValues(values, {
      enodeUrl: deriveBootnodeRethEnodeUrl(nodekey, 0),
      index: 0,
      nodekey,
      secretMode: 'external-secret',
      secretName: 'l2-reth-bootnode-0-secret-env',
    })

    expect(values.secrets).to.equal(undefined)
    expect(values.externalSecrets).to.have.property('secret-env')
  })
})
