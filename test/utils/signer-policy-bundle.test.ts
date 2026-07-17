import { expect } from 'chai'

import type { SignerPolicyBundleInput } from '../../src/utils/signer-policy-bundle.js'

import {
  DEFAULT_ENVELOPE_MAX_PROOF_ARTIFACTS,
  renderPartnerCommands,
  renderSignerPolicyEnv,
} from '../../src/utils/signer-policy-bundle.js'

function input(provingMode: 'mock' | 'production'): SignerPolicyBundleInput {
  return {
    activeBridgeKeyHash: `0x${'11'.repeat(20)}`,
    allowedProofTriples: `openvm_state_transition:bridge-v1:0x${'22'.repeat(32)},scroll_batch:batch-v1:0x${'33'.repeat(32)}`,
    bridgeNamespaceId: `0x${'44'.repeat(20)}`,
    network: 'testnet',
    protocolInstanceId: `0x${'55'.repeat(32)}`,
    provingMode,
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
      'scrollsdk setup attestation-signer --threshold <T> --probe',
      'docker compose --project-directory docker-compose up -d',
      'kubectl -n <namespace> run signer-reachability-partner-a',
      "curl -fsS 'http://10.20.30.40:4040/health'",
    ]) expect(commands).to.include(expected)

    expect(commands).to.include('staging_scaffold')
    expect(commands).to.include('same in mock and production')
  })
})
