/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect rendered Kubernetes YAML. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {buildProofCoordinatorIngress} from '../../src/utils/proof-coordinator-ingress.js'

const chart = path.resolve('../scroll-sdk/charts/proof-coordinator')

describe('Proof Coordinator ingress chart contract', () => {
  for (const controller of ['alb']) it(`renders a numeric backend and the selected ${controller} TLS contract`, function () {
    if (!fs.existsSync(path.join(chart, 'charts/common-1.5.1.tgz'))) this.skip()
    try {execFileSync('helm', ['version', '--short'], {stdio: 'ignore'})} catch {this.skip()}
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-ingress-helm-'))
    try {
      const values = {
        ingress: {main: buildProofCoordinatorIngress('prover.example.com', {annotations: controller === 'alb' ? {'alb.ingress.kubernetes.io/certificate-arn': 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'} : {}, ingressClassName: controller})},
        proofCoordinator: {config: {existingConfigMap: 'fixture-proof-config'}},
        service: {main: {enabled: true, ports: {http: {enabled: false}, prover: {enabled: true, port: 7788, primary: true, targetPort: 7788}}}},
      }
      const input = path.join(dir, 'values.yaml')
      fs.writeFileSync(input, yaml.dump(values))
      const manifests = yaml.loadAll(execFileSync('helm', ['template', 'custom-proof-release', chart, '-f', input], {encoding: 'utf8'})) as any[]
      const ingress = manifests.find(item => item?.kind === 'Ingress')
      const backend = ingress.spec.rules[0].http.paths[0].backend.service
      const service = manifests.find(item => item?.kind === 'Service' && item.metadata.name === backend.name)
      expect(backend.port).to.deep.equal({number: 7788})
      expect(service.spec.ports.map((port: any) => port.port)).to.deep.equal([7788])
      expect(ingress.spec.rules[0].host).to.equal('prover.example.com')
      expect(ingress.spec.ingressClassName).to.equal(controller)
      if (controller === 'nginx') expect(ingress.spec.tls[0].hosts).to.deep.equal(['prover.example.com'])
      else {
        expect(ingress.spec.tls).to.equal(undefined)
        expect(ingress.metadata.annotations['alb.ingress.kubernetes.io/load-balancer-attributes']).to.equal('idle_timeout.timeout_seconds=120')
      }
    } finally {
      fs.rmSync(dir, {force: true, recursive: true})
    }
  })
})
