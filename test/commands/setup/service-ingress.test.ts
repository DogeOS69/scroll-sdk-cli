/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise command configuration paths with isolated fixtures. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'

import SetupDomains from '../../../src/commands/setup/domains.js'
import TestIngress from '../../../src/commands/test/ingress.js'
import {stripRetiredServiceConfig} from '../../../src/utils/retired-services.js'

const execFileAsync = promisify(execFile)
const cli = path.resolve('bin/run.js')

describe('active service ingress configuration', () => {
  for (const shared of [true, false]) {
    it(`preserves explicit TSO and proof hosts and omits retired prompts (shared domain: ${shared})`, async () => {
      const command = Object.create(SetupDomains.prototype) as any
      const existing = {
        frontend: {EXTERNAL_EXPLORER_URI_L1: 'https://doge-explorer.example'},
        ingress: {
          ...(shared ? {FRONTEND_HOST: 'portal.example.com'} : {}),
          ADMIN_SYSTEM_DASHBOARD_HOST: 'old-admin', BLOCKSCOUT_BACKEND_HOST: 'old-backend',
          COORDINATOR_API_HOST: 'old-coordinator', L1_EXPLORER_HOST: 'old-explorer',
          PROOF_COORDINATOR_HOST: 'provers.example.com', ROLLUP_EXPLORER_API_HOST: 'old-rollup',
          TSO_HOST: 'signer-callback.example.com',
        },
      }
      const result = await command.setupSharedConfigs(existing, false, {enabled: true, missingFields: []})
      expect(result.ingressConfig.PROOF_COORDINATOR_HOST).to.equal('provers.example.com')
      expect(result.ingressConfig.TSO_HOST).to.equal('signer-callback.example.com')
      expect(JSON.stringify(result)).not.to.match(/old-admin|old-backend|old-coordinator|old-explorer|old-rollup|L1_EXPLORER_HOST/)
      const cleaned = stripRetiredServiceConfig(existing)
      expect(cleaned.frontend.EXTERNAL_EXPLORER_URI_L1).to.equal('https://doge-explorer.example')
      expect(cleaned.ingress).to.include({PROOF_COORDINATOR_HOST: 'provers.example.com', TSO_HOST: 'signer-callback.example.com'})
      expect(JSON.stringify(cleaned)).not.to.include('old-')
    })
  }

  it('updates both active service TLS files through the CLI without touching retired files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-ingress-tls-'))
    try {
      fs.mkdirSync(path.join(root, 'bin'))
      fs.mkdirSync(path.join(root, 'values'))
      fs.writeFileSync(path.join(root, 'bin/kubectl'), '#!/bin/sh\nif [ "$1" = get ] && [ "$2" = clusterissuer ]; then echo letsencrypt-prod; else exit 99; fi\n', {mode: 0o755})
      const retired = ['admin-system-dashboard', 'coordinator-api', 'rollup-explorer-backend', 'l1-explorer']
      for (const service of ['tso-service', 'proof-coordinator', ...retired]) {
        fs.writeFileSync(path.join(root, 'values', `${service}-production.yaml`), yaml.dump({ingress: {main: {enabled: true, hosts: [{host: `${service}.example.com`, paths: [{path: '/'}]}]}}}))
      }

      const before = retired.map(service => fs.readFileSync(path.join(root, 'values', `${service}-production.yaml`), 'utf8'))
      await execFileAsync('node', [cli, 'setup', 'tls', '-N', '--json', '--cluster-issuer', 'letsencrypt-prod'], {
        cwd: root, env: {...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`},
      })
      for (const service of ['tso-service', 'proof-coordinator']) {
        const values = yaml.load(fs.readFileSync(path.join(root, 'values', `${service}-production.yaml`), 'utf8')) as any
        expect(values.ingress.main.annotations['cert-manager.io/cluster-issuer']).to.equal('letsencrypt-prod')
        expect(values.ingress.main.tls).to.deep.equal([{hosts: [`${service}.example.com`], secretName: `${service}-tls`}])
      }

      expect(retired.map(service => fs.readFileSync(path.join(root, 'values', `${service}-production.yaml`), 'utf8'))).to.deep.equal(before)
    } finally {
      fs.rmSync(root, {force: true, recursive: true})
    }
  })

  it('checks the service health endpoints rather than their API roots', async () => {
    const command = Object.create(TestIngress.prototype) as any
    command.log = () => {}
    const original = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = async input => {
      requested.push(String(input))
      return new Response('', {status: /\/healthz?$/.test(String(input)) ? 200 : 404})
    }

    try {
      expect(await command.checkHost('tso.example.com', 'tso-service')).to.equal(true)
      expect(await command.checkHost('proof.example.com', 'proof-coordinator')).to.equal(true)
      expect(requested).to.deep.equal(['http://tso.example.com/health', 'https://tso.example.com/health', 'http://proof.example.com/healthz', 'https://proof.example.com/healthz'])
    } finally {
      globalThis.fetch = original
    }
  })
})
