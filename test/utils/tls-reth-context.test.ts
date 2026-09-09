import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import SetupTls from '../../src/commands/setup/tls.js'

describe('TLS Reth generation', () => {
  it('updates Reth HTTP/WebSocket ingress and retains the explicit context', async () => {
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
        'cluster-issuer': 'letsencrypt-prod',
        json: true,
        'kube-context': 'arn:aws:eks:us-east-1:123456789012:cluster/devnet',
        'non-interactive': true,
        'values-dir': path.relative(process.cwd(), root),
      }})
      command.kubectl = async (args: string[]) => {
        expect(command.kubeContext).to.equal('arn:aws:eks:us-east-1:123456789012:cluster/devnet')
        expect(args).to.deep.equal(['get', 'clusterissuer', '-o', 'jsonpath={.items[*].metadata.name}'])
        return {stdout: 'letsencrypt-prod'}
      }

      await command.run()
      const result = yaml.load(fs.readFileSync(file, 'utf8')) as any
      for (const [kind, hostname, secret] of [
        ['main', 'rpc.devnet.example', 'l2-reth-rpc-public-tls'],
        ['websocket', 'ws.rpc.devnet.example', 'l2-reth-rpc-public-websocket-tls'],
      ]) {
        expect(result.ingress[kind].annotations['cert-manager.io/cluster-issuer']).to.equal('letsencrypt-prod')
        expect(result.ingress[kind].tls).to.deep.equal([{hosts: [hostname], secretName: secret}])
      }

      const first = fs.readFileSync(file, 'utf8')
      await command.run()
      expect(fs.readFileSync(file, 'utf8')).to.equal(first)
    } finally {
      fs.rmSync(root, {force: true, recursive: true})
    }
  })
})
