/* eslint-disable @typescript-eslint/no-explicit-any -- Deliberately malformed provider fixtures. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import TestIngress from '../../src/commands/test/ingress.js'
import {AwsCliRunner} from '../../src/utils/aws-cli.js'
import {verifyExistingAlbTargetHealth} from '../../src/utils/existing-alb-runtime.js'

function fixture() {
  const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
  const targetGroupArn = `${prefix}targetgroup/example/2222222222222222`
  const spec = {infrastructure: {aws: {
    accountId: '000000000000', alb: {bindings: {frontends: {endpoint: 'public', serviceRef: {name: 'frontends', port: 80}, targetGroupArn}}, endpoints: {public: {
      listenerArn: `${prefix}listener/app/example/0000000000000000/1111111111111111`, loadBalancerArn: `${prefix}loadbalancer/app/example/0000000000000000`,
    }}, mode: 'existing'}, eksClusterName: 'example', region: 'us-east-1',
  }, kubeContext: 'fixture-context', namespace: 'fixture-namespace', provider: 'aws'}} as unknown as DeploymentSpec
  const binding: any = {metadata: {}, spec: {serviceRef: {name: 'frontends', port: 80}, targetGroupARN: targetGroupArn, targetType: 'ip'}}
  const service: any = {metadata: {uid: 'current-service'}, spec: {ports: [{name: 'http', port: 80, protocol: 'TCP', targetPort: 'web'}], selector: {app: 'frontends'}, type: 'ClusterIP'}}
  const slice: any = {endpoints: [{addresses: ['10.0.1.10'], conditions: {ready: true}}], metadata: {ownerReferences: [{kind: 'Service', uid: 'current-service'}]}, ports: [{name: 'http', port: 8080, protocol: 'TCP'}, {name: 'metrics', port: 9090, protocol: 'TCP'}]}
  const target: any = {Target: {Id: '10.0.1.10', Port: 8080}, TargetHealth: {State: 'healthy'}}
  const group = {IpAddressType: 'ipv4', TargetGroupArn: targetGroupArn}
  const data = {bindings: [binding], slices: [slice], targets: [target]}
  const calls: string[][] = []
  const kube = (args: string[]) => {
    calls.push(args)
    expect(args.slice(0, 3)).to.deep.equal(['--context', 'fixture-context', 'get'])
    expect(args.slice(-4)).to.deep.equal(['-n', 'fixture-namespace', '-o', 'json'])
    if (args[3] === 'targetgroupbindings.elbv2.k8s.aws') return {items: data.bindings}
    if (args[3] === 'service') {expect(args[4]).to.equal('frontends'); return service}
    expect(args.slice(3, 6)).to.deep.equal(['endpointslices.discovery.k8s.io', '-l', 'kubernetes.io/service-name=frontends'])
    return {items: data.slices}
  }

  const aws = {json(args: string[], options?: {region?: string}) {
    expect(options).to.deep.equal({region: 'us-east-1'})
    if (args[1] === 'describe-target-groups') {
      expect(args).to.deep.equal(['elbv2', 'describe-target-groups', '--target-group-arns', targetGroupArn])
      return {TargetGroups: [group]}
    }

    expect(args).to.deep.equal(['elbv2', 'describe-target-health', '--target-group-arn', targetGroupArn])
    return {TargetHealthDescriptions: data.targets}
  }}
  return {aws, binding, calls, data, group, kube, run: () => verifyExistingAlbTargetHealth(spec, aws, kube), service, slice, spec, target}
}

describe('existing ALB runtime ownership', () => {
  for (const installed of [false, true]) it(`test ingress ${installed ? 'accepts matching targets' : 'fails without the live binding'}`, async () => {
    const f = fixture()
    if (!installed) f.data.bindings = []
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-alb-runtime-'))
    const cwd = process.cwd()
    const oldPath = process.env.PATH
    const sandbox = sinon.createSandbox()
    try {
      fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), JSON.stringify(f.spec))
      fs.mkdirSync(path.join(root, 'values'))
      fs.writeFileSync(path.join(root, 'values/frontends-production.yaml'), JSON.stringify({ingress: {main: {enabled: false, existingAlbBinding: 'frontends', hosts: [{host: 'portal.example.invalid'}]}}}))
      fs.writeFileSync(path.join(root, 'config.toml'), '[frontend]\nEXTERNAL_RPC_URI_L2 = "https://wrong-rpc.example.invalid"\n')
      fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({bindings: f.data.bindings, service: f.service, slices: f.data.slices}))
      fs.writeFileSync(path.join(root, 'kubectl'), `#!${process.execPath}\nconst fs = require('node:fs'); const f = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'fixture.json'))})); const args = process.argv.slice(2); if (args[0] !== '--context' || args[1] !== 'fixture-context' || args[2] !== 'get') process.exit(2); const result = {'targetgroupbindings.elbv2.k8s.aws': {items: f.bindings}, service: f.service, 'endpointslices.discovery.k8s.io': {items: f.slices}}[args[3]]; if (!result) process.exit(2); console.log(JSON.stringify(result));\n`, {mode: 0o755})
      process.chdir(root)
      process.env.PATH = root
      sandbox.stub(AwsCliRunner.prototype, 'json').callsFake(f.aws.json)
      const log = sandbox.stub()
      const command: any = Object.create(TestIngress.prototype)
      Object.assign(command, {config: {}, configValues: {}, frontendToIngressMapping: {EXTERNAL_RPC_URI_L2: 'rpc'}, log, parse: async () => ({flags: {config: 'config.toml', dev: true, 'values-dir': 'values'}})})
      const ingresses = sandbox.stub(command, 'getIngresses').resolves({grafana: 'grafana.example.invalid', rpc: 'rpc.example.invalid'})
      const connectivity = sandbox.stub(command, 'checkHost').callsFake(async (_host: unknown, name: unknown) => name !== 'grafana')
      const compare = sandbox.spy(command, 'compareWithConfig')
      let error: unknown
      try {await command.run()} catch (error_) {error = error_}
      if (installed) {
        expect(error).to.equal(undefined)
        expect(log.calledWithMatch('Existing ALB targets healthy')).to.equal(true)
        expect(ingresses.calledOnceWithExactly('fixture-namespace', 'fixture-context')).true
        expect(connectivity.calledWith('portal.example.invalid', 'frontends')).true
        expect(connectivity.calledWith('grafana.example.invalid', 'grafana')).true
        expect(compare.calledOnce).true
        expect(log.args.flat().join('\n')).include('grafana is not reachable').and.include('Mismatch for EXTERNAL_RPC_URI_L2').and.include('l1-devnet')
      } else {
        expect(String(error)).to.include('expected one installed')
        expect(log.called).to.equal(false)
        expect(ingresses.called).false
      }
    } finally {
      sandbox.restore()
      process.chdir(cwd)
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      fs.rmSync(root, {force: true, recursive: true})
    }
  })

  it('retains normal ingress checks without an ALB spec', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingress-without-alb-'))
    const cwd = process.cwd()
    const sandbox = sinon.createSandbox()
    try {
      process.chdir(root)
      const command = Object.create(TestIngress.prototype)
      Object.assign(command, {configValues: {}, log() {}, parse: async () => ({flags: {namespace: 'legacy'}})})
      const ingresses = sandbox.stub(command, 'getIngresses').resolves({grafana: 'grafana.example.invalid'})
      const connectivity = sandbox.stub(command, 'checkHost').resolves(true)
      await command.run()
      expect(ingresses.calledOnce).true
      expect(ingresses.firstCall.args[0]).eq('legacy')
      expect(ingresses.firstCall.args[1]).undefined
      expect(connectivity.calledOnceWithExactly('grafana.example.invalid', 'grafana')).true
    } finally {
      sandbox.restore()
      process.chdir(cwd)
      fs.rmSync(root, {force: true, recursive: true})
    }
  })

  it('matches the live binding and pod target port, not the Service port or metrics port', () => {
    const f = fixture()
    expect(f.run()).to.deep.equal(['frontends'])
    expect(f.calls).to.have.length(3)
  })

  for (const [name, mutate, error] of [
    ['missing binding with healthy foreign targets', (f: any) => {f.data.bindings = []; f.target.Target.Id = '10.99.99.99'}, 'expected one installed'],
    ['duplicate binding', (f: any) => {f.data.bindings.push(f.binding)}, 'expected one installed'],
    ['wrong target group', (f: any) => {f.binding.spec.targetGroupARN += '0'}, 'expected one installed'],
    ['wrong Service', (f: any) => {f.binding.spec.serviceRef.name = 'other'}, 'expected one installed'],
    ['wrong Service port', (f: any) => {f.binding.spec.serviceRef.port = 9090}, 'expected one installed'],
    ['wrong target type', (f: any) => {f.binding.spec.targetType = 'instance'}, 'expected one installed'],
    ['deleting binding', (f: any) => {f.binding.metadata.deletionTimestamp = '2026-01-01T00:00:00Z'}, 'expected one installed'],
    ['missing Service port', (f: any) => {f.service.spec.ports = []}, 'Service or TCP port'],
    ['no EndpointSlices', (f: any) => {f.data.slices = []}, 'no ready endpoints'],
    ['stale Service UID', (f: any) => {f.slice.metadata.ownerReferences[0].uid = 'old-service'}, 'no ready endpoints'],
    ['not ready endpoint', (f: any) => {f.slice.endpoints[0].conditions.ready = false}, 'no ready endpoints'],
    ['terminating endpoint', (f: any) => {f.slice.endpoints[0].conditions.terminating = true}, 'no ready endpoints'],
    ['unresolved endpoint port', (f: any) => {f.slice.ports[0].port = null}, 'no ready endpoints'],
    ['empty target group', (f: any) => {f.data.targets = []}, 'healthy targets only'],
    ['unhealthy target', (f: any) => {f.target.TargetHealth.State = 'unhealthy'}, 'healthy targets only'],
    ['draining target', (f: any) => {f.target.TargetHealth.State = 'draining'}, 'healthy targets only'],
    ['foreign healthy target', (f: any) => {f.target.Target.Id = '10.99.99.99'}, 'do not match'],
    ['wrong registered port', (f: any) => {f.target.Target.Port = 80}, 'do not match'],
    ['missing registered endpoint', (f: any) => {f.slice.endpoints.push({addresses: ['10.0.1.11']})}, 'do not match'],
    ['extra registered endpoint', (f: any) => {f.data.targets.push({...f.target, Target: {Id: '10.0.1.11', Port: 8080}})}, 'do not match'],
  ] as const) it(`rejects ${name}`, () => {
    const f = fixture()
    mutate(f)
    expect(f.run).to.throw(error)
  })

  it('deduplicates endpoints across slices during updates and accepts unspecified readiness', () => {
    const f = fixture()
    delete f.slice.endpoints[0].conditions.ready
    f.data.slices.push(structuredClone(f.slice))
    expect(f.run()).to.deep.equal(['frontends'])
  })

  it('normalizes equivalent IPv6 addresses', () => {
    const f = fixture()
    f.slice.endpoints[0].addresses = ['2001:db8:0:0::1']
    f.group.IpAddressType = 'ipv6'
    f.target.Target.Id = '2001:db8::1'
    expect(f.run()).to.deep.equal(['frontends'])
  })

  it('selects only the target group address family for a dual-stack Service', () => {
    const f = fixture()
    const ipv6 = structuredClone(f.slice)
    ipv6.endpoints[0].addresses = ['2001:db8::1']
    f.data.slices.push(ipv6)
    expect(f.run()).to.deep.equal(['frontends'])
  })

  it('matches unnamed TCP Service ports', () => {
    const f = fixture()
    delete f.service.spec.ports[0].name
    delete f.slice.ports[0].name
    expect(f.run()).to.deep.equal(['frontends'])
  })

  it('requires an explicit context and omits provider failure details', () => {
    const f = fixture()
    const unavailable = () => {throw new Error('PRIVATE_PROVIDER_DETAILS')}
    for (const run of [() => verifyExistingAlbTargetHealth(f.spec, f.aws, unavailable), () => verifyExistingAlbTargetHealth(f.spec, {json: unavailable}, f.kube)]) {
      expect(run).to.throw('provider output omitted')
      expect(run).not.to.throw('PRIVATE_PROVIDER_DETAILS')
    }

    delete f.spec.infrastructure.kubeContext
    expect(f.run).to.throw('kubeContext is required')
  })
})
