import { expect } from 'chai'

import type { SignerPolicyBundleInput } from '../../src/utils/signer-policy-bundle.js'

import {
  DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
  renderMockSourceSetToml,
  renderPartnerCommands,
  renderSignerPolicyEnv,
  renderVerifierRegistryToml,
} from '../../src/utils/signer-policy-bundle.js'

function input(mode: 'disabled' | 'mock' | 'production'): SignerPolicyBundleInput {
  return {
    activeBridgeKeyHash: `0x${'11'.repeat(20)}`,
    allowedProofTriples: `openvm_state_transition:bridge-v1:0x${'22'.repeat(32)},scroll_batch:batch-v1:0x${'33'.repeat(32)}`,
    bridgeNamespaceId: `0x${'44'.repeat(20)}`,
    mode,
    network: 'testnet',
    protocolInstanceId: `0x${'55'.repeat(32)}`,
    signerProofArtifactBaseUrl: 'https://proofs.bridge.example/proof-topology',
    signers: [
      { endpoint: 'https://signer.partner-a.example:4040', id: 'partner-a', publicKey: `02${'66'.repeat(32)}` },
      { endpoint: 'http://10.20.30.40:4040', id: 'partner-b', publicKey: `03${'77'.repeat(32)}` },
    ],
    supportedSigningPolicyVersions: '1',
    teeAllowedSignerIds: `02${'88'.repeat(32)}`,
    tsoUrl: 'https://tso.bridge.example',
  }
}

function envMap(rendered: string): Record<string, string> {
  return Object.fromEntries(rendered
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
}

describe('signer policy bundle', () => {
  it('renders a verifier registry from the exact staged proof triples', () => {
    const registry = renderVerifierRegistryToml(input('mock').allowedProofTriples)
    expect(registry).to.include('proof_kind = "openvm_state_transition"')
    expect(registry).to.include('verifier_id = "bridge-v1"')
    expect(registry).to.include(`vk_hash = "0x${'22'.repeat(32)}"`)
    expect(registry).to.include('proof_kind = "scroll_batch"')
    expect(registry.match(/\[\[verifier]]/g)).to.have.length(2)
  })

  it('rejects malformed proof triples instead of emitting a permissive registry', () => {
    expect(() => renderVerifierRegistryToml('scroll_batch:missing-vk'))
      .to.throw('must be proof_kind:verifier_id:vk_hash')
    expect(() => renderVerifierRegistryToml('scroll_batch:batch-v1:not-a-hash'))
      .to.throw('vk_hash must be 32-byte hex')
  })

  it('renders an intentionally empty mock source-set scaffold', () => {
    const sourceSet = renderMockSourceSetToml()
    expect(sourceSet).to.include('Mock/e2e_harness')
    expect(sourceSet).not.to.include('[dogecoin]')
  })

  it('renders the e2e_harness-compatible mock signer posture with bounded proof and TEE allowlists', () => {
    const env = envMap(renderSignerPolicyEnv(input('mock')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('staging_scaffold')
    expect(env.ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS).to.equal('true')
    expect(env.ATTESTATION_SIGNER_ENVELOPE_MAX_PROOF_ARTIFACTS)
      .to.equal(String(DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS))
    expect(env.ATTESTATION_SIGNER_ENVELOPE_ALLOWED_PROOF_TRIPLES).to.include('bridge-v1')
    expect(env.ATTESTATION_SIGNER_ENVELOPE_ALLOWED_TEE_SIGNER_IDS)
      .to.equal(input('mock').teeAllowedSignerIds)
    expect(env.ATTESTATION_SIGNER_PROOF_ARTIFACT_FETCH_MODE).to.equal('http')
    expect(env.ATTESTATION_SIGNER_TSO_URL).to.equal('https://tso.bridge.example')
  })

  it('renders the proof-disabled direct-sign posture without proof fetch or proof allowlists', () => {
    const env = envMap(renderSignerPolicyEnv(input('disabled')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('dev_permissive')
    expect(env.ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS).to.equal('false')
    expect(env.ATTESTATION_SIGNER_ENVELOPE_MAX_PROOF_ARTIFACTS).to.equal('0')
    expect(env.ATTESTATION_SIGNER_ENVELOPE_ALLOWED_PROOF_TRIPLES).to.equal('')
    expect(env.ATTESTATION_SIGNER_PROOF_ARTIFACT_FETCH_MODE).to.equal('disabled')
    expect(env.ATTESTATION_SIGNER_VERIFIER_REGISTRY_TOML).to.equal(undefined)
    expect(env.ATTESTATION_SIGNER_SOURCE_SET_TOML).to.equal(undefined)
  })

  it('keeps the operator/network flow identical while production changes only the signer safety posture', () => {
    const mock = envMap(renderSignerPolicyEnv(input('mock')))
    const production = envMap(renderSignerPolicyEnv(input('production')))
    const changed = Object.keys(mock).filter(key => mock[key] !== production[key]).sort()

    expect(changed).to.deep.equal([
      'ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS',
      'ATTESTATION_SIGNER_POLICY_MODE',
    ])
    expect(production.ATTESTATION_SIGNER_POLICY_MODE).to.equal('production_enforce')
    expect(production.ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS).to.equal('false')
  })

  it('puts exact domain/IP addresses and both parties commands in the generated handoff', () => {
    const commands = renderPartnerCommands(input('mock'))
    for (const expected of [
      'https://signer.partner-a.example:4040',
      'http://10.20.30.40:4040',
      'https://tso.bridge.example',
      'https://proofs.bridge.example/proof-topology',
      'scrollsdk signer init',
      'scrollsdk signer preflight',
      'scrollsdk setup attestation-signer --threshold <T>',
      'docker compose --project-directory docker-compose up -d',
      'kubectl -n <namespace> run signer-reachability-partner-a',
      "curl -fsS 'http://10.20.30.40:4040/health'",
    ]) expect(commands).to.include(expected)

    expect(commands).to.include('staging_scaffold')
    expect(commands).to.include('staging_scaffold')
  })

  it('documents direct-sign acceptance without a proof GET dependency', () => {
    const directInput = { ...input('disabled'), signerProofArtifactBaseUrl: undefined }
    const commands = renderPartnerCommands(directInput)
    expect(commands).to.include('Direct-sign acceptance')
    expect(commands).not.to.include('accepted proof HTTPS GET root')
  })
})
