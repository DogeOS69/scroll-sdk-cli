import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {projectExistingAlb, projectExistingAlbDirectory, suppressExistingAlbIngress, validateExistingAlb, validateExistingAlbSdk} from '../../src/utils/existing-alb.js'
import {reconcileDeploymentIngresses} from '../../src/utils/public-service-ingress.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
const loadBalancerArn = `${prefix}loadbalancer/app/example/0000000000000000`
const listenerArn = `${prefix}listener/app/example/0000000000000000/1111111111111111`
const targetGroupArn = `${prefix}targetgroup/example/2222222222222222`
const spec = () => ({infrastructure: {aws: {
  accountId: '000000000000',
  alb: {bindings: {'tso-service': {endpoint: 'public', serviceRef: {name: 'tso-service', port: 3000}, targetGroupArn}}, endpoints: {public: {listenerArn, loadBalancerArn}}, mode: 'existing'},
  eksClusterName: 'example', region: 'us-east-1',
}, provider: 'aws'}} as unknown as DeploymentSpec)
const files = () => ({'tso-service-production.yaml': yaml.dump({ingress: {main: {
  annotations: {'alb.ingress.kubernetes.io/certificate-arn': '<TODO>'}, enabled: true,
  hosts: [{host: 'tso.example.invalid', paths: [{path: '/health', pathType: 'Exact'}, {path: '/signer', pathType: 'Prefix'}]}], ingressClassName: 'alb',
}}})})

