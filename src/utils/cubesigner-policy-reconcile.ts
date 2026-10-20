import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {POLICY_BUILD_RECEIPT_SCHEMA} from './cubesigner-policy-build.js'
import {EXTERNAL_POLICY_SCHEMA} from './cubesigner-policy-import.js'
import {type CubesignerExpectedPolicyInputs, type CubesignerPolicyReceiptInputs, resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {localPath, writeJson} from './preparation-io.js'
import {POLICY_RECEIPTS_INPUT} from './preparation-policy-receipts.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

type ObjectValue = Record<string, any>
export interface PolicyReadbackClient {
  authorities(): Promise<string[]>
  environment: string
  key(role: string, key: string): Promise<unknown>
  organization: string
  /** Provider-verified alias for the canonical organization above. */
  organizationName?: string
  policy(name: string, version: string): Promise<unknown>
  role(id: string): Promise<unknown>
}
export class PolicyReconciliationError extends Error {}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PolicyReconciliationError(message)
}

function object(value: unknown, label: string): ObjectValue {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value as ObjectValue
}

function bindOrganization(client: PolicyReadbackClient, input: ObjectValue): void {
  requireValue(client.environment === input.environment && client.organization.startsWith('Org#')
    && (input.organization === client.organization || input.organization === client.organizationName), 'Management session environment/organization mismatch')
  input.organization = client.organization
}

const json = (file: string) => object(JSON.parse(fs.readFileSync(file, 'utf8')), 'JSON input')
const hash = (file: string) => `sha256:${proofFileHash(file)}`

