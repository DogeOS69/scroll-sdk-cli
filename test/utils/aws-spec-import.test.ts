/* eslint-disable @typescript-eslint/no-explicit-any -- Operator YAML and CloudFormation fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import ImportAws from '../../src/commands/setup/import-aws.js'
import {importAwsSpec, parseAwsOutputs} from '../../src/utils/aws-spec-import.js'

const account = '000000000000'
const region = 'us-east-2'
const arn = (resource: string): string => `arn:aws:${resource.startsWith('role/') ? 'iam:' : resource.startsWith('key/') ? `kms:${region}` : `elasticloadbalancing:${region}`}:${account}:${resource}`
const outputs = (values: Record<string, string>): any[] => Object.entries(values).map(([OutputKey, OutputValue]) => ({OutputKey, OutputValue}))
const lb = {ListenerArn: arn('listener/app/example/123/456'), LoadBalancerArn: arn('loadbalancer/app/example/123')}

describe('CloudFormation references to operator spec', () => {
  let root: string
  let specFile: string
  let manifest: string
  let spec: any
  let sources: any[]
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-spec-import-'))
    specFile = path.join(root, 'deployment-spec.yaml')
    manifest = path.join(root, 'sources.yaml')
    sources = []
    spec = {accounts: {owner: {address: '$ENV:OWNER_ADDRESS'}}, bootnodePublicP2p: [{enabled: true, existingNlb: {securityGroupIds: ['<SG_ID>']}, index: 1, mode: 'existing'}],
    capacityManager: {maxWorkers: 2, provider: 'aws'},
    helmValues: {frontends: {resources: {requests: {cpu: '50m'}}}},
    identities: {sequencers: [{index: 1, nodekey: {action: 'create'}}, {index: 0, nodekey: {action: 'reuse'}}]},
    infrastructure: {aws: {accountId: account, alb: {bindings: {frontends: {endpoint: 'public', serviceRef: {name: 'frontends', port: 80}, targetGroupArn: 'REPLACE_TG'}}, endpoints: {public: {loadBalancerArn: 'REPLACE_ALB'}}, mode: 'existing'}, region,
      workloadIdentity: 'pod-identity'}, provider: 'aws'},
    preparation: {bridge: {mode: 'production'}, proofAws: {action: 'reuse'}}, version: '1.0'}
  })
  afterEach(() => {sinon.restore(); fs.rmSync(root, {force: true, recursive: true})})
  const add = (kind: string, values: Record<string, string>, fields = {}): void => {
    const file = `outputs-${sources.length}.json`
    fs.writeFileSync(path.join(root, file), JSON.stringify(outputs(values)))
    sources.push({file, kind, ...fields})
  }

  const save = (): string => {
    const original = '# operator comments remain in the backup\n' + yaml.dump(spec)
    fs.writeFileSync(specFile, original)
    fs.writeFileSync(manifest, yaml.dump({sources, version: 1}))
    return original
  }

  const run = (flags = {}): ReturnType<typeof importAwsSpec> => importAwsSpec({manifest, spec: specFile, ...flags})
  const read = (): any => yaml.load(fs.readFileSync(specFile, 'utf8'))

  it('imports composed and component outputs, binds by index, preserves intent and is byte-idempotent', () => {
    add('signing-identities', Object.fromEntries(['EthDa', 'FeeOracle', 'Sequencer0', 'Sequencer1', 'Bridge'].map(k => [`${k}KeyArn`, arn(`key/${k}`)])))
    const roleNames = ['EthDa', 'FeeOracle', 'Sequencer0', 'Sequencer1', 'ProofCoordinator', 'WithdrawalProcessor']
    add('workload-access', Object.fromEntries(roleNames.flatMap(k => [[`${k}RoleArn`, arn(`role/${k}`)], [`${k}RoleAssociationId`, `a-${k}`]])))
    add('public-network', {BootnodeSecurityGroupId: 'sg-0123456789abcdef0', BootnodeTargetGroupArn: arn('targetgroup/bootnode/123'),
      HttpsListenerArn: lb.ListenerArn, HttpsLoadBalancerArn: lb.LoadBalancerArn}, {endpoint: 'public', index: 1})
    add('http-target', {TargetGroupArn: arn('targetgroup/portal/123')}, {binding: 'frontends'})
    add('capacity-access', {RoleArn: arn('role/dstack')})
    add('capacity-network', {ControllerTargetGroupArn: arn('targetgroup/dstack/123'), HttpsListenerArn: lb.ListenerArn, HttpsLoadBalancerArn: lb.LoadBalancerArn, HttpsPrivateUrl: 'https://dstack.example.invalid'})
    add('secret-metadata', {SecretName: 'example/proof-token'})
    add('secrets-reader', {RoleArn: arn('role/eso')})
    const original = save()
    const preview = run()
    expect(preview.written).false
    expect(preview.changes.length).greaterThan(30)
    expect(preview.changes.every(c => !c.conflict)).true
    expect(fs.readFileSync(specFile, 'utf8')).eq(original)
    const written = run({write: true})
    expect(fs.readFileSync(written.backup!, 'utf8')).eq(original)
    expect(fs.statSync(written.backup!).mode % 0o1000).eq(0o600)
    expect(fs.statSync(specFile).mode % 0o1000).eq(0o600)
    const result = read()
    expect(result.identities.sequencers[1].signer.kms.keyId).eq(arn('key/Sequencer0'))
    expect(result.identities.sequencers[0].signer.kms.keyId).eq(arn('key/Sequencer1'))
    expect(result.identities.sequencers[1].nodekey).deep.eq({action: 'reuse'})
    expect(result.accounts).deep.eq(spec.accounts)
    expect(result.helmValues).deep.eq(spec.helmValues)
    expect(result.infrastructure.aws.alb.bindings.frontends.serviceRef).deep.eq({name: 'frontends', port: 80})
    expect(result.capacityManager.connection.serverUrl).eq('https://dstack.example.invalid')
    expect(result.preparation.bridge.production.sequencerKms.keyId).eq(arn('key/Bridge'))
    const bytes = fs.readFileSync(specFile, 'utf8')
    expect(run({write: true})).deep.eq({changes: [], written: false})
    expect(fs.readFileSync(specFile, 'utf8')).eq(bytes)
  })

  it('supports individual keys, ALBs, NLBs and split capacity stacks', () => {
    add('signing-key', {KeyArn: arn('key/da')}, {identity: 'ethDaSubmitter'})
    add('signing-key', {KeyArn: arn('key/s1')}, {identity: 'sequencer', index: 1})
    add('alb', lb, {endpoint: 'public'})
    add('bootnode-nlb', {SecurityGroupId: 'sg-01234567', TargetGroupArn: arn('targetgroup/bootnode/123')}, {index: 1})
    add('capacity-alb', {...lb, PrivateUrl: 'https://dstack.example.invalid'})
    add('capacity-target', {TargetGroupArn: arn('targetgroup/dstack/123')})
    save(); run({write: true})
    expect(read().capacityManager.connection.existingAlb.targetGroupArn).eq(arn('targetgroup/dstack/123'))
    expect(read().identities.sequencers[0].signer.kms.keyId).eq(arn('key/s1'))
  })

  it('previews concrete conflicts, refuses writes by default and requires explicit replacement', () => {
    spec.infrastructure.aws.alb.endpoints.public.loadBalancerArn = arn('loadbalancer/app/old/123')
    add('alb', lb, {endpoint: 'public'})
    const original = save()
    expect(run().changes.some(c => c.conflict)).true
    expect(() => run({write: true})).throws('--replace')
    expect(fs.readFileSync(specFile, 'utf8')).eq(original)
    run({replace: true, write: true})
    expect(read().infrastructure.aws.alb.endpoints.public.loadBalancerArn).eq(lb.LoadBalancerArn)
  })

  for (const reason of ['missing', 'wrong-account', 'wrong-region', 'wrong-type', 'duplicate-source', 'disabled-bootnode', 'duplicate-index', 'unknown-field']) {
    it(`does not write partial changes for ${reason}`, () => {
      add('secret-metadata', {SecretName: 'example/proof'})
      const selected = {...lb}
      if (reason === 'missing') delete (selected as any).ListenerArn
      if (reason === 'wrong-account') selected.ListenerArn = selected.ListenerArn.replace(account, '111111111111')
      if (reason === 'wrong-region') selected.ListenerArn = selected.ListenerArn.replace(region, 'us-west-2')
      if (reason === 'wrong-type') selected.ListenerArn = arn('role/wrong')
      add('alb', selected, {endpoint: 'public'})
      if (reason === 'duplicate-source') add('alb', {...lb, ListenerArn: arn('listener/app/other/123/456')}, {endpoint: 'public'})
      if (['disabled-bootnode', 'duplicate-index'].includes(reason)) {
        if (reason === 'disabled-bootnode') spec.bootnodePublicP2p[0].enabled = false
        else spec.bootnodePublicP2p.push({...spec.bootnodePublicP2p[0]})
        add('bootnode-nlb', {SecurityGroupId: 'sg-01234567', TargetGroupArn: arn('targetgroup/bootnode/123')}, {index: 1})
      }

      if (reason === 'unknown-field') sources[0].typo = 'ignored?'
      const original = save()
      expect(() => run({replace: true, write: true})).throws()
      expect(fs.readFileSync(specFile, 'utf8')).eq(original)
      expect(fs.readdirSync(root).some(f => f.endsWith('.bak'))).false
    })
  }

  it('reads only explicitly named stacks and caches repeated reads', () => {
    sources = [{endpoint: 'public', kind: 'alb', stack: 'existing-network'}, {endpoint: 'public', kind: 'alb', stack: 'existing-network'}]
    save()
    const readStack = sinon.stub().returns({Outputs: outputs(lb), StackStatus: 'UPDATE_COMPLETE'})
    run({profile: 'operator', readStack})
    expect(readStack.calledOnceWithExactly('existing-network', region, 'operator')).true
  })

  it('does not echo YAML contents or saved Secret values on parse failures or in CLI preview', async () => {
    add('secret-metadata', {SecretName: 'example/proof'})
    spec.privateNote = 'NONFUNCTIONAL_PRIVATE_PLACEHOLDER'
    save()
    const log = sinon.stub(process.stdout, 'write')
    await ImportAws.run(['--spec', specFile, '--manifest', manifest, '--json'])
    const printed = log.args.map(args => String(args[0])).join('')
    expect(printed).include('preparation.proofAws.secretName')
    expect(printed).not.include(spec.privateNote)
    fs.writeFileSync(specFile, 'private: [NONFUNCTIONAL_PRIVATE_PLACEHOLDER')
    expect(() => run()).throws('contents omitted')
    expect(() => run()).not.throws(spec.privateNote)
  })

  it('refuses frozen preparation inputs and symlink destinations', () => {
    add('alb', lb, {endpoint: 'public'}); save()
    const link = path.join(root, 'link.yaml'); fs.symlinkSync(specFile, link)
    expect(() => importAwsSpec({manifest, spec: link})).throws('operator-owned')
    expect(() => importAwsSpec({manifest, spec: path.join(root, '.scrollsdk', 'spec.yaml')})).throws('operator-owned')
  })

  it('does not change an unrelated YAML anchor alias when importing one endpoint', () => {
    add('alb', lb, {endpoint: 'public'})
    save()
    fs.writeFileSync(specFile, `version: '1.0'\ninfrastructure:\n  aws:\n    accountId: '${account}'\n    region: ${region}\n    alb:\n      mode: existing\n      endpoints:\n        public: &endpoint\n          loadBalancerArn: REPLACE_ALB\n        unrelated: *endpoint\n`)
    run({write: true})
    expect(read().infrastructure.aws.alb.endpoints.unrelated.loadBalancerArn).eq('REPLACE_ALB')
    expect(read().infrastructure.aws.alb.endpoints.public.loadBalancerArn).eq(lb.LoadBalancerArn)
  })

  it('keeps an older capacity stack certificate URL and refuses to guess it when absent', () => {
    add('capacity-network', {ControllerTargetGroupArn: arn('targetgroup/dstack/123'), HttpsListenerArn: lb.ListenerArn, HttpsLoadBalancerArn: lb.LoadBalancerArn})
    save()
    expect(() => run({write: true})).throws('certificate hostname')
    spec.capacityManager.connection = {serverUrl: 'https://dstack.example.invalid'}
    save(); run({write: true})
    expect(read().capacityManager.connection.serverUrl).eq('https://dstack.example.invalid')
  })

  it('accepts AWS output formats but rejects ambiguous stacks, duplicate keys and unsuccessful status', () => {
    expect(parseAwsOutputs({Stacks: [{Outputs: outputs(lb), StackStatus: 'CREATE_COMPLETE'}]})).deep.eq(lb)
    expect(parseAwsOutputs({Outputs: outputs(lb)})).deep.eq(lb)
    for (const value of [{Stacks: []}, {Stacks: [{}, {}]}, {Outputs: outputs(lb), StackStatus: 'UPDATE_ROLLBACK_COMPLETE'}, [...outputs(lb), ...outputs(lb)], {Outputs: [{OutputKey: 'X', OutputValue: null}]}]) expect(() => parseAwsOutputs(value)).throws()
  })
})
