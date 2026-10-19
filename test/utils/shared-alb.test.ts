import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {existingAlbIngress, projectExistingAlb, projectExistingAlbDirectory, projectSharedAlbValues, validateExistingAlb} from '../../src/utils/existing-alb.js'
import {reconcileDeploymentIngresses} from '../../src/utils/public-service-ingress.js'

const alb = 'alb.ingress.kubernetes.io/'
const certificateArn = 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
const spec = () => ({infrastructure: {aws: {
  accountId: '000000000000', region: 'us-east-1',
  sharedAlb: {certificateArn, groupName: 'public-example', services: ['blockscout-api', 'blockscout-frontend', 'frontends', 'l2-reth-rpc-public']},
}, provider: 'aws'}, network: {l2ChainId: 12_345, l2ChainName: 'Example'}} as DeploymentSpec)
const ingress = () => ({annotations: {'nginx.ingress.kubernetes.io/enable-cors': null}, enabled: false, hostname: 'explorer.example.invalid'})
const files = (): Record<string, string> => ({
  'blockscout-production.yaml': yaml.dump({'blockscout-stack': {
    blockscout: {env: {COIN: 'DOGE', COIN_NAME: 'Dogecoin'}, ingress: ingress()},
    frontend: {env: {NEXT_PUBLIC_API_HOST: 'old.example.invalid', NEXT_PUBLIC_APP_HOST: 'old.example.invalid'}, ingress: ingress()},
  }}),
  'frontends-production.yaml': yaml.dump({ingress: {main: {enabled: false, hosts: [{host: 'portal.example.invalid', paths: [{path: '/', pathType: 'Prefix'}, {path: '/extra', pathType: 'Prefix'}]}]}}}),
  'l2-reth-rpc-public-production.yaml': yaml.dump({ingress: {main: {hosts: [{host: 'rpc.example.invalid', paths: [{path: '/', pathType: 'Prefix'}]}]}, websocket: {enabled: false}}}),
})

