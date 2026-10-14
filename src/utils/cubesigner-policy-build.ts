import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {parseImmutableProofImage} from './proof-materials.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export type PolicyToolRunner = (program: string, args: string[]) => string
export const runPolicyTool: PolicyToolRunner = (program, args) => {
  const result = spawnSync(program, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000})
  // Provider diagnostics can contain signing requests or session material.
  if (result.error || result.status !== 0) throw new Error(`${program} policy operation failed (exit ${result.status ?? 'unknown'})`)
  return result.stdout
}

export const POLICY_BUILD_RECEIPT_SCHEMA = 'dogeos/cubesigner-policy-build-receipt/v2'
const WASM = 'cubesigner_verifier_policy.wasm'
const COMPONENT_MAGIC = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0])

/**
 * Export the CubeSigner policy Wasm from the release's compiler image. The policy's release values are
 * constants committed at that core revision, so the image takes no inputs: it writes the Wasm and its
 * `.sha256` to one output directory. The image is published only to the private GHCR package
 * ghcr.io/dogeos69/cubesigner-policy-compiler; pulling it needs a `docker login ghcr.io` with a token
 * that has `read:packages`.
 */
export function buildCubesignerPolicy(options: {
  compilerImage: string; expectedRevision: string; output: string; run?: PolicyToolRunner
}): {directory: string; receipt: string; receiptSha256: string; wasm: string; wasmSha256: string} {
  const run = options.run ?? runPolicyTool
  parseImmutableProofImage(options.compilerImage, 'policy compiler')
  if (!/^[\da-f]{40}$/.test(options.expectedRevision)) throw new Error('Expected a full core revision')
  const target = path.resolve(options.output)
  if (fs.existsSync(target)) throw new Error('Policy output already exists')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Policy output parent contains a symlink')
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.policy-build-'))
  try {
    run('docker', ['pull', options.compilerImage])
    const revision = run('docker', ['image', 'inspect', options.compilerImage, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
    if (revision !== options.expectedRevision) throw new Error('Policy compiler image revision mismatch')
    run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-v', `${stage}:/output`, options.compilerImage, '/output/artifact'])
    const artifact = path.join(stage, 'artifact')
    const wasm = proofRegularFile(path.join(artifact, WASM), 128 * 1024 * 1024)
    const digestLine = fs.readFileSync(proofRegularFile(path.join(artifact, `${WASM}.sha256`), 1024), 'utf8')
    const wasmSha256 = proofFileHash(wasm)
    if (digestLine !== `${wasmSha256}  ${WASM}\n`) throw new Error('Policy Wasm does not match the compiler image sha256')
    if (!fs.readFileSync(wasm).subarray(0, 8).equals(COMPONENT_MAGIC)) throw new Error('Expected a WebAssembly component')
    const receipt = {compilerImage: options.compilerImage, coreRevision: revision, schema: POLICY_BUILD_RECEIPT_SCHEMA, wasm: {path: WASM, sha256: wasmSha256, sizeBytes: fs.statSync(wasm).size}}
    fs.writeFileSync(path.join(artifact, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    fs.renameSync(artifact, target)
    const receiptFile = path.join(target, 'build-receipt.json')
    return {directory: target, receipt: receiptFile, receiptSha256: proofFileHash(receiptFile), wasm: path.join(target, WASM), wasmSha256}
  } finally {
    fs.rmSync(stage, {force: true, recursive: true})
  }
}
