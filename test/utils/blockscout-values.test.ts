/* eslint-disable @typescript-eslint/no-explicit-any -- Chart fixture. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {reconcileBlockscoutFrontend} from '../../src/utils/blockscout-values.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

describe('Blockscout frontend environment', () => {
  it('generates canonical network values and an application host from the spec', () => {
    const spec = yaml.load(fs.readFileSync(new URL('../fixtures/deployment-spec/minimal.yaml', import.meta.url), 'utf8')
      .replaceAll('$ENV:OWNER_ADDRESS', `0x${'e'.repeat(40)}`).replaceAll(/\$ENV:\w+/g, 'NONFUNCTIONAL_TEST')) as DeploymentSpec
    spec.frontend.hosts = {...spec.frontend.hosts, blockscout: 'explorer.example.invalid'}
    const stack = (yaml.load(generateValuesFiles(spec)['blockscout-production.yaml']) as any)['blockscout-stack']
    expect(stack.config.network.id).to.equal(String(spec.network.l2ChainId))
    expect(stack.config.network.name).to.equal(spec.network.l2ChainName)
    expect(stack.frontend.env.NEXT_PUBLIC_APP_HOST).to.equal(spec.frontend.hosts.blockscout)
    expect(stack.frontend.env).not.to.have.any.keys('NEXT_PUBLIC_NETWORK_ID', 'NEXT_PUBLIC_NETWORK_NAME', 'PROMETHEUS_METRICS_ENABLED')
  })

  for (const enabled of [false, true]) {
    it(`keeps environment names unique with ingress enabled=${enabled}`, () => {
      const stack: any = {blockscout: {ingress: {enabled}}, frontend: {env: {
        CUSTOM: 'preserved', NEXT_PUBLIC_API_HOST: 'old', NEXT_PUBLIC_APP_HOST: 'old',
        NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL: 'DOGE', NEXT_PUBLIC_NETWORK_ID: 1, NEXT_PUBLIC_NETWORK_NAME: 'old', PROMETHEUS_METRICS_ENABLED: 'false',
      }, ingress: {enabled}}}
      expect(reconcileBlockscoutFrontend(stack, 'explorer.example.invalid', 'Example', 1_122_005)).to.equal(true)
      expect(stack.config.network).to.include({id: '1122005', name: 'Example'})
      expect(stack.config.network.currency.symbol).to.equal('DOGE')
      expect(stack.frontend.env).to.deep.equal(enabled ? {CUSTOM: 'preserved'} : {
        CUSTOM: 'preserved', NEXT_PUBLIC_API_HOST: 'explorer.example.invalid', NEXT_PUBLIC_APP_HOST: 'explorer.example.invalid',
      })
      expect(reconcileBlockscoutFrontend(stack, 'explorer.example.invalid', 'Example', 1_122_005)).to.equal(false)
    })
  }

  it('preserves explicit canonical currency and disabled metrics', () => {
    const stack: any = {config: {network: {currency: {decimals: 8, name: 'Custom', symbol: 'C'}}, prometheus: {enabled: false}}, frontend: {env: {PROMETHEUS_METRICS_ENABLED: 'false'}}}
    reconcileBlockscoutFrontend(stack, 'explorer.example.invalid', 'Example', '1122005')
    expect(stack.config.network.currency).to.deep.equal({decimals: 8, name: 'Custom', symbol: 'C'})
    expect(stack.frontend.env.PROMETHEUS_METRICS_ENABLED).to.equal('false')
  })
})
