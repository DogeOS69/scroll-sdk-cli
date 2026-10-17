import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {POLICY_BUILD_RECEIPT_SCHEMA} from './cubesigner-policy-build.js'
import {type ExternalPolicySelection, verifyExternalPolicy} from './cubesigner-policy-import.js'
import {AwaitingInput, localPath, writeJson} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export const POLICY_COMPILER_INPUT = '.scrollsdk/inputs/cubesigner-policy/compiler.json'
export const POLICY_OUTPUT = '.data/cubesigner-policy'

export function needsPreparationPolicy(spec: DeploymentSpec): boolean {
  return Boolean(spec.signing?.cubesigner && spec.signing.cubesigner.mode !== 'transport_only')
}

/** Export only; publication and governed attachment remain separate operator actions. */
export async function prepareCubesignerPolicy(root: string, command: (args: string[]) => Promise<void>): Promise<void> {
  const input = localPath(root, POLICY_COMPILER_INPUT)
  const inputTemplate = {
    compilerImage: 'ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:REPLACE_WITH_RELEASE_IMAGE_DIGEST',
    expectedCoreRevision: 'REPLACE_WITH_RELEASE_CORE_COMMIT',
  }
  if (!fs.existsSync(input)) writeJson(input, inputTemplate)
  let selection: {buildReceiptSha256?: unknown; compilerImage?: unknown; expectedCoreRevision?: unknown; method?: unknown}
  try {selection = JSON.parse(fs.readFileSync(proofRegularFile(input, 16 * 1024), 'utf8'))} catch {
    throw new AwaitingInput({file: input, inputTemplate, message: 'Policy compiler input must be a JSON object. Use the private compiler image digest and Core commit from the approved Core release; no credentials belong in this file.'})
  }

  if (selection?.method === 'external') {
    const verified = verifyExternalPolicy(root, selection as ExternalPolicySelection)
    writeJson(localPath(root, '.data/cubesigner-policy-governance-handoff.json'), {
      buildReceipt: {path: `${POLICY_OUTPUT}/build-receipt.json`, sha256: proofFileHash(verified.receiptFile)},
      buildScript: verified.receipt.buildScript,
      coreRevision: verified.receipt.coreRevision,
      instructions: [
        'This import records operator-declared build provenance and checks local hashes; it does not independently reproduce the build or verify governance.',
        'If the reviewed artifact is already published and attached, preserve those operations and obtain the governed release/attachment receipts; do not publish or attach it again.',
        'Use the Core governance runbook for attestation and test evidence. Fill .scrollsdk/inputs/cubesigner-policy/receipts.json when preparation pauses at charts. API snapshots alone are not production receipts.',
      ],
      schema: 'scrollsdk/cubesigner-policy-governance-handoff/v1',
      status: 'external-build-imported-governance-unverified',
      wasm: {path: `${POLICY_OUTPUT}/cubesigner_verifier_policy.wasm`, sha256: verified.wasmSha256},
    })
    return
  }

  if (!selection || typeof selection !== 'object'
    || selection.method !== undefined
    || typeof selection.compilerImage !== 'string' || !/^ghcr\.io\/dogeos69\/cubesigner-policy-compiler@sha256:[\da-f]{64}$/.test(selection.compilerImage)
    || typeof selection.expectedCoreRevision !== 'string' || !/^[\da-f]{40}$/.test(selection.expectedCoreRevision)) {
    throw new AwaitingInput({file: input, inputTemplate, message: 'Supply the policy compiler digest and full Core commit from the approved Core release (not the proof producer). Authenticate Docker to private GHCR with read:packages, then rerun scrollsdk setup proof-materials.'})
  }

  const output = localPath(root, POLICY_OUTPUT)
  if (!fs.existsSync(output)) {
    await command(['cubesigner-policy', 'build', '--compiler-image', selection.compilerImage, '--expected-core-revision', selection.expectedCoreRevision, '--output', output])
  }

  // Reconcile a successful export followed by an interrupted workflow checkpoint.
  // Never overwrite an artifact or treat directory existence alone as success.
  const receiptFile = proofRegularFile(path.join(output, 'build-receipt.json'))
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  const wasmFile = proofRegularFile(path.join(output, 'cubesigner_verifier_policy.wasm'), 128 * 1024 * 1024)
  const wasm = fs.readFileSync(wasmFile)
  const hash = proofFileHash(wasmFile)
  const checksum = fs.readFileSync(proofRegularFile(`${wasmFile}.sha256`, 1024), 'utf8')
  if (receipt.schema !== POLICY_BUILD_RECEIPT_SCHEMA || receipt.compilerImage !== selection.compilerImage
    || receipt.coreRevision !== selection.expectedCoreRevision || receipt.wasm?.path !== path.basename(wasmFile)
    || receipt.wasm?.sha256 !== hash || receipt.wasm?.sizeBytes !== wasm.length
    || checksum !== `${hash}  ${path.basename(wasmFile)}\n`
    || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]))) {
    throw new Error('Existing CubeSigner policy output does not match its pinned compiler and verified build receipt; inspect it before resuming')
  }

  writeJson(localPath(root, '.data/cubesigner-policy-governance-handoff.json'), {
    buildReceipt: {path: `${POLICY_OUTPUT}/build-receipt.json`, sha256: proofFileHash(receiptFile)},
    compilerImage: selection.compilerImage,
    coreRevision: selection.expectedCoreRevision,
    instructions: [
      'Submit this artifact and its build provenance through the approved governance tooling. This file is a build handoff, not approval or attachment evidence.',
      'Publish a policy version; propose attaching that exact version while preserving RequireRoleSession. Council members independently reproduce and compare the Wasm hash before approval.',
      'After approval, complete attachment and verify provider readback for the intended key and role. Fill .scrollsdk/inputs/cubesigner-policy/receipts.json when setup proof-materials pauses at charts, then rerun the same command. Do not edit the frozen spec or managed doge-config.toml.',
    ],
    schema: 'scrollsdk/cubesigner-policy-governance-handoff/v1',
    status: 'built-not-published-or-attached',
    wasm: {path: `${POLICY_OUTPUT}/${path.basename(wasmFile)}`, sha256: hash},
  })
}
