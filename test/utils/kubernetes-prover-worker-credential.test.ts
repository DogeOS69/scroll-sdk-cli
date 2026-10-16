import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofDeploymentContract} from '../../src/utils/proof-deployment-contract.js'

import {kubernetesWorkerCredentialTarget, provisionKubernetesWorkerCredential} from '../../src/utils/kubernetes-prover-worker-credential.js'
import {writeProofDeploymentContract} from '../../src/utils/proof-deployment-contract.js'
import {mintWorkerCredential} from '../../src/utils/prover-worker-credential.js'

describe('local Kubernetes worker credential provisioning', () => {
  let root: string
  let originalPath: string | undefined
  const master = 'nonfunctional-test-master-0000000000000000'
  const target = {context: 'test-context', namespace: 'test-namespace', secretName: 'test-worker', workerId: 'worker-1'}
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-credential-test-'))
    originalPath = process.env.PATH
    process.env.PATH = `${root}:${originalPath}`
    fs.writeFileSync(path.join(root, 'kubectl'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(root, 'request.json'))}, JSON.stringify({argv: process.argv.slice(2), input: JSON.parse(fs.readFileSync(0, 'utf8'))}));
`, {mode: 0o700})
  })
  afterEach(() => {
    process.env.PATH = originalPath
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('sends only the worker credential over stdin to an explicit cluster target', () => {
    const credential = mintWorkerCredential(master, target.workerId)
    provisionKubernetesWorkerCredential(target, credential)
    const request = JSON.parse(fs.readFileSync(path.join(root, 'request.json'), 'utf8'))
    expect(request.argv).to.deep.equal(['--context', target.context, '--namespace', target.namespace, 'apply', '--server-side', '--field-manager=scrollsdk-worker-credential', '-f', '-'])
    expect(request.input.metadata).to.deep.equal({name: target.secretName, namespace: target.namespace})
    expect(request.input.data).to.deep.equal({'prover-worker-credential': Buffer.from(credential).toString('base64')})
    expect(JSON.stringify(request)).not.to.include(master)
    expect(request.input.metadata).not.to.have.property('annotations')
  })

  it('rejects raw masters and another worker credential before invoking kubectl', () => {
    expect(() => provisionKubernetesWorkerCredential(target, master)).to.throw('never give a worker the master')
    expect(() => provisionKubernetesWorkerCredential(target, mintWorkerCredential(master, 'worker-2'))).to.throw('does not match')
    expect(fs.existsSync(path.join(root, 'request.json'))).to.equal(false)
  })

  it('sanitizes cluster errors that can contain the entire Secret request', () => {
    fs.writeFileSync(path.join(root, 'kubectl'), '#!/usr/bin/env node\nprocess.stderr.write(require("node:fs").readFileSync(0)); process.exit(1);', {mode: 0o700})
    const credential = mintWorkerCredential(master, target.workerId)
    expect(() => provisionKubernetesWorkerCredential(target, credential)).to.throw('Failed to provision Kubernetes worker credential')
      .with.property('message').that.does.not.include(Buffer.from(credential).toString('base64'))
  })

  it('runs the public command and rejects stale generated bindings before a cluster write', () => {
    for (const name of ['pc', 'wp', 'tso', 'da']) fs.writeFileSync(path.join(root, name + '.yaml'), '{}')
    fs.writeFileSync(path.join(root, 'worker.yaml'), JSON.stringify({persistence: {'prover-worker-token': {items: [{key: 'prover-worker-credential', path: 'credential'}], name: target.secretName, type: 'secret'}}}))
    fs.writeFileSync(path.join(root, 'worker.json'), JSON.stringify({argv: ['--worker-id', target.workerId]}))
    fs.writeFileSync(path.join(root, 'manifest.json'), '{}')
    fs.writeFileSync(path.join(root, 'resolved.json'), '{}')
    const component = (name: string) => ({enabled: true, valuesFile: path.join(root, name + '.yaml')})
    writeProofDeploymentContract({
      deploymentDir: root, enforcement: 'observe', ethDaSubmitter: component('da'), generation: 'real',
      intentSource: {kind: 'doge-config', path: 'fixture.toml', sha256: 'a'.repeat(64)}, mode: 'active',
      proofCoordinator: component('pc'), proverWorker: component('worker'),
      topology: {bundleDir: root, bundleManifest: path.join(root, 'manifest.json'), bundleRevision: 'b'.repeat(64), resolvedSidecar: path.join(root, 'resolved.json')},
      tsoValuesFile: path.join(root, 'tso.yaml'), withdrawalProcessor: component('wp'),
      worker: {contractFile: path.join(root, 'worker.json'), kind: 'compiled-local'},
    })
    const credential = mintWorkerCredential(master, target.workerId)
    const run = () => spawnSync(process.execPath, [path.resolve('bin/run.js'), 'setup', 'proof-worker', '--deployment-dir', root,
      '--kube-context', target.context, '--namespace', target.namespace, '--json'], {encoding: 'utf8', env: {...process.env, DOGEOS_PROVER_WORKER_TOKEN: credential}})
    const success = run()
    expect(success.status, success.stderr + success.stdout).to.equal(0)
    expect(success.stdout).to.include(target.secretName).and.not.to.include(credential)
    expect(fs.existsSync(path.join(root, 'request.json'))).to.equal(true)
    fs.unlinkSync(path.join(root, 'request.json'))
    fs.writeFileSync(path.join(root, 'worker.json'), JSON.stringify({argv: ['--worker-id', 'changed-worker']}))
    const failure = run()
    expect(failure.status).not.to.equal(0)
    expect(failure.stdout + failure.stderr).to.include('Worker contract checksum mismatch').and.not.to.include(credential)
    expect(fs.existsSync(path.join(root, 'request.json'))).to.equal(false)
  })

  it('takes the worker id and Secret binding from generated output, requiring explicit cluster selection', () => {
    const contract = {components: {proofCoordinator: {valuesFile: 'coordinator.yaml'}, proverWorker: {enabled: true, valuesFile: 'worker.yaml'}}, worker: {contractFile: 'worker.json', enabled: true, kind: 'compiled-local'}} as ProofDeploymentContract
    fs.writeFileSync(path.join(root, 'coordinator.yaml'), '{}')
    fs.writeFileSync(path.join(root, 'worker.json'), JSON.stringify({argv: ['--worker-id', target.workerId]}))
    fs.writeFileSync(path.join(root, 'worker.yaml'), JSON.stringify({persistence: {'prover-worker-token': {items: [{key: 'prover-worker-credential', path: 'credential'}], name: target.secretName, type: 'secret'}}}))
    expect(kubernetesWorkerCredentialTarget(root, contract, target.context, target.namespace)).to.deep.equal(target)
    expect(() => kubernetesWorkerCredentialTarget(root, contract)).to.throw('explicit --kube-context and --namespace')
    fs.writeFileSync(path.join(root, 'coordinator.yaml'), JSON.stringify({persistence: {master: {name: target.secretName, type: 'secret'}}}))
    expect(() => kubernetesWorkerCredentialTarget(root, contract, target.context, target.namespace)).to.throw('separate from coordinator Secrets')
    fs.writeFileSync(path.join(root, 'coordinator.yaml'), '{}')
    fs.writeFileSync(path.join(root, 'worker.yaml'), JSON.stringify({persistence: {'prover-worker-token': {items: [{key: 'prover-worker-token', path: 'master'}], name: 'coordinator', type: 'secret'}}}))
    expect(() => kubernetesWorkerCredentialTarget(root, contract, target.context, target.namespace)).to.throw('only its credential key')
  })
})
