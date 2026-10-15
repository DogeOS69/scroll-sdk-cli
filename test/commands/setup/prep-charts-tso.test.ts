/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise the command's dynamic production YAML pass. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'

const BODY_SIZE = 'nginx.ingress.kubernetes.io/proxy-body-size'

describe('setup prep-charts ALB edges', () => {
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
        networkPolicy: {allowFrom: {edge: [{ipBlock: {cidr: '10.0.1.0/24'}}], signers: [{podSelector: {matchLabels: {app: 'signer'}}}], withdrawalProcessor: [{podSelector: {matchLabels: {app: 'wp'}}}]}, enabled: true},
      }))
      const command: any = Object.create(PrepCharts.prototype)
      Object.assign(command, {
        configData: {general: {CHAIN_ID_L2: 1234}, ingress: {PROOF_COORDINATOR_HOST: 'proof.example.invalid', TSO_HOST: 'tso.example.invalid'}},
        dogeConfig: {ethereumRpcSecretStore: {prefix: 'dogeos/fixture/default/bridge', provider: 'aws'}, network: 'testnet'},
        flags: {},
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
      command.flags['proof-preparation'] = true
      if (service === 'tso-service') {
        invalid.networkPolicy.allowFrom.edge = [{ipBlock: {cidr: '<TODO>'}}]
        fs.writeFileSync(file, yaml.dump(invalid))
      }

      await command.processProductionYaml(directory)
      expect((yaml.load(fs.readFileSync(file, 'utf8')) as any).ingress.main.annotations['alb.ingress.kubernetes.io/certificate-arn']).to.equal('<TODO>')
      command.flags['proof-preparation'] = false
      error = undefined
      try {await command.processProductionYaml(directory)} catch (error_) {error = error_}
      expect(String(error)).to.include('issued ACM certificate ARN')
    } finally {
      fs.rmSync(directory, {force: true, recursive: true})
    }
  })

})
