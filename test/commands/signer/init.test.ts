import {runCommand} from '@oclif/test'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderSignerReleasePins } from '../../../src/commands/signer/init.js'

describe('signer init release pins', () => {
  it('renders the complete fail-closed production release identity', () => {
    const lines = renderSignerReleasePins({
      allowedGitCommit: '0123456789ABCDEF0123456789ABCDEF01234567',
      allowedReleaseVersion: '0.1.0',
      allowedSigningPolicyVersion: '1',
    })
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=0.1.0')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=0123456789abcdef0123456789abcdef01234567')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=1')
  })

  it('keeps explicit placeholders for mock/onboarding but still pins the policy version', () => {
    const lines = renderSignerReleasePins({ allowedSigningPolicyVersion: '1' })
    expect(lines).to.include('# ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=')
    expect(lines).to.include('# ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=1')
  })

  it('rejects partial or non-canonical release pins', () => {
    expect(() => renderSignerReleasePins({ allowedReleaseVersion: '0.1.0' }))
      .to.throw('must be provided together')
    expect(() => renderSignerReleasePins({
      allowedGitCommit: 'short',
      allowedReleaseVersion: '0.1.0',
    })).to.throw('full 40-character git commit')
  })
})

describe('signer init partner-owned V2 policy', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-init-v2-'))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('creates the current policy template once and preserves operator edits under --force', async () => {
    const out = path.join(root, 'partner-a')
    const args = [
      'signer', 'init',
      '--id', 'partner-a',
      '--network', 'testnet',
      '--endpoint', 'https://signer.partner-a.example:4040',
      '--out', out,
    ]
    await runCommand(args)

    const policyFile = path.join(out, 'attestation-signer.toml')
    const template = fs.readFileSync(policyFile, 'utf8')
    expect(template).to.include('[advance_l1_policy.terminal_anchor_sources]')
    expect(template).to.include('[advance_l2_policy.ethereum_sources]')
    expect(template).to.include('[rotation_policy]')

    const reviewed = `${template}\n# reviewed-partner-policy-marker\n`
    fs.writeFileSync(policyFile, reviewed)
    await runCommand([...args, '--force'])
    expect(fs.readFileSync(policyFile, 'utf8')).to.equal(reviewed)
  })
})
