import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {POLICY_READER_FIX_REVISION} from '../../src/utils/cubesigner-policy-build.js'
import {EXTERNAL_POLICY_INPUT, EXTERNAL_POLICY_OUTPUT, importCubesignerPolicy, verifyExternalPolicy} from '../../src/utils/cubesigner-policy-import.js'
import {prepareCubesignerPolicy} from '../../src/utils/preparation-cubesigner-policy.js'
import {AwaitingInput, digest} from '../../src/utils/preparation-io.js'

describe('external policy import', () => {
  const wasm = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0, 0, 1, 0])
  const context = '{"protocol":"synthetic"}\n'
  let root: string
  let calls: string[][]
  // A core revision the fake repository reports as not containing core #1712.
  const readerFixMissing = 'c'.repeat(40)
  const options = () => ({
    buildScriptRevision: 'b'.repeat(40), coreRevision: 'a'.repeat(40), directory: root,
    expectedProtocolContextSha256: digest(context), expectedWasmSha256: digest(wasm),
    run(program: string, args: string[]) {
      expect(program).eq('git'); calls.push(args)
      if (args.includes('merge-base') && args.at(-1) === readerFixMissing) throw new Error('git policy operation failed (exit 1)')
      return args.includes('show') ? '#!/bin/bash\n# synthetic build script\n' : args.at(-1)!.replace('^{commit}', '') + '\n'
    },
    sourceRepo: root, wasm: '.data/evidence/policy.wasm',
  })
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-import-')); calls = []
    fs.mkdirSync(path.join(root, '.data/evidence'), {recursive: true})
    fs.writeFileSync(path.join(root, '.data/evidence/policy.wasm'), wasm)
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), context)
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('imports and resumes through the preparation path without building or contacting the provider', async () => {
    const result = importCubesignerPolicy(options())
    expect(result.wasmSha256).eq(digest(wasm))
    expect(calls).length(4)
    expect(calls.find(args => args.includes('merge-base'))).deep.eq(['-C', fs.realpathSync(root), 'merge-base', '--is-ancestor', POLICY_READER_FIX_REVISION, 'a'.repeat(40)])
    const receipt = JSON.parse(fs.readFileSync(result.buildReceipt, 'utf8'))
    expect(receipt).not.have.property('compilerImage')
    expect(receipt).not.have.property('sourceRepo')
    expect(JSON.parse(fs.readFileSync(result.selection, 'utf8')).sourceRepo).eq(fs.realpathSync(root))
    expect(receipt.provenance).eq('operator-declared-external-build')
    expect(receipt.buildScript.sha256).eq(digest('#!/bin/bash\n# synthetic build script\n'))
    const before = fs.readFileSync(result.buildReceipt)
    expect(importCubesignerPolicy(options())).deep.eq(result)
    expect(fs.readFileSync(result.buildReceipt).equals(before)).true
    calls = []
    await prepareCubesignerPolicy(root, async () => {throw new Error('must not run a build or provider command')}, options().run)
    expect(calls).deep.eq([['-C', fs.realpathSync(root), 'merge-base', '--is-ancestor', POLICY_READER_FIX_REVISION, receipt.coreRevision]])
    const handoff = JSON.parse(fs.readFileSync(path.join(root, '.data/cubesigner-policy-governance-handoff.json'), 'utf8'))
    expect(handoff.status).eq('external-build-imported-governance-unverified')
    expect(fs.statSync(result.buildReceipt).mode % 0o1000).eq(0o600)
  })

  it('refuses a core revision without core #1712 before writing output', () => {
    expect(() => importCubesignerPolicy({...options(), coreRevision: readerFixMissing})).to.throw('core #1712')
    expect(fs.existsSync(path.join(root, EXTERNAL_POLICY_OUTPUT))).false
  })

  it('requests missing or unavailable source checkouts for legacy external imports before writing a handoff', async () => {
    const result = importCubesignerPolicy(options())
    const selection = JSON.parse(fs.readFileSync(result.selection, 'utf8'))
    for (const sourceRepo of [undefined, '', path.join(root, 'missing-checkout')]) {
      fs.writeFileSync(result.selection, JSON.stringify({...selection, sourceRepo}))
      calls = []
      let caught: unknown
      try {await prepareCubesignerPolicy(root, async () => {throw new Error('unexpected command')}, options().run)} catch (error) {caught = error}

      expect(caught).instanceOf(AwaitingInput)
      expect((caught as AwaitingInput).details.file).eq(result.selection)
      expect((caught as AwaitingInput).details.message).contains('--source-repo')
      expect(calls).empty
      expect(fs.existsSync(path.join(root, '.data/cubesigner-policy-governance-handoff.json'))).false
    }
  })

  it('rejects reuse of an older external artifact without core #1712 before writing a handoff', async () => {
    // Reproduce an artifact accepted by the importer before the ancestry gate existed.
    const current = options()
    const result = importCubesignerPolicy({...current, coreRevision: readerFixMissing, run(program, args) {
      return args.includes('merge-base') ? '' : current.run(program, args)
    }})
    const before = fs.readFileSync(result.buildReceipt)
    calls = []
    let caught: unknown
    try {await prepareCubesignerPolicy(root, async () => {throw new Error('unexpected command')}, current.run)} catch (error) {caught = error}

    expect(String(caught)).contains('core #1712')
    expect(calls).deep.eq([['-C', fs.realpathSync(root), 'merge-base', '--is-ancestor', POLICY_READER_FIX_REVISION, readerFixMissing]])
    expect(fs.existsSync(path.join(root, '.data/cubesigner-policy-governance-handoff.json'))).false
    expect(fs.readFileSync(result.buildReceipt).equals(before)).true
  })

  it('upgrades and reuses a matching legacy selection without replacing its artifact or receipt', async () => {
    const result = importCubesignerPolicy(options())
    const selection = JSON.parse(fs.readFileSync(result.selection, 'utf8'))
    delete selection.sourceRepo
    fs.writeFileSync(result.selection, JSON.stringify(selection))
    const receipt = fs.readFileSync(result.buildReceipt)
    const artifact = path.join(root, EXTERNAL_POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm')
    const before = fs.readFileSync(artifact)
    expect(importCubesignerPolicy(options())).deep.eq(result)
    expect(JSON.parse(fs.readFileSync(result.selection, 'utf8')).sourceRepo).eq(fs.realpathSync(root))
    await prepareCubesignerPolicy(root, async () => {throw new Error('unexpected command')}, options().run)
    expect(fs.existsSync(path.join(root, '.data/cubesigner-policy-governance-handoff.json'))).true
    expect(fs.readFileSync(result.buildReceipt).equals(receipt)).true
    expect(fs.readFileSync(artifact).equals(before)).true
  })

  it('does not upgrade a legacy selection if its existing artifact is invalid', () => {
    const result = importCubesignerPolicy(options())
    const selection = JSON.parse(fs.readFileSync(result.selection, 'utf8'))
    delete selection.sourceRepo
    const before = JSON.stringify(selection)
    fs.writeFileSync(result.selection, before)
    fs.appendFileSync(path.join(root, EXTERNAL_POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm'), 'tampered')
    expect(() => importCubesignerPolicy(options())).to.throw('does not match')
    expect(fs.readFileSync(result.selection, 'utf8')).eq(before)
  })

  it('recovers an import interrupted before selecting it', () => {
    const first = importCubesignerPolicy(options())
    fs.unlinkSync(first.selection)
    expect(importCubesignerPolicy(options())).deep.eq(first)
  })

  it('refuses mismatched artifact/context hashes and non-component Wasm before writing output', () => {
    expect(() => importCubesignerPolicy({...options(), expectedWasmSha256: '0'.repeat(64)})).to.throw('Wasm digest mismatch')
    expect(() => importCubesignerPolicy({...options(), expectedProtocolContextSha256: '0'.repeat(64)})).to.throw('context digest mismatch')
    const bad = Buffer.from('not a component')
    fs.writeFileSync(path.join(root, options().wasm), bad)
    expect(() => importCubesignerPolicy({...options(), expectedWasmSha256: digest(bad)})).to.throw('WebAssembly component')
    expect(fs.existsSync(path.join(root, EXTERNAL_POLICY_OUTPUT))).false
    expect(calls).empty
  })

  it('refuses paths outside the deployment and symlinks', () => {
    expect(() => importCubesignerPolicy({...options(), wasm: '../outside.wasm'})).to.throw('inside the deployment')
    fs.symlinkSync(path.join(root, options().wasm), path.join(root, '.data/link.wasm'))
    expect(() => importCubesignerPolicy({...options(), wasm: '.data/link.wasm'})).to.throw('symlinks')
  })

  it('refuses an existing compiler selection without replacing it', () => {
    const file = path.join(root, EXTERNAL_POLICY_INPUT)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    const selected = '{"compilerImage":"example.invalid/compiler"}'
    fs.writeFileSync(file, selected)
    expect(() => importCubesignerPolicy(options())).to.throw('selection already exists')
    expect(fs.readFileSync(file, 'utf8')).eq(selected)
    expect(fs.existsSync(path.join(root, EXTERNAL_POLICY_OUTPUT))).false
  })

  it('does not expose malformed local selection or receipt contents in errors', () => {
    const result = importCubesignerPolicy(options())
    const malformed = 'PRIVATE_TEST_MARKER_NOT_A_CREDENTIAL'
    fs.writeFileSync(result.selection, malformed)
    expect(() => importCubesignerPolicy(options())).to.throw('Invalid policy JSON in compiler.json (contents omitted)')
    fs.writeFileSync(result.buildReceipt, malformed)
    expect(() => verifyExternalPolicy(root, {buildReceiptSha256: digest(malformed), expectedCoreRevision: options().coreRevision, method: 'external'}))
      .to.throw('Invalid policy JSON in build-receipt.json (contents omitted)')
  })

  it('refuses to overwrite conflicting output', () => {
    const result = importCubesignerPolicy(options())
    const artifact = path.join(root, EXTERNAL_POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm')
    fs.appendFileSync(artifact, 'tampered')
    expect(() => importCubesignerPolicy(options())).to.throw('does not match')
    expect(fs.readFileSync(artifact).includes(Buffer.from('tampered'))).true
    expect(fs.existsSync(result.selection)).true
  })

  it('revalidates imported Wasm, receipt, checksum and context before preparation resumes', async () => {
    importCubesignerPolicy(options())
    for (const file of [
      path.join(root, EXTERNAL_POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm'),
      path.join(root, EXTERNAL_POLICY_OUTPUT, 'cubesigner_verifier_policy.wasm.sha256'),
      path.join(root, EXTERNAL_POLICY_OUTPUT, 'build-receipt.json'),
      path.join(root, '.data/protocol_context.json'),
    ]) {
      const original = fs.readFileSync(file)
      fs.appendFileSync(file, ' ')
      let caught = false
      try {await prepareCubesignerPolicy(root, async () => {throw new Error('unexpected command')})} catch (error) {
        caught = true; expect(String(error)).to.match(/does not match|digest mismatch/)
      }

      expect(caught).true
      fs.writeFileSync(file, original)
    }
  })

  it('rejects changed provenance on retry and invalid commit selectors', () => {
    importCubesignerPolicy(options())
    expect(() => importCubesignerPolicy({...options(), buildScriptRevision: 'c'.repeat(40)})).to.throw('selection already exists')
    expect(() => importCubesignerPolicy({...options(), coreRevision: 'main'})).to.throw('commit hashes')
  })
})
