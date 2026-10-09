/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect TOML/YAML runtime projections. */
import * as toml from '@iarna/toml'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {buildTsoSigners} from '../../src/commands/setup/prep-charts.js'
import {generateDogeConfigToml, generateSetupDefaultsToml, normalizeDeploymentSpec, validateDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {resolveSpecAttestationSigners} from '../../src/utils/spec-attestation-signers.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = normalizeDeploymentSpec(yaml.load(fs.readFileSync(path.join(cliRoot, 'src/config/deployment-spec.minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec)
  spec.attestationSigners = Array.from({length: 4}, (_, index) => ({attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: `partner-${index}`, transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}))
  spec.bridge.initialAttestationKeyset = {signerIds: ['partner-2', 'partner-0', 'partner-1'], threshold: 2}
  return spec
}

describe('spec attestation signer public identities', () => {
  it('projects the selected key order and registers every signer with its paired transport key', () => {
    const spec = fixture()
    expect(validateDeploymentSpec(spec).valid).to.equal(true)
    const doge = toml.parse(generateDogeConfigToml(spec)) as any
    const setup = toml.parse(generateSetupDefaultsToml(spec)) as any
    const values = yaml.load(generateValuesFiles(spec)['withdrawal-processor-production.yaml']) as any
    expect(setup.attestation_pubkeys).to.deep.equal([2, 0, 1].map(index => spec.attestationSigners![index].attestationPubkey))
    expect(setup.attestation_key_count).to.equal(3)
    expect(setup.attestation_threshold).to.equal(2)
    expect(doge.attestationSigner.activeSignerIds).to.deep.equal(['partner-2', 'partner-0', 'partner-1'])
    expect(doge.attestationSigner.external).to.have.length(4)
    const runtime = buildTsoSigners({attestationSigner: doge.attestationSigner, network: doge.network})
    expect(values.tsoSigners).to.deep.equal(runtime)
    expect(runtime).to.have.length(4)
    for (const [index, signer] of runtime.entries()) {
      expect(signer).to.include({delivery: 'pull', network: spec.dogecoin.network, publicKeyOverride: spec.attestationSigners![index].attestationPubkey, transportPubkey: spec.attestationSigners![index].transportPubkey})
      expect(signer).not.to.have.property('uri')
    }
  })

  it('defaults to all declared signers and the bridge threshold when no subset is selected', () => {
    const spec = fixture()
    delete spec.bridge.initialAttestationKeyset
    spec.bridge.thresholds.attestation = 3
    const resolved = resolveSpecAttestationSigners(spec)!
    expect(resolved.activeSignerIds).to.deep.equal(spec.attestationSigners!.map(signer => signer.name))
    expect(resolved.threshold).to.equal(3)
    const setup = toml.parse(generateSetupDefaultsToml(spec))
    expect(setup.attestation_key_count).to.equal(4)
  })

  it('normalizes public key case and rejects duplicates across both key roles', () => {
    const spec = fixture()
    spec.attestationSigners![0].attestationPubkey = spec.attestationSigners![0].attestationPubkey.toUpperCase()
    expect(resolveSpecAttestationSigners(spec)!.external[0].publicKey).to.equal(spec.attestationSigners![0].attestationPubkey.toLowerCase())
    spec.attestationSigners![1].transportPubkey = spec.attestationSigners![0].attestationPubkey
    expect(() => resolveSpecAttestationSigners(spec)).to.throw('distinct')
  })

  it('rejects malformed keys, duplicate names, unknown selections and impossible thresholds', () => {
    for (const mutate of [
      (s: DeploymentSpec) => {s.attestationSigners![0].attestationPubkey = 'REPLACE_WITH_PUBLIC_KEY'},
      (s: DeploymentSpec) => {s.attestationSigners![0].transportPubkey = '02' + 'ff'.repeat(32)},
      (s: DeploymentSpec) => {s.attestationSigners![1].name = s.attestationSigners![0].name},
      (s: DeploymentSpec) => {s.attestationSigners![0].name = 'Not a stable name'},
      (s: DeploymentSpec) => {s.attestationSigners![0].transportPubkey = s.attestationSigners![0].attestationPubkey},
      (s: DeploymentSpec) => {s.bridge.initialAttestationKeyset!.signerIds = ['unknown']},
      (s: DeploymentSpec) => {s.bridge.initialAttestationKeyset!.signerIds = ['partner-0', 'partner-0']},
      (s: DeploymentSpec) => {s.bridge.initialAttestationKeyset!.threshold = 4},
      (s: DeploymentSpec) => {s.attestationSigners = []},
    ]) {
      const spec = fixture(); mutate(spec)
      expect(() => resolveSpecAttestationSigners(spec)).to.throw()
      expect(validateDeploymentSpec(spec).valid).to.equal(false)
    }
  })

  it('rejects the removed spec file-input field and per-signer fields outside the three-field contract', () => {
    const spec = fixture() as any
    spec.preparation = {attestationDescriptors: ['unused-descriptor.json']}
    expect(validateDeploymentSpec(spec).errors.some(error => error.path.includes('attestationDescriptors'))).to.equal(true)
    delete spec.preparation
    spec.attestationSigners[0].network = 'testnet'
    expect(validateDeploymentSpec(spec).errors.some(error => error.path.includes('network'))).to.equal(true)
  })
})
