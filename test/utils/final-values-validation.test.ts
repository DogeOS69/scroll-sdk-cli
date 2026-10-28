import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {validateFinalValues} from '../../src/utils/final-values-validation.js'
import {mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'
import {applyHelmValues, writeHelmValues} from '../../src/utils/spec-helm-values.js'

const mainnet = {metadata: {environment: 'mainnet' as const, name: 'example'}}
const rpc = 'l2-reth-rpc-public-production.yaml'
const wp = 'withdrawal-processor-production.yaml'
const tso = 'tso-service-production.yaml'
const follower = {controller: {type: 'statefulset'}, reth: {extraArgs: ['--consensus.exit-on-signer-rotation'], l1Url: 'http://l1-interface:8545'}}
const peer = {podSelector: {matchLabels: {app: 'example'}}}
const policy = {networkPolicy: {allowFrom: {proofCoordinator: [peer], signers: [peer], tso: [peer], withdrawalProcessor: [peer]}, enabled: true}}

describe('final deployment values validation', () => {
  it('rejects a retained unsafe template even when generated projection is safe', () => {
    const template = yaml.dump({...follower, reth: {...follower.reth, extraArgs: ['--consensus.exit-on-signer-rotation', '--network.legacy-geth-header-transform', 'true']}})
    const merged = mergeBootstrapValues(template, yaml.dump(follower))
    expect(() => validateFinalValues({[rpc]: merged}, mainnet)).throw('mainnet must not enable')
  })

  it('rejects legacy true, bare flags and duplicates in list/string forms, but allows false or omission', () => {
    for (const legacy of ['--network.legacy-geth-header-transform true', '--network.legacy-geth-header-transform=true', '--network.legacy-geth-header-transform', '--network.legacy-geth-header-transform=false --network.legacy-geth-header-transform=true']) {
      for (const args of [legacy, legacy.split(' ')]) {
        expect(() => validateFinalValues({[rpc]: yaml.dump({...follower, reth: {...follower.reth, extraArgs: args}})}, mainnet)).throw('legacy-geth-header-transform')
      }
    }

    for (const suffix of ['', ' --network.legacy-geth-header-transform false', ' --network.legacy-geth-header-transform=false']) {
      const args = `--consensus.exit-on-signer-rotation${suffix}`
      expect(() => validateFinalValues({[rpc]: yaml.dump({...follower, reth: {...follower.reth, extraArgs: args}})}, mainnet)).not.throw()
    }
  })

  it('checks follower rotation, pinned signer, consensus, L1 and restarting controller', () => {
    const invalid = [
      {...follower, reth: {...follower.reth, extraArgs: []}},
      {...follower, reth: {...follower.reth, extraArgs: ['--consensus.exit-on-signer-rotation', '--consensus.authorized-signer=placeholder']}},
      {...follower, reth: {...follower.reth, extraArgs: ['--consensus.exit-on-signer-rotation', '--consensus.algorithm', 'noop']}},
      {...follower, reth: {...follower.reth, l1Url: ''}},
      {...follower, controller: {restartPolicy: 'OnFailure'}},
      {...follower, controller: {enabled: false}},
      {...follower, controller: {type: 'job'}},
    ]
    for (const values of invalid) expect(() => validateFinalValues({[rpc]: yaml.dump(values)}, mainnet)).throw()
    expect(() => validateFinalValues({'l2-reth-bootnode-0-production.yaml': yaml.dump(follower)}, mainnet)).not.throw()
    expect(() => validateFinalValues({'l2-reth-sequencer-production-0.yaml': yaml.dump(follower)}, mainnet)).throw('sequencers must not')
    expect(() => validateFinalValues({'l2-reth-sequencer-production.yaml': 'reth: {extraArgs: []}'}, mainnet)).not.throw()
    // An explicit testnet compatibility override remains operator-owned.
    expect(() => validateFinalValues({[rpc]: 'reth: {extraArgs: ["--network.legacy-geth-header-transform", "true"]}'}, {})).not.throw()
  })

  it('validates policies after overlays and leaves every file untouched on rejection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-values-'))
    try {
      fs.mkdirSync(path.join(root, 'values'))
      const files = {'other-production.yaml': 'replicas: 1\n', [wp]: yaml.dump(policy)}
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, 'values', name), content)
      expect(() => writeHelmValues(root, {helmValues: {'other-production.yaml': 'replicas: 2', [wp]: 'networkPolicy: {enabled: false}'}})).throw('networkPolicy must be enabled')
      for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(root, 'values', name), 'utf8')).eq(content)
      // Validate retained files even if no overlay addresses them.
      fs.writeFileSync(path.join(root, 'values', wp), 'networkPolicy: {enabled: false}')
      expect(() => writeHelmValues(root, {})).throw('networkPolicy must be enabled')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('keeps bootstrap edge deferral narrow and accepts cross-namespace monitoring', () => {
    const files = {[tso]: yaml.dump(policy)}
    expect(() => validateFinalValues(files, {}, {deferIngressValidation: true})).not.throw()
    expect(() => validateFinalValues(files, {})).throw('allowFrom.edge')
    applyHelmValues(files, {helmValues: {[tso]: yaml.dump({networkPolicy: {allowFrom: {edge: [{ipBlock: {cidr: '10.0.10.0/24'}}], monitoring: [{...peer, namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'monitoring'}}}]}}})}})
    expect(() => validateFinalValues(files, {})).not.throw()
    applyHelmValues(files, {helmValues: {[tso]: 'networkPolicy: {enabled: false}'}})
    expect(() => validateFinalValues(files, {}, {deferIngressValidation: true})).throw('must be enabled')
  })
})
