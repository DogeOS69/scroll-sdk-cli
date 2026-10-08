import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {parseImmutableProofImage} from './proof-materials.js'
import {readProofReleasePreparation} from './proof-release-preparation.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export type PolicyToolRunner = (program: string, args: string[]) => string
export const runPolicyTool: PolicyToolRunner = (program, args) => {
  const result = spawnSync(program, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000})
  // Provider diagnostics can contain signing requests or session material.
  if (result.error || result.status !== 0) throw new Error(`${program} policy operation failed (exit ${result.status ?? 'unknown'})`)
  return result.stdout
}

export function buildCubesignerPolicy(options: {
  compilerImage: string; expectedRevision: string; output: string; preparationReceipt: string
  protocolContext: string; resolverBaseUrl: string; run?: PolicyToolRunner
}): {directory: string; receipt: string; receiptSha256: string; wasm: string} {
  const run = options.run ?? runPolicyTool
  parseImmutableProofImage(options.compilerImage, 'policy compiler')
  if (!/^[\da-f]{40}$/.test(options.expectedRevision)) throw new Error('Expected a full core revision')
  const preparation = readProofReleasePreparation(options.preparationReceipt)
  if (preparation.coreRevision !== options.expectedRevision) throw new Error('Policy compiler and preparation must use the same core revision')
  const context = proofRegularFile(options.protocolContext)
  if (proofFileHash(context) !== preparation.files.protocolContext.sha256) throw new Error('Preparation belongs to a different protocol context')
  const resolver = new URL(options.resolverBaseUrl)
  if (resolver.protocol !== 'https:' || resolver.username || resolver.password || resolver.search || resolver.hash || !resolver.pathname.endsWith('/')) throw new Error('Policy resolver requires a public HTTPS base URL ending in /')
  const target = path.resolve(options.output)
  if (fs.existsSync(target)) throw new Error('Policy output already exists')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Policy output parent contains a symlink')
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.policy-build-'))
  try {
    const inputDir = path.join(stage, 'inputs')
    fs.mkdirSync(inputDir)
    const request: Record<string, unknown> = {resolverBaseUrl: options.resolverBaseUrl, schema: 'dogeos/cubesigner-policy-build/v1'}
    for (const [name, source] of Object.entries({aggregateVerifyingKey: preparation.files.scroll.aggregateVerifyingKey.path, bridgeManifest: preparation.files.bridge.nativeManifest.path, protocolContext: context})) {
      const file = proofRegularFile(source)
      const copy = path.join(inputDir, name)
      fs.copyFileSync(file, copy)
      if (proofFileHash(file) !== proofFileHash(copy)) throw new Error('Policy input changed during copy')
      request[name] = {path: name, sha256: proofFileHash(copy)}
    }

    fs.writeFileSync(path.join(inputDir, 'request.json'), JSON.stringify(request) + '\n', {mode: 0o600})
    run('docker', ['pull', options.compilerImage])
    const revision = run('docker', ['image', 'inspect', options.compilerImage, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
    if (revision !== options.expectedRevision) throw new Error('Policy compiler image revision mismatch')
    run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-v', `${inputDir}:/input:ro`, '-v', `${stage}:/output`, options.compilerImage, '/input/request.json', '/output/artifact'])
    const artifact = path.join(stage, 'artifact')
    const receiptPath = proofRegularFile(path.join(artifact, 'build-receipt.json'), 1024 * 1024)
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    const wasm = proofRegularFile(path.join(artifact, 'cubesigner_verifier_policy.wasm'), 128 * 1024 * 1024)
    if (receipt.schema !== 'dogeos/cubesigner-policy-build-receipt/v1' || receipt.coreRevision !== revision || receipt.requestSha256 !== proofFileHash(path.join(inputDir, 'request.json')) || receipt.pins.protocolContextSha256 !== proofFileHash(context) || receipt.wasm.path !== path.basename(wasm) || receipt.wasm.sha256 !== proofFileHash(wasm) || receipt.wasm.sizeBytes !== fs.statSync(wasm).size || receipt.checks.componentImportSubset !== 'passed') throw new Error('Policy build receipt does not match its inputs and Wasm')
    if (!fs.readFileSync(wasm).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]))) throw new Error('Expected a WebAssembly component')
    fs.writeFileSync(path.join(artifact, 'compiler.json'), JSON.stringify({image: options.compilerImage, preparationReceiptSha256: proofFileHash(options.preparationReceipt), revision}, null, 2) + '\n')
    fs.renameSync(inputDir, path.join(artifact, 'inputs'))
    fs.renameSync(artifact, target)
    const receiptFile = path.join(target, 'build-receipt.json')
    return {directory: target, receipt: receiptFile, receiptSha256: proofFileHash(receiptFile), wasm: path.join(target, path.basename(wasm))}
  } finally {
    fs.rmSync(stage, {force: true, recursive: true})
  }
}
