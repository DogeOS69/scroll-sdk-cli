import {expect} from 'chai'

import {validateServiceNetworkPolicy} from '../../src/utils/service-network-policy.js'
const pod = {podSelector: {matchLabels: {app: 'expected'}}}
const tso = () => ({ingress: {main: {enabled: true}}, networkPolicy: {allowFrom: {edge: [{ipBlock: {cidr: '10.0.1.0/24'}}], signers: [pod], withdrawalProcessor: [pod]}, enabled: true}})
describe('production bridge network policy validation', () => {
  it('accepts explicit pod peers and ALB subnet CIDRs', () => validateServiceNetworkPolicy(tso(), 'tso-service'))
  for (const cidr of ['<TODO>', '0.0.0.0/0', '::/0', '10.0.0.0/33', '10.0.0.0', 'invalid/24']) it(`rejects ${cidr}`, () => {
    const values = tso(); values.networkPolicy.allowFrom.edge[0].ipBlock.cidr = cidr
    expect(() => validateServiceNetworkPolicy(values, 'tso-service')).to.throw('restricted CIDRs')
  })
  it('rejects disabled isolation and missing or unrestricted peers', () => {
    const values = tso(); values.networkPolicy.enabled = false
    expect(() => validateServiceNetworkPolicy(values, 'tso-service')).to.throw('must be enabled')
    values.networkPolicy.enabled = true; values.networkPolicy.allowFrom.withdrawalProcessor = [{podSelector: {matchLabels: {} as any}}]
    expect(() => validateServiceNetworkPolicy(values, 'tso-service')).to.throw('nonempty podSelector')
    values.networkPolicy.allowFrom.withdrawalProcessor = []
    expect(() => validateServiceNetworkPolicy(values, 'tso-service')).to.throw('required callers')
  })
  it('requires proof coordinator access when the WP proof-work listener is enabled', () => {
    const values: any = {networkPolicy: {allowFrom: {tso: [pod]}, enabled: true}, service: {main: {ports: {'proof-work': {enabled: true}}}}}
    expect(() => validateServiceNetworkPolicy(values, 'withdrawal-processor')).to.throw('proofCoordinator')
    values.networkPolicy.allowFrom.proofCoordinator = [pod]
    validateServiceNetworkPolicy(values, 'withdrawal-processor')
  })
})
