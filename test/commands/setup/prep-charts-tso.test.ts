/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise the command's dynamic production YAML pass. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'

const BODY_SIZE = 'nginx.ingress.kubernetes.io/proxy-body-size'

describe('setup prep-charts TSO ingress body limit', () => {
  const cases: Array<{main: any; name: string; size: null | string | undefined}> = [
    {main: {}, name: 'legacy ingress without annotations', size: '16m'},
    {main: {annotations: {}}, name: 'empty annotations', size: '16m'},
    ...['8m', '1m', '0', null].map(size => ({main: {annotations: {[BODY_SIZE]: size}}, name: `override ${size}`, size})),
    {main: {enabled: false}, name: 'disabled ingress', size: undefined},
    {main: {ingressClassName: 'traefik'}, name: 'other ingress controller', size: undefined},
    {main: {annotations: {'kubernetes.io/ingress.class': 'traefik'}, ingressClassName: undefined}, name: 'legacy other controller', size: undefined},
  ]

  for (const service of ['tso-service', 'proof-coordinator']) it(`prepares the ${service} ALB edge without nginx or TLS Secret leakage`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-alb-'))
    try {
      const file = path.join(directory, `${service}-production.yaml`)
      const certificate = 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
      fs.writeFileSync(file, yaml.dump({
        env: [{name: 'DOGE_NETWORK', value: 'testnet'}],
        ingress: {main: {
          annotations: {[BODY_SIZE]: '4m', 'alb.ingress.kubernetes.io/certificate-arn': certificate, 'cert-manager.io/cluster-issuer': 'stale'},
          enabled: true,
          hosts: [{host: 'old.example.invalid', paths: [{path: '/', pathType: 'Prefix'}]}],
          ingressClassName: 'alb',
          tls: [{secretName: 'stale-tls'}],
        }},
      }))
      const command: any = Object.create(PrepCharts.prototype)
      Object.assign(command, {
        configData: {general: {CHAIN_ID_L2: 1234}, ingress: {PROOF_COORDINATOR_HOST: 'proof.example.invalid', TSO_HOST: 'tso.example.invalid'}},
        dogeConfig: {network: 'testnet'},
        jsonCtx: {info() {}, logSuccess() {}},
        jsonMode: true,
        log() {},
        nonInteractive: true,
      })
      await command.processProductionYaml(directory)
      const first = fs.readFileSync(file, 'utf8')
      const actual = (yaml.load(first) as any).ingress.main
      expect(actual.ingressClassName).to.equal('alb')
      expect(actual.tls).to.equal(undefined)
      expect(actual.annotations['alb.ingress.kubernetes.io/certificate-arn']).to.equal(certificate)
      expect(actual.annotations[BODY_SIZE]).to.equal(undefined)
      expect(actual.annotations['cert-manager.io/cluster-issuer']).to.equal(undefined)
      if (service === 'tso-service') expect(actual.hosts[0].paths).to.deep.equal([{path: '/health', pathType: 'Exact'}, {path: '/signer', pathType: 'Prefix'}])
      else expect(actual.annotations['alb.ingress.kubernetes.io/load-balancer-attributes']).to.equal('idle_timeout.timeout_seconds=120')
      expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 1, updated: 0})
      expect(fs.readFileSync(file, 'utf8')).to.equal(first)
      const invalid = yaml.load(first) as any
      invalid.ingress.main.annotations['alb.ingress.kubernetes.io/certificate-arn'] = '<TODO>'
      fs.writeFileSync(file, yaml.dump(invalid))
      let error: unknown
      try {await command.processProductionYaml(directory)} catch (error_) {error = error_}
      expect(String(error)).to.include('issued ACM certificate ARN')
    } finally {
      fs.rmSync(directory, {force: true, recursive: true})
    }
  })

  for (const fixture of cases) {
    it(`preserves annotations and is idempotent for ${fixture.name}`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-tso-'))
      try {
        const file = path.join(directory, 'tso-service-production.yaml')
        const main = fixture.main && {
          ingressClassName: 'nginx',
          ...fixture.main,
          annotations: {'cert-manager.io/cluster-issuer': 'operator-issuer', ...fixture.main.annotations},
          hosts: [{host: 'old.example.com', paths: [{path: '/', pathType: 'Prefix'}]}],
          tls: [{hosts: ['old.example.com'], secretName: 'operator-tls'}],
        }
        fs.writeFileSync(file, yaml.dump({
          env: [{name: 'DOGE_NETWORK', value: 'testnet'}],
          ...(main ? {ingress: {main}} : {}),
        }))
        const command: any = Object.create(PrepCharts.prototype)
        Object.assign(command, {
          configData: {general: {CHAIN_ID_L2: 1234}, ingress: {TSO_HOST: 'tso.example.com'}},
          dogeConfig: {network: 'testnet'},
          jsonCtx: {info() {}, logSuccess() {}},
          jsonMode: true,
          log() {},
          nonInteractive: true,
        })
        await command.processProductionYaml(directory)
        const first = fs.readFileSync(file, 'utf8')
        const generated = (yaml.load(first) as any).ingress.main
        expect(generated.annotations?.[BODY_SIZE]).to.equal(fixture.size)
        if (main) {
          expect(generated.annotations['cert-manager.io/cluster-issuer']).to.equal('operator-issuer')
          expect(generated.hosts[0].host).to.equal('tso.example.com')
          expect(generated.tls).to.deep.equal([{hosts: ['tso.example.com'], secretName: 'operator-tls'}])
          expect(generated.enabled).to.equal(main.enabled)
          expect(generated.ingressClassName).to.equal(main.ingressClassName || main.annotations['kubernetes.io/ingress.class'])
        }

        expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 1, updated: 0})
        expect(fs.readFileSync(file, 'utf8')).to.equal(first)
      } finally {
        fs.rmSync(directory, {force: true, recursive: true})
      }
    })
  }
})
