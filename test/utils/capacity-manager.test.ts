/* eslint-disable @typescript-eslint/no-explicit-any -- Public deployment fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {assertSdkWorkersRetired, buildCapacityManagerValues, capacityManagerDstackUrl, capacityManagerFleets, prepareCapacityManager, resolveCapacityManager} from '../../src/utils/capacity-manager.js'
import {generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {writeJson} from '../../src/utils/preparation-io.js'
import {preparationSteps} from '../../src/utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'
import {operateWorkerCapacity} from '../../src/utils/proof-workers-lifecycle.js'
import {capacityPlan} from '../../src/utils/proof-workers-plan.js'
import {planSpecBootstrap} from '../../src/utils/spec-bootstrap.js'
import {createSdkFixture} from '../helpers/sdk-templates.js'
import {internalTls} from './dstack-internal-tls.test.js'
import {fixturePlan} from './proof-workers.test.js'

function fixture() {
  const {input} = fixturePlan()
  delete input.spec.proofWorkers
  input.spec.dstackController = {enabled: true}
  input.spec.preparation!.dstack = {mode: 'external'}
  input.spec.proofTopology = {deployment: {}, generation: 'real', mode: 'active'} as any
  input.spec.capacityManager = {fleets: ['aws-l4'], gpu: 'L4', image: {digest: `sha256:${'c'.repeat(64)}`, repository: 'example.invalid/capacity-manager'}, project: 'isolated-aws', provider: 'aws', regions: ['us-east-1']}
  input.imageCheck.cudaArchitectures = ['89']
  return input
}

describe('Core capacity manager', () => {
  it('requires Core-compatible controller transport without disclosing rejected URLs', () => {
    for (const url of ['https://controller.example.invalid', 'https://controller.example.invalid:8443/api/', 'http://127.0.0.1:3000', 'http://127.1.2.3:3000', 'http://[::1]:3000']) expect(capacityManagerDstackUrl(url)).to.equal(url)
    for (const url of [undefined, '', 'http://dstack-controller.chain.svc:3000', 'http://localhost:3000', 'http://192.0.2.1:3000', 'ftp://controller.example.invalid', 'https://user:FAKE_PASSWORD@controller.example.invalid', 'https://controller.example.invalid/?token=FAKE_TOKEN', 'https://controller.example.invalid/#fragment', 'https://<TODO>', 'https://controller.example.invalid?']) {
      expect(() => capacityManagerDstackUrl(url)).to.throw('verified HTTPS controller endpoint')
      try {capacityManagerDstackUrl(url)} catch (error) {expect((error as Error).message).not.to.include('FAKE_')}
    }
  })

  it('binds imported controller project/backend to capacity intent without extra operator commands', async () => {
    const {spec} = fixture()
    spec.preparation!.bridge = {image: 'example.invalid/bridge:offline', mode: 'production'}
    spec.preparation!.dstack = {aws: {vpcIds: {'us-east-1': 'vpc-00000000000000000'}}, mode: 'import', providers: ['aws']}
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-import-'))
    const calls: string[][] = []
    try {
      await new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)}).run({effect: 'local', id: 'dstack', retry: 'safe', title: 'Import'}, spec, root, {} as any)
      expect(calls).to.have.length(1)
      expect(calls[0]).to.include.members(['dstack-config', '--provider', 'aws', '--project', 'isolated-aws', '--aws-backend-config'])
      expect(JSON.parse(fs.readFileSync(path.join(root, '.data/dstack/aws-backend.json'), 'utf8'))).to.deep.equal(spec.preparation!.dstack!.aws)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('generates empty bounded fleets and validates imported project/backend bindings', () => {
    const {spec} = fixture()
    const fleets = capacityManagerFleets(spec)
    expect(fleets.action).to.equal('create')
    expect(fleets.configurations[0]).to.include({idle_duration: '600s', max_price: 1.5, name: 'aws-l4'})
    expect(fleets.configurations[0].nodes).to.deep.equal({max: 2, min: 0, target: 0})
    expect(fleets.configurations[0].resources).to.deep.equal({cpu: '16..', disk: {size: '200GB..'}, gpu: {count: 1, name: ['L4'], vendor: 'nvidia'}, memory: '64GB..'})
    spec.capacityManager!.fleet = {action: 'reuse', idleDurationSeconds: 1200}
    expect(capacityManagerFleets(spec)).to.include({action: 'reuse'})
    spec.preparation = {dstack: {mode: 'import', project: 'wrong-project', providers: ['aws']}} as any
    expect(() => resolveCapacityManager(spec)).to.throw('must match capacityManager.project')
    delete spec.preparation!.dstack!.project
    expect(() => resolveCapacityManager(spec)).to.throw('VPC IDs')
    spec.preparation!.dstack!.aws = {vpcIds: {'us-east-1': 'vpc-00000000000000000'}}
    expect(() => resolveCapacityManager(spec)).to.throw('IRSA')
    spec.dstackController = {defaultCredentialsEnabled: true, enabled: true, serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'arn:aws:iam::000000000000:role/example-dstack'}}}
    expect(() => resolveCapacityManager(spec)).not.to.throw()
    spec.capacityManager!.regions = ['us-west-2']
    expect(() => resolveCapacityManager(spec)).to.throw('explicit dstack VPC ID')
    spec.preparation!.dstack!.providers = ['vastai']
    expect(() => resolveCapacityManager(spec)).to.throw('must include')
  })

  it('rejects missing SDK templates and excludes deployment-specific DevNet profiles', () => {
    const {spec} = fixture()
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sdk-'))
    try {
      createSdkFixture(sdk)
      spec.infrastructure = {bootnodeCount: 0, provider: 'local', sequencerCount: 0}
      spec.identities = {} as any
      spec.images = {services: {l2Rpc: {tag: 'nonfunctional-test'}}}
      delete spec.templates
      expect(() => planSpecBootstrap(spec, sdk)).to.throw('lacks capacity-manager templates')
      fs.appendFileSync(path.join(sdk, 'examples/Makefile.example'), '\nCAPACITY_MANAGER_CHART ?= oci://example.invalid/helm/capacity-manager\nCAPACITY_MANAGER_CHART_VERSION ?= 0.1.1\n.PHONY: install-capacity-manager\ninstall-capacity-manager:\n\t@true\n')
      fs.writeFileSync(path.join(sdk, 'examples/values/capacity-manager-production.yaml'), 'prepared: false\n')
      fs.writeFileSync(path.join(sdk, 'examples/values/capacity-manager-devnet-aws-l40s.yaml'), 'devnetOnly: true\n')
      execFileSync('git', ['-C', sdk, 'add', 'examples'])
      execFileSync('git', ['-C', sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add nonfunctional capacity templates'], {stdio: 'pipe'})
      const files = planSpecBootstrap(spec, sdk)
      expect(files.Makefile).to.include('CAPACITY_MANAGER_CHART ?= oci://example.invalid/helm/capacity-manager\n')
      expect(files.Makefile).to.include('CAPACITY_MANAGER_CHART_VERSION ?= 0.1.1\n')
      expect(files.Makefile).to.include('.PHONY: install-capacity-manager\n')
      expect(files['values/capacity-manager-production.yaml']).to.equal('prepared: false\n')
      expect(files).not.to.have.property('values/capacity-manager-devnet-aws-l40s.yaml')
      delete spec.capacityManager
      expect(planSpecBootstrap(spec, sdk)).not.to.have.property('values/capacity-manager-production.yaml')
    } finally {fs.rmSync(sdk, {force: true, recursive: true})}
  })


  it('places capacity preparation after final rendering and before checks, without a cloud action', () => {
    const {spec} = fixture()
    spec.preparation = {bridge: {image: `example.invalid/bridge@sha256:${'a'.repeat(64)}`, mode: 'helper'}, proofMaterials: {mode: 'existing'}}
    const steps = preparationSteps(spec, true)
    const index = steps.findIndex(step => step.id === 'capacity-manager')
    expect(steps[index]).to.include({effect: 'local', stage: 'render'})
    expect(index).to.be.greaterThan(steps.findIndex(step => step.id === 'render-final'))
    expect(index).to.be.lessThan(steps.findIndex(step => step.id === 'proof-check'))
  })

  it('supports the SDK L40S profile and checks its CUDA architecture', () => {
    const input = fixture()
    input.spec.capacityManager!.gpu = 'L40S'
    const values = buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)
    expect((toml.parse(values.manager.policy) as any).pool).to.include({gpu_class: 'L40S', vram_gib: 44})
    input.imageCheck.cudaArchitectures = ['86']
    expect(() => buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)).to.throw('GPU/image')
  })


  for (const managedTls of [false, true]) it(`prepares reproducible values and a WP-only peer without allocating (managed TLS: ${managedTls})`, () => {
    const input = fixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-prepare-'))
    input.spec.infrastructure = {kubeContext: 'saved-cluster-context', namespace: 'chain'} as any
    if (managedTls) {
      input.spec.infrastructure.aws = {region: 'us-east-1'} as any
      input.spec.dstackController = {internalTls}
    }

    input.spec.proofTopology!.deployment.workerSecretName = 'dedicated-worker-secret'
    try {
      writeJson(path.join(root, '.scrollsdk/intent.json'), input.spec)
      writeJson(path.join(root, '.data/worker.json'), input.worker)
      writeJson(path.join(root, '.data/publication.json'), input.publication)
      writeJson(path.join(root, '.data/proof-worker-image-check-v1.json'), input.imageCheck)
      fs.mkdirSync(path.join(root, 'values'))
      const save = (service: string, value: any) => fs.writeFileSync(path.join(root, `values/${service}-production.yaml`), yaml.dump(value))
      save('capacity-manager', {dstackAuth: {existingSecret: 'capacity-manager-dstack-auth'}, fullnameOverride: 'capacity-manager', manager: {dstack: {serverUrl: 'https://controller.example.invalid'}, scaleDownOnShutdown: false}, persistence: {size: '4Gi'}})
      save('proof-coordinator', {persistence: {secrets: {name: 'deployment-proof-secrets'}}})
      save('dstack-controller', {auth: {existingSecret: 'controller-auth', key: 'admin-token'}, fullnameOverride: 'dstack-controller', service: {port: 3000}})
      if (managedTls) save('dstack-controller', yaml.load(generateDstackControllerValues({auth: {existingSecret: 'controller-auth', key: 'admin-token'}, internalTls})!))
      save('withdrawal-processor', {networkPolicy: {allowFrom: {proofCoordinator: [{podSelector: {matchLabels: {app: 'coordinator'}}}]}, enabled: true}})
      const contract: any = {components: {proofCoordinator: {valuesFile: 'values/proof-coordinator-production.yaml'}, withdrawalProcessor: {valuesFile: 'values/withdrawal-processor-production.yaml'}}, generation: 'real', generationId: 'test-generation', inputs: {publication: {path: '.data/publication.json'}}, mode: 'active', worker: {contractFile: '.data/worker.json'}}
      const managerPath = path.join(root, 'values/capacity-manager-production.yaml')
      const original = fs.readFileSync(managerPath, 'utf8')
      const wpPath = path.join(root, 'values/withdrawal-processor-production.yaml')
      const originalWp = fs.readFileSync(wpPath, 'utf8')
      const invalid = original.replace('https://controller.example.invalid', 'http://dstack-controller.chain.svc:3000')
      if (!managedTls) {
        fs.writeFileSync(managerPath, invalid)
      expect(() => prepareCapacityManager(root, () => contract)).to.throw('verified HTTPS controller endpoint')
      expect(fs.readFileSync(managerPath, 'utf8')).to.equal(invalid)
      expect(fs.readFileSync(wpPath, 'utf8')).to.equal(originalWp)
      expect(fs.existsSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'))).to.equal(false)
      fs.writeFileSync(managerPath, original)
      }

      const result = prepareCapacityManager(root, () => contract)
      const first = fs.readFileSync(result.valuesFile, 'utf8')
      const fleet = yaml.load(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/fleets/aws-l4.yaml'), 'utf8')) as any
      expect(fleet.nodes).to.deep.equal({max: 2, min: 0, target: 0})
      const values = yaml.load(first) as any
      expect(result.namespace).to.equal('chain')
      expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), 'utf8')).kubeContext).to.equal('saved-cluster-context')
      expect(values.persistence.size).to.equal('4Gi')
      expect(values.dstackAuth).to.deep.equal({existingSecret: 'controller-auth', key: 'admin-token'})
      expect(values.wpAuth.existingSecret).to.equal('deployment-proof-secrets')
      expect(JSON.parse(fs.readFileSync(path.join(root, '.scrollsdk/capacity-manager/plan.json'), 'utf8')).workerSecret).to.equal('dedicated-worker-secret')
      expect(values.manager.dstack.serverUrl).to.equal(managedTls ? `https://${internalTls.hostname}` : 'https://controller.example.invalid')
      const wp = yaml.load(fs.readFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'utf8')) as any
      expect(wp.networkPolicy.allowFrom.proofCoordinator).to.have.length(1)
      expect(wp.networkPolicy.allowFrom.capacityManager[0].podSelector.matchLabels).to.deep.equal({'app.kubernetes.io/name': 'capacity-manager'})
      prepareCapacityManager(root, () => contract)
      expect(fs.readFileSync(result.valuesFile, 'utf8')).to.equal(first)
      input.spec.capacityManager!.workerIdPrefix = 'replacement'
      writeJson(path.join(root, '.scrollsdk/intent.json'), input.spec)
      expect(() => prepareCapacityManager(root, () => contract)).to.throw('drain the old manager')
      expect(fs.readFileSync(result.valuesFile, 'utf8')).to.equal(first)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('generates a bounded AWS policy and preserves the compiler worker contract', () => {
    const input = fixture()
    const values = buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)
    const policy = toml.parse(values.manager.policy) as any
    expect(policy.global).to.include({liveness_floor: 1, max_workers: 2, target_drain_seconds: 600})
    expect(policy.pool).to.include({gpu_class: 'L4', hourly_cost_usd_per_worker: 1.5, max_hourly_cost_usd: 3, provider: 'aws'})
    expect(Object.keys(policy.families)).to.have.members(['scroll_chunk', 'scroll_batch', 'l2_range_aggregation', 'bridge_state'])
    expect(values.manager.workerCommand).to.include("'--worker-id' '{worker_id}'")
    expect(values.manager.workerCommand).to.include('--enable-prove-scroll-chunk')
    expect(values.manager.workerCommand).to.include('sha256sum --check --status')
    expect(values.manager.workerImage).to.equal(`${input.worker.image.repository}@${input.worker.image.digest}`)
    expect(values.manager.workerTokenSecret).to.match(/^cm_worker_[\da-f]{16}$/)
    expect(values.prepared).to.equal(true)
    expect(input.worker.argv[1]).to.equal('original')
  })

  it('supports manual Vast placement and rejects incompatible images, mutable manager tags and invalid budgets', () => {
    const input = fixture()
    Object.assign(input.spec.capacityManager!, {gpu: 'RTX4090', provider: 'vastai'})
    expect(resolveCapacityManager(input.spec).maxPricePerHourUsd).to.equal(0.8)
    expect(buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck).manager.dstack.project).to.equal('isolated-aws')
    input.imageCheck.cudaArchitectures = ['86']
    expect(() => buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)).to.throw('GPU/image')
    for (const change of [{maxWorkers: 0}, {minWorkers: 3}, {maxHourlyCostUsd: 0.1}, {regions: []}, {gpu: 'toString'}, {workerIdPrefix: '../escape'}, {image: {digest: 'latest', repository: 'example.invalid/manager'}}]) {
      const changed = structuredClone(input.spec)
      Object.assign(changed.capacityManager!, change)
      expect(() => resolveCapacityManager(changed)).to.throw()
    }

    input.spec.proofTopology!.deployment.proofWorkPublicUrl = 'https://user:NONFUNCTIONAL_PASSWORD@example.invalid'
    expect(() => resolveCapacityManager(input.spec)).to.throw('credential-free')
  })

  it('rejects unverified publication and incomplete program bundles', () => {
    const input = fixture()
    input.publication.verification.anonymousHttpReadback = 'failed' as any
    expect(() => buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)).to.throw('Publish and verify')
    input.publication.verification.anonymousHttpReadback = 'passed'
    delete input.publication.files['protocol_context.json']
    expect(() => buildCapacityManagerValues(input.spec, input.worker, input.publication, input.imageCheck)).to.throw('resource missing')
  })

  it('prevents both worker controllers from claiming the deployment', () => {
    const input = fixture()
    input.spec.proofWorkers = {}
    expect(() => resolveCapacityManager(input.spec)).to.throw('mutually exclusive')
    expect(() => capacityPlan(input)).to.throw('capacityManager owns')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-owner-'))
    try {
      writeJson(path.join(root, '.scrollsdk/proof-workers/plan.json'), {})
      expect(() => assertSdkWorkersRetired(root)).to.throw('Retire')
      writeJson(path.join(root, '.scrollsdk/proof-workers/state.json'), {status: 'submitted'})
      expect(() => assertSdkWorkersRetired(root)).to.throw('Retire')
      writeJson(path.join(root, '.scrollsdk/proof-workers/state.json'), {status: 'destroyed'})
      expect(() => assertSdkWorkersRetired(root)).not.to.throw()
      const {plan} = fixturePlan()
      writeJson(path.join(root, '.scrollsdk/proof-workers/plan.json'), plan)
      // checksum is needed for the existing lifecycle before its ownership check.
      fs.writeFileSync(path.join(root, '.scrollsdk/proof-workers/plan.sha256'), createHash('sha256').update(fs.readFileSync(path.join(root, '.scrollsdk/proof-workers/plan.json'))).digest('hex'))
      fs.rmSync(path.join(root, '.scrollsdk/proof-workers/state.json'))
      writeJson(path.join(root, '.scrollsdk/capacity-manager/plan.json'), {})
      expect(() => operateWorkerCapacity(root, 'apply', () => {throw new Error('Unexpected cluster write')})).to.throw('capacity-manager owns')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
