import {expect} from 'chai'

import type {SignerPolicyBundleInput} from '../../src/utils/signer-policy-bundle.js'

import {
  ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
  renderPartnerCommands,
  renderSignerOperatorPolicyTemplate,
  renderSignerPolicyEnv,
} from '../../src/utils/signer-policy-bundle.js'

function input(mode: 'disabled' | 'mock' | 'production'): SignerPolicyBundleInput {
  return {
    ...(mode === 'production'
      ? {
          advanceL2Verifier: {
            aggVerifyingKeyFile: ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
            aggVerifyingKeySha256: `sha256:${'11'.repeat(32)}`,
            batchProgramCommitmentHex: `0x${'22'.repeat(64)}`,
            l2RangeAggregationProgramCommitmentHex: `0x${'33'.repeat(64)}`,
          },
        }
      : {}),
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

  it('renders audited scaffold mode without activating production verifier material', () => {
    const env = envMap(renderSignerPolicyEnv(input('mock')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('staging_scaffold')
    expect(env.ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS).to.equal('true')
    expect(env.ATTESTATION_SIGNER_PROTOCOL_CONTEXT_JSON).to.equal('/etc/dogeos/protocol_context.json')
    expect(env.ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS).to.equal('https://proofs.bridge.example')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH')
  })

  it('renders all compiler-selected AdvanceL2 verifier inputs in production', () => {
    const env = envMap(renderSignerPolicyEnv(input('production')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('production_enforce')
    expect(env.ATTESTATION_SIGNER_ALLOW_UNIMPLEMENTED_CHECKS).to.equal('false')
    expect(env.ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH)
      .to.equal('/etc/dogeos/advance-l2-agg-verifying-key.bin')
    expect(env.ATTESTATION_SIGNER_ADVANCE_L2_BATCH_PROGRAM_COMMITMENT_HEX)
      .to.equal(`0x${'22'.repeat(64)}`)
    expect(env.ATTESTATION_SIGNER_L2_RANGE_AGGREGATION_PROGRAM_COMMITMENT_HEX)
      .to.equal(`0x${'33'.repeat(64)}`)
  })

  it('fails closed when production verifier material is absent', () => {
    expect(() => renderSignerPolicyEnv({...input('mock'), mode: 'production'}))
      .to.throw('requires compiler-selected AdvanceL2 verifier material')
  })

  it('renders disabled direct-sign posture without artifact or verifier activation', () => {
    const env = envMap(renderSignerPolicyEnv(input('disabled')))
    expect(env.ATTESTATION_SIGNER_POLICY_MODE).to.equal('dev_permissive')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ARTIFACT_ALLOWED_ORIGINS')
    expect(env).not.to.have.property('ATTESTATION_SIGNER_ADVANCE_L2_AGG_VERIFYING_KEY_PATH')
  })

  it('projects the recovery pin and its retirement order', () => {
    const direct = {...input('disabled'), preTsukiDirectSign: {maxEndBatchHeight: 6863}}
    const env = envMap(renderSignerPolicyEnv(direct))
    expect(env.ATTESTATION_SIGNER_PRE_TSUKI_DIRECT_SIGN_MAX_END_BATCH_HEIGHT).to.equal('6863')
    const commands = renderPartnerCommands(direct)
    expect(commands).to.include('Issue #843')
    expect(commands).to.include('Retire WP, signer, then TSO')
  })

  it('documents the protocol-context bootstrap boundary and production readiness check', () => {
    const commands = renderPartnerCommands(input('production'))
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
