import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {assertPolicyAttachmentAllowed, deployCubesignerPolicy} from '../../src/utils/cubesigner-policy-deploy.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'

describe('CubeSigner policy deployment', () => {
  const providerId = 'NamedPolicy#00000000-0000-0000-0000-000000000001'
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-deploy-')) })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function fixture(change?: (args: string[]) => unknown) {
    const wasm = path.join(root, 'cubesigner_verifier_policy.wasm')
    fs.writeFileSync(wasm, Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]))
    const buildReceipt = path.join(root, 'build-receipt.json')
    fs.writeFileSync(buildReceipt, JSON.stringify({checks: {componentImportSubset: 'passed'}, pins: {protocolContextSha256: 'a'.repeat(64)}, schema: 'dogeos/cubesigner-policy-build-receipt/v1', wasm: {path: path.basename(wasm), sha256: proofFileHash(wasm), sizeBytes: 8}}))
    const calls: string[][] = []
    let policy: string[] = []
    const args = {buildReceipt, buildReceiptSha256: proofFileHash(buildReceipt), keyId: 'Key#fixture', name: 'test-policy', organization: 'Org#fixture', output: path.join(root, 'deployment'), run(_program: string, argv: string[]) {
      calls.push(argv)
      const changed = change?.(argv)
      if (changed !== undefined) return JSON.stringify(changed)
      if (argv[0] === 'key') {
        if (argv.includes('set-policy')) { policy = [`${providerId}/v0`]; return '{}' }
        return JSON.stringify({material_id: 'fixture-material', policy})
      }

      if (argv.includes('invoke')) return JSON.stringify({response: {response: 'Deny'}})
      return JSON.stringify({name: 'test-policy', policy_id: providerId, policy_type: 'Wasm', rules: [{hash: `0x${proofFileHash(wasm)}`}], version: 0})
    }}
    return {args, calls, wasm}
  }

  it('accepts the actual provider first version v0 and verifies it before attaching', () => {
    const {args, calls} = fixture()
    const result = deployCubesignerPolicy(args)
    expect(result.policyIdentifier).to.equal('test-policy/v0')
    const mutation = calls.findIndex(args => args.includes('set-policy'))
    expect(calls.slice(0, mutation).some(args => args.includes('invoke'))).to.equal(true)
    expect(calls[mutation]).to.include(JSON.stringify(`${providerId}/v0`))
    const receipt = JSON.parse(fs.readFileSync(result.attachmentReceipt, 'utf8'))
    expect(receipt.readback).to.equal('verified')
    expect(receipt.providerPolicyIdentifier).to.equal(`${providerId}/v0`)
  })

  it('resumes a partial attachment using the verified canonical provider ID without uploading again', () => {
    let keyReads = 0
    const {args, calls} = fixture(argv => {
      if (argv[0] === 'key' && argv.includes('get') && ++keyReads === 3) return {policy: []}

    })
    expect(() => deployCubesignerPolicy(args)).to.throw('readback mismatch')
    const result = deployCubesignerPolicy(args)
    expect(result.policyIdentifier).to.equal('test-policy/v0')
    expect(calls.filter(argv => argv.includes('create'))).to.have.length(1)
  })

  it('rejects a foreign policy or missing policy field before uploading', () => {
    for (const policy of [{}, {policy: ['another/v2']}, {policy: [{RequireMfa: {count: 1}}]}]) {
      expect(() => assertPolicyAttachmentAllowed(policy, 'test-policy/v0')).to.throw()
    }
  })

  it('does not mutate a key if the provider reports another Wasm hash', () => {
    const {args, calls} = fixture(argv => argv.includes('create') ? {name: 'test-policy', policy_id: providerId, policy_type: 'Wasm', rules: [{hash: `0x${'f'.repeat(64)}`}], version: 0} : undefined)
    expect(() => deployCubesignerPolicy(args)).to.throw('digest')
    expect(calls.some(args => args.includes('set-policy'))).to.equal(false)
  })

  it('does not attach a policy that permits the empty request', () => {
    const {args, calls} = fixture(argv => argv.includes('invoke') ? {response: {response: 'Allow'}} : undefined)
    expect(() => deployCubesignerPolicy(args)).to.throw('empty request')
    expect(calls.some(args => args.includes('set-policy'))).to.equal(false)
  })

  it('rejects a changed local Wasm before contacting CubeSigner', () => {
    const {args, calls, wasm} = fixture()
    fs.appendFileSync(wasm, 'changed')
    expect(() => deployCubesignerPolicy(args)).to.throw('Wasm changed')
    expect(calls).to.have.length(0)
  })
})
