import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {validateDeploymentSpecFields} from '../../src/utils/deployment-spec-fields.js'
import {generateAllConfigs, normalizeDeploymentSpec, validateDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  return yaml.load(fs.readFileSync(path.join(root, 'src/config/deployment-spec.minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec
}

describe('DeploymentSpec field validation', () => {
  it('rejects unknown fields before normalization can discard them', () => {
    for (const [input, field] of [
      [{ethereumDA: {}}, 'ethereumDA'],
      [{ethereumDa: {confirmationDepht: 5}}, 'ethereumDa.confirmationDepht'],
      [{frontend: {hosts: {tsso: 'tso.invalid'}}}, 'frontend.hosts.tsso'],
      [{frontend: {externalUrls: {l2Rcp: 'https://rpc.invalid'}}}, 'frontend.externalUrls.l2Rcp'],
      [{dstackController: {monitoring: {gpuHosts: {staleAfterSecond: 5}}}}, 'dstackController.monitoring.gpuHosts.staleAfterSecond'],
      [{signing: {cubesigner: {roles: [{keys: [{keyID: 'placeholder'}]}]}}}, 'signing.cubesigner.roles[0].keys[0].keyID'],
      [{proofTopology: {deployment: {workerTolerations: [{affect: 'NoSchedule'}]}}}, 'proofTopology.deployment.workerTolerations[0].affect'],
    ] as const) {
      expect(validateDeploymentSpecFields(input).map(error => error.path)).to.include(field)
    }

    const spec = fixture()
    Object.assign(spec.frontend, {hosts: {tsso: 'tso.invalid'}})
    expect(validateDeploymentSpec(spec).valid).to.equal(false)
    expect(() => normalizeDeploymentSpec(spec)).to.throw('frontend.hosts.tsso')
  })

  it('preserves dictionary keys and supported optional, legacy and nested inputs', () => {
    const errors = validateDeploymentSpecFields({
      bridge: {feeRateSatPerKvb: 1, fees: {deposit: '0'}},
      dstackController: {serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'NONFUNCTIONAL_ROLE_PLACEHOLDER'}}, tolerations: [{key: 'gpu', operator: 'Exists'}]},
      metadata: {tags: {'custom.org/team': 'example'}},
      proofTopology: {deployment: {workerNodeSelector: {'custom.org/gpu': 'yes'}, workerResources: {limits: {'example.org/device': 1, memory: '1Gi'}}}},
    })
    expect(errors).to.deep.equal([])
    for (const file of ['deployment-spec.minimal.yaml', 'deployment-spec.example.yaml']) {
      const spec = yaml.load(fs.readFileSync(path.join(root, 'src/config', file), 'utf8'))
      expect(validateDeploymentSpecFields(spec), file).to.deep.equal([])
    }
  })

  it('reports malformed containers without including their contents', () => {
    const placeholder = 'NONFUNCTIONAL_SENSITIVE_VALUE'
    for (const input of [null, [], 'invalid', {signing: {cubesigner: {roles: {privateKey: placeholder}}}}, {ethereumDa: null}, {metadata: {tags: []}}]) {
      const errors = validateDeploymentSpecFields(input)
      expect(errors).not.to.have.length(0)
      expect(JSON.stringify(errors)).not.to.include(placeholder)
    }
  })

  it('rejects the unused TSO URL with guidance and keeps public ingress separate from internal consumers', () => {
    const spec = fixture()
    spec.signing.tsoServiceUrl = 'https://unused.invalid'
    expect(validateDeploymentSpec(spec).errors.find(error => error.path === 'signing.tsoServiceUrl')?.message).to.include('frontend.hosts.tso')
    expect(() => generateAllConfigs(spec)).to.throw('signing.tsoServiceUrl')
    expect(() => generateValuesFiles(spec)).to.throw('signing.tsoServiceUrl')
    delete spec.signing.tsoServiceUrl
    Object.assign(spec.frontend, {hosts: {tso: 'public-tso.invalid'}})
    const files = generateValuesFiles(spec)
    expect(files['tso-service-production.yaml']).to.include('public-tso.invalid')
    expect(files['withdrawal-processor-production.yaml']).to.include('http://tso-service:3000')
    expect(files['cubesigner-signer-production.yaml']).to.include('http://tso-service:3000')
  })

  it('rejects invalid input in every CLI output mode before creating output files', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-field-validation-'))
    try {
      const spec = fixture()
      Object.assign(spec.ethereumDa!, {confirmationDepht: 'NONFUNCTIONAL_SENSITIVE_VALUE'})
      const source = path.join(scratch, 'intent.yaml')
      fs.writeFileSync(source, yaml.dump(spec))
      for (const mode of ['--config-only', '--with-values', '--values-only', '--dry-run']) {
        const output = path.join(scratch, mode.slice(2))
        const result = spawnSync(process.execPath, [path.join(root, 'bin/run.js'), 'setup', 'generate-from-spec', '--spec', source, '--output', output, mode, '--json'], {
          cwd: scratch, encoding: 'utf8', env: {OCLIF_TEST_ROOT: root, PATH: process.env.PATH},
        })
        expect(result.status, mode).not.to.equal(0)
        expect(result.stdout + result.stderr).to.include('ethereumDa.confirmationDepht')
        expect(result.stdout + result.stderr).not.to.include('NONFUNCTIONAL_SENSITIVE_VALUE')
        expect(fs.existsSync(output)).to.equal(false)
      }
    } finally {fs.rmSync(scratch, {force: true, recursive: true})}
  })
})
