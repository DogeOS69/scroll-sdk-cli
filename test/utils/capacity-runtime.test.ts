/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values documents. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {startCapacityDocument} from '../../src/utils/capacity-command.js'
import {type CapacityDeployDeps, CapacityDeployError, deployCapacity} from '../../src/utils/capacity-deploy.js'
import {CAPACITY_DOCUMENT, readCapacityDocument} from '../../src/utils/capacity-document.js'
import {capacitySpec, inCapacityDocumentTerms, prepareCapacityManager} from '../../src/utils/capacity-manager.js'
import {checkVastApiKey, createCapacityDocument, createCapacityDocumentAfterPreparation, renderCapacity} from '../../src/utils/capacity-runtime.js'
import {DSTACK_CREDENTIALS_FILE, dstackServerConfigChecksum, newDstackCredentials, readDstackCredentials} from '../../src/utils/dstack-credentials.js'
import {writeJson} from '../../src/utils/preparation-io.js'
import {capacityWorkerFixture} from '../helpers/capacity-manager-worker.js'

const VAST_KEY = 'NONFUNCTIONAL-VAST-KEY-0123456789'
const ROTATED_KEY = 'NONFUNCTIONAL-ROTATED-KEY-9876543210'
const CONTEXT = 'saved-cluster-context'
const ROLE = 'arn:aws:iam::123456789012:role/example-dstack-controller'

