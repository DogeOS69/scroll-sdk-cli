import {expect} from 'chai'

import type {SignerPolicyBundleInput} from '../../src/utils/signer-policy-bundle.js'

import {
  ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
  renderPartnerCommands,
  renderSignerOperatorPolicyTemplate,
  renderSignerPolicyEnv,
} from '../../src/utils/signer-policy-bundle.js'

function input(
  mode: 'active' | 'disabled',
  generation: 'mock' | 'real' = 'mock',
  enforcement: 'enforce' | 'observe' = 'observe',
): SignerPolicyBundleInput {
  return {
    ...(generation === 'real'
      ? {
          advanceL2Verifier: {
            aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
            aggVerifyingKeySha256: `sha256:${'11'.repeat(32)}`,
            batchProgramCommitmentHex: `0x${'22'.repeat(64)}`,
            l2RangeAggregationProgramCommitmentHex: `0x${'33'.repeat(64)}`,
          },
        }
      : {}),
    enforcement,
    generation,
    mode,
    network: 'testnet',
    signerProofArtifactBaseUrl: mode === 'disabled' ? undefined : 'https://proofs.bridge.example/proof-topology',
    signers: [
      {endpoint: 'https://signer.partner-a.example:4040', id: 'partner-a', publicKey: `02${'66'.repeat(32)}`},
      {endpoint: 'http://10.20.30.40:4040', id: 'partner-b', publicKey: `03${'77'.repeat(32)}`},
    ],
    tsoUrl: 'https://tso.bridge.example',
  }
}

function envMap(rendered: string): Record<string, string> {
  return Object.fromEntries(rendered.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

describe('signer policy bundle V2', () => {
  it('renders partner-owned RPC and rotation policy without bridge-owned verifier fields', () => {
    const policy = renderSignerOperatorPolicyTemplate()
    expect(policy).to.include('[advance_l1_policy.terminal_anchor_sources]')
    expect(policy).to.include('[advance_l2_policy.ethereum_sources]')
    expect(policy).to.include('[advance_l2_policy.l2_sources]')
    expect(policy).to.include('[rotation_policy]')
    expect(policy).not.to.include('agg_verifying_key_path')
    expect(policy).not.to.include('protocol_context_json')
    expect(policy).not.to.include('source-set.toml')
    expect(policy).not.to.include('verifier-registry.toml')
  })

  it('renders observe mode without activating real verifier material', () => {
    const env = envMap(renderSignerPolicyEnv(input('active')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('observe')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS')
    expect(env.ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON).to.equal('/etc/dogeos/protocol_context.json')
    expect(env.ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS).to.equal('https://proofs.bridge.example')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH')
  })

  it('renders all compiler-selected AdvanceL2 verifier inputs for real enforcement', () => {
    const env = envMap(renderSignerPolicyEnv(input('active', 'real', 'enforce')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('enforce')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS')
    expect(env.ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH)
      .to.equal('/etc/dogeos/advance-l2-agg-verifying-key.bin')
    expect(env.ATTESTATION_SIGNER_ADVANCE_L2_BATCH_PROGRAM_COMMITMENT_HEX)
      .to.equal(`0x${'22'.repeat(64)}`)
    expect(env.ATTESTATION_SIGNER_L2_RANGE_AGGREGATION_PROGRAM_COMMITMENT_HEX)
      .to.equal(`0x${'33'.repeat(64)}`)
  })

  it('fails closed when real verifier material is absent', () => {
    expect(() => renderSignerPolicyEnv({...input('active'), generation: 'real'}))
      .to.throw('requires compiler-selected AdvanceL2 verifier material')
  })

  it('renders disabled observe posture without artifact or verifier activation', () => {
    const env = envMap(renderSignerPolicyEnv(input('disabled')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('observe')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH')
  })

  it('documents the protocol-context bootstrap boundary and enforcement readiness check', () => {
    const commands = renderPartnerCommands(input('active', 'real', 'enforce'))
    for (const expected of [
      'https://signer.partner-a.example:4040',
      'https://tso.bridge.example',
      'https://proofs.bridge.example/proof-topology',
      'requires canonical protocol context in every mode',
      'cp "signer-$SIGNER_ID/attestation-signer.toml" docker-compose/',
      'advance-l2-agg-verifying-key.bin',
      '--require-production-ready',
      'kubectl -n <namespace> run signer-reachability-partner-a',
    ]) expect(commands).to.include(expected)
    expect(commands).not.to.include('verifier-registry.toml')
    expect(commands).not.to.include('source-set.toml')
  })
})
