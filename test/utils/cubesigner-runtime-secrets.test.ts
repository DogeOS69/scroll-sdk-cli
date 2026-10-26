/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic rendered Kubernetes objects. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {prepareCubesignerRuntimeSecrets} from '../../src/utils/cubesigner-runtime-secrets.js'

const names = ['cubesigner-signer-env', 'cubesigner-signer-session']
const owned = {'app.kubernetes.io/managed-by': 'Helm'}
const annotations = {'meta.helm.sh/release-name': 'cubesigner-signer', 'meta.helm.sh/release-namespace': 'default'}
const rejects = async (run: () => Promise<unknown>, message: string) => {
  let error: unknown
  try {await run()} catch (error_) {error = error_}
  expect(error).instanceOf(Error)
  expect((error as Error).message).include(message)
}

describe('CubeSigner runtime Secret delivery before activation', () => {
  let root: string
  let documents: any[]
  let calls: Array<{args: string[]; stdin?: string}>
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesigner-delivery-'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/cubesigner-signer-production.yaml'), '{}')
    documents = names.flatMap(name => [
      {apiVersion: 'external-secrets.io/v1beta1', kind: 'SecretStore', metadata: {name}, spec: {provider: {aws: {region: 'us-east-1', service: 'SecretsManager'}}}},
      {apiVersion: 'external-secrets.io/v1beta1', kind: 'ExternalSecret', metadata: {name}, spec: {secretStoreRef: {kind: 'SecretStore', name}, target: {name}}},
    ])
    documents.push({apiVersion: 'apps/v1', kind: 'Deployment', metadata: {name: 'cubesigner-signer'}}, {apiVersion: 'v1', kind: 'Secret', metadata: {name: 'ignore-inline'}, stringData: {key: 'synthetic-secret'}})
    calls = []
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const run = (readback = '') => prepareCubesignerRuntimeSecrets({directory: root, kubeContext: 'fixture-context', namespace: 'default',
    render: () => documents.map(doc => yaml.dump(doc)).join('---\n'),
    async runner(args, stdin) {calls.push({args, stdin}); return args.includes('get') ? readback : ''},
  })

  it('creates only four owned references, waits for delivery and leaves activation unverified', async () => {
    const result = await run()
    expect(result).include({activation: 'not-verified', workloadStarted: false})
    const applies = calls.filter(call => call.args.includes('apply'))
    expect(applies).length(2)
    expect(applies[0].args).include('--dry-run=server')
    expect(applies[1].args).not.include('--dry-run=server')
    for (const call of applies) {
      expect(call.stdin).not.include('Deployment').and.not.include('synthetic-secret')
      const {items} = JSON.parse(call.stdin!)
      expect(items).length(4)
      for (const item of items) {
        expect(item.metadata).include({namespace: 'default'})
        expect(item.metadata.labels).deep.equal(owned)
        expect(item.metadata.annotations).deep.equal(annotations)
      }
    }

    expect(calls.at(-1)!.args).include('wait').and.include('--for=condition=Ready')
    expect(calls.every(call => call.args[1] === 'fixture-context' && call.args[3] === 'default')).equal(true)
  })

  it('can resume resources owned by the signer Helm release', async () => {
    await run(JSON.stringify({metadata: {annotations, labels: owned, resourceVersion: '7'}}))
    const payload = JSON.parse(calls.find(call => call.args.includes('apply'))!.stdin!)
    expect(payload.items.every((item: any) => item.metadata.resourceVersion === '7')).equal(true)
  })

  it('refuses a different or unclaimed owner before any apply', async () => {
    await rejects(() => run(JSON.stringify({metadata: {annotations: {...annotations, 'meta.helm.sh/release-name': 'another-release'}, labels: owned}})), 'another owner')
    expect(calls.some(call => call.args.includes('apply'))).equal(false)
    await rejects(() => run(JSON.stringify({metadata: {}})), 'another owner')
  })

  it('rejects cluster-wide stores, extra references and another namespace without Kubernetes writes', async () => {
    documents[0].kind = 'ClusterSecretStore'
    await rejects(() => run(), 'exactly the two')
    documents[0].kind = 'SecretStore'
    documents[0].metadata.namespace = 'other'
    await rejects(() => run(), 'namespace')
    delete documents[0].metadata.namespace
    documents.push({...documents[0], metadata: {name: 'unrelated'}})
    await rejects(() => run(), 'exactly the two')
    expect(calls).length(0)
  })

  it('refuses an ExternalSecret that redirects the target or store', async () => {
    documents[1].spec.target.name = 'unrelated'
    await rejects(() => run(), 'matching namespaced store and target')
    documents[1].spec.target.name = names[0]
    documents[1].spec.secretStoreRef.kind = 'ClusterSecretStore'
    await rejects(() => run(), 'matching namespaced store and target')
    expect(calls).length(0)
  })

  it('stops at failed server admission before applying resources', async () => {
    await rejects(() => prepareCubesignerRuntimeSecrets({directory: root, kubeContext: 'fixture-context', namespace: 'default',
      render: () => documents.map(doc => yaml.dump(doc)).join('---\n'),
      async runner(args, stdin) {
        calls.push({args, stdin})
        if (args.includes('--dry-run=server')) throw new Error('Synthetic admission rejection')
        return ''
      },
    }), 'admission rejection')
    expect(calls.filter(call => call.args.includes('apply'))).length(1)
    expect(calls.some(call => call.args.includes('wait'))).equal(false)
  })
})
