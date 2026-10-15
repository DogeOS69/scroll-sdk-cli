import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {ALB_BINDINGS_FILE, projectExistingAlb, projectExistingAlbDirectory, suppressExistingAlbIngress, validateExistingAlb, verifyExistingAlb, verifyExistingAlbTargetHealth} from '../../src/utils/existing-alb.js'
import {reconcileDeploymentIngresses} from '../../src/utils/public-service-ingress.js'

const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
const loadBalancerArn = `${prefix}loadbalancer/app/example/0000000000000000`
const listenerArn = `${prefix}listener/app/example/0000000000000000/1111111111111111`
const targetGroupArn = `${prefix}targetgroup/example/2222222222222222`
const certificateArn = 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
const spec = () => ({infrastructure: {aws: {
  accountId: '000000000000',
  alb: {bindings: {'tso-service': {endpoint: 'public', serviceRef: {name: 'tso-service', port: 3000}, targetGroupArn}}, endpoints: {public: {listenerArn, loadBalancerArn}}, mode: 'existing'},
  eksClusterName: 'example', region: 'us-east-1',
}, provider: 'aws'}} as unknown as DeploymentSpec)
const files = () => ({'tso-service-production.yaml': yaml.dump({ingress: {main: {
  annotations: {'alb.ingress.kubernetes.io/certificate-arn': '<TODO>'}, enabled: true,
  hosts: [{host: 'tso.example.invalid', paths: [{path: '/health', pathType: 'Exact'}, {path: '/signer', pathType: 'Prefix'}]}], ingressClassName: 'alb',
}}})})

function provider() {
  const listener = {Certificates: [{CertificateArn: certificateArn}], ListenerArn: listenerArn, LoadBalancerArn: loadBalancerArn, Port: 443, Protocol: 'HTTPS'}
  const responses: Record<string, any> = {
    'describe-certificate': {Certificate: {NotAfter: 4_000_000_000, Status: 'ISSUED', SubjectAlternativeNames: ['*.example.invalid']}},
    'describe-cluster': {cluster: {resourcesVpcConfig: {vpcId: 'vpc-example'}}},
    'describe-listener-certificates': {Certificates: [{CertificateArn: certificateArn}]},
    'describe-listeners': {Listeners: [listener]},
    'describe-load-balancers': {LoadBalancers: [{LoadBalancerArn: loadBalancerArn, Scheme: 'internet-facing', State: {Code: 'active'}, Type: 'application', VpcId: 'vpc-example'}]},
    'describe-rules': {Rules: [{Actions: [{TargetGroupArn: targetGroupArn, Type: 'forward'}], Conditions: [{Field: 'host-header', HostHeaderConfig: {Values: ['tso.example.invalid']}}, {Field: 'path-pattern', PathPatternConfig: {Values: ['/health', '/signer', '/signer/*']}}]}]},
    'describe-tags': {TagDescriptions: [{Tags: []}]},
    'describe-target-groups': {TargetGroups: [{HealthCheckEnabled: true, HealthCheckPath: '/health', HealthCheckPort: 'traffic-port', HealthCheckProtocol: 'HTTP', LoadBalancerArns: [loadBalancerArn], Matcher: {HttpCode: '200'}, Protocol: 'HTTP', TargetGroupArn: targetGroupArn, TargetType: 'ip', VpcId: 'vpc-example'}]},
  }
  const calls: string[][] = []
  return {calls, json(args: string[]) {calls.push(args); if (!responses[args[1]]) throw new Error('Unexpected provider request'); return responses[args[1]]}, responses}
}

