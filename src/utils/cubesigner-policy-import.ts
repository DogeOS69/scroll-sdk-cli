import fs from 'node:fs'
import path from 'node:path'

import {type PolicyToolRunner, runPolicyTool} from './cubesigner-policy-build.js'
import {digest, localPath, writeJson} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export const EXTERNAL_POLICY_SCHEMA = 'dogeos/cubesigner-policy-external-build/v1'
export const EXTERNAL_POLICY_INPUT = '.scrollsdk/inputs/cubesigner-policy/compiler.json'
export const EXTERNAL_POLICY_OUTPUT = '.data/cubesigner-policy'
const WASM = 'cubesigner_verifier_policy.wasm'
const SCRIPT = 'tools/cubesigner/build-verifier.sh'
const CONTEXT = '.data/protocol_context.json'
const MAGIC = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0])
const SHA = /^[\da-f]{64}$/
const REVISION = /^[\da-f]{40}$/

export type ExternalPolicySelection = {
  buildReceiptSha256: string; expectedCoreRevision: string; method: 'external'
}

/** Validate a local import, without claiming reproducibility, governance, or live verification. */
export function verifyExternalPolicy(root: string, selection: ExternalPolicySelection) {
  if (!REVISION.test(selection.expectedCoreRevision) || !SHA.test(selection.buildReceiptSha256)) throw new Error('Invalid external policy selection')
  const output = localPath(root, EXTERNAL_POLICY_OUTPUT)
  const receiptFile = proofRegularFile(path.join(output, 'build-receipt.json'), 64 * 1024)
  if (proofFileHash(receiptFile) !== selection.buildReceiptSha256) throw new Error('External policy receipt digest mismatch')
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  const file = proofRegularFile(path.join(output, WASM), 128 * 1024 * 1024)
  const wasm = fs.readFileSync(file)
  const hash = digest(wasm)
  if (receipt.schema !== EXTERNAL_POLICY_SCHEMA || receipt.coreRevision !== selection.expectedCoreRevision
    || receipt.provenance !== 'operator-declared-external-build' || receipt.compilerImage !== undefined
    || receipt.buildScript?.path !== SCRIPT || typeof receipt.buildScript?.revision !== 'string' || !REVISION.test(receipt.buildScript.revision)
    || typeof receipt.buildScript?.sha256 !== 'string' || !SHA.test(receipt.buildScript.sha256)
    || receipt.protocolContext?.path !== CONTEXT || receipt.protocolContext?.sha256 !== proofFileHash(proofRegularFile(localPath(root, CONTEXT)))
    || receipt.wasm?.path !== WASM || receipt.wasm?.sha256 !== hash || receipt.wasm?.sizeBytes !== wasm.length
    || !wasm.subarray(0, 8).equals(MAGIC)
    || fs.readFileSync(proofRegularFile(`${file}.sha256`, 1024), 'utf8') !== `${hash}  ${WASM}\n`) {
    throw new Error('External policy artifact, provenance, or current protocol context does not match its receipt')
  }

  return {receipt, receiptFile, wasmSha256: hash}
}

/** Archive an already built component and select it for preparation. Never runs build or provider commands. */
export function importCubesignerPolicy(options: {
  buildScriptRevision: string; coreRevision: string; directory: string; expectedProtocolContextSha256: string
  expectedWasmSha256: string; run?: PolicyToolRunner; sourceRepo: string; wasm: string
}) {
  const root = fs.realpathSync(options.directory)
  if (!REVISION.test(options.coreRevision) || !REVISION.test(options.buildScriptRevision)) throw new Error('Full core and build-script commit hashes are required')
  if (!SHA.test(options.expectedWasmSha256) || !SHA.test(options.expectedProtocolContextSha256)) throw new Error('Expected SHA-256 values must contain 64 lowercase hexadecimal characters')
  const wasm = fs.readFileSync(proofRegularFile(localPath(root, options.wasm), 128 * 1024 * 1024))
  if (digest(wasm) !== options.expectedWasmSha256) throw new Error('External Wasm digest mismatch')
  if (!wasm.subarray(0, 8).equals(MAGIC)) throw new Error('Expected a WebAssembly component')
  const contextHash = proofFileHash(proofRegularFile(localPath(root, CONTEXT)))
  if (contextHash !== options.expectedProtocolContextSha256) throw new Error('Current protocol context digest mismatch')
  const run = options.run ?? runPolicyTool
  const repo = fs.realpathSync(options.sourceRepo)
  for (const revision of [options.coreRevision, options.buildScriptRevision]) {
    if (run('git', ['-C', repo, 'rev-parse', '--verify', `${revision}^{commit}`]).trim() !== revision) throw new Error('Source revision is not the requested commit')
  }

  const script = run('git', ['-C', repo, 'show', `${options.buildScriptRevision}:${SCRIPT}`])
  if (!script.trim()) throw new Error('Build script is empty')
  const receipt = {
    buildScript: {path: SCRIPT, revision: options.buildScriptRevision, sha256: digest(script)},
    coreRevision: options.coreRevision,
    protocolContext: {path: CONTEXT, sha256: contextHash},
    provenance: 'operator-declared-external-build',
    schema: EXTERNAL_POLICY_SCHEMA,
    wasm: {path: WASM, sha256: options.expectedWasmSha256, sizeBytes: wasm.length},
  }
  const receiptText = JSON.stringify(receipt, null, 2) + '\n'
  const selection: ExternalPolicySelection = {buildReceiptSha256: digest(receiptText), expectedCoreRevision: options.coreRevision, method: 'external'}
  const input = localPath(root, EXTERNAL_POLICY_INPUT)
  if (fs.existsSync(input)) {
    const existing = JSON.parse(fs.readFileSync(proofRegularFile(input, 16 * 1024), 'utf8'))
    if (existing.method !== selection.method || existing.expectedCoreRevision !== selection.expectedCoreRevision || existing.buildReceiptSha256 !== selection.buildReceiptSha256
      || Object.keys(existing).length !== 3) throw new Error('Policy selection already exists with different inputs; inspect it before importing')
  }

  const output = localPath(root, EXTERNAL_POLICY_OUTPUT)
  if (!fs.existsSync(output)) {
    fs.mkdirSync(path.dirname(output), {mode: 0o700, recursive: true})
    const stage = fs.mkdtempSync(path.join(path.dirname(output), '.policy-import-'))
    try {
      fs.writeFileSync(path.join(stage, WASM), wasm, {flag: 'wx', mode: 0o600})
      fs.writeFileSync(path.join(stage, `${WASM}.sha256`), `${options.expectedWasmSha256}  ${WASM}\n`, {flag: 'wx', mode: 0o600})
      fs.writeFileSync(path.join(stage, 'build-receipt.json'), receiptText, {flag: 'wx', mode: 0o600})
      fs.renameSync(stage, output)
    } finally { fs.rmSync(stage, {force: true, recursive: true}) }
  }

  // An interrupted import can resume from matching artifacts. Conflicting output is never overwritten.
  const verified = verifyExternalPolicy(root, selection)
  if (!fs.existsSync(input)) writeJson(input, selection)
  return {
    buildReceipt: verified.receiptFile,
    buildReceiptSha256: selection.buildReceiptSha256,
    governance: 'not-verified-by-import',
    selection: input,
    status: 'external-build-imported',
    wasmSha256: verified.wasmSha256,
  }
}
