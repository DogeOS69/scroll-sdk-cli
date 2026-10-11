import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import SetupTls from '../../src/commands/setup/tls.js'

describe('ACM TLS generation', () => {
  it('updates Reth HTTP/WebSocket ingress without accessing Kubernetes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dogeos-tls-test-'))
    try {
      const file = path.join(root, 'l2-reth-rpc-public-production.yaml')
      fs.writeFileSync(file, yaml.dump({ingress: {
        main: {hosts: [{host: 'rpc.devnet.example'}]},
        websocket: {hosts: [{host: 'ws.rpc.devnet.example'}]},
      }}))
      // Exercise the command without contacting Kubernetes or requiring an
      // installed oclif manifest. The real issuer query is tested in rollout.
      const command = Object.create(SetupTls.prototype) as any
      command.parse = async () => ({flags: {
        'certificate-arn': 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
        json: true,
        'kube-context': 'arn:aws:eks:us-east-1:123456789012:cluster/devnet',
        'non-interactive': true,
        'values-dir': path.relative(process.cwd(), root),
      }})
      command.log = () => {}
      command.kubectl = async (args: string[]) => {
        expect(command.kubeContext).to.equal('arn:aws:eks:us-east-1:123456789012:cluster/devnet')
        expect(args).to.deep.equal(['get', 'clusterissuer', '-o', 'jsonpath={.items[*].metadata.name}'])
        return {stdout: 'letsencrypt-prod'}
      }

      await command.run()
      const result = yaml.load(fs.readFileSync(file, 'utf8')) as any
      for (const kind of ['main', 'websocket']) {
        expect(result.ingress[kind].ingressClassName).to.equal('alb')
        expect(result.ingress[kind].annotations['alb.ingress.kubernetes.io/certificate-arn']).to.include('arn:aws:acm:')
        expect(result.ingress[kind].tls).to.equal(undefined)
      }

      const first = fs.readFileSync(file, 'utf8')
      await command.run()
      expect(fs.readFileSync(file, 'utf8')).to.equal(first)
    } finally {
      fs.rmSync(root, {force: true, recursive: true})
    }
  })
  it('does not open private endpoints and validates every enabled file before writing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-atomic-'))
    try {
      const privateFile = path.join(root, 'scroll-monitor-production.yaml')
      fs.writeFileSync(privateFile, yaml.dump({grafana: {ingress: {enabled: false, ingressClassName: 'alb'}}}))
      const goodFile = path.join(root, 'frontends-production.yaml')
      fs.writeFileSync(goodFile, yaml.dump({ingress: {main: {enabled: true, ingressClassName: 'alb'}}}))
      const badFile = path.join(root, 'tso-service-production.yaml')
      fs.writeFileSync(badFile, yaml.dump({ingress: {main: {enabled: true, ingressClassName: 'nginx'}}}))
      const before = [privateFile, goodFile, badFile].map(file => fs.readFileSync(file, 'utf8'))
      const command = Object.create(SetupTls.prototype) as any
      command.parse = async () => ({flags: {'certificate-arn': 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000', 'non-interactive': true, 'values-dir': root}})
      command.log = () => {}
      let failure: unknown
      try {await command.run()} catch (error) {failure = error}
      expect(String(failure)).to.include('unsupported')
      expect([privateFile, goodFile, badFile].map(file => fs.readFileSync(file, 'utf8'))).to.deep.equal(before)
      fs.unlinkSync(badFile)
      await command.run()
      expect(fs.readFileSync(privateFile, 'utf8')).to.equal(before[0])
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

})