describe('existing ALB lifecycle', () => {
  it('disables managed Ingress and emits only external target references, idempotently', () => {
    const values: Record<string, string> = files()
    projectExistingAlb(values, spec())
    expect((yaml.load(values['tso-service-production.yaml']) as any).ingress.main).to.include({enabled: false, existingAlbBinding: 'tso-service'})
    expect(yaml.load(values[ALB_BINDINGS_FILE])).to.deep.equal({bindings: {'tso-service': {serviceRef: {name: 'tso-service', port: 3000}, targetGroupARN: targetGroupArn, targetType: 'ip'}}})
    const first = {...values}
    projectExistingAlb(values, spec())
    expect(values).to.deep.equal(first)
    const regenerated = yaml.load(values['tso-service-production.yaml']) as any
    regenerated.ingress.main.enabled = true
    reconcileDeploymentIngresses(regenerated, 'tso-service')
    expect(regenerated.ingress.main.enabled).to.equal(false)
  })

  it('rejects every unbound enabled ingress atomically, including nested Grafana', () => {
    const values = {...files(), 'scroll-monitor-production.yaml': yaml.dump({grafana: {ingress: {enabled: true, hosts: ['grafana.example.invalid']}}})}
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

  it('suppresses regenerated dstack ingress before certificate annotation validation', () => {
    const input = spec()
    input.infrastructure.aws!.alb!.bindings = {'dstack-controller': {...input.infrastructure.aws!.alb!.bindings['tso-service']}}
    const values = {ingress: {annotations: {'alb.ingress.kubernetes.io/certificate-arn': '<TODO>'}, enabled: true, hosts: ['dstack.example.invalid']}}
    suppressExistingAlbIngress(values, 'dstack-controller-production.yaml', input)
    reconcileDeploymentIngresses(values, 'dstack-controller')
    expect(values.ingress.enabled).to.equal(false)
  })

  it('verifies selected AWS resources using only describe calls', () => {
    const values = files()
    projectExistingAlb(values, spec())
    const aws = provider()
    expect(verifyExistingAlb(spec(), values, aws)).to.deep.equal({bindings: ['tso-service'], loadBalancers: 1})
    expect(aws.calls.every(args => args[1].startsWith('describe-'))).to.equal(true)
  })

  for (const [name, mutate, message] of [
    ['controller-owned ALB', (r: any) => {r['describe-tags'].TagDescriptions[0].Tags.push({Key: 'ingress.k8s.aws/stack', Value: 'another-release'})}, 'externally managed ALB'],
    ['wrong VPC', (r: any) => {r['describe-load-balancers'].LoadBalancers[0].VpcId = 'other'}, 'selected EKS VPC'],
    ['wrong target type', (r: any) => {r['describe-target-groups'].TargetGroups[0].TargetType = 'instance'}, 'HTTP/IP group'],
    ['wrong health path', (r: any) => {r['describe-target-groups'].TargetGroups[0].HealthCheckPath = '/'}, 'health check'],
    ['broad TSO route', (r: any) => {r['describe-rules'].Rules[0].Conditions[1].PathPatternConfig.Values = ['/*']}, 'outside the generated ingress policy'],
    ['missing route', (r: any) => {r['describe-rules'].Rules = []}, 'missing listener rule'],
    ['default forwarding', (r: any) => {r['describe-rules'].Rules[0].Conditions = []}, 'explicit host/path'],
    ['foreign host', (r: any) => {r['describe-rules'].Rules[0].Conditions[0].HostHeaderConfig.Values.push('other.example.invalid')}, 'outside the generated ingress policy'],
    ['expired certificate', (r: any) => {r['describe-certificate'].Certificate.NotAfter = 0}, 'unexpired issued ACM'],
    ['certificate mismatch', (r: any) => {r['describe-certificate'].Certificate.SubjectAlternativeNames = ['other.invalid']}, 'unexpired issued ACM'],
  ] as const) it(`fails preflight for ${name}`, () => {
    const values = files()
    projectExistingAlb(values, spec())
    const aws = provider()
    mutate(aws.responses)
    expect(() => verifyExistingAlb(spec(), values, aws)).to.throw(message)
  })

  it('does not silently repair tampered values during verification', () => {
    const values: Record<string, string> = files()
    projectExistingAlb(values, spec())
    const changed = yaml.load(values[ALB_BINDINGS_FILE]) as any
    changed.bindings['tso-service'].serviceRef.name = 'unrelated'
    values[ALB_BINDINGS_FILE] = yaml.dump(changed)
    expect(() => verifyExistingAlb(spec(), values, provider())).to.throw('stale values')
  })

  it('requires registered healthy targets for runtime checks', () => {
    for (const targets of [[], [{TargetHealth: {State: 'unhealthy'}}], [{TargetHealth: {State: 'healthy'}}, {TargetHealth: {State: 'initial'}}]]) {
      expect(() => verifyExistingAlbTargetHealth(spec(), {json() {return {TargetHealthDescriptions: targets}}})).to.throw('healthy targets only')
    }

    expect(verifyExistingAlbTargetHealth(spec(), {json() {return {TargetHealthDescriptions: [{TargetHealth: {State: 'healthy'}}]}}})).to.deep.equal(['tso-service'])
  })

  it('never exposes provider response details in failures', () => {
    const values = files()
    projectExistingAlb(values, spec())
    const run = () => verifyExistingAlb(spec(), values, {json() {throw new Error('private-provider-response')}})
    expect(run).to.throw('provider output omitted')
    expect(run).not.to.throw('private-provider-response')
  })

  it('renders real SDK TargetGroupBindings from CLI output without Ingress, hooks or keep annotations', function () {
    if (!process.env.SDK_ALB_CHART) this.skip()
    const values: Record<string, string> = files()
    projectExistingAlb(values, spec())
    const output = execFileSync('helm', ['template', 'alb-bindings', process.env.SDK_ALB_CHART!, '-n', 'example', '-f', '-'], {encoding: 'utf8', input: values[ALB_BINDINGS_FILE]})
    const docs = yaml.loadAll(output).filter(Boolean) as any[]
    expect(docs).to.have.length(1)
    expect(docs[0].kind).to.equal('TargetGroupBinding')
    expect(docs[0].metadata.namespace).to.equal('example')
    expect(docs[0].metadata.annotations).to.equal(undefined)
    expect(docs[0].spec).to.deep.equal({serviceRef: {name: 'tso-service', port: 3000}, targetGroupARN: targetGroupArn, targetType: 'ip'})
    const application = execFileSync('helm', ['template', 'tso-service', path.join(process.env.SDK_ALB_CHART!, '../tso-service'), '-n', 'example', '-f', '-'], {encoding: 'utf8', input: values['tso-service-production.yaml']})
    const workload = yaml.loadAll(application).filter(Boolean) as any[]
    expect(workload.some(item => item.kind === 'Ingress')).to.equal(false)
    const service = workload.find(item => item.kind === 'Service' && item.metadata.name === 'tso-service')
    expect(service.spec.type ?? 'ClusterIP').to.equal('ClusterIP')
    expect(service.spec.ports.some((port: any) => port.port === 3000)).to.equal(true)
  })
})
