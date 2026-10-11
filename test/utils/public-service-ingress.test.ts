/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise operator Helm values. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'

import {buildProofCoordinatorIngress} from '../../src/utils/proof-coordinator-ingress.js'
import {reconcileDeploymentIngresses, reconcilePublicServiceIngress} from '../../src/utils/public-service-ingress.js'
import {mergeBootstrapValues} from '../../src/utils/spec-bootstrap.js'

const alb = 'alb.ingress.kubernetes.io/'
const certificate = 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
const base = () => ({annotations: {[`${alb}certificate-arn`]: certificate}, enabled: true, hosts: [{host: 'tso.example.invalid'}], ingressClassName: 'alb'})

describe('public service ingress controller policy', () => {
  it('preserves ALB operator settings, removes stale nginx TLS, and is idempotent', () => {
    const input = {...base(), annotations: {...base().annotations, [`${alb}inbound-cidrs`]: '192.0.2.0/24', 'cert-manager.io/cluster-issuer': 'old', 'nginx.ingress.kubernetes.io/proxy-body-size': '4m'}, tls: [{secretName: 'old-tls'}]}
    const actual = reconcilePublicServiceIngress(input, 'tso-service')
    expect(actual.ingressClassName).to.equal('alb')
    expect(actual.tls).to.equal(undefined)
    expect(actual.annotations).to.include({[`${alb}certificate-arn`]: certificate, [`${alb}healthcheck-path`]: '/health', [`${alb}inbound-cidrs`]: '192.0.2.0/24'})
    expect(Object.keys(actual.annotations).some(key => /nginx|cert-manager/.test(key))).to.equal(false)
    expect(reconcilePublicServiceIngress(actual, 'tso-service')).to.deep.equal(actual)
    expect(input.tls).to.have.length(1)
  })

  it('rejects explicit legacy controllers instead of silently moving an existing edge', () => {
    const merged = yaml.load(mergeBootstrapValues(yaml.dump({ingress: {main: base()}}), '{}', yaml.dump({ingress: {main: {ingressClassName: 'nginx'}}}))) as any
    expect(() => reconcilePublicServiceIngress(merged.ingress.main, 'tso-service')).to.throw('unsupported')
  })

  for (const value of [undefined, '<TODO>', '$ENV:ACM_CERTIFICATE', 'REPLACE_WITH_CERTIFICATE', 'not-an-arn']) {
    it(`rejects unresolved required ACM input (${value}) before preparation`, () => {
      expect(() => reconcilePublicServiceIngress({...base(), annotations: {[`${alb}certificate-arn`]: value}}, 'tso-service')).to.throw('issued ACM certificate ARN')
    })
  }

  it('allows editable bootstrap templates and disabled ingress without a certificate', () => {
    expect(reconcilePublicServiceIngress({}, 'tso-service', false).ingressClassName).to.equal('alb')
    expect(reconcilePublicServiceIngress({enabled: false}, 'proof-coordinator').enabled).to.equal(false)
    expect(() => buildProofCoordinatorIngress('proof.example.invalid', {enabled: false})).to.throw('certificate-arn')
  })

  it('defaults an unspecified L1 devnet edge to disabled and validates an explicit opt-in', () => {
    const values: any = {ingress: {main: {annotations: {[`${alb}certificate-arn`]: '<TODO>'}, hosts: [{host: 'l1.example.invalid'}], ingressClassName: 'alb'}}}
    expect(() => reconcileDeploymentIngresses(values, 'l1-devnet')).not.to.throw()
    expect(values.ingress.main.enabled).to.equal(false)
    values.ingress.main.enabled = true
    expect(() => reconcileDeploymentIngresses(values, 'l1-devnet')).to.throw('certificate-arn')
    values.ingress.main.annotations[`${alb}certificate-arn`] = certificate
    expect(() => reconcileDeploymentIngresses(values, 'l1-devnet')).not.to.throw()
    expect(values.ingress.main.enabled).to.equal(true)
  })

  it('rejects shared ALB groups and optional annotations left as placeholders', () => {
    for (const [key, value, error] of [[`${alb}group.name`, 'shared', 'independent ALBs'], [`${alb}wafv2-acl-arn`, '<TODO>', 'placeholder annotation']]) {
      expect(() => reconcilePublicServiceIngress({...base(), annotations: {...base().annotations, [key]: value}}, 'tso-service')).to.throw(error)
    }
  })

  it('preserves proof coordinator host/backend, sets 120 seconds, and rejects a shorter timeout', () => {
    const actual = buildProofCoordinatorIngress('proof.example.invalid', base())
    expect(actual.hosts).to.deep.equal([{host: 'proof.example.invalid', paths: [{path: '/', pathType: 'Prefix', service: {port: 7788}}]}])
    expect(actual.annotations[`${alb}load-balancer-attributes`]).to.equal('idle_timeout.timeout_seconds=120')
    for (const attributes of ['idle_timeout.timeout_seconds=60', 'access_logs.s3.enabled=false']) {
      expect(() => buildProofCoordinatorIngress('proof.example.invalid', {...base(), annotations: {...base().annotations, [`${alb}load-balancer-attributes`]: attributes}})).to.throw('at least 120')
    }
  })
})
