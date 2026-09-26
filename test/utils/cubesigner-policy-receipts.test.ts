import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {cubesignerLiveEvidenceProjection, cubesignerPolicyEnvironment, resolveCubesignerPolicy} from '../../src/utils/cubesigner-policy-receipts.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'

describe('CubeSigner policy receipt import', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-receipts-')) })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const keys = [{keyId: 'key-1', materialId: 'material-1', roleId: 'role-1'}]
  function fixture() {
    const write = (name: string, value: unknown) => {
      const file = path.join(root, name)
      fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value))
      return {path: name, sha256: `sha256:${proofFileHash(file)}`}
    }

    const protocolContext = write('context.json', {genesis: {}})
    const wasm = write('policy.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
    const tests = write('test-report.json', {result: 'passed'})
    const liveEvidence = write('live.json', {keyId: 'key-1', policyIdentifier: 'dogeos-bridge/v2', protocolContextSha256: protocolContext.sha256, result: 'passed'})
    const release = write('release.json', {
      coreRevision: 'a'.repeat(40), createdAt: new Date().toISOString(), policyIdentifier: 'dogeos-bridge/v2',
      programIdentityDigest: `sha256:${'b'.repeat(64)}`, proofResolverAuthority: 'https://proofs.example.com', protocolContextSha256: protocolContext.sha256,
      requestContract: 'dogeos-cubesigner-compact-psbt-bridge-proof-ref-v1-sign-all-scripts-false-unprefixed-hex-explain-v3', requiresLiveEvidence: true, schema: 'dogeos/cubesigner-policy-release/v1',
      sdkVersion: '0.4.281', tests: {...tests, result: 'passed'}, verifierIdentityDigest: `sha256:${'c'.repeat(64)}`,
      verifierProvenance: {aggregateVerifyingKeySha256: `sha256:${'e'.repeat(64)}`, bridgeProgramSha256: `sha256:${'d'.repeat(64)}`}, wasm: {...wasm, sizeBytes: 8},
    })
    const attachment = write('attachment.json', {
      createdAt: new Date().toISOString(), schema: 'dogeos/cubesigner-policy-attachment/v1', ...keys[0], c2fEgressAuthority: 'https://proofs.example.com', environment: 'test',
      organization: 'org-1', policyArtifactDigest: wasm.sha256, policyIdentifier: 'dogeos-bridge/v2', proofResolverAuthority: 'https://proofs.example.com', readback: 'verified', releaseSha256: release.sha256,
    })
    return {deploymentDir: root, keys, network: 'testnet', selection: {mode: 'production_verifier_key_policy' as const, policyReceipts: {attachment, environment: 'test', liveEvidence, organization: 'org-1', protocolContext, release}}}
  }

  it('binds release, Wasm, protocol, provider readback and live evidence mount', () => {
    const result = resolveCubesignerPolicy(fixture())
    expect(result.warnings).to.deep.equal([])
    expect(cubesignerPolicyEnvironment(result).DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE).to.equal('production_verifier_key_policy')
    const mount = cubesignerLiveEvidenceProjection(result).persistence['proof-policy-live-evidence']
    expect(mount).to.include({mountPath: '/app/proof-policy/live-evidence.json', readOnly: true, subPath: 'live-evidence.json'})
  })
  it('rejects another key, organization, changed context and changed Wasm', () => {
    const input = fixture()
    expect(() => resolveCubesignerPolicy({...input, keys: [{...keys[0], keyId: 'key-2'}]})).to.throw('keyId')
    input.selection.policyReceipts.organization = 'org-2'
    expect(() => resolveCubesignerPolicy(input)).to.throw('organization')
    input.selection.policyReceipts.organization = 'org-1'
    fs.appendFileSync(path.join(root, 'context.json'), ' ')
    expect(() => resolveCubesignerPolicy(input)).to.throw('digest mismatch')
    const restored = fixture()
    fs.appendFileSync(path.join(root, 'policy.wasm'), 'bad')
    expect(() => resolveCubesignerPolicy(restored)).to.throw('digest mismatch')
  })
  it('rejects symlink evidence and explicit production without receipts', () => {
    const input = fixture()
    fs.renameSync(path.join(root, 'live.json'), path.join(root, 'real-live.json'))
    fs.symlinkSync('real-live.json', path.join(root, 'live.json'))
    expect(() => resolveCubesignerPolicy(input)).to.throw('symlink')
    expect(() => resolveCubesignerPolicy({keys, network: 'testnet', selection: {mode: 'production_verifier_key_policy'}})).to.throw('requires release and attachment receipts')
  })
  it('limits transport_only to non-mainnet and warns about hosted policies', () => {
    const input = fixture()
    const selection = {...input.selection, mode: 'transport_only' as const}
    expect(resolveCubesignerPolicy({...input, selection}).warnings.join(' ')).to.include('does not bypass')
    expect(() => resolveCubesignerPolicy({...input, network: 'mainnet', selection})).to.throw('forbidden on mainnet')
  })
})
