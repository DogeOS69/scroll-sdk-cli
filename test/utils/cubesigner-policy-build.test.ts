import {expect} from 'chai'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {POLICY_BUILD_RECEIPT_SCHEMA, buildCubesignerPolicy} from '../../src/utils/cubesigner-policy-build.js'

describe('CubeSigner policy build', () => {
  const image = `ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:${'1'.repeat(64)}`
  const revision = 'a'.repeat(40)
  const component = Buffer.concat([Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]), Buffer.from('policy')])
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-build-')) })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  /** A fake docker whose image writes `wasm` and `digestLine` into the mounted output directory. */
  function docker(options: {digestLine?: (wasm: Buffer) => string; labelRevision?: string; wasm?: Buffer} = {}) {
    const calls: string[][] = []
    const run = (program: string, args: string[]) => {
      expect(program).to.equal('docker')
      calls.push(args)
      if (args[0] === 'image') return `${options.labelRevision ?? revision}\n`
      if (args[0] === 'run') {
        const mount = args[args.indexOf('-v') + 1]
        const [host, container] = mount.split(':')
        const out = path.join(host, path.relative(container, args.at(-1)!))
        const wasm = options.wasm ?? component
        fs.mkdirSync(out)
        fs.writeFileSync(path.join(out, 'cubesigner_verifier_policy.wasm'), wasm)
        fs.writeFileSync(path.join(out, 'cubesigner_verifier_policy.wasm.sha256'),
          options.digestLine ? options.digestLine(wasm) : `${sha256(wasm)}  cubesigner_verifier_policy.wasm\n`)
      }

      return ''
    }

    return {calls, run}
  }

  it('exports the Wasm offline with one output argument and records its hash', () => {
    const {calls, run} = docker()
    const result = buildCubesignerPolicy({compilerImage: image, expectedRevision: revision, output: path.join(root, 'policy'), run})
    const dockerRun = calls.find(args => args[0] === 'run')!
    expect(dockerRun).to.include.members(['--network', 'none', '--read-only', '--cap-drop', 'ALL'])
    expect(dockerRun.slice(dockerRun.indexOf(image))).to.deep.equal([image, '/output/artifact'])
    expect(dockerRun.join(' ')).to.not.include('request.json')
    expect(result.wasmSha256).to.equal(sha256(component))
    const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'))
    expect(receipt).to.deep.equal({compilerImage: image, coreRevision: revision, schema: POLICY_BUILD_RECEIPT_SCHEMA, wasm: {path: 'cubesigner_verifier_policy.wasm', sha256: sha256(component), sizeBytes: component.length}})
    expect(fs.readdirSync(result.directory).sort()).to.deep.equal(['build-receipt.json', 'cubesigner_verifier_policy.wasm', 'cubesigner_verifier_policy.wasm.sha256'])
    expect(fs.readdirSync(root)).to.deep.equal(['policy'])
  })

  it('refuses a compiler image from another core revision', () => {
    const {run} = docker({labelRevision: 'b'.repeat(40)})
    expect(() => buildCubesignerPolicy({compilerImage: image, expectedRevision: revision, output: path.join(root, 'policy'), run})).to.throw('revision mismatch')
    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('refuses a Wasm that does not match the image sha256', () => {
    const {run} = docker({digestLine: () => `${'0'.repeat(64)}  cubesigner_verifier_policy.wasm\n`})
    expect(() => buildCubesignerPolicy({compilerImage: image, expectedRevision: revision, output: path.join(root, 'policy'), run})).to.throw('does not match')
  })

  it('refuses output that is not a WebAssembly component', () => {
    const {run} = docker({wasm: Buffer.from('not wasm')})
    expect(() => buildCubesignerPolicy({compilerImage: image, expectedRevision: revision, output: path.join(root, 'policy'), run})).to.throw('WebAssembly component')
  })

  it('requires an immutable image reference and a fresh output directory', () => {
    const {run} = docker()
    expect(() => buildCubesignerPolicy({compilerImage: 'ghcr.io/dogeos69/cubesigner-policy-compiler:v0.3.0', expectedRevision: revision, output: path.join(root, 'policy'), run})).to.throw('sha256')
    fs.mkdirSync(path.join(root, 'policy'))
    expect(() => buildCubesignerPolicy({compilerImage: image, expectedRevision: revision, output: path.join(root, 'policy'), run})).to.throw('already exists')
  })
})
