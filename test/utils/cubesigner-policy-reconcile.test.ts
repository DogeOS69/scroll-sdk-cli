import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {resolveCubesignerPolicy} from '../../src/utils/cubesigner-policy-receipts.js'
import {type PolicyReadbackClient, reconcileCubesignerPolicy} from '../../src/utils/cubesigner-policy-reconcile.js'
import {importPreparationPolicyReceipts} from '../../src/utils/preparation-policy-receipts.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'

describe('reconcile an externally governed policy into preparation receipts', () => {
  let root: string
  let input: any
  let remote: any
  let calls: string[]
  const id = 'NamedPolicy#00000000-0000-0000-0000-000000000001'
  const key = {keyId: 'Key#fixture', materialId: 'fixture', roleId: 'Role#fixture'}
  const selection = '.scrollsdk/inputs/cubesigner-policy/receipts.json'
  const hash = (name: string) => `sha256:${proofFileHash(path.join(root, name))}`
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(value))
  const ref = (name: string) => ({path: name, sha256: hash(name)})
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-reconcile-test-'))
    calls = []
    policyReceiptFixture(root)
    fs.mkdirSync(path.join(root, '.data'))
    fs.copyFileSync(path.join(root, 'context.json'), path.join(root, '.data/protocol_context.json'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), `network = "mainnet"\n[cubesigner]\nmode = "production_verifier_key_policy"\n[[cubesigner.roles]]\nrole_id = "${key.roleId}"\n[[cubesigner.roles.keys]]\nkey_id = "${key.keyId}"\nmaterial_id = "${key.materialId}"\n`)
    fs.writeFileSync(path.join(root, 'policy.wasm'), Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]))
    const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'))
    release.requiresLiveEvidence = false
    release.wasm = {...ref('policy.wasm'), sizeBytes: 8}
    write('test-report.json', {coreRevision: release.coreRevision, protocolContextSha256: hash('context.json'), result: 'passed', wasmSha256: hash('policy.wasm')})
    release.tests = {...ref('test-report.json'), result: 'passed'}
    write('bridge.vmexe', {fixture: 'bridge'})
    write('aggregate-vk', {fixture: 'vk'})
    release.verifierProvenance = {aggregateVerifyingKeySha256: hash('aggregate-vk'), bridgeProgramSha256: hash('bridge.vmexe')}
    write('build.json', {coreRevision: release.coreRevision, protocolContext: {sha256: hash('context.json').slice(7)},
      schema: 'dogeos/cubesigner-policy-external-build/v1', wasm: {sha256: hash('policy.wasm').slice(7), sizeBytes: 8}})
    input = {aggregateVerifyingKey: ref('aggregate-vk'), bridgeProgram: ref('bridge.vmexe'), buildReceipt: ref('build.json'), environment: 'gamma',
      key, organization: 'Org#fixture', release}
    remote = {
      authorities: ['proofs.example.com'],
      key: {enabled: true, key_id: key.keyId, material_id: key.materialId, policy: [{RequireRoleSession: [key.roleId]}, `${id}/v2`]},
      policy: {attached_to: [{key_id: key.keyId}], name: 'dogeos-bridge', policy_id: id, policy_type: 'Wasm',
        rules: [{hash: `0x${hash('policy.wasm').slice(7)}`}], version: 2}, role: {enabled: true, role_id: key.roleId},
    }
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const client = (): PolicyReadbackClient => ({
    async authorities() {calls.push('authorities'); return remote.authorities}, environment: 'gamma',
    async key(role, id) {calls.push('key'); expect([role, id]).to.deep.equal([key.roleId, key.keyId]); return remote.key},
    organization: 'Org#fixture',
    async policy(name, version) {calls.push('policy'); expect([name, version]).to.deep.equal(['dogeos-bridge', 'v2']); return remote.policy},
    async role() {calls.push('role'); return remote.role},
  })
  const run = async (provider = client()) => {
    write('input.json', input)
    return reconcileCubesignerPolicy({connect: async () => provider, directory: root, input: 'input.json', output: '.data/reconciled'})
  }

  const fails = async (message: string, provider?: PolicyReadbackClient) => {
    let error: unknown
    try {await run(provider)} catch (error_) {error = error_}
    expect(error).to.be.instanceOf(Error)
    expect((error as Error).message).to.include(message)
    expect(fs.existsSync(path.join(root, '.data/reconciled'))).to.equal(false)
    expect(fs.existsSync(path.join(root, selection))).to.equal(false)
  }

  it('generates canonical receipts and resumes the actual charts importer without attestation or provider mutations', async () => {
    const original = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    const result = await run()
    expect(result.liveAcceptance).to.equal('not-verified')
    expect(calls).to.deep.equal(['policy', 'key', 'role', 'authorities'])
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).to.equal(original)
    const refs = JSON.parse(fs.readFileSync(path.join(root, selection), 'utf8'))
    expect(resolveCubesignerPolicy({deploymentDir: root, keys: [key], network: 'mainnet', selection: {mode: 'production_verifier_key_policy', policyReceipts: refs}}).policy?.policyIdentifier).to.equal('dogeos-bridge/v2')
    importPreparationPolicyReceipts(root)
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).to.include('[cubesigner.policyReceipts]')
    expect(fs.statSync(path.join(root, '.data/reconciled/readback.json')).mode % 512).to.equal(0o600)
  })
  it('replaces only the untouched waiting template and pins every emitted file', async () => {
    try {importPreparationPolicyReceipts(root)} catch { /* expected wait */ }
    await run()
    const refs = JSON.parse(fs.readFileSync(path.join(root, selection), 'utf8'))
    for (const ref of [refs.release, refs.attachment, refs.protocolContext]) expect(hash(ref.path)).to.equal(ref.sha256)
  })
  for (const [label, change, message] of [
    ['wrong Wasm', () => {remote.policy.rules[0].hash = `0x${'0'.repeat(64)}`}, 'Wasm mismatch'],
    ['wrong policy version', () => {remote.policy.version = 3}, 'version/Wasm mismatch'],
    ['missing role restriction', () => {remote.key.policy.shift()}, 'role restriction'],
    ['extra policy', () => {remote.key.policy.push('unrelated')}, 'role restriction'],
    ['disabled key', () => {remote.key.enabled = false}, 'enabled state'],
    ['disabled role', () => {remote.role.enabled = false}, 'role is not enabled'],
    ['missing attachment', () => {remote.policy.attached_to = []}, 'confirm key attachment'],
    ['missing resolver', () => {remote.authorities = []}, 'not allowed'],
  ] as const) {
    it(`rejects ${label} without publishing receipts`, async () => {change(); await fails(message)})
  }

  it('rejects another environment before any read', async () => {await fails('environment/organization mismatch', {...client(), environment: 'prod'}); expect(calls).to.deep.equal([])})
  it('rejects another organization before any read', async () => {await fails('environment/organization mismatch', {...client(), organization: 'Org#other'}); expect(calls).to.deep.equal([])})
  it('rejects passing tests for another context before connecting', async () => {
    write('test-report.json', {result: 'passed'})
    input.release.tests = {...ref('test-report.json'), result: 'passed'}
    await fails('Test report'); expect(calls).to.deep.equal([])
  })
  it('rejects changed Wasm, even with a recalculated input hash', async () => {
    fs.appendFileSync(path.join(root, 'policy.wasm'), 'tamper')
    input.release.wasm = ref('policy.wasm')
    await fails('build receipt'); expect(calls).to.deep.equal([])
  })
  it('rejects a different frozen key and role', async () => {input.key = {...key, roleId: 'Role#other'}; await fails('saved deployment'); expect(calls).to.deep.equal([])})
  it('does not silently waive required live evidence', async () => {input.release.requiresLiveEvidence = true; await fails('required live evidence')})
  it('accepts bound live evidence only when supplied', async () => {
    input.release.requiresLiveEvidence = true
    write('live.json', {keyId: key.keyId, policyIdentifier: input.release.policyIdentifier, protocolContextSha256: hash('context.json'), result: 'passed'})
    input.liveEvidence = ref('live.json')
    expect((await run()).liveAcceptance).to.equal('supplied-report-validated')
  })
  it('leaves an existing receipt selection intact', async () => {
    fs.mkdirSync(path.dirname(path.join(root, selection)), {recursive: true})
    write(selection, {release: {sha256: 'existing'}})
    try {await run(); expect.fail('must refuse')} catch (error) {expect((error as Error).message).to.include('refusing replacement')}
    expect(fs.readFileSync(path.join(root, selection), 'utf8')).to.equal('{"release":{"sha256":"existing"}}')
  })
  it('refuses symlink evidence', async () => {
    fs.renameSync(path.join(root, 'test-report.json'), path.join(root, 'actual-report.json'))
    fs.symlinkSync('actual-report.json', path.join(root, 'test-report.json'))
    await fails('symlink')
  })
  it('refuses existing output without altering it', async () => {
    fs.mkdirSync(path.join(root, '.data/reconciled'))
    fs.writeFileSync(path.join(root, '.data/reconciled/keep'), 'existing evidence')
    try {await run(); expect.fail('must refuse')} catch (error) {expect((error as Error).message).to.include('Output already exists')}
    expect(fs.readFileSync(path.join(root, '.data/reconciled/keep'), 'utf8')).to.equal('existing evidence')
    expect(calls).to.deep.equal([])
  })
  it('detects context changes during provider readback', async () => {
    const provider = client()
    provider.authorities = async () => {fs.appendFileSync(path.join(root, '.data/protocol_context.json'), ' '); return remote.authorities}
    await fails('context changed during readback', provider)
  })
  it('detects concurrent deployment config edits', async () => {
    const provider = client()
    provider.authorities = async () => {fs.appendFileSync(path.join(root, '.data/doge-config.toml'), '\n'); return remote.authorities}
    await fails('configuration changed during readback', provider)
  })
  it('does not leave receipts on provider failure', async () => {
    const provider = client()
    provider.key = async () => {throw new Error('provider unavailable')}
    await fails('provider unavailable', provider)
  })
})
