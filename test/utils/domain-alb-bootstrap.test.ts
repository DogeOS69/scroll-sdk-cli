import {expect} from 'chai'

import {buildDogecoinBootstrapValues, buildL1DevnetBootstrapValues} from '../../src/commands/setup/domains.js'
const annotations = {'alb.ingress.kubernetes.io/certificate-arn': 'operator-arn', 'alb.ingress.kubernetes.io/subnets': 'subnet-one,subnet-two'}
describe('per-command ALB domain bootstrap', () => {
  it('defaults Dogecoin to internal and preserves an explicit ALB opt-in', () => {
    const input = {clusterRpcPassword: 'NONFUNCTIONAL_TEST_PASSWORD', clusterRpcUsername: 'fixture', host: 'doge.example.invalid', network: 'testnet' as const}
    expect(buildDogecoinBootstrapValues({}, input).ingress.enabled).to.equal(false)
    const actual = buildDogecoinBootstrapValues({ingress: {annotations, className: 'alb', enabled: true}}, input)
    expect(actual.ingress.enabled).to.equal(true)
    expect(actual.ingress.annotations).to.include(annotations)
    expect(actual.ingress.hosts[0].host).to.equal(input.host)
    expect(actual.ingress.tls).to.deep.equal([])
    expect(() => buildDogecoinBootstrapValues({ingress: {className: 'nginx'}}, input)).to.throw('unsupported')
  })
  it('preserves L1 ACM settings and disabled state while refreshing domains', () => {
    const input = {chainId: 1234, host: 'ethereum.example.invalid'}
    const actual = buildL1DevnetBootstrapValues({ingress: {main: {annotations, enabled: false, ingressClassName: 'alb'}}}, input)
    expect(actual.ingress.main.enabled).to.equal(false)
    expect(actual.ingress.main.annotations).to.include(annotations)
    expect(actual.ingress.main.hosts[0].host).to.equal(input.host)
    expect(() => buildL1DevnetBootstrapValues({ingress: {main: {ingressClassName: 'nginx'}}}, input)).to.throw('unsupported')
  })
})
