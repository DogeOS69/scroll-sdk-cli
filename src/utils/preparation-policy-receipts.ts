import * as toml from '@iarna/toml'
import fs from 'node:fs'

import type {DogeConfig} from '../types/doge-config.js'
import type {CubesignerPolicyReceiptInputs} from './cubesigner-policy-receipts.js'

import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {AwaitingInput, localPath, privateWrite, writeJson} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export const POLICY_RECEIPTS_INPUT = '.scrollsdk/inputs/cubesigner-policy/receipts.json'

/** Import late governance evidence inside the workflow, without changing frozen intent. */
export function importPreparationPolicyReceipts(root: string): void {
  const file = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8')) as unknown as DogeConfig
  const selection = config.cubesigner
  if (selection?.mode !== 'production_verifier_key_policy') return

  const resolve = (policyReceipts: CubesignerPolicyReceiptInputs | undefined) => resolveCubesignerPolicy({
    deploymentDir: root,
    keys: (selection.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id}))),
    network: config.network,
    selection: {...selection, policyReceipts},
  })
  // Existing evidence remains authoritative; a stray input file cannot replace it.
  if (selection.policyReceipts || selection.productionPolicy) {
    resolve(selection.policyReceipts)
    return
  }

  const protocolPath = '.data/protocol_context.json'
  const protocolContext = {path: protocolPath, sha256: `sha256:${proofFileHash(proofRegularFile(localPath(root, protocolPath)))}`}
  const input = localPath(root, POLICY_RECEIPTS_INPUT)
  const inputTemplate = {
    attachment: {path: '.scrollsdk/inputs/cubesigner-policy/attachment.json', sha256: 'REPLACE_WITH_ATTACHMENT_RECEIPT_SHA256'},
    environment: 'REPLACE_WITH_CUBESIGNER_ENVIRONMENT',
    organization: 'REPLACE_WITH_CUBESIGNER_ORGANIZATION',
    protocolContext,
    release: {path: '.scrollsdk/inputs/cubesigner-policy/release.json', sha256: 'REPLACE_WITH_RELEASE_RECEIPT_SHA256'},
  }
  if (!fs.existsSync(input)) writeJson(input, inputTemplate)
  const waiting = () => new AwaitingInput({
    file: input, inputTemplate,
    message: 'Release/attachment receipts are missing. If the policy is already published and Council-approved, use scrollsdk setup cubesigner-policy reconcile --dir <deployment> --input <reviewed-input.json>; do not repeat publication or approval. See docs/cubesigner-external-policy.md for the release/test inputs. Otherwise complete governance first. Include liveEvidence if required by the release. Rerun the same preparation command; do not edit the spec, frozen intent or doge-config.toml.',
  })
  let refs: CubesignerPolicyReceiptInputs
  try {refs = JSON.parse(fs.readFileSync(proofRegularFile(input, 64 * 1024), 'utf8'))} catch {throw waiting()}
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)
    || typeof refs.environment !== 'string' || !refs.environment.trim() || refs.environment.startsWith('REPLACE_WITH_')
    || typeof refs.organization !== 'string' || !refs.organization.trim() || refs.organization.startsWith('REPLACE_WITH_')
    || [refs.release, refs.attachment, refs.protocolContext].some(ref => !ref || typeof ref.path !== 'string' || !ref.path.trim() || !/^(sha256:)?[\da-f]{64}$/.test(ref.sha256))) throw waiting()

  // Validate every dependency and the exact key/role/context before any managed write.
  resolve(refs)
  selection.policyReceipts = refs
  privateWrite(file, toml.stringify(config as unknown as toml.JsonMap))
}
