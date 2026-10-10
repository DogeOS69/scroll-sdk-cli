/* eslint-disable @typescript-eslint/no-explicit-any -- YAML helper tests use dynamic values objects */
import * as toml from '@iarna/toml'
import { expect } from 'chai'
import {Wallet} from 'ethers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import SetupL2BootnodeReth, {
  applyBootnodeRethValues,
  deriveBootnodeRethEnodeUrl,
  getBootnodeRethValuesFileName,
} from '../../../src/commands/setup/l2-bootnode-reth.js'

describe('setup l2-bootnode-reth', () => {
  const nodekey = '1111111111111111111111111111111111111111111111111111111111111111'

  it('imports the explicitly supplied key for a scoped nonzero bootnode index', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootnode-import-'))
    try {
      const file = path.join(root, 'doge-config.toml')
      fs.writeFileSync(file, 'network = "testnet"\n[wallet]\npath = "unused-test-wallet"\n', {mode: 0o600})
      const imported = Wallet.createRandom().privateKey.slice(2)
      const command = Object.create(SetupL2BootnodeReth.prototype)
      command.argv = ['--secret-mode', 'external-secret']
      await command.prepareIdentity({'count': 1, 'doge-config': file, 'indices': [1], 'nodekey': imported, 'non-interactive': true, 'secret-mode': 'external-secret'}, {info() {}, logSuccess() {}})
      const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
      expect(config.bootnodeReth.instances).to.have.length(1)
      expect(config.bootnodeReth.instances[0].index).to.equal(1)
      expect(config.bootnodeReth.instances[0].nodekey.privateKey).to.equal(imported)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('retains previously prepared nodekeys across per-instance spec tasks and retries', () => {
    const config: any = {}
    const update = (SetupL2BootnodeReth.prototype as any).updateDogeConfig
    const first = {enodeUrl: 'enode://first', index: 0, nodekey: Wallet.createRandom().privateKey, secretMode: 'external-secret'}
    const second = {enodeUrl: 'enode://second', index: 1, nodekey: Wallet.createRandom().privateKey, secretMode: 'external-secret'}
    update.call({}, config, [first], true)
    update.call({}, config, [second], true)
    update.call({}, config, [second], true)
    expect(config.bootnodeReth.instances.map((node: any) => node.index)).to.deep.equal([0, 1])
    expect(config.bootnodeReth.instances[0].nodekey.privateKey).to.equal(first.nodekey)
    expect(config.bootnodeReth.instances[1].nodekey.privateKey).to.equal(second.nodekey)
  })

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
        {remoteRef: {key: remoteKey}, secretKey: 'RETH_NODEKEY'},
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
