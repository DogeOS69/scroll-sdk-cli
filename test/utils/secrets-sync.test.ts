import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {type SecretsSyncDeps, secretDestination, secretsKubeTarget, syncSecrets} from '../../src/utils/secrets-sync.js'

const OLD_RPC = 'https://old-rpc.example.invalid/NONFUNCTIONAL-OLD-TOKEN'
const NEW_RPC = 'https://new-rpc.example.invalid/NONFUNCTIONAL-NEW-TOKEN'
const PREFIX = 'dogeos/test-cluster/chain/test-deployment'

describe('secrets sync', () => {
  let root: string
  let pushes: string[]
  let annotations: string[]
  let generate: (root: string) => Promise<void>
  let synced: boolean
  const files = () => Object.fromEntries(fs.readdirSync(path.join(root, 'secrets')).map(name => [name, fs.readFileSync(path.join(root, 'secrets', name), 'utf8')]))
  const write = (name: string, content: string) => fs.writeFileSync(path.join(root, 'secrets', name), content, {mode: 0o600})
  const deps = (): SecretsSyncDeps => ({
    generate: async directory => generate(directory),
    kube(args) {
      if (args[0] === 'get' && args[1] === 'externalsecrets.external-secrets.io' && args.length === 4) {
        return JSON.stringify({items: [
          {metadata: {name: 'fee-oracle-secret-env'}, spec: {dataFrom: [{extract: {key: `${PREFIX}/fee-oracle-secret-env`}}], target: {name: 'fee-oracle-secret-env'}}},
          {metadata: {name: 'l1-interface-secret-env'}, spec: {data: [{remoteRef: {key: `${PREFIX}/l1-interface-secret-env`, property: 'URL'}, secretKey: 'URL'}]}},
          {metadata: {name: 'other-deployment'}, spec: {dataFrom: [{extract: {key: 'dogeos/other/fee-oracle-secret-env'}}]}},
        ]})
      }

      if (args[0] === 'get' && args[1] === 'externalsecrets.external-secrets.io') return JSON.stringify({status: {conditions: [{status: 'True', type: 'Ready'}], refreshTime: synced ? '2030-01-01T00:00:10Z' : '2020-01-01T00:00:00Z'}})
      if (args[0] === 'get' && args[1] === 'deployments,statefulsets,daemonsets') {
        return JSON.stringify({items: [
          {kind: 'StatefulSet', metadata: {name: 'fee-oracle'}, spec: {template: {spec: {containers: [{envFrom: [{secretRef: {name: 'fee-oracle-secret-env'}}]}]}}}},
          {kind: 'Deployment', metadata: {name: 'l1-interface'}, spec: {template: {spec: {containers: [{env: [{name: 'URL', valueFrom: {secretKeyRef: {key: 'URL', name: 'l1-interface-secret-env'}}}]}]}}}},
          {kind: 'Deployment', metadata: {name: 'unrelated'}, spec: {template: {spec: {containers: [{}], volumes: [{secret: {secretName: 'something-else'}}]}}}},
        ]})
      }

      if (args[0] === 'annotate') {annotations.push(args.join(' ')); return ''}
      throw new Error(`unexpected kubectl ${args.join(' ')}`)
    },
    now: () => new Date('2030-01-01T00:00:05Z'),
    async push(_root, file) {pushes.push(file); return [file.endsWith('.env') ? `${file.slice(0, -4)}-env` : file.slice(0, -5)]},
    async sleep() {synced = true},
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-sync-'))
    fs.mkdirSync(path.join(root, '.scrollsdk'))
    fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify({infrastructure: {aws: {eksClusterName: 'test-cluster', region: 'us-east-1'}, kubeContext: 'test-context', namespace: 'chain', provider: 'aws'}, metadata: {name: 'test-deployment'}}))
    fs.mkdirSync(path.join(root, 'secrets'))
    write('fee-oracle-secret.env', `DOGEOS_FEE_ORACLE_PRIVATE_KEY="0xNONFUNCTIONAL"\nDOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL="${OLD_RPC}"\n`)
    write('l1-interface-secret.env', `URL="${OLD_RPC}"\n`)
    write('dogecoin-secret.env', 'DOGECOIN_RPC_USER="u"\n')
    pushes = []
    annotations = []
    synced = false
    // gen-secrets resolves deployment.env references into the files.
    generate = async directory => {
      for (const name of ['fee-oracle-secret.env', 'l1-interface-secret.env']) {
        const file = path.join(directory, 'secrets', name)
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(OLD_RPC, NEW_RPC))
      }
    }
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('reports changed files, keys, ExternalSecrets and readers without changing anything', async () => {
    const before = files()
    const result = await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())
    expect(result.changes).to.deep.equal([
      {file: 'fee-oracle-secret.env', keys: ['DOGEOS_FEE_ORACLE_ETHEREUM_DA__ETH_RPC_URL'], route: 'push', secret: 'fee-oracle-secret-env', status: 'changed'},
      {file: 'l1-interface-secret.env', keys: ['URL'], route: 'push', secret: 'l1-interface-secret-env', status: 'changed'},
    ])
    expect(result.externalSecrets.map(item => item.name)).to.deep.equal(['fee-oracle-secret-env', 'l1-interface-secret-env'])
    expect(result.restarts).to.deep.equal([
      'kubectl --context test-context --namespace chain rollout restart deployment/l1-interface',
      'kubectl --context test-context --namespace chain rollout restart statefulset/fee-oracle',
    ])
    expect(files()).to.deep.equal(before)
    expect(pushes).to.deep.equal([])
    expect(annotations).to.deep.equal([])
    expect(fs.existsSync(path.join(root, '.scrollsdk/secrets-sync-backup'))).to.equal(false)
    expect(JSON.stringify(result)).not.to.include('NONFUNCTIONAL')
  })

  it('uploads only changed files, forces their ExternalSecrets to sync and waits for them', async () => {
    const result = await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, deps())
    expect(pushes).to.deep.equal(['fee-oracle-secret.env', 'l1-interface-secret.env'])
    expect(annotations).to.deep.equal([
      'annotate externalsecrets.external-secrets.io fee-oracle-secret-env force-sync=1893456005 --overwrite',
      'annotate externalsecrets.external-secrets.io l1-interface-secret-env force-sync=1893456005 --overwrite',
    ])
    expect(result.externalSecrets.every(item => item.synced)).to.equal(true)
    expect(files()['l1-interface-secret.env']).to.include(NEW_RPC)
    expect(fs.existsSync(path.join(root, '.scrollsdk/secrets-sync-backup'))).to.equal(false)
    const again = await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, deps())
    expect(again.changes).to.deep.equal([])
  })

  it('refuses signing or node key changes and restores secrets/', async () => {
    const before = files()
    generate = async directory => {fs.writeFileSync(path.join(directory, 'secrets/fee-oracle-secret.env'), 'DOGEOS_FEE_ORACLE_PRIVATE_KEY="0xNONFUNCTIONAL-OTHER"\n')}
    try {
      await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, deps())
      expect.fail('expected refusal')
    } catch (error) {
      expect((error as Error).message).to.include('fee-oracle-secret.env:DOGEOS_FEE_ORACLE_PRIVATE_KEY').and.not.include('NONFUNCTIONAL')
    }

    expect(files()).to.deep.equal(before)
    expect(pushes).to.deep.equal([])
  })

  it('restores secrets/ when an upload fails, so a rerun uploads the same changes', async () => {
    const before = files()
    const failing = {...deps(), async push() {throw new Error('scrollsdk setup push-secrets failed: denied')}}
    try {
      await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, failing)
      expect.fail('expected failure')
    } catch (error) {expect((error as Error).message).to.include('secrets/ was restored')}

    expect(files()).to.deep.equal(before)
    expect((await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())).changes).to.have.length(2)
  })

  it('re-requests a sync while ExternalSecrets back off after provider errors', async () => {
    let sleeps = 0
    const slow = {...deps(), async sleep() {sleeps++; if (sleeps === 12) synced = true}}
    const result = await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, slow)
    expect(result.externalSecrets[0].synced).to.equal(true)
    expect(annotations.filter(item => item.includes('fee-oracle-secret-env'))).to.have.length(2)
    expect(annotations.at(-1)).to.match(/force-sync=\d+-9 --overwrite$/)
  })

  it('treats an upload that writes nothing as a failure', async () => {
    const before = files()
    const silent = {...deps(), async push() {return []}}
    try {
      await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, silent)
      expect.fail('expected failure')
    } catch (error) {expect((error as Error).message).to.include('did not write fee-oracle-secret-env').and.include('secrets/ was restored')}

    expect(files()).to.deep.equal(before)
  })

  it('routes Kubernetes manifests to their own commands and refuses after an interrupted sync', async () => {
    write('dstack-controller-config.yaml', 'kind: Secret\n')
    generate = async directory => {fs.writeFileSync(path.join(directory, 'secrets/dstack-controller-config.yaml'), 'kind: Secret\nchanged: true\n')}
    const result = await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())
    expect(result.changes).to.deep.equal([{file: 'dstack-controller-config.yaml', keys: ['*'], route: 'manual', status: 'changed'}])
    expect(result.manual[0]).to.include('push-secrets --dstack-only')
    fs.mkdirSync(path.join(root, '.scrollsdk/secrets-sync-backup'))
    try {
      await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())
      expect.fail('expected refusal')
    } catch (error) {expect((error as Error).message).to.include('did not finish')}
  })

  it('reports removed files and subdirectory changes as not uploaded, with guidance', async () => {
    write('proof-coordinator.env', 'URL="x"\n')
    generate = async directory => {
      fs.mkdirSync(path.join(directory, 'secrets/.retired'), {recursive: true})
      fs.renameSync(path.join(directory, 'secrets/proof-coordinator.env'), path.join(directory, 'secrets/.retired/proof-coordinator.env'))
    }

    const result = await syncSecrets(root, {apply: true, context: 'test-context', namespace: 'chain'}, deps())
    expect(result.changes.map(change => [change.file, change.status, change.route])).to.deep.equal([
      ['.retired/proof-coordinator.env', 'added', 'manual'],
      ['proof-coordinator.env', 'removed', 'manual'],
    ])
    expect(result.manual[0]).to.include('subdirectory')
    expect(result.manual[1]).to.include('retire them by hand')
    expect(pushes).to.deep.equal([])
  })

  it('points a changed Vast.ai key to capacity deploy, by name only', async () => {
    fs.mkdirSync(path.join(root, '.data/dstack'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/dstack/credentials.json'), JSON.stringify({adminToken: 'a'.repeat(64), encryptionKey: Buffer.alloc(32).toString('base64'), project: 'main', providers: ['vastai'], vastaiApiKey: 'NONFUNCTIONAL-OLD-VAST', version: 1}), {mode: 0o600})
    fs.writeFileSync(path.join(root, 'capacity.yaml'), 'apiVersion: scrollsdk.dogeos/capacity/v1\nproject: main\nproviders: {vastai: {apiKeyEnv: TEST_SYNC_VAST_KEY}}\nprimary: {fleet: vast-rtx3090, gpu: RTX3090, maxPricePerHourUsd: 0.8, provider: vastai, regions: [us-texas]}\n')
    process.env.TEST_SYNC_VAST_KEY = 'NONFUNCTIONAL-NEW-VAST'
    try {
      const result = await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())
      expect(result.manual).to.include('TEST_SYNC_VAST_KEY: the dstack controller uses another Vast.ai key; deploy it with scrollsdk capacity deploy')
      expect(JSON.stringify(result)).not.to.include('NONFUNCTIONAL-NEW-VAST').and.not.include('NONFUNCTIONAL-OLD-VAST')
      process.env.TEST_SYNC_VAST_KEY = 'NONFUNCTIONAL-OLD-VAST'
      expect((await syncSecrets(root, {apply: false, context: 'test-context', namespace: 'chain'}, deps())).manual.join(' ')).not.to.include('TEST_SYNC_VAST_KEY')
    } finally {
      delete process.env.TEST_SYNC_VAST_KEY
    }
  })

  it('accepts a relative deployment directory', async () => {
    const previous = process.cwd()
    process.chdir(root)
    try {
      expect((await syncSecrets('.', {apply: false, context: 'test-context', namespace: 'chain'}, deps())).changes).to.have.length(2)
      expect(secretsKubeTarget('.', 'test-context').namespace).to.equal('chain')
    } finally {process.chdir(previous)}
  })

  it('resolves the saved destination and Kubernetes target', () => {
    expect(secretDestination(root)).to.deep.equal({awsPrefix: PREFIX, awsRegion: 'us-east-1', provider: 'aws'})
    expect(secretsKubeTarget(root, 'test-context')).to.deep.equal({context: 'test-context', namespace: 'chain'})
    expect(() => secretsKubeTarget(root, 'other-context')).to.throw('context differs')
  })
})
