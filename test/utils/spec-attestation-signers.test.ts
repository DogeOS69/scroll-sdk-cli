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
import {generateValuesFiles, generateWithdrawalProcessorValues} from '../../src/utils/values-generator.js'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(): DeploymentSpec {
  const spec = normalizeDeploymentSpec(yaml.load(fs.readFileSync(path.join(cliRoot, 'test/fixtures/deployment-spec/minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec)
  spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
  spec.bridge.attestation.signers = [2, 0, 1].map(index => ({attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: `partner-${index}`, transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}))
  spec.bridge.attestation.threshold = 2
  return spec
}

describe('spec attestation signer public identities', () => {
  it('projects the selected key order and registers every signer with its paired transport key', () => {
    const spec = fixture()
    expect(validateDeploymentSpec(spec).valid).to.equal(true)
    const doge = toml.parse(generateDogeConfigToml(spec)) as any
    const setup = toml.parse(generateSetupDefaultsToml(spec)) as any
    const values = yaml.load(generateValuesFiles(spec)['withdrawal-processor-production.yaml']) as any
    expect(setup.attestation_pubkeys).to.deep.equal(spec.bridge.attestation.signers.map(signer => signer.attestationPubkey))
    expect(setup.attestation_key_count).to.equal(3)
    expect(setup.attestation_threshold).to.equal(2)
    expect(doge.attestationSigner.activeSignerIds).to.deep.equal(['partner-2', 'partner-0', 'partner-1'])
    expect(doge.attestationSigner.external).to.have.length(3)
    const runtime = buildTsoSigners({attestationSigner: doge.attestationSigner, network: doge.network})
    expect(values.tsoSigners).to.deep.equal(runtime)
    expect(runtime).to.have.length(3)
    for (const [index, signer] of runtime.entries()) {
      expect(signer).to.include({delivery: 'pull', network: spec.dogecoin.network, publicKeyOverride: spec.bridge.attestation.signers![index].attestationPubkey, transportPubkey: spec.bridge.attestation.signers![index].transportPubkey})
      expect(signer).not.to.have.property('uri')
    }
  })

  it('projects recovery keys in order and derives their count from the list', () => {
    const spec = fixture()
    spec.bridge.recovery = {publicKeys: Array.from({length: 3}, () => new bitcore.PrivateKey().toPublicKey().toString()), threshold: 2, timelock: 1_234_567}
    const setup = toml.parse(generateSetupDefaultsToml(spec))
    expect(setup.recovery_pubkeys).to.deep.equal(spec.bridge.recovery.publicKeys)
    expect(setup.recovery_key_count).to.equal(3)
    expect(setup.recovery_threshold).to.equal(2)
    expect(setup.timelock).to.equal(1_234_567)
    expect(validateDeploymentSpec(spec).valid).to.equal(true)
    spec.bridge.recovery.publicKeys[1] = spec.bridge.recovery.publicKeys[0]
    expect(validateDeploymentSpec(spec).errors.some(error => error.path === 'bridge.recovery.publicKeys')).to.equal(true)
    spec.bridge.recovery.publicKeys[1] = 'NONFUNCTIONAL_INVALID_KEY'
    expect(validateDeploymentSpec(spec).errors.some(error => error.path === 'bridge.recovery.publicKeys')).to.equal(true)
    spec.bridge.recovery.threshold = 4
    expect(validateDeploymentSpec(spec).errors.some(error => error.path === 'bridge.recovery')).to.equal(true)
  })

  it('writes canonical mainnet into tsoSigners, matching prep-charts', () => {
    const spec = fixture()
    spec.dogecoin.network = 'mainnet'
    const doge = toml.parse(generateDogeConfigToml(spec)) as any
    // Only the WP values: the full set refuses the example's devnet CubeSigner mode on mainnet.
    const values = yaml.load(generateWithdrawalProcessorValues(spec)) as any
    expect(values.tsoSigners.map((signer: any) => signer.network)).to.deep.equal(values.tsoSigners.map(() => 'mainnet'))
    expect(values.tsoSigners).to.deep.equal(buildTsoSigners({attestationSigner: doge.attestationSigner, network: doge.network}))
  })

  it('uses every listed signer as an initial member', () => {
    const spec = fixture()
    spec.bridge.attestation.threshold = 3
    const resolved = resolveSpecAttestationSigners(spec)!
    expect(resolved.activeSignerIds).to.deep.equal(spec.bridge.attestation.signers!.map(signer => signer.name))
    expect(resolved.threshold).to.equal(3)
    const setup = toml.parse(generateSetupDefaultsToml(spec))
    expect(setup.attestation_key_count).to.equal(3)
  })

  it('normalizes public key case and rejects duplicates across both key roles', () => {
    const spec = fixture()
    spec.bridge.attestation.signers![0].attestationPubkey = spec.bridge.attestation.signers![0].attestationPubkey.toUpperCase()
    expect(resolveSpecAttestationSigners(spec)!.external[0].publicKey).to.equal(spec.bridge.attestation.signers![0].attestationPubkey.toLowerCase())
    spec.bridge.attestation.signers![1].transportPubkey = spec.bridge.attestation.signers![0].attestationPubkey
    expect(() => resolveSpecAttestationSigners(spec)).to.throw('distinct')
  })

  it('rejects malformed keys, duplicate names, invalid thresholds', () => {
    for (const mutate of [
      (s: DeploymentSpec) => {s.bridge.attestation.signers![0].attestationPubkey = 'REPLACE_WITH_PUBLIC_KEY'},
      (s: DeploymentSpec) => {s.bridge.attestation.signers![0].transportPubkey = '02' + 'ff'.repeat(32)},
      (s: DeploymentSpec) => {s.bridge.attestation.signers![1].name = s.bridge.attestation.signers![0].name},
      (s: DeploymentSpec) => {s.bridge.attestation.signers![0].name = 'Not a stable name'},
      (s: DeploymentSpec) => {s.bridge.attestation.signers![0].transportPubkey = s.bridge.attestation.signers![0].attestationPubkey},
      (s: DeploymentSpec) => {s.bridge.attestation.threshold = 4},
      (s: DeploymentSpec) => {s.bridge.attestation.signers = []},
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
    spec.bridge.attestation.signers[0].network = 'testnet'
    expect(validateDeploymentSpec(spec).errors.some(error => error.path.includes('network'))).to.equal(true)
  })
})
