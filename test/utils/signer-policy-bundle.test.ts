import {parse} from '@iarna/toml'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {SignerPolicyBundleInput} from '../../src/utils/signer-policy-bundle.js'

import {
  ADVANCE_L2_AGG_VERIFYING_KEY_BUNDLE_FILE,
  TRANSPORT_KEY_COMMANDS,
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
      {id: 'partner-a', publicKey: `02${'66'.repeat(32)}`, transportPubkey: `02${'88'.repeat(32)}`},
      {id: 'partner-b', publicKey: `03${'77'.repeat(32)}`, transportPubkey: `03${'99'.repeat(32)}`},
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
  it('provides enforce-compatible quorum examples for all three RPC source sets', () => {
    const examples = renderSignerOperatorPolicyTemplate().split('\n')
      .filter(line => /^# (\[|[_a-z]+ = )/.test(line))
      .map(line => line.slice(2)).join('\n')
    const policy = parse(examples) as unknown as {
      advance_l1_policy: {terminal_anchor_sources: SourceSet}
      advance_l2_policy: {ethereum_sources: SourceSet; l2_sources: SourceSet}
    }
    interface SourceSet {
      posture: string
      required_agreement: number
      sources: {rpc_url: string; trust_domain_id: string}[]
    }

    for (const sourceSet of [policy.advance_l1_policy.terminal_anchor_sources,
      policy.advance_l2_policy.ethereum_sources, policy.advance_l2_policy.l2_sources]) {
      expect(sourceSet.posture).to.equal('quorum')
      expect(sourceSet.required_agreement).to.be.at.least(2)
      expect(new Set(sourceSet.sources.map(source => source.trust_domain_id)).size)
        .to.be.at.least(sourceSet.required_agreement)
      expect(new Set(sourceSet.sources.map(source => source.rpc_url)).size)
        .to.equal(sourceSet.sources.length)
    }
  })

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
      `| \`partner-a\` | \`02${'66'.repeat(32)}\` | \`02${'88'.repeat(32)}\` |`,
      'https://tso.bridge.example',
      // The transport key is generated locally, kept 0600 and mounted into the
      // same compose service that prints the identity and later runs.
      TRANSPORT_KEY_COMMANDS,
      'run --rm --no-deps -T attestation-signer',
      '--print-identity > "signer-$SIGNER_ID/identity.json"',
      '--identity "signer-$SIGNER_ID/identity.json"',
      'https://proofs.bridge.example/proof-topology',
      'requires canonical protocol context in every mode',
      'cp "signer-$SIGNER_ID/attestation-signer.toml" docker-compose/',
      'advance-l2-agg-verifying-key.bin',
      '--require-production-ready',
    ]) expect(commands).to.include(expected)
    // Phase A and Phase B install the runtime key only through the validated block.
    expect(commands.split(TRANSPORT_KEY_COMMANDS)).to.have.length(3)
    expect(commands).not.to.match(/cp [^\n]*transport\.key"? docker-compose\/(?:\n|$)/)
    // Signers dial out: no inbound signer URL or reachability probe remains.
    expect(commands).not.to.include('--endpoint')
    expect(commands).not.to.include('signer-reachability')
    expect(commands).not.to.include('verifier-registry.toml')
    expect(commands).not.to.include('source-set.toml')
  })
})

describe('partner transport key commands', () => {
  it('create once, validate the whole file, install atomically, and fail as a unit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-key-'))
    try {
      fs.mkdirSync(path.join(root, 'signer-partner-a'))
      fs.mkdirSync(path.join(root, 'docker-compose'))
      const source = path.join(root, 'signer-partner-a/transport.key')
      const runtime = path.join(root, 'docker-compose/transport.key')
      const run = (extraPath?: string) => spawnSync('bash', ['-c', TRANSPORT_KEY_COMMANDS], {
        cwd: root,
        encoding: 'utf8',
        env: {...process.env, PATH: extraPath ? `${extraPath}${path.delimiter}${process.env.PATH}` : process.env.PATH, SIGNER_ID: 'partner-a'},
      })

      expect(run().status).to.equal(0)
      const key = fs.readFileSync(source, 'utf8')
      expect(key).to.match(/^[\da-f]{64}\n$/)
      expect(fs.readFileSync(runtime, 'utf8')).to.equal(key)
      for (const file of [source, runtime]) expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
      expect(run().status).to.equal(0)
      expect(fs.readFileSync(source, 'utf8')).to.equal(key)
      expect(fs.readFileSync(runtime, 'utf8')).to.equal(key)

      // Corrupt or empty sources fail and never reach the runtime key.
      for (const corrupt of ['', `${key}garbage\n`, `\n${key.trim()}`, key.toUpperCase(), key.trim(), `${key.slice(0, 63)}g\n`]) {
        fs.writeFileSync(source, corrupt)
        const result = run()
        expect(result.status, JSON.stringify(corrupt)).not.to.equal(0)
        expect(result.stderr).to.include('must be exactly one line of 64 hex characters')
        expect(fs.readFileSync(source, 'utf8')).to.equal(corrupt)
        expect(fs.readFileSync(runtime, 'utf8')).to.equal(key)
      }

      // A failed generator returns nonzero and leaves no key and the runtime key intact.
      fs.rmSync(source)
      const bin = path.join(root, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'openssl'), '#!/bin/sh\nexit 1\n', {mode: 0o755})
      expect(run(bin).status).not.to.equal(0)
      expect(fs.existsSync(source)).to.equal(false)
      expect(fs.readFileSync(runtime, 'utf8')).to.equal(key)
      // The next successful run recovers from the leftover temp file.
      expect(run().status).to.equal(0)
      expect(fs.readFileSync(source, 'utf8')).to.match(/^[\da-f]{64}\n$/)
    } finally {
      fs.rmSync(root, {force: true, recursive: true})
    }
  })
})
