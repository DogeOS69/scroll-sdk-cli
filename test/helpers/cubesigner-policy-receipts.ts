import fs from 'node:fs'
import path from 'node:path'

import {proofFileHash} from '../../src/utils/proof-software-release.js'

const keys = [{keyId: 'key-1', materialId: 'material-1', roleId: 'role-1'}]
export function policyReceiptFixture(root: string) {
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
