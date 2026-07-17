import { expect } from 'chai'

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
