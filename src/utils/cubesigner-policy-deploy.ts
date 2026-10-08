import fs from 'node:fs'
import path from 'node:path'

import {type PolicyToolRunner, runPolicyTool} from './cubesigner-policy-build.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

type Json = Record<string, unknown>
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected CubeSigner response')
  return value as Json
}

/** Refuse to replace unrelated key policies. Repeating this exact attachment is safe. */
export function assertPolicyAttachmentAllowed(key: Json, identifier: string, providerIdentifier?: string): void {
  if (!Object.hasOwn(key, 'policy')) throw new Error('CubeSigner key response lacks policy; refusing replacement')
  const {policy} = key
  if (policy === null || (Array.isArray(policy) && policy.length === 0)) return
  if (Array.isArray(policy) && policy.length === 1 && (policy[0] === identifier || (providerIdentifier && policy[0] === providerIdentifier))) return
  throw new Error('Key already has a different policy; explicit policy migration is required')
}

export function deployCubesignerPolicy(options: {
  buildReceipt: string; buildReceiptSha256: string; keyId: string; name: string; organization: string; output: string
  run?: PolicyToolRunner
}): {attachmentReceipt: string; policyIdentifier: string; wasmSha256: string} {
  if (!/^[\da-z][\d._a-z-]{2,63}$/.test(options.name)) throw new Error('Invalid policy name')
  if (!options.keyId.startsWith('Key#') || !options.organization.startsWith('Org#')) throw new Error('Explicit CubeSigner key and organization IDs are required')
  const run = options.run ?? runPolicyTool
  const cs = (args: string[]): Json => {
    const raw = run('cs', [args[0], '--org-id', options.organization, ...args.slice(1)])
    try { return object(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))) }
    catch { throw new Error('CubeSigner returned an unrecognized JSON response') }
  }

  const receiptFile = proofRegularFile(options.buildReceipt, 1024 * 1024)
  if (proofFileHash(receiptFile) !== options.buildReceiptSha256.replace(/^sha256:/, '')) throw new Error('Policy build receipt digest mismatch')
  const build = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
  if (build.schema !== 'dogeos/cubesigner-policy-build-receipt/v1' || build.wasm.path !== 'cubesigner_verifier_policy.wasm' || build.checks.componentImportSubset !== 'passed') throw new Error('Invalid policy build receipt')
  const wasm = proofRegularFile(path.join(path.dirname(receiptFile), build.wasm.path), 128 * 1024 * 1024)
  const wasmSha256 = proofFileHash(wasm)
  if (wasmSha256 !== build.wasm.sha256 || fs.statSync(wasm).size !== build.wasm.sizeBytes) throw new Error('Wasm changed after compilation')
  const output = path.resolve(options.output)
  fs.mkdirSync(output, {mode: 0o700, recursive: true})
  const attachmentFile = path.join(output, 'attachment.json')
  if (fs.existsSync(attachmentFile)) throw new Error('Attachment receipt already exists')
  const uploadFile = path.join(output, 'upload.json')
  // Preflight BEFORE upload, and again immediately before the provider mutation.
  const key = cs(['key', 'get', '--key-id', options.keyId])
  const previous = fs.existsSync(uploadFile) ? JSON.parse(fs.readFileSync(uploadFile, 'utf8')) : undefined
  let uploaded: Json
  if (previous) {
    if (previous.name !== options.name || previous.organization !== options.organization || previous.wasmSha256 !== wasmSha256 || !/^v\d+$/.test(previous.version)) throw new Error('Upload receipt belongs to a different operation')
    uploaded = cs(['policy', 'get', '--name', options.name, '--version', previous.version])
  } else {
    assertPolicyAttachmentAllowed(key, `${options.name}/v0`)
    uploaded = cs(['policy', 'create', '--type', 'wasm', '--name', options.name, wasm])
  }

  const {version} = uploaded
  if (!Number.isSafeInteger(version) || Number(version) < 0 || uploaded.name !== options.name || uploaded.policy_type !== 'Wasm') throw new Error('Unexpected uploaded policy name/type/version; no key was changed')
  const identifier = `${options.name}/v${version}`
  if (typeof uploaded.policy_id !== 'string' || !/^namedpolicy#[\da-f-]{36}$/i.test(uploaded.policy_id)) throw new Error('Remote policy lacks a canonical provider ID')
  const providerIdentifier = `${uploaded.policy_id}/v${version}`
  if (previous?.providerPolicyIdentifier && previous.providerPolicyIdentifier !== providerIdentifier) throw new Error('Remote policy ID changed after upload')
  const verifyPolicy = (policy: Json): void => {
    const {rules} = policy
    if (policy.name !== options.name || policy.policy_id !== uploaded.policy_id || policy.version !== version || policy.policy_type !== 'Wasm' || !Array.isArray(rules) || rules.length !== 1 || object(rules[0]).hash !== `0x${wasmSha256}`) throw new Error('Remote policy Wasm digest does not match the local artifact')
  }

  verifyPolicy(uploaded)
  verifyPolicy(cs(['policy', 'get', '--name', options.name, '--version', `v${version}`]))
  assertPolicyAttachmentAllowed(key, identifier, providerIdentifier)
  if (!previous) fs.writeFileSync(uploadFile, JSON.stringify({name: options.name, organization: options.organization, policyIdentifier: identifier, providerPolicyIdentifier: providerIdentifier, schema: 'dogeos/cubesigner-policy-upload/v1', version: `v${version}`, wasmSha256}, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  // A policy-level empty-request rejection tests the actual hosted component.
  const smoke = cs(['policy', 'invoke', '--name', options.name, '--version', `v${version}`, '--key-id', options.keyId, '{}', '--json'])
  if (object(smoke.response).response !== 'Deny') throw new Error('Hosted policy did not reject an empty request; no key was changed')
  assertPolicyAttachmentAllowed(cs(['key', 'get', '--key-id', options.keyId]), identifier, providerIdentifier)
  run('cs', ['key', '--org-id', options.organization, 'set-policy', '--key-id', options.keyId, '--policy', JSON.stringify(providerIdentifier)])
  const readback = cs(['key', 'get', '--key-id', options.keyId])
  if (!Array.isArray(readback.policy) || readback.policy.length !== 1 || readback.policy[0] !== providerIdentifier) throw new Error('Key policy readback mismatch; inspect the key before retrying')
  const attachment = {buildReceiptSha256: proofFileHash(receiptFile), checkedAt: new Date().toISOString(), keyId: options.keyId, materialId: readback.material_id, organization: options.organization, policyArtifactDigest: `sha256:${wasmSha256}`, policyIdentifier: identifier, protocolContextSha256: build.pins.protocolContextSha256, providerPolicyIdentifier: providerIdentifier, readback: 'verified', schema: 'dogeos/cubesigner-policy-deployment/v1', smoke: {emptyRequest: 'Deny'}}
  fs.writeFileSync(attachmentFile, JSON.stringify(attachment, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  return {attachmentReceipt: attachmentFile, policyIdentifier: identifier, wasmSha256}
}
