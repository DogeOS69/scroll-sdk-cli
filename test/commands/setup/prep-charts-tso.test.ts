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
    {main: undefined, name: 'inherited chart ingress', size: '4m'},
    {main: {}, name: 'legacy ingress without annotations', size: '4m'},
    {main: {annotations: {}}, name: 'empty annotations', size: '4m'},
    ...['8m', '1m', '0', null].map(size => ({main: {annotations: {[BODY_SIZE]: size}}, name: `override ${size}`, size})),
    {main: {enabled: false}, name: 'disabled ingress', size: undefined},
    {main: {ingressClassName: 'traefik'}, name: 'other ingress controller', size: undefined},
    {main: {annotations: {'kubernetes.io/ingress.class': 'traefik'}}, name: 'legacy other controller', size: undefined},
  ]

  for (const fixture of cases) {
    it(`preserves annotations and is idempotent for ${fixture.name}`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-tso-'))
      try {
        const file = path.join(directory, 'tso-service-production.yaml')
        const main = fixture.main && {
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
          expect(generated.ingressClassName).to.equal(main.ingressClassName)
        }

        expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 1, updated: 0})
        expect(fs.readFileSync(file, 'utf8')).to.equal(first)
      } finally {
        fs.rmSync(directory, {force: true, recursive: true})
      }
    })
  }
})