describe('capacity.yaml creation and render', function () {
  this.timeout(30_000)
  let root: string
  let env: NodeJS.ProcessEnv
  let checked: string[]

  const contract: any = {components: {proofCoordinator: {valuesFile: 'values/proof-coordinator-production.yaml'}, withdrawalProcessor: {valuesFile: 'values/withdrawal-processor-production.yaml'}}, generation: 'real', generationId: 'test-generation', inputs: {publication: {path: '.data/publication.json'}}, mode: 'active', worker: {contractFile: '.data/worker.json'}}
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
  const values = (service: string) => yaml.load(read(`values/${service}-production.yaml`)) as any
  const serverConfig = () => yaml.load((yaml.load(read('secrets/dstack-controller-config.yaml')) as any).stringData['config.yml']) as any
  const render = (options: Parameters<typeof renderCapacity>[1] = {}) => renderCapacity(root, {
    async checkVastKey(key) {checked.push(key)}, env, prepare: (directory, preparation) => prepareCapacityManager(directory, () => contract, undefined, preparation), ...options,
  })
  const rejects = async (promise: Promise<unknown>, message: string) => {
    try {
      await promise
      expect.fail(`expected a rejection with ${message}`)
    } catch (error) {
      expect((error as Error).message).to.include(message)
      return (error as Error).message
    }
  }

  const editDocument = (change: (document: any) => void) => {
    const document = yaml.load(read(CAPACITY_DOCUMENT)) as any
    change(document)
    fs.writeFileSync(path.join(root, CAPACITY_DOCUMENT), yaml.dump(document))
  }

  const setController = (config: Record<string, unknown>) => fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify({dstackController: {database: {type: 'sqlite'}, enabled: true, ...config}} as any))
  /** The controller's AWS identity, edited in its values as on a prepared deployment. */
  const allowAws = (extraEnv = [{name: 'AWS_EC2_METADATA_DISABLED', value: 'true'}]) => {
    const controller = values('dstack-controller')
    fs.writeFileSync(path.join(root, 'values/dstack-controller-production.yaml'), yaml.dump({...controller, defaultCredentialsEnabled: true, extraEnv, serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': ROLE}}}))
  }

  const createDocument = (directory: string) => createCapacityDocument(directory)!
  /** Make AWS primary and the existing Vast fleet the fallback. */
  const addAwsPrimary = () => editDocument(document => {
    document.providers.aws = {vpcIds: {'us-east-1': 'vpc-0123456789abcdef0'}}
    document.fallback = {...document.primary}
    document.primary = {fleet: 'aws-l4', gpu: 'L4', instanceTypes: ['g6.4xlarge'], maxPricePerHourUsd: 1.5, provider: 'aws', regions: ['us-east-1']}
    document.scaling.maxHourlyCostUsd = 3
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-runtime-'))
    const input = capacityWorkerFixture()
    input.imageCheck.cudaArchitectures = ['86', '89']
    input.spec.dstackController = {database: {type: 'sqlite'}, enabled: true}
    input.spec.preparation!.dstack = {mode: 'import', project: 'test', providers: ['vastai'], vastaiApiKeyEnv: 'TEST_VASTAI_KEY'}
    input.spec.proofTopology = {deployment: {}, generation: 'real', mode: 'active'} as any
    input.spec.infrastructure = {kubeContext: CONTEXT, namespace: 'chain'} as any
    input.spec.capacityManager = {fleets: ['vast-rtx3090'], gpu: 'RTX3090', image: {digest: `sha256:${'c'.repeat(64)}`, repository: 'example.invalid/capacity-manager'}, maxWorkers: 1, minWorkers: 0, project: 'test', provider: 'vastai', regions: ['us-texas']}
    writeJson(path.join(root, '.scrollsdk/intent.json'), input.spec)
    writeJson(path.join(root, '.data/worker.json'), input.worker)
    writeJson(path.join(root, '.data/publication.json'), input.publication)
    writeJson(path.join(root, '.data/proof-worker-image-check-v1.json'), input.imageCheck)
    setController({})
    const state = {...newDstackCredentials(), project: 'test', providers: ['vastai' as const], vastaiApiKey: VAST_KEY}
    fs.mkdirSync(path.join(root, '.data/dstack'), {recursive: true})
    fs.writeFileSync(path.join(root, DSTACK_CREDENTIALS_FILE), JSON.stringify(state), {mode: 0o600})
    fs.mkdirSync(path.join(root, 'values'))
    const save = (service: string, value: any) => fs.writeFileSync(path.join(root, `values/${service}-production.yaml`), yaml.dump(value))
    save('capacity-manager', {dstackAuth: {existingSecret: 'dstack-controller-auth', key: 'admin-token'}, fullnameOverride: 'capacity-manager', manager: {dstack: {serverUrl: 'https://controller.example.invalid'}}, persistence: {size: '4Gi'}})
    save('proof-coordinator', {persistence: {secrets: {name: 'deployment-proof-secrets'}}})
    // As prepared: the controller runs the config.yml of the current credential state.
    save('dstack-controller', {auth: {existingSecret: 'dstack-controller-auth', key: 'admin-token'}, fullnameOverride: 'dstack-controller', podAnnotations: {'checksum/server-config': dstackServerConfigChecksum(state)}})
    save('withdrawal-processor', {networkPolicy: {enabled: true}})
    prepareCapacityManager(root, () => contract)
    env = {TEST_VASTAI_KEY: VAST_KEY}
    checked = []
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('imports capacity.yaml without credentials and renders the current deployment unchanged', async () => {
    const before = values('capacity-manager')
    const {document} = createDocument(root)
    expect(read(CAPACITY_DOCUMENT)).not.to.include(VAST_KEY)
    expect(document).to.deep.include({project: 'test', providers: {vastai: {apiKeyEnv: 'TEST_VASTAI_KEY'}}})
    expect(document.primary).to.include({fleet: 'vast-rtx3090', gpu: 'RTX3090', maxPricePerHourUsd: 0.8, provider: 'vastai'})
    expect(createCapacityDocument(root)).to.equal(undefined)
    const result = await render()
    expect(result).to.deep.include({addedProviders: [], keyRotated: false, providers: ['vastai'], removedProviders: [], serverConfigChanged: false})
    expect(result.fleets).to.deep.equal({created: [], unchanged: ['vast-rtx3090'], undeclared: [], updated: []})
    // The chart hook prepares the same fleet, so the next install changes nothing in dstack.
    // With capacity.yaml it may also update existing fleets in place.
    expect(values('capacity-manager').initialization).to.deep.equal({...before.initialization, fleetAction: 'update'})
    expect(values('capacity-manager').manager.dstack).to.deep.equal(before.manager.dstack)
    // The key did not change, so Vast.ai is not contacted.
    expect(checked).to.deep.equal([])
  })

  it('adds a provider: backend in config.yml, controller restart, fleets through the chart hook', async () => {
    createDocument(root)
    addAwsPrimary()
    // The AWS backend uses the controller's workload role, which its values must carry first; nothing is written.
    const credentials = read(DSTACK_CREDENTIALS_FILE)
    await rejects(render(), 'defaultCredentialsEnabled')
    allowAws([])
    await rejects(render(), 'AWS_EC2_METADATA_DISABLED')
    expect(read(DSTACK_CREDENTIALS_FILE)).to.equal(credentials)
    allowAws()
    const controllerValues = values('dstack-controller')
    const result = await render()
    expect(result).to.deep.include({addedProviders: ['aws'], providers: ['aws', 'vastai'], removedProviders: [], serverConfigChanged: true})
    expect(result.fleets).to.deep.include({created: ['aws-l4'], unchanged: ['vast-rtx3090']})
    // Only the checksum annotation changes in the operator's controller values.
    const {podAnnotations: after, ...rest} = values('dstack-controller')
    const {podAnnotations: before, ...restBefore} = controllerValues
    expect(rest).to.deep.equal(restBefore)
    expect(after['checksum/server-config']).not.to.equal(before['checksum/server-config'])
    expect(serverConfig().projects).to.deep.equal([{backends: [
      {creds: {type: 'default'}, default_vpcs: false, public_ips: false, regions: ['us-east-1'], type: 'aws', vpc_ids: {'us-east-1': 'vpc-0123456789abcdef0'}},
      {creds: {api_key: VAST_KEY, type: 'api_key'}, type: 'vastai'},
    ], name: 'test'}])
    const state = readDstackCredentials(root)!
    expect(values('dstack-controller').podAnnotations['checksum/server-config']).to.equal(dstackServerConfigChecksum(state))
    expect(read('values/dstack-controller-production.yaml')).not.to.include(VAST_KEY)
    const manager = values('capacity-manager')
    expect(manager.initialization).to.include({enabled: true, fallbackProvider: 'vastai', fleetAction: 'update', provider: 'aws'})
    expect(manager.initialization.fleets.map((fleet: any) => fleet.name)).to.deep.equal(['aws-l4', 'vast-rtx3090'])
    expect(manager.manager.dstack).to.include({fallbackFleet: 'vast-rtx3090', maxPricePerHourUsd: 1.5})
    expect(manager.persistence).to.deep.equal({size: '4Gi'})
    expect(toml.parse(manager.manager.policy) as any).to.have.nested.include({'pool.provider': 'aws', 'pool.vram_gib': 22})
    expect(capacitySpec(root).capacityManager!.fallback).to.include({fleet: 'vast-rtx3090', provider: 'vastai'})
    // Rendering again is a no-op for the controller.
    expect(await render()).to.include({serverConfigChanged: false})
    // Preparation keeps the intent's action for the first activation.
    prepareCapacityManager(root, () => contract)
    expect(values('capacity-manager').initialization.fleetAction).to.equal('create')
  })

  it('refuses a directory that is not a prepared deployment, such as running from inside it', () => {
    const output = {addWarning() {}, logSuccess() {}, success() {}} as any
    expect(() => startCapacityDocument(path.join(root, 'deployment'), output)).to.throw('is not a prepared deployment directory')
  })

  it('names capacity.yaml fields in validation errors', async () => {
    createDocument(root)
    editDocument(document => {document.scaling.minWorkers = 2; document.scaling.maxWorkers = 1})
    await rejects(render(), 'scaling.minWorkers must not exceed maxWorkers')
    editDocument(document => {document.scaling.minWorkers = 0; document.scaling.maxWorkers = 1; document.primary.gpu = 'RTX3080'})
    expect(await rejects(render(), 'Unsupported primary.gpu; use one of')).to.include('RTX3090')
    expect(inCapacityDocumentTerms('capacityManager.fleet.idleDurationSeconds must be a valid integer')).to.equal('resources.idleSeconds must be a valid integer')
    expect(inCapacityDocumentTerms('capacityManager.fallback.maxPricePerHourUsd must be positive')).to.equal('fallback.maxPricePerHourUsd must be positive')
    expect(inCapacityDocumentTerms('capacityManager hourly budget cannot fund')).to.equal('capacity.yaml hourly budget cannot fund')
    expect(inCapacityDocumentTerms('capacityManager.image must select')).to.equal('capacityManager.image must select')
  })

  it('removes the fleet file of a fleet that is no longer declared', async () => {
    createDocument(root)
    await render()
    const old = values('capacity-manager').initialization.fleets[0].name
    editDocument(document => {document.primary.fleet = 'renamed-fleet'})
    await render()
    const files = fs.readdirSync(path.join(root, '.scrollsdk/capacity-manager/fleets'))
    expect(files).to.include('renamed-fleet.yaml').and.not.include(`${old}.yaml`)
  })

  it('treats capacity.yaml as the whole source: an omitted field returns to its default', async () => {
    const {document} = createDocument(root)
    const policy = () => toml.parse(values('capacity-manager').manager.policy) as any
    const memory = () => values('capacity-manager').initialization.fleets[0].resources.memory
    const defaults = {drain: policy().global.target_drain_seconds, memory: memory()}
    editDocument(changed => {
      changed.scaling.targetDrainSeconds = document.scaling!.targetDrainSeconds! + 60
      changed.resources.memoryGiB = document.resources!.memoryGiB! * 2
    })
    await render()
    expect(policy().global.target_drain_seconds).to.equal(defaults.drain + 60)
    expect(memory()).not.to.equal(defaults.memory)
    editDocument(changed => {
      delete changed.scaling.targetDrainSeconds
      delete changed.resources.memoryGiB
    })
    await render()
    expect(policy().global.target_drain_seconds).to.equal(defaults.drain)
    expect(memory()).to.equal(defaults.memory)
    expect(JSON.parse(read('.scrollsdk/capacity-manager/plan.json')).fleets.action).to.equal('update')
  })

  it('checks the dstack Secret files before preparing, so a refused write leaves the manager values unchanged', async () => {
    createDocument(root)
    env.TEST_VASTAI_KEY = ROTATED_KEY
    const manager = read('values/capacity-manager-production.yaml')
    const credentials = read(DSTACK_CREDENTIALS_FILE)
    const secret = path.join(root, 'secrets/dstack-controller-config.yaml')
    fs.mkdirSync(path.dirname(secret), {recursive: true})
    fs.rmSync(secret, {force: true})
    fs.symlinkSync(path.join(root, 'elsewhere.yaml'), secret)
    await rejects(render(), 'symbolic links')
    expect(read('values/capacity-manager-production.yaml')).to.equal(manager)
    expect(read(DSTACK_CREDENTIALS_FILE)).to.equal(credentials)
    expect(fs.existsSync(path.join(root, 'elsewhere.yaml'))).to.equal(false)
  })

  it('accepts an AWS fallback for a Vast primary', async () => {
    createDocument(root)
    allowAws()
    editDocument(document => {
      document.providers.aws = {vpcIds: {'us-east-1': 'vpc-0123456789abcdef0'}}
      document.fallback = {fleet: 'aws-l4', gpu: 'L4', instanceTypes: ['g6.4xlarge'], maxPricePerHourUsd: 1.5, provider: 'aws', regions: ['us-east-1']}
      document.scaling.maxHourlyCostUsd = 3
    })
    const result = await render()
    expect(result).to.deep.include({addedProviders: ['aws'], providers: ['aws', 'vastai']})
    expect(result.fleets.created).to.deep.equal(['aws-l4'])
    const manager = values('capacity-manager')
    expect(manager.initialization).to.include({fallbackProvider: 'aws', provider: 'vastai'})
    expect(manager.manager.dstack.fallbackFleet).to.equal('aws-l4')
  })

  it('requires the capacity-manager chart that updates fleets in place', async () => {
    createDocument(root)
    const manager = read('values/capacity-manager-production.yaml')
    fs.writeFileSync(path.join(root, 'Makefile'), 'CAPACITY_MANAGER_CHART_VERSION ?= 0.1.8\n')
    await rejects(render(), 'require capacity-manager chart >= 0.1.9')
    expect(read('values/capacity-manager-production.yaml')).to.equal(manager)
  })

  it('reports a removed provider, whose backend the controller restart deletes', async () => {
    createDocument(root)
    addAwsPrimary()
    allowAws()
    await render()
    editDocument(document => {delete document.fallback; delete document.providers.vastai})
    const result = await render()
    expect(result).to.deep.include({providers: ['aws'], removedProviders: ['vastai'], serverConfigChanged: true})
    expect(readDstackCredentials(root)).not.to.have.property('vastaiApiKey')
    expect(serverConfig().projects[0].backends.map((backend: any) => backend.type)).to.deep.equal(['aws'])
    expect(values('capacity-manager').initialization).to.include({provider: 'aws'}).and.not.have.property('fallbackProvider')
  })

  it('rotates a provider key from the environment file without writing it to public files', async () => {
    createDocument(root)
    env.TEST_VASTAI_KEY = ROTATED_KEY
    const result = await render()
    expect(checked).to.deep.equal([ROTATED_KEY])
    expect(result).to.include({keyRotated: true, serverConfigChanged: true})
    expect(readDstackCredentials(root)).to.include({vastaiApiKey: ROTATED_KEY})
    expect(serverConfig().projects[0].backends[0].creds.api_key).to.equal(ROTATED_KEY)
    for (const file of [CAPACITY_DOCUMENT, 'values/dstack-controller-production.yaml', 'values/capacity-manager-production.yaml']) expect(read(file)).not.to.include(ROTATED_KEY).and.not.include(VAST_KEY)
  })

  it('validates before writing and never echoes credentials', async () => {
    createDocument(root)
    const credentials = read(DSTACK_CREDENTIALS_FILE)
    const missing = await rejects(renderCapacity(root, {env: {}, prepare() {throw new Error('must not prepare')}}), 'Set TEST_VASTAI_KEY')
    expect(missing).not.to.include(VAST_KEY)
    editDocument(document => {document.project = 'other'})
    await rejects(render(), "controller's dstack project test")
    editDocument(document => {
      document.project = 'test'
      document.fallback = {fleet: 'aws-l4', gpu: 'L4', maxPricePerHourUsd: 1.5, provider: 'aws', regions: ['us-east-1']}
    })
    expect(() => readCapacityDocument(root)).to.throw('provider aws is not configured under providers')
    expect(read(DSTACK_CREDENTIALS_FILE)).to.equal(credentials)
  })

  it('refuses a key Vast.ai rejects, before writing anything', async () => {
    createDocument(root)
    const files = [DSTACK_CREDENTIALS_FILE, 'secrets/dstack-controller-config.yaml', 'values/capacity-manager-production.yaml', 'values/dstack-controller-production.yaml']
    await render()
    const before = files.map(file => fs.existsSync(path.join(root, file)) ? read(file) : undefined)
    env.TEST_VASTAI_KEY = ROTATED_KEY
    await rejects(render({async checkVastKey() {throw new Error('Vast.ai rejected the API key')}}), 'rejected the API key')
    expect(files.map(file => fs.existsSync(path.join(root, file)) ? read(file) : undefined)).to.deep.equal(before)
    // Offline rendering skips the check explicitly.
    expect(await render({async checkVastKey() {throw new Error('must not check')}, skipProviderCheck: true})).to.include({serverConfigChanged: true})
  })

  it('checks a Vast.ai key with the request dstack uses, never echoing the key or the body', async () => {
    const requests: Array<{init?: RequestInit; url: string}> = []
    const answer = (status: number) => (async (url: Request | URL | string, init?: RequestInit) => {
      requests.push({init, url: String(url)})
      return new Response(`{"echo": "${VAST_KEY}"}`, {status})
    }) as typeof fetch
    await checkVastApiKey(VAST_KEY, answer(200))
    expect(requests[0].url).to.equal('https://console.vast.ai/api/v1/instances/')
    expect(requests[0].init?.headers).to.deep.equal({Authorization: `Bearer ${VAST_KEY}`})
    for (const [status, message] of [[401, 'rejected the API key'], [404, 'rejected the API key (HTTP 404)'], [429, 'HTTP 429; retry'], [500, 'HTTP 500; retry']] as const) {
      const text = await rejects(checkVastApiKey(VAST_KEY, answer(status)), message)
      expect(text).not.to.include(VAST_KEY)
    }

    const offline = (async () => {throw new Error(`connect ECONNREFUSED ${VAST_KEY}`)}) as typeof fetch
    expect(await rejects(checkVastApiKey(VAST_KEY, offline), '--skip-provider-check')).not.to.include(VAST_KEY)
  })

  it('starts capacity.yaml after capacity-manager preparation, only where the controller credentials are managed', () => {
    expect(createCapacityDocumentAfterPreparation(root)).to.deep.equal([])
    expect(readCapacityDocument(root)).to.include({project: 'test'})
    fs.rmSync(path.join(root, CAPACITY_DOCUMENT))
    fs.rmSync(path.join(root, DSTACK_CREDENTIALS_FILE))
    expect(createCapacityDocumentAfterPreparation(root)).to.deep.equal([])
    expect(readCapacityDocument(root)).to.equal(undefined)
  })

  describe('deploy', () => {
    let calls: string[]
    let installed: any
    let installedController: any
    let liveConfig: string | undefined
    let failMake: string | undefined
    let shown: string[] = []
    let controllerLog = ''
    const deps = (confirmAnswer = true): CapacityDeployDeps => ({
      async confirm() {calls.push('confirm'); return confirmAnswer},
      async helmValues(release, context, namespace) {
        expect([context, namespace]).to.deep.equal([CONTEXT, 'chain'])
        return release === 'capacity-manager' ? installed : installedController
      },
      async kubectl(args) {
        const verb = args.findIndex(arg => arg === 'get' || arg === 'rollout' || arg === 'logs')
        const end = args.findIndex((arg, index) => index > verb && arg.startsWith('-'))
        calls.push(`kubectl ${args.slice(verb, end === -1 ? undefined : end).join(' ')}`)
        if (args.includes('get')) return liveConfig === undefined ? '' : JSON.stringify({data: {'config.yml': Buffer.from(liveConfig).toString('base64')}})
        if (args.includes('logs')) return controllerLog
        return ''
      },
      async make(target, variables, cwd) {
        expect([variables, cwd]).to.deep.equal([{KUBE_CONTEXT: CONTEXT, NAMESPACE: 'chain'}, root])
        calls.push(`make ${target}`)
        if (target === failMake) throw new Error(`make ${target} exited with 2`)
      },
      async publish(options) {
        expect(process.cwd()).to.equal(fs.realpathSync(root))
        calls.push(`publish ${options.namespace}`)
        return {checksumMissing: false, context: options.context, dryRun: false, namespace: options.namespace, secrets: []}
      },
      show(lines) {shown = lines},
    })
    const deploy = (options: Partial<Parameters<typeof deployCapacity>[1]> = {}, confirmAnswer = true) => deployCapacity(root, {
      async checkVastKey(key) {checked.push(key)}, env, interactive: false, prepare: (directory, preparation) => prepareCapacityManager(directory, () => contract, undefined, preparation), ...options,
    }, deps(confirmAnswer))
    /** As deployed: the running controller uses the current config.yml and the manager its current values. */
    const settle = async () => {
      await render()
      liveConfig = (yaml.load(read('secrets/dstack-controller-config.yaml')) as any).stringData['config.yml']
      installed = values('capacity-manager')
      installedController = values('dstack-controller')
      calls = []
    }

    beforeEach(async () => {
      createDocument(root)
      failMake = undefined
      controllerLog = ''
      await settle()
    })

    it('changes nothing when the running deployment already matches', async () => {
      const result = await deploy()
      expect(result).to.deep.include({applied: false, context: CONTEXT, namespace: 'chain'})
      expect(result.summary).to.deep.include({controllerRestart: false, keyRotated: false, managerChanges: []})
      expect(calls).to.deep.equal(['kubectl get secret dstack-controller-config'])
    })

    it('summarizes against the running deployment, asks, then deploys in order', async () => {
      env.TEST_VASTAI_KEY = ROTATED_KEY
      editDocument(document => {document.primary.maxPricePerHourUsd = 0.9})
      // An earlier render that was never deployed does not hide the changes.
      await render()
      await rejects(deploy(), 'rerun with --yes')
      // The summary is shown before the refusal, so "the changes above" exist.
      expect(shown.join('\n')).to.include('~ vast-rtx3090  updated in place').and.include('~ vastai  API key rotated')
      // Values are shown for what the operator checks: old and new price.
      expect(shown.join('\n')).to.match(/max_price \S+ -> 0\.9/)
      expect(calls.filter(call => !call.startsWith('kubectl get'))).to.deep.equal([])
      await rejects(deploy({interactive: true}, false), 'Deployment cancelled')
      calls = []
      const result = await deploy({yes: true})
      expect(result.summary).to.deep.include({controllerRestart: true, keyRotated: true})
      expect(result.summary.managerChanges.map(change => change.path)).to.include('policy.pool.hourly_cost_usd_per_worker')
      expect(result.summary.fleets.updated[0]).to.deep.include({name: 'vast-rtx3090'})
      expect(result.summary.fleets.updated[0].fields).to.include('max_price')
      expect(calls).to.deep.equal([
        'kubectl get secret dstack-controller-config',
        'publish chain',
        'make install-dstack-controller',
        'kubectl rollout status deployment/dstack-controller',
        'kubectl logs deployment/dstack-controller',
        'make install-capacity-manager',
      ])
      expect(result.applied).to.equal(true)
      // Key suffixes tell the operator which key to revoke, without printing either key.
      expect(shown.join('\n')).to.include('API key rotated (...6789 -> ...3210)')
      expect(result.notes.join(' ')).to.include('now uses the Vast.ai key ending in ...3210').and.include('key ending in ...6789 is no longer configured')
      expect(JSON.stringify(result)).not.to.include(ROTATED_KEY).and.not.include(VAST_KEY)
    })

    it('stops before the manager when dstack logged a backend it could not update, keeping the old key', async () => {
      env.TEST_VASTAI_KEY = ROTATED_KEY
      controllerLog = '{"level": "WARNING", "message": "Failed to update backend vastai in project test: Invalid credentials"}\n'
      const error = await deploy({yes: true}).catch(error_ => error_)
      expect(error).to.be.instanceOf(CapacityDeployError)
      expect(error.message).to.include('backend vastai').and.include('Do not revoke any Vast.ai key yet').and.include('not the one ending in ...3210')
      expect(calls).not.to.include('make install-capacity-manager')
      expect(error.message).not.to.include(ROTATED_KEY)
    })

    it('reports added backends and new fleets, and names the next step when a backend is missing', async () => {
      addAwsPrimary()
      allowAws()
      failMake = 'install-capacity-manager'
      const error = await deployCapacity(root, {env, interactive: false, prepare: (directory, preparation) => prepareCapacityManager(directory, () => contract, undefined, preparation), yes: true}, deps()).catch(error_ => error_)
      expect(error).to.be.instanceOf(CapacityDeployError)
      expect(error.message).to.include('Failed to create backend').and.include('--restart-controller')
      expect(calls).to.include('make install-dstack-controller')
    })

    it('restarts the controller on request even when config.yml did not change', async () => {
      const result = await deploy({restartController: true, yes: true})
      expect(result.summary.controllerRestart).to.equal(true)
      expect(calls).to.include('kubectl rollout restart deployment/dstack-controller')
      expect(calls.indexOf('kubectl rollout restart deployment/dstack-controller')).to.be.lessThan(calls.indexOf('kubectl rollout status deployment/dstack-controller'))
    })

    it('counts a controller values change as a restart, such as the first checksum annotation', async () => {
      const {podAnnotations, ...older} = installedController
      expect(podAnnotations).to.have.property('checksum/server-config')
      installedController = older
      const result = await deploy({yes: true})
      expect(result.summary.controllerChanges.map(change => change.path)).to.deep.equal(['podAnnotations'])
      expect(result.summary.controllerRestart).to.equal(true)
      expect(calls).not.to.include('kubectl rollout restart deployment/dstack-controller')
    })

    it('leaves the deployment files as they were when it stops before the cluster', async () => {
      editDocument(document => {document.primary.maxPricePerHourUsd = 0.9})
      const files = ['values/capacity-manager-production.yaml', 'values/dstack-controller-production.yaml', '.scrollsdk/capacity-manager/plan.json', 'secrets/dstack-controller-config.yaml']
      const before = files.map(file => read(file))
      await rejects(deploy(), 'Nothing changed in the cluster or in the deployment files')
      expect(files.map(file => read(file))).to.deep.equal(before)
      await rejects(deploy({interactive: true}, false), 'Deployment cancelled')
      expect(files.map(file => read(file))).to.deep.equal(before)
      expect(fs.statSync(path.join(root, 'secrets/dstack-controller-config.yaml')).mode % 0o1000).to.equal(0o600)
      expect(calls.filter(call => !call.startsWith('kubectl get'))).to.deep.equal(['confirm'])
    })

    it('refuses a fleet change dstack cannot make in place before asking', async () => {
      editDocument(document => {document.resources.idleSeconds = 1200})
      const before = read('values/capacity-manager-production.yaml')
      const message = await rejects(deploy({yes: true}), 'cannot update idle_duration of fleet vast-rtx3090 in place')
      expect(message).to.include('new name')
      expect(shown.join('\n')).to.include('! vast-rtx3090  cannot be updated in place (idle_duration)')
      expect(read('values/capacity-manager-production.yaml')).to.equal(before)
      expect(calls.filter(call => !call.startsWith('kubectl get'))).to.deep.equal([])
    })

    it('keeps a capacity-manager image the operator upgraded', async () => {
      const upgraded = {digest: `sha256:${'d'.repeat(64)}`, repository: 'example.invalid/capacity-manager'}
      fs.writeFileSync(path.join(root, 'values/capacity-manager-production.yaml'), yaml.dump({...values('capacity-manager'), image: upgraded}))
      installed = values('capacity-manager')
      editDocument(document => {document.primary.maxPricePerHourUsd = 0.9})
      const result = await deploy({yes: true})
      expect(values('capacity-manager').image).to.deep.equal(upgraded)
      expect(result.summary.managerChanges.map(change => change.path).filter(name => name.startsWith('image'))).to.deep.equal([])
    })

    it('rewrites operator values files only when their content changes', async () => {
      const file = 'values/withdrawal-processor-production.yaml'
      fs.writeFileSync(path.join(root, file), `# operator note\n${read(file)}`)
      await render()
      expect(read(file)).to.match(/^# operator note/)
    })

    it('lists fleets that are no longer declared', async () => {
      installed = {...installed, initialization: {...installed.initialization, fleets: [...installed.initialization.fleets, {name: 'retired-fleet'}]}}
      const result = await deploy({yes: true})
      expect(result.summary.fleets.undeclared).to.deep.equal(['retired-fleet'])
      expect(result.notes.join(' ')).to.include('retired-fleet')
    })
  })
})