describe('shared public ALB projection', () => {
  for (const shared of ['l2-reth-rpc-public', 'l2-reth-rpc-public-ws'] as const) it(`preserves disjoint external RPC bindings when rerunning ${shared} shared ingress preparation`, () => {
    const intent = spec()
    intent.infrastructure.aws!.sharedAlb!.services = [shared]
    const external = shared === 'l2-reth-rpc-public' ? 'l2-reth-rpc-public-ws' : 'l2-reth-rpc-public'
    const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
    const binding = {endpoint: 'rpc', serviceRef: {name: 'l2-reth-rpc-public', port: external.endsWith('-ws') ? 8546 : 8545}, targetGroupArn: `${prefix}targetgroup/rpc/2222222222222222`}
    intent.infrastructure.aws!.alb = {bindings: {[external]: binding}, endpoints: {rpc: {listenerArn: `${prefix}listener/app/rpc/0000000000000000/1111111111111111`, loadBalancerArn: `${prefix}loadbalancer/app/rpc/0000000000000000`}}, mode: 'existing'}
    const file = 'l2-reth-rpc-public-production.yaml'
    const values = {[file]: yaml.dump({ingress: {main: {hosts: [{host: 'rpc.example.invalid'}]}, websocket: {hosts: [{host: 'ws.example.invalid'}]}}})}
    projectExistingAlb(values, intent)
    const parsed = yaml.load(values[file]) as {
      ingress: Record<string, {enabled: boolean; existingAlbBinding?: string}>
      targetGroupBindings: Record<string, unknown>
    }
    const before = structuredClone(parsed)
    // prep-charts also applies the shared projection directly after merging.
    projectSharedAlbValues(parsed, file, intent)
    expect(parsed).to.deep.equal(before)
    projectExistingAlb(values, intent)
    expect(yaml.load(values[file])).to.deep.equal(before)
    expect(parsed.targetGroupBindings).to.deep.equal({[external]: {serviceRef: binding.serviceRef, targetGroupARN: binding.targetGroupArn, targetType: 'ip'}})
    expect(parsed.ingress[shared.endsWith('-ws') ? 'websocket' : 'main'].enabled).to.equal(true)
    expect(parsed.ingress[external.endsWith('-ws') ? 'websocket' : 'main'].enabled).to.equal(false)

    parsed.targetGroupBindings[shared] = parsed.targetGroupBindings[external]
    expect(() => projectSharedAlbValues(parsed, file, intent)).to.throw('remove external targetGroupBindings')
    delete parsed.targetGroupBindings[shared]
    parsed.ingress[shared.endsWith('-ws') ? 'websocket' : 'main'].existingAlbBinding = external
    expect(() => projectSharedAlbValues(parsed, file, intent)).to.throw('remove external targetGroupBindings')
  })

  it('enables selected edges, preserves routes, emits TLS/health/order and survives preparation', () => {
    const values = files()
    projectExistingAlb(values, spec())
    const stack = (yaml.load(values['blockscout-production.yaml']) as any)['blockscout-stack']
    expect(stack.blockscout.ingress).to.include({className: 'alb', enabled: true})
    expect(stack.blockscout.ingress).not.to.have.property('paths')
    expect(stack.frontend.ingress).not.to.have.property('paths')
    expect(stack.blockscout.ingress.annotations).to.include({[`${alb}certificate-arn`]: certificateArn, [`${alb}group.name`]: 'public-example', [`${alb}group.order`]: '10', [`${alb}healthcheck-path`]: '/api/health/readiness'})
    expect(stack.frontend.ingress.annotations).to.include({[`${alb}group.order`]: '100', [`${alb}healthcheck-path`]: '/api/healthz'})
    expect(stack.frontend.env).to.include({NEXT_PUBLIC_API_WEBSOCKET_PROTOCOL: 'wss'})
    expect(stack.frontend.env).not.to.have.property('NEXT_PUBLIC_API_HOST')
    expect(stack.frontend.env).not.to.have.property('NEXT_PUBLIC_APP_HOST')
    expect(stack.blockscout.env).not.to.have.property('COIN')
    expect(stack.config.prometheus.ingressWhitelist.enabled).to.equal(false)
    const frontend = yaml.load(values['frontends-production.yaml']) as any
    expect(frontend.ingress.main.hosts[0].paths).to.have.length(2)
    const rpc = yaml.load(values['l2-reth-rpc-public-production.yaml']) as any
    expect(rpc.ingress.main.annotations[`${alb}success-codes`]).to.equal('200-499')
    expect(rpc.ingress.websocket.enabled).to.equal(false)
    const before = {...values}
    for (const [file, content] of Object.entries(values)) {
      const parsed = yaml.load(content) as any
      projectSharedAlbValues(parsed, file, spec())
      reconcileDeploymentIngresses(parsed, file.replace('-production.yaml', ''))
      values[file] = yaml.dump(parsed, {lineWidth: -1, noRefs: true})
    }

    projectExistingAlb(values, spec())
    // Legacy reconciliation also fills defaults for the disabled, unselected WS edge.
    for (const file of Object.keys(values)) {
      const expected = yaml.load(before[file]) as any
      reconcileDeploymentIngresses(expected, file.replace('-production.yaml', ''))
      expect(yaml.load(values[file])).to.deep.equal(expected)
    }

    projectExistingAlb(values, spec())
  })

  it('keeps dedicated TSO bindings while allowing only selected public ingresses', () => {
    const intent = spec()
    const prefix = 'arn:aws:elasticloadbalancing:us-east-1:000000000000:'
    intent.infrastructure.aws!.alb = {bindings: {'tso-service': {endpoint: 'tso', serviceRef: {name: 'tso-service', port: 3000}, targetGroupArn: `${prefix}targetgroup/tso/2222222222222222`}}, endpoints: {tso: {listenerArn: `${prefix}listener/app/tso/0000000000000000/1111111111111111`, loadBalancerArn: `${prefix}loadbalancer/app/tso/0000000000000000`}}, mode: 'existing'}
    const values: Record<string, string> = {...files(), 'tso-service-production.yaml': yaml.dump({ingress: {main: {enabled: true}}})}
    projectExistingAlb(values, intent)
    const tso = yaml.load(values['tso-service-production.yaml']) as any
    expect(tso.ingress.main.enabled).to.equal(false)
    expect(tso.targetGroupBindings).to.have.property('tso-service')
    const rpc = yaml.load(values['l2-reth-rpc-public-production.yaml']) as any
    rpc.ingress.unselected = {enabled: true, hosts: [{host: 'extra.example.invalid'}]}
    values['l2-reth-rpc-public-production.yaml'] = yaml.dump(rpc)
    const before = {...values}
    expect(() => projectExistingAlb(values, intent)).to.throw('enabled ingress has no existing ALB binding')
    expect(values).to.deep.equal(before)
  })

  it('rejects invalid selections, conflicting ownership and stale configuration atomically', () => {
    for (const config of [
      {services: ['tso-service']}, {services: ['blockscout-api']}, {services: ['frontends', 'frontends']},
      {groupName: '../bad'}, {certificateArn: certificateArn.replace('us-east-1', 'us-west-2')},
    ]) {
      const intent = spec()
      Object.assign(intent.infrastructure.aws!.sharedAlb!, config)
      expect(() => validateExistingAlb(intent)).to.throw()
    }

    const values = files()
    delete values['frontends-production.yaml']
    expect(() => projectExistingAlb(values, spec())).to.throw('missing generated application values')
    const selected = files()
    projectExistingAlb(selected, spec())
    const before = {...selected}
    const removed = spec()
    delete removed.infrastructure.aws!.sharedAlb
    expect(() => projectExistingAlb(selected, removed)).to.throw('stale sharedAlb selection')
    expect(selected).to.deep.equal(before)
    const legacy = files()
    const blockscout = yaml.load(legacy['blockscout-production.yaml']) as any
    blockscout.targetGroupBindings = {old: {targetGroupARN: 'placeholder'}}
    legacy['blockscout-production.yaml'] = yaml.dump(blockscout)
    expect(() => projectExistingAlb(legacy, spec())).to.throw('remove external targetGroupBindings')
  })

  it('verifies inherited Blockscout routes without writing a replacement path list', () => {
    const values = files()
    const before = {...values}
    const ingress = existingAlbIngress(values, 'blockscout-api')
    expect(ingress.paths).to.deep.include({path: '/socket', pathType: 'Prefix'})
    expect(values).to.deep.equal(before)
  })

  it('accepts shared selection in final AWS preparation and persists it idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-alb-'))
    try {
      for (const [file, content] of Object.entries(files())) fs.writeFileSync(path.join(dir, file), content)
      projectExistingAlbDirectory(dir, spec(), true)
      const before = fs.readFileSync(path.join(dir, 'blockscout-production.yaml'), 'utf8')
      projectExistingAlbDirectory(dir, spec(), true)
      expect(fs.readFileSync(path.join(dir, 'blockscout-production.yaml'), 'utf8')).to.equal(before)
    } finally {fs.rmSync(dir, {force: true, recursive: true})}
  })
})
