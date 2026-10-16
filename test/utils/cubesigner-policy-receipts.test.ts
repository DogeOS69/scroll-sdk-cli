import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {cubesignerLiveEvidenceProjection, cubesignerPolicyEnvironment, resolveCubesignerPolicy} from '../../src/utils/cubesigner-policy-receipts.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'

describe('CubeSigner policy receipt import', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-receipts-')) })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const keys = [{keyId: 'key-1', materialId: 'material-1', roleId: 'role-1'}]
  const fixture = () => policyReceiptFixture(root)

  it('binds release, Wasm, protocol, provider readback and live evidence mount', () => {
    const result = resolveCubesignerPolicy(fixture())
    expect(result.warnings).to.deep.equal([])
    expect(cubesignerPolicyEnvironment(result).DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_MODE).to.equal('production_verifier_key_policy')
    const mount = cubesignerLiveEvidenceProjection(result).persistence['proof-policy-live-evidence']
    expect(mount).to.include({mountPath: '/app/proof-policy/live-evidence.json', readOnly: true, subPath: 'live-evidence.json'})
  })
  it('accepts the CubeSigner initial version v0', () => {
    const input = fixture()
    for (const name of ['live.json', 'release.json', 'attachment.json']) {
      const file = path.join(root, name)
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('dogeos-bridge/v2', 'dogeos-bridge/v0'))
    }

    const refs = input.selection.policyReceipts
    refs.liveEvidence.sha256 = `sha256:${proofFileHash(path.join(root, refs.liveEvidence.path))}`
    refs.release.sha256 = `sha256:${proofFileHash(path.join(root, refs.release.path))}`
    const file = path.join(root, refs.attachment.path)
    const attachment = JSON.parse(fs.readFileSync(file, 'utf8'))
    attachment.releaseSha256 = refs.release.sha256
    fs.writeFileSync(file, JSON.stringify(attachment))
    refs.attachment.sha256 = `sha256:${proofFileHash(file)}`
    expect(resolveCubesignerPolicy(input).policy?.policyIdentifier).to.equal('dogeos-bridge/v0')
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

  it('rejects a previous Bridge even when old receipts are internally consistent', () => {
    const input = fixture()
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), JSON.stringify({genesis: {newBridge: true}}))
    for (const mode of ['production_verifier_key_policy', 'transport_only'] as const) {
      expect(() => resolveCubesignerPolicy({...input, selection: {...input.selection, mode}})).to.throw('previous Bridge')
    }

    fs.copyFileSync(path.join(root, 'context.json'), path.join(root, '.data/protocol_context.json'))
    expect(resolveCubesignerPolicy({...input, selection: {...input.selection, mode: 'transport_only'}}).mode).to.equal('transport_only')
  })

  it('validates transport-only attachment identity without requiring C2F egress', () => {
    const input = fixture()
    const selection = {...input.selection, mode: 'transport_only' as const}
    expect(() => resolveCubesignerPolicy({...input, keys: [{...keys[0], keyId: 'other'}], selection})).to.throw('keyId')
    const file = path.join(root, 'attachment.json')
    const attachment = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete attachment.c2fEgressAuthority
    fs.writeFileSync(file, JSON.stringify(attachment))
    selection.policyReceipts.attachment.sha256 = `sha256:${proofFileHash(file)}`
    expect(resolveCubesignerPolicy({...input, selection}).mode).to.equal('transport_only')
  })
})