/** Read existing remote state only. Never uploads, attaches, approves, signs, or changes an allowlist. */
export async function reconcileCubesignerPolicy(options: {
  connect: () => Promise<PolicyReadbackClient>; directory: string; input: string; output: string; prepareOnly?: boolean
}) {
  const root = fs.realpathSync(options.directory)
  const input = json(proofRegularFile(localPath(root, options.input), 128 * 1024))
  const releaseInput = object(input.release, 'release')
  const key = object(input.key, 'key')
  for (const [field, prefix] of [['keyId', 'Key#'], ['roleId', 'Role#']] as const) {
    requireValue(typeof key[field] === 'string' && key[field].startsWith(prefix), `Invalid ${field}`)
  }

  requireValue(typeof key.materialId === 'string' && key.materialId.length > 0, 'Missing materialId')
  const configFile = localPath(root, '.data/doge-config.toml')
  const configDigest = hash(proofRegularFile(configFile))
  const config = toml.parse(fs.readFileSync(proofRegularFile(configFile), 'utf8')) as ObjectValue
  const selection = config.cubesigner
  requireValue(selection?.mode === 'production_verifier_key_policy' && (options.prepareOnly || !selection.policyReceipts) && !selection.productionPolicy,
    'Deployment must select explicit production mode without an existing receipt selection or manually transcribed policy')
  const declaredKeys = (selection.roles ?? []).flatMap((role: ObjectValue) => (role.keys ?? []).map((entry: ObjectValue) => ({keyId: entry.key_id, materialId: entry.material_id, roleId: role.role_id})))
  requireValue(isDeepStrictEqual(declaredKeys, [{keyId: key.keyId, materialId: key.materialId, roleId: key.roleId}]), 'Reconciliation key/role differs from saved deployment configuration')
  requireValue(['beta', 'gamma', 'prod'].includes(input.environment) && typeof input.organization === 'string' && input.organization.trim().length > 0, 'Explicit CubeSigner environment and organization are required')
  requireValue(typeof releaseInput.requiresLiveEvidence === 'boolean', 'release.requiresLiveEvidence must explicitly describe the reviewed release requirement')
  requireValue(typeof releaseInput.policyIdentifier === 'string' && /^[\da-z][\d._a-z-]{2,63}\/v(?:0|[1-9]\d{0,8})$/.test(releaseInput.policyIdentifier), 'Explicit immutable name/vN policy identifier is required')
  requireValue(typeof releaseInput.proofResolverAuthority === 'string', 'Missing HTTPS proof resolver authority')
  const resolver = new URL(releaseInput.proofResolverAuthority)
  requireValue(resolver.protocol === 'https:' && resolver.origin === releaseInput.proofResolverAuthority, 'Proof resolver must be an HTTPS origin without a path')
  const read = (ref: ObjectValue, label: string, limit = 128 * 1024 * 1024) => {
    requireValue(ref && typeof ref.path === 'string' && typeof ref.sha256 === 'string' && /^(sha256:)?[\da-f]{64}$/.test(ref.sha256), `${label} requires a path and SHA-256`)
    const file = proofRegularFile(localPath(root, ref.path), limit)
    requireValue(hash(file) === `sha256:${ref.sha256.replace(/^sha256:/, '')}`, `${label} digest mismatch`)
    return file
  }

  const buildFile = read(input.buildReceipt, 'buildReceipt', 1024 * 1024)
  const build = json(buildFile)
  requireValue([EXTERNAL_POLICY_SCHEMA, POLICY_BUILD_RECEIPT_SCHEMA].includes(build.schema), 'Unsupported build receipt; deployment/v2 is not a release receipt')
  const wasmFile = read(releaseInput.wasm, 'release.wasm')
  requireValue(build.coreRevision === releaseInput.coreRevision && `sha256:${build.wasm?.sha256}` === hash(wasmFile)
    && build.wasm?.sizeBytes === fs.statSync(wasmFile).size, 'Release does not match build receipt')
  requireValue(fs.readFileSync(wasmFile).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 13, 0, 1, 0])), 'Expected a WebAssembly component')
  const context = proofRegularFile(localPath(root, '.data/protocol_context.json'))
  requireValue(releaseInput.protocolContextSha256 === hash(context), 'Release does not match current protocol context')
  if (build.schema === EXTERNAL_POLICY_SCHEMA) requireValue(`sha256:${build.protocolContext?.sha256}` === hash(context), 'External build belongs to another protocol context')
  const testsFile = read(releaseInput.tests, 'release.tests', 16 * 1024 * 1024)
  const tests = json(testsFile)
  requireValue(tests.result === 'passed' && releaseInput.tests.result === 'passed'
    && tests.coreRevision === releaseInput.coreRevision && tests.wasmSha256 === hash(wasmFile)
    && tests.protocolContextSha256 === hash(context), 'Test report must record passed tests bound to the source, Wasm and protocol context; build success is not test evidence')
  const bridge = read(input.bridgeProgram, 'bridgeProgram')
  const vk = read(input.aggregateVerifyingKey, 'aggregateVerifyingKey')
  requireValue(releaseInput.verifierProvenance?.bridgeProgramSha256 === hash(bridge)
    && releaseInput.verifierProvenance?.aggregateVerifyingKeySha256 === hash(vk), 'Verifier provenance does not match supplied artifacts')
  const live = input.liveEvidence ? read(input.liveEvidence, 'liveEvidence', 512 * 1024) : undefined
  const output = localPath(root, options.output)
  if (options.prepareOnly && fs.existsSync(output)) {
    const archived = json(proofRegularFile(path.join(output, 'expected-selection.json')))
    requireValue(json(proofRegularFile(path.join(output, 'preparation-request.json'))).inputSha256 === hash(proofRegularFile(localPath(root, options.input))), 'Existing preparation belongs to different inputs; review a new output explicitly')
    const resolved = resolveCubesignerPolicy({deploymentDir: root, keys: declaredKeys, network: config.network, scope: 'preparation', selection: {expectedPolicy: archived as CubesignerExpectedPolicyInputs, mode: 'production_verifier_key_policy'}})
    const client = await options.connect()
    bindOrganization(client, input)
    requireValue(archived.organization === input.organization, 'Prepared organization differs from current management session')
    const [name, version] = releaseInput.policyIdentifier.split('/')
    const policy = object(await client.policy(name, version), 'published policy')
    requireValue(policy.name === name && policy.version === Number(version.slice(1)) && policy.policy_type === 'Wasm' && policy.rules?.length === 1 && policy.rules[0].hash === resolved.policy?.policyArtifactDigest.replace('sha256:', '0x'), 'Published version changed during preparation recovery')
    const selectionPath = localPath(root, '.scrollsdk/inputs/cubesigner-policy/expected.json')
    requireValue(!fs.existsSync(selectionPath) || isDeepStrictEqual(json(proofRegularFile(selectionPath)), archived), 'Expected selection changed; refusing replacement')
    requireValue(!selection.expectedPolicy || isDeepStrictEqual(selection.expectedPolicy, archived), 'Managed expected selection differs from preparation archive')
    if (!fs.existsSync(selectionPath)) writeJson(selectionPath, archived)
    return {directory: output, liveAcceptance: 'not-verified', nextCommand: 'scrollsdk setup proof-publish', policyIdentifier: releaseInput.policyIdentifier, receiptSelection: selectionPath, status: 'configuration-inputs-prepared-activation-pending'}
  }

  requireValue(!fs.existsSync(output), 'Output already exists; use a new evidence directory')
  const receiptInput = localPath(root, POLICY_RECEIPTS_INPUT)
  const original = fs.existsSync(receiptInput) ? fs.readFileSync(proofRegularFile(receiptInput), 'utf8') : undefined
  if (original && !options.prepareOnly) {
    const existing = JSON.parse(original)
    requireValue(existing.release?.sha256 === 'REPLACE_WITH_RELEASE_RECEIPT_SHA256'
      && existing.attachment?.sha256 === 'REPLACE_WITH_ATTACHMENT_RECEIPT_SHA256'
      && existing.environment === 'REPLACE_WITH_CUBESIGNER_ENVIRONMENT'
      && existing.organization === 'REPLACE_WITH_CUBESIGNER_ORGANIZATION'
      && existing.protocolContext?.sha256 === hash(context), 'Existing receipt selection is not the untouched workflow placeholder; refusing replacement')
  }

  fs.mkdirSync(path.dirname(output), {mode: 0o700, recursive: true})
  const stage = fs.mkdtempSync(path.join(path.dirname(output), '.policy-reconcile-'))
  try {
    const copy = (source: string, name: string) => {
      fs.writeFileSync(path.join(stage, name), fs.readFileSync(source), {flag: 'wx', mode: 0o600})
      return {path: name, sha256: hash(path.join(stage, name))}
    }

    const protocol = copy(context, 'protocol_context.json')
    const wasm = copy(wasmFile, 'policy.wasm')
    const testsRef = copy(testsFile, 'tests.json')
    const buildRef = copy(buildFile, 'build-receipt.json')
    const liveRef = live ? copy(live, 'live.json') : undefined
    requireValue(protocol.sha256 === releaseInput.protocolContextSha256 && wasm.sha256 === `sha256:${build.wasm.sha256}`
      && testsRef.sha256 === `sha256:${releaseInput.tests.sha256.replace(/^sha256:/, '')}`
      && (!liveRef || liveRef.sha256 === `sha256:${input.liveEvidence.sha256.replace(/^sha256:/, '')}`), 'Evidence changed while copying')
    const client = await options.connect()
    bindOrganization(client, input)
    const createdAt = new Date().toISOString()
    const release: ObjectValue = {...releaseInput, createdAt, schema: 'dogeos/cubesigner-policy-release/v1',
      tests: {...testsRef, result: 'passed'}, wasm: {...wasm, sizeBytes: fs.statSync(wasmFile).size}}
    writeJson(path.join(stage, 'release.json'), release)
    const attachment = {c2fEgressAuthority: release.proofResolverAuthority, createdAt,
      environment: input.environment, keyId: key.keyId, materialId: key.materialId,
      organization: input.organization, policyArtifactDigest: wasm.sha256, policyIdentifier: release.policyIdentifier,
      proofResolverAuthority: release.proofResolverAuthority, readback: 'pending',
      releaseSha256: hash(path.join(stage, 'release.json')), roleId: key.roleId, schema: 'dogeos/cubesigner-policy-attachment/v1'}
    const refs: CubesignerPolicyReceiptInputs = {
      attachment: {path: 'attachment.json', sha256: ''}, environment: input.environment, organization: input.organization,
      protocolContext: protocol,
      release: {path: 'release.json', sha256: attachment.releaseSha256},
      ...(liveRef ? {liveEvidence: liveRef} : {}),
    }
    const [name, version] = release.policyIdentifier.split('/')
    const policy = object(await client.policy(name, version), 'policy readback')
    requireValue(policy.name === name && policy.version === Number(version.slice(1)) && policy.policy_type === 'Wasm'
      && typeof policy.policy_id === 'string' && /^NamedPolicy#[\da-f-]{36}$/.test(policy.policy_id)
      && policy.rules?.length === 1 && policy.rules[0].hash === `0x${wasm.sha256.slice(7)}`, 'Remote policy identity/version/Wasm mismatch')
    const providerIdentifier = `${policy.policy_id}/${version}`
    if (options.prepareOnly) {
      const materialsRef = copy(read(input.materials, 'materials'), 'materials.json')
      const publicBridgeRef = copy(read(input.publicBridge, 'publicBridge'), 'bridge.json')
      const bridgeRef = copy(bridge, 'bridge-program.vmexe')
      const vkRef = copy(vk, 'aggregate-vk')
      writeJson(path.join(stage, 'published.json'), {checkedAt: createdAt, environment: client.environment,
        organization: client.organization, policyArtifactDigest: wasm.sha256, policyIdentifier: release.policyIdentifier,
        providerPolicyIdentifier: providerIdentifier, schema: 'scrollsdk/cubesigner-policy-published/v1'})
      const expected: CubesignerExpectedPolicyInputs = {
        aggregateVerifyingKey: vkRef, bridgeProgram: bridgeRef, buildReceipt: buildRef,
        environment: input.environment, key: {keyId: key.keyId, materialId: key.materialId, roleId: key.roleId}, materials: materialsRef, organization: input.organization, protocolContext: protocol, publicBridge: publicBridgeRef, publishedVersion: {path: 'published.json', sha256: hash(path.join(stage, 'published.json'))},
        release: refs.release, ...(liveRef ? {liveEvidence: liveRef} : {}),
      }
      resolveCubesignerPolicy({deploymentDir: stage, keys: [expected.key], network: config.network, scope: 'preparation',
        selection: {expectedPolicy: expected, mode: 'production_verifier_key_policy'}})
      for (const ref of [expected.release, expected.protocolContext, expected.materials, expected.publicBridge, expected.buildReceipt, expected.bridgeProgram, expected.aggregateVerifyingKey, expected.publishedVersion, expected.liveEvidence]) {
        if (ref) ref.path = path.join(options.output, ref.path)
      }

      requireValue(hash(context) === protocol.sha256 && hash(proofRegularFile(configFile)) === configDigest, 'Deployment changed during preparation')
      const selectionPath = localPath(root, '.scrollsdk/inputs/cubesigner-policy/expected.json')
      requireValue(!fs.existsSync(selectionPath), 'Expected policy already selected; review existing evidence before replacing it')
      writeJson(path.join(stage, 'expected-selection.json'), expected)
      writeJson(path.join(stage, 'preparation-request.json'), {inputSha256: hash(proofRegularFile(localPath(root, options.input)))})
      fs.renameSync(stage, output)
      writeJson(selectionPath, expected)
      return {directory: output, liveAcceptance: 'not-verified', nextCommand: 'scrollsdk setup proof-publish',
        policyIdentifier: release.policyIdentifier, receiptSelection: selectionPath, status: 'configuration-inputs-prepared-activation-pending'}
    }

    const observed = object(await client.key(key.roleId, key.keyId), 'key readback')
    requireValue(observed.key_id === key.keyId && observed.material_id === key.materialId && observed.enabled === true, 'Remote key identity or enabled state mismatch')
    const expected = [{RequireRoleSession: [key.roleId]}, providerIdentifier]
    requireValue(Array.isArray(observed.policy) && observed.policy.length === 2 && expected.every(entry => observed.policy.some((item: unknown) => isDeepStrictEqual(entry, item))), 'Remote key must retain exactly the selected role restriction and immutable policy')
    requireValue(Array.isArray(policy.attached_to) && policy.attached_to.some((item: ObjectValue) => item.key_id === key.keyId), 'Policy readback does not confirm key attachment')
    const role = object(await client.role(key.roleId), 'role readback')
    requireValue(role.role_id === key.roleId && role.enabled === true, 'Selected role is not enabled')
    const authorities = await client.authorities()
    requireValue(Array.isArray(authorities) && authorities.some(value => typeof value === 'string' && value.toLowerCase() === resolver.host), 'Proof resolver authority is not allowed; reconcile does not change the allowlist')
    writeJson(path.join(stage, 'attachment.json'), {...attachment, providerPolicyIdentifier: providerIdentifier, readback: 'verified'})
    // Store only the fields used for verification, not provider sessions or unrelated account data.
    writeJson(path.join(stage, 'readback.json'), {checkedAt: createdAt, environment: client.environment, key: {enabled: observed.enabled, keyId: observed.key_id, materialId: observed.material_id, policy: observed.policy},
      organization: client.organization,
      policy: {name, providerIdentifier, version, wasmSha256: wasm.sha256},
      resolver: release.proofResolverAuthority, role: {enabled: role.enabled, roleId: role.role_id}})
    refs.attachment.sha256 = hash(path.join(stage, 'attachment.json'))
    try {
      resolveCubesignerPolicy({deploymentDir: stage, keys: [{keyId: key.keyId, materialId: key.materialId, roleId: key.roleId}], network: 'mainnet', selection: {mode: 'production_verifier_key_policy', policyReceipts: refs}})
    } catch {throw new PolicyReconciliationError('Release/attachment validation failed; check the documented receipt contract, identity digests and required live evidence')}

    for (const ref of [refs.release, refs.attachment, refs.protocolContext, refs.liveEvidence]) {
      if (ref) ref.path = path.join(options.output, ref.path)
    }

    requireValue(hash(context) === protocol.sha256, 'Protocol context changed during readback')
    requireValue(hash(proofRegularFile(configFile)) === configDigest, 'Deployment configuration changed during readback')
    requireValue((fs.existsSync(receiptInput) ? fs.readFileSync(receiptInput, 'utf8') : undefined) === original, 'Receipt selection changed during readback')
    fs.renameSync(stage, output)
    resolveCubesignerPolicy({deploymentDir: root, keys: [{keyId: key.keyId, materialId: key.materialId, roleId: key.roleId}], network: 'mainnet', selection: {mode: 'production_verifier_key_policy', policyReceipts: refs}})
    writeJson(receiptInput, refs)
    return {directory: output, liveAcceptance: live ? 'supplied-report-validated' : 'not-verified', nextCommand: 'scrollsdk setup proof-materials',
      policyIdentifier: release.policyIdentifier, receiptSelection: receiptInput, status: 'receipts-reconciled'}
  } finally {fs.rmSync(stage, {force: true, recursive: true})}
}