describe('existing ALB lifecycle', () => {

  it('disables managed Ingress and emits only external target references, idempotently', () => {
    const values: Record<string, string> = files()
    projectExistingAlb(values, spec())
    expect((yaml.load(values['tso-service-production.yaml']) as any).ingress.main).to.include({enabled: false, existingAlbBinding: 'tso-service'})
    expect((yaml.load(values['tso-service-production.yaml']) as any).targetGroupBindings).to.deep.equal({'tso-service': {serviceRef: {name: 'tso-service', port: 3000}, targetGroupARN: targetGroupArn, targetType: 'ip'}})
    expect(Object.keys(values)).to.deep.equal(['tso-service-production.yaml'])
    const first = {...values}
    projectExistingAlb(values, spec())
    expect(values).to.deep.equal(first)
    const regenerated = yaml.load(values['tso-service-production.yaml']) as any
    regenerated.ingress.main.enabled = true
    reconcileDeploymentIngresses(regenerated, 'tso-service')
    expect(regenerated.ingress.main.enabled).to.equal(false)
  })

  it('rejects every unbound enabled ingress atomically, including nested Blockscout', () => {
    const values = {...files(), 'blockscout-production.yaml': yaml.dump({'blockscout-stack': {blockscout: {ingress: {enabled: true, hostname: 'explorer.example.invalid'}}}})}
    const before = {...values}
    expect(() => projectExistingAlb(values, spec())).to.throw('enabled ingress has no existing ALB binding')
    expect(values).to.deep.equal(before)
  })

  it('rejects removing a selected binding or its entire spec configuration', () => {
    const values = files()
    projectExistingAlb(values, spec())
    const changed = spec()
    delete changed.infrastructure.aws!.alb
    expect(() => projectExistingAlb(values, changed)).to.throw('cannot remove alb configuration')
  })

  it('requires a binding selection at final AWS preparation and leaves files untouched on failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-alb-'))
    try {
      const values = files()
      for (const [name, content] of Object.entries(values)) fs.writeFileSync(path.join(root, name), content)
      const missing = spec()
      delete missing.infrastructure.aws!.alb
      expect(() => projectExistingAlbDirectory(root, missing, true)).to.throw('requires infrastructure.aws.alb')
      expect(fs.readFileSync(path.join(root, 'tso-service-production.yaml'), 'utf8')).to.equal(values['tso-service-production.yaml'])
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  for (const [name, mutate, message] of [
    ['missing endpoint', (s: any) => {s.infrastructure.aws.alb.bindings['tso-service'].endpoint = 'missing'}, 'unknown service or endpoint'],
    ['wrong account', (s: any) => {s.infrastructure.aws.accountId = '111111111111'}, 'configured account and region'],
    ['wrong listener', (s: any) => {s.infrastructure.aws.alb.endpoints.public.listenerArn = listenerArn.replace('example/', 'other/')}, 'listener ARN must belong'],
    ['unknown service', (s: any) => {s.infrastructure.aws.alb.bindings.typo = s.infrastructure.aws.alb.bindings['tso-service']}, 'unknown service'],
    ['automatic mode', (s: any) => {s.infrastructure.aws.alb.mode = 'create'}, 'must be existing'],
    ['legacy discovery', (s: any) => {s.preparation = {tsoAlbEdge: {enabled: true}}}, 'disable preparation.tsoAlbEdge'],
    ['invalid service port', (s: any) => {s.infrastructure.aws.alb.bindings['tso-service'].serviceRef.port = 0}, 'numeric port'],
  ] as const) it(`rejects ${name}`, () => {const input = spec(); mutate(input); expect(() => validateExistingAlb(input)).to.throw(message)})
  it('leaves excluded application ingresses unchanged, including final preparation without ALB selection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alb-unrelated-values-'))
    const unrelated = Object.fromEntries(['l1-devnet', 'dogecoin', 'blockbook', 'l1-interface', 'scroll-monitor', 'dstack-controller'].map(name => [
      `${name}-production.yaml`, yaml.dump(name === 'scroll-monitor'
        ? {grafana: {ingress: {enabled: true, hosts: ['monitor.example.invalid']}}}
        : {ingress: {enabled: true, hosts: ['operator.example.invalid']}}),
    ]))
    try {
      const input = spec()
      input.dstackController = {internalTls: {hostname: 'private.example.invalid'}} as any
      const values: Record<string, string> = {...unrelated, ...files()}
      projectExistingAlb(values, input)
      for (const [file, content] of Object.entries(unrelated)) {
        expect(values[file]).to.equal(content)
        const document = yaml.load(content) as any
        suppressExistingAlbIngress(document, file, input)
        expect(document).to.deep.equal(yaml.load(content))
        fs.writeFileSync(path.join(root, file), content)
      }

      delete input.infrastructure.aws!.alb
      projectExistingAlbDirectory(root, input, true)
      for (const [file, content] of Object.entries(unrelated)) expect(fs.readFileSync(path.join(root, file), 'utf8')).to.equal(content)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('requires binding templates in the pinned SDK commit, not just the working tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alb-sdk-contract-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'})
    try {
      git('init')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
      const template = path.join(root, 'charts/tso-service/templates/targetgroupbindings.yaml')
      fs.mkdirSync(path.dirname(template), {recursive: true})
      fs.writeFileSync(template, '# Nonfunctional capability fixture\n')
      expect(() => validateExistingAlbSdk(root, spec())).to.throw('selected SDK revision lacks')
      git('add', 'charts/tso-service/templates/targetgroupbindings.yaml')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'chart fixture')
      expect(() => validateExistingAlbSdk(root, spec())).not.to.throw()
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('rejects stale bindings even if their ingress marker was removed', () => {
    const values = files()
    projectExistingAlb(values, spec())
    const changed = yaml.load(values['tso-service-production.yaml']) as any
    delete changed.ingress.main.existingAlbBinding
    changed.targetGroupBindings.foreign = changed.targetGroupBindings['tso-service']
    values['tso-service-production.yaml'] = yaml.dump(changed)
    expect(() => projectExistingAlb(values, spec())).to.throw('stale or misplaced targetGroupBindings')
    const input = spec()
    delete input.infrastructure.aws!.alb
    expect(() => projectExistingAlb(values, input)).to.throw('cannot remove alb configuration')
  })

  it('renders the application and its binding in one SDK Helm release without Ingress', function () {
    if (!process.env.SDK_ALB_CHARTS) this.skip()
    const values: Record<string, string> = files()
    projectExistingAlb(values, spec())
    const output = execFileSync('helm', ['template', 'tso-service', path.join(process.env.SDK_ALB_CHARTS!, 'tso-service'), '-n', 'example', '-f', '-'], {encoding: 'utf8', input: values['tso-service-production.yaml']})
    const docs = yaml.loadAll(output).filter(Boolean) as any[]
    const bindings = docs.filter(item => item.kind === 'TargetGroupBinding')
    expect(bindings).to.have.length(1)
    expect(bindings[0].metadata.namespace).to.equal('example')
    expect(bindings[0].metadata.labels['app.kubernetes.io/instance']).to.equal('tso-service')
    expect(bindings[0].metadata.annotations).to.equal(undefined)
    expect(bindings[0].spec).to.deep.equal({serviceRef: {name: 'tso-service', port: 3000}, targetGroupARN: targetGroupArn, targetType: 'ip'})
    expect(docs.some(item => item.kind === 'Ingress')).to.equal(false)
    const service = docs.find(item => item.kind === 'Service' && item.metadata.name === 'tso-service')
    expect(service.spec.type ?? 'ClusterIP').to.equal('ClusterIP')
    expect(service.spec.ports.some((port: any) => port.port === 3000)).to.equal(true)
  })
})
