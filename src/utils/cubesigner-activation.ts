/* eslint-disable @typescript-eslint/no-explicit-any -- Helm and provider documents are validated at this boundary. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {DogeConfig} from '../types/doge-config.js'
import type {ActivationClient} from './cubesigner-activation-client.js'

import {validateLiveAcceptance} from './cubesigner-acceptance.js'
import {GOVERNANCE_INPUT, requirePolicy, verifyGovernanceEvidence, verifyRoleAttestation} from './cubesigner-governance.js'
import {matchesCubesignerOrganization} from './cubesigner-organization.js'
import {cubesignerPolicyEnvironment, resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {cubesignerSessionExpiration} from './cubesigner-session-format.js'
import {localPath, writeJson} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'
import {normalizeCompressedSecp256k1PublicKey} from './secp256k1-public-key.js'

export const ACTIVATION_REPORT = '.scrollsdk/cubesigner-activation.json'
const SESSION_SCOPE = 'sign:btc:psbt:doge'
export function validateRuntimeSession(root: string, client: ActivationClient, key: {keyId: string; roleId: string}, handoff: any, sessions: any[], now = Date.now() / 1000): void {
  const file = proofRegularFile(path.join(root, 'secrets/cubesigner-signer-session.json'), 1024 * 1024)
  const session = JSON.parse(fs.readFileSync(file, 'utf8'))
  requirePolicy(matchesCubesignerOrganization(session.org_id, client) && session.role_id === key.roleId
    && session.env?.['Dev-CubeSignerStack']?.SignerApiRoot === client.apiRoot, 'Runtime session environment/org/role mismatch')
  const expiration = cubesignerSessionExpiration(session)
  requirePolicy(typeof session.token === 'string' && session.token.length > 0 && (expiration === undefined || expiration > now) && session.session_info?.refresh_token_exp > now, 'Runtime session expired or incomplete; explicit rotation is required')
  const remote = sessions.filter(entry => entry.session_id === session.session_info?.session_id)
  requirePolicy(remote.length === 1 && remote[0].exp > now, 'Runtime session is absent, revoked or expired')
  requirePolicy(isDeepStrictEqual(remote[0].scopes, [SESSION_SCOPE]), 'Runtime session must have only the Dogecoin PSBT signing scope')
  const limits = handoff.runtimeSession
  requirePolicy(limits && Number.isSafeInteger(limits.session) && limits.session > 0, 'Reviewed bounded session lifetime missing')
  const {lifetimes} = remote[0]
  requirePolicy(lifetimes && lifetimes.auth_lifetime <= 300 && lifetimes.auth_lifetime > 0 && lifetimes.refresh_lifetime > 0 && lifetimes.refresh_lifetime <= 86_400
    && remote[0].exp - remote[0].created_at <= limits.session, 'Runtime session lifetimes exceed the reviewed runbook')
  const env = fs.readFileSync(proofRegularFile(path.join(root, 'secrets/cubesigner-signer.env')), 'utf8').trim()
  requirePolicy(env === `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${key.keyId}"`, 'Runtime key Secret mismatch')
}

export function validateSignerEnvironment(entries: unknown, expected: Record<string, string>): void {
  requirePolicy(Array.isArray(entries), 'Signer env must be an explicit array')
  const actual: Record<string, string> = {}
  for (const entry of entries) {
    requirePolicy(entry && typeof entry.name === 'string' && !(entry.name in actual), 'Duplicate or invalid signer environment entry')
    if (entry.name in expected) requirePolicy(typeof entry.value === 'string' && !entry.valueFrom, 'Production pin must be an explicit value')
    actual[entry.name] = entry.value
  }

  for (const [name, value] of Object.entries(expected)) requirePolicy(actual[name] === value, `Rendered ${name} does not match expected policy`)
}

/** Fresh, read-only provider verification. The persisted report is informational, never installation authority. */
export async function verifyCubesignerActivation(options: {
  chart?: string
  chartVersion?: string
  connect: () => Promise<ActivationClient>
  directory: string
  governance?: string
  kubeContext?: string
  namespace?: string
  policyOnly?: boolean
  readConfigMap?: (name: string) => any
  readSecret?: (name: string) => any
  render?: (args: string[], root: string) => string
  values?: string
}) {
  const root = fs.realpathSync(options.directory)
  writeJson(localPath(root, ACTIVATION_REPORT), {acceptance: 'not-verified', activation: 'pending', checkedAt: new Date().toISOString(), installed: 'not-verified', schema: 'scrollsdk/cubesigner-activation/v1'})
  const configFile = proofRegularFile(path.join(root, '.data/doge-config.toml'))
  const configHash = proofFileHash(configFile)
  const config = toml.parse(fs.readFileSync(configFile, 'utf8')) as unknown as DogeConfig
  if (!options.policyOnly) requirePolicy(options.kubeContext?.trim(), 'An explicit nonempty Kubernetes context is required for runtime activation')
  if (config.cubesigner?.mode === 'transport_only') {
    requirePolicy(!options.policyOnly, 'transport_only requires runtime checks; policy-only cannot authorize activation')
    const transport = await verifyTransportActivation({...options, chart: options.chart ?? 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer', chartVersion: options.chartVersion ?? '0.1.9',
      kubeContext: options.kubeContext!, namespace: options.namespace ?? 'default', values: options.values ?? 'values/cubesigner-signer-production.yaml'})
    const result = {...transport, acceptance: 'not-verified', governance: undefined, schema: 'scrollsdk/cubesigner-activation/v1'}
    writeJson(localPath(root, ACTIVATION_REPORT), result)
    return result
  }

  const keys = (config.cubesigner?.roles ?? []).flatMap(role => role.keys.map(key => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id})))
  requirePolicy(config.cubesigner?.mode === 'production_verifier_key_policy' && keys.length === 1, 'Activation requires explicit production mode and one key/role')
  requirePolicy(config.cubesigner.expectedPolicy, 'Import complete expected material bindings with prepare-input and prepare; existing verified receipts remain intact and publication/approval must not be repeated')
  const refs = config.cubesigner.expectedPolicy ?? config.cubesigner.policyReceipts
  requirePolicy(refs, 'Expected policy or verified release receipts are missing')
  const resolved = resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, scope: 'preparation', selection: config.cubesigner})
  requirePolicy(resolved.policy, 'Complete expected production policy required')
  const expected = {...cubesignerPolicyEnvironment(resolved), DOGEOS_CUBESIGNER_SIGNER_NETWORK: config.network}
  const valuesFile = proofRegularFile(path.resolve(root, options.values ?? 'values/cubesigner-signer-production.yaml'))
  const valuesHash = proofFileHash(valuesFile)
  const values: any = yaml.load(fs.readFileSync(valuesFile, 'utf8'))
  validateSignerEnvironment(values.env, expected)
  requirePolicy(!values.envFrom?.length, 'Unreviewed envFrom overrides are not allowed')
  const render = options.render ?? ((args: string[], cwd: string) => execFileSync('helm', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000}))
  const manifest = render(['template', 'cubesigner-signer', options.chart ?? 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer', '--version', options.chartVersion ?? '0.1.9', '--namespace', options.namespace ?? 'default', '--values', valuesFile], root)
  const documents: any[] = yaml.loadAll(manifest)
  const workloads = documents.filter(doc => ['CronJob', 'DaemonSet', 'Deployment', 'Job', 'StatefulSet'].includes(doc?.kind))
  requirePolicy(workloads.length === 1 && ['Deployment', 'StatefulSet'].includes(workloads[0].kind) && (workloads[0].spec.replicas ?? 1) === 1
    && !documents.some(doc => doc?.kind === 'HorizontalPodAutoscaler'), 'One signer instance per runtime session is required')
  const {containers} = workloads[0].spec.template.spec
  requirePolicy(containers?.length === 1 && !containers[0].envFrom?.length, 'Unexpected signer containers/environment sources')
  requirePolicy(!containers[0].command?.length && !containers[0].args?.length, 'Unreviewed signer command overrides are not allowed')
  validateSignerEnvironment(containers[0].env, expected)
  validateSignerRuntimeManifest(workloads[0])
  const wp: any = toml.parse(fs.readFileSync(proofRegularFile(path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')), 'utf8'))
  requirePolicy(wp.proof_system?.correctness_policy_transport === 'bridge_proof_ref_v1', 'WP must use bridge_proof_ref_v1')
  const policyRelease = JSON.parse(fs.readFileSync(path.resolve(root, refs.release.path), 'utf8'))
  if (policyRelease.bindings) {
    requirePolicy(wp.proof_system?.signer_proof_artifact_base_url === policyRelease.bindings.proofArtifactBaseUrl, 'WP resolver base URL/path differs from the compiled policy')
    requirePolicy(config.cubesigner.roles?.[0].keys[0].public_key_compressed === policyRelease.bindings.teePublicKey, 'Selected TEE key differs from public Bridge script')
  }

  const handoff = JSON.parse(fs.readFileSync(proofRegularFile(path.resolve(root, options.governance ?? GOVERNANCE_INPUT)), 'utf8'))
  const handoffHash = proofFileHash(path.resolve(root, options.governance ?? GOVERNANCE_INPUT))
  const client = await options.connect()
  requirePolicy(client.environment === refs.environment && client.organization === refs.organization, 'Management session environment/organization mismatch')
  const key = keys[0]
  const [name, version] = resolved.policy.policyIdentifier.split('/')
  const policy: any = await client.policy(name, version)
  requirePolicy(policy.name === name && policy.version === Number(version.slice(1)) && policy.policy_type === 'Wasm' && /^NamedPolicy#[\da-f-]{36}$/.test(policy.policy_id)
    && policy.rules?.length === 1 && policy.rules[0].hash === resolved.policy.policyArtifactDigest.replace('sha256:', '0x'), 'Remote immutable policy/version/Wasm mismatch')
  const observed: any = await client.key(key.roleId, key.keyId)
  requirePolicy(observed.key_type === (config.network === 'mainnet' ? 'SecpDogeAddr' : 'SecpDogeTestAddr'), 'Provider key type does not match the selected network')
  if (policyRelease.bindings) requirePolicy(normalizeCompressedSecp256k1PublicKey(observed.public_key, 'provider key') === policyRelease.bindings.teePublicKey, 'Remote public key differs from the genesis Bridge')
  const expectedPolicy = [{RequireRoleSession: [key.roleId]}, `${policy.policy_id}/${version}`]
  requirePolicy(observed.key_id === key.keyId && observed.material_id === key.materialId && observed.enabled === true && isDeepStrictEqual(observed.policy, expectedPolicy), 'Attachment pending or key/role/policy drift; approval must be executed')
  requirePolicy(policy.attached_to?.some((entry: any) => entry.key_id === key.keyId), 'Immutable policy does not confirm key attachment')
  const role: any = await client.role(key.roleId)
  requirePolicy(role.role_id === key.roleId && role.enabled === true, 'Selected role is disabled or mismatched')
  const authorities = await client.authorities()
  requirePolicy(authorities.includes(new URL(resolved.policy.proofResolverAuthority).host), 'Resolver egress hostname is not allowed')
  const attestation = await client.attestation(key.roleId)
  const jwks = await client.jwks()
  const claims = verifyRoleAttestation(attestation.jwt, jwks)
  const governance = verifyGovernanceEvidence({claims, environment: client.environment, expectedPolicy, handoff, key: observed, organization: client.organization, policy: await client.policy(name, 'latest'), role, root})
  // Releases requiring real acceptance cannot be activated using unit-test or empty-request evidence.
  const release = JSON.parse(fs.readFileSync(path.resolve(root, refs.release.path), 'utf8'))
  let acceptance = 'not-verified'
  if (release.requiresLiveEvidence || refs.liveEvidence) {
    requirePolicy(refs.liveEvidence, 'Required live acceptance is missing; use a separately governed, unregistered mainnet-type canary and import its evidence')
    requirePolicy(resolved.liveEvidence, 'Required live acceptance is invalid')
    const live = JSON.parse(fs.readFileSync(resolved.liveEvidence, 'utf8'))
    validateLiveAcceptance(live, resolved.policy.policyArtifactDigest, release.bindings?.proofArtifactBaseUrl)
    acceptance = live.scope === 'canary' ? 'canary-evidence-validated-production-not-verified' : 'verified-evidence'
  }

  if (!options.policyOnly) {
    validateRuntimeSession(root, client, key, handoff, await client.sessions(key.roleId))
    const readSecret = options.readSecret ?? ((name: string) => JSON.parse(execFileSync('kubectl', [...(options.kubeContext ? ['--context', options.kubeContext] : []), '-n', options.namespace ?? 'default', 'get', 'secret', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
    const readConfigMap = options.readConfigMap ?? ((name: string) => JSON.parse(execFileSync('kubectl', [...(options.kubeContext ? ['--context', options.kubeContext] : []), '-n', options.namespace ?? 'default', 'get', 'configmap', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
    const contextBytes = fs.readFileSync(proofRegularFile(path.resolve(root, refs.protocolContext.path)), 'utf8')
    requirePolicy(readConfigMap('protocol-context-config').data?.['protocol_context.json'] === contextBytes, 'Delivered protocol context differs from prepared genesis')
    for (const document of documents.filter(doc => doc?.kind === 'ConfigMap' && doc.metadata?.name === 'protocol-context-config')) requirePolicy(document.data?.['protocol_context.json'] === contextBytes, 'Helm would replace the verified protocol context')
    const sessionSecret = readSecret('cubesigner-signer-session')
    const keySecret = readSecret('cubesigner-signer-env')
    requirePolicy(Buffer.from(keySecret.data?.DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID ?? '', 'base64').toString() === key.keyId, 'Installed Secret key differs; finish Secret delivery before installation')
    requirePolicy(Buffer.from(sessionSecret.data?.['session.json'] ?? '', 'base64').equals(fs.readFileSync(proofRegularFile(path.join(root, 'secrets/cubesigner-signer-session.json')))), 'Installed Secret session differs; finish Secret delivery before installation')
  }

  requirePolicy(proofFileHash(configFile) === configHash && proofFileHash(valuesFile) === valuesHash
    && proofFileHash(path.resolve(root, options.governance ?? GOVERNANCE_INPUT)) === handoffHash, 'Activation inputs changed during verification')
  resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, scope: 'preparation', selection: config.cubesigner})
  const result = {acceptance, activation: options.policyOnly ? 'pending-runtime-session' : 'verified', checkedAt: new Date().toISOString(),
    configSha256: configHash, configuration: 'prepared', credentials: options.policyOnly ? 'not-checked' : 'metadata-and-delivery-verified', governance,
    installed: 'not-verified', runtimeCache: 'operator-managed-not-inspected', schema: 'scrollsdk/cubesigner-activation/v1', valuesSha256: valuesHash}
  writeJson(path.join(root, ACTIVATION_REPORT), result)
  return result
}

/** Check the actual pod, including secret indirection and exclusive writable refresh state. */
export function validateSignerRuntimeManifest(workload: any): void {
  const pod = workload.spec.template.spec
  const container = pod.containers[0]
  requirePolicy(!pod.initContainers?.length, 'Unreviewed init containers can alter signer runtime inputs')
  const env = Object.fromEntries(container.env.map((entry: any) => [entry.name, entry]))
  for (const name of ['DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER']) {
    requirePolicy(isDeepStrictEqual(env[name]?.valueFrom, {secretKeyRef: {key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env'}}) && env[name].value === undefined, 'Signer key must use the verified Secret reference')
  }

  const paths = {CS_SESSIONS_DIR: '/app/.sessions', DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH: '/etc/cubesigner/session.json', DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json'}
  validateSignerEnvironment(container.env, paths)
  const mounts = container.volumeMounts ?? []
  const contextMount = mounts.filter((mount: any) => mount.mountPath === '/app/protocol_context.json')
  requirePolicy(contextMount.length === 1 && contextMount[0].readOnly === true && contextMount[0].subPath === 'protocol_context.json' && !contextMount[0].subPathExpr, 'Protocol context must use the verified read-only ConfigMap path')
  const contextVolume = (pod.volumes ?? []).find((entry: any) => entry.name === contextMount[0].name)
  requirePolicy(contextVolume?.configMap?.name === 'protocol-context-config' && !contextVolume.configMap.optional
    && (!contextVolume.configMap.items || isDeepStrictEqual(contextVolume.configMap.items, [{key: 'protocol_context.json', path: 'protocol_context.json'}])), 'Protocol context volume differs from the verified ConfigMap')
  const sessionMount = mounts.filter((mount: any) => mount.mountPath === '/etc/cubesigner')
  requirePolicy(sessionMount.length === 1 && sessionMount[0].readOnly === true && !sessionMount[0].subPath && !sessionMount[0].subPathExpr, 'Session seed must be mounted read-only at the verified path')
  const volume = (pod.volumes ?? []).find((entry: any) => entry.name === sessionMount[0].name)
  requirePolicy(volume?.secret?.secretName === 'cubesigner-signer-session' && !volume.secret.optional
    && (!volume.secret.items || isDeepStrictEqual(volume.secret.items, [{key: 'session.json', path: 'session.json'}])), 'Session volume differs from the verified Secret')
  const cache = mounts.filter((mount: any) => mount.mountPath === '/app/.sessions')
  requirePolicy(cache.length === 1 && !cache[0].readOnly && !cache[0].subPath && !cache[0].subPathExpr, 'Signer requires one private writable refresh cache')
  const cacheVolume = (pod.volumes ?? []).find((entry: any) => entry.name === cache[0].name)
  const claim = (workload.spec.volumeClaimTemplates ?? []).find((entry: any) => entry.metadata?.name === cache[0].name)
  requirePolicy(cacheVolume?.emptyDir || (workload.kind === 'StatefulSet' && isDeepStrictEqual(claim?.spec.accessModes, ['ReadWriteOnce'])), 'Shared or external session caches require a separately reviewed deployment; automatic activation refuses them')
  requirePolicy(!mounts.some((mount: any) => ['/', '/app', '/etc'].includes(mount.mountPath) || mount.mountPath.startsWith('/etc/cubesigner/') || mount.mountPath.startsWith('/app/.sessions/')), 'Overlapping mounts can replace verified runtime inputs')
}

async function verifyTransportActivation(options: {
  chart: string; chartVersion: string; connect: () => Promise<ActivationClient>; directory: string;
  kubeContext: string; namespace: string; readConfigMap?: (name: string) => any;
  readSecret?: (name: string) => any; render?: (args: string[], root: string) => string; values: string;
}) {
  const root = fs.realpathSync(options.directory)
  const configFile = proofRegularFile(path.join(root, '.data/doge-config.toml'))
  const configHash = proofFileHash(configFile)
  const config = toml.parse(fs.readFileSync(configFile, 'utf8')) as unknown as DogeConfig
  const selection = config.cubesigner
  const keys = (selection?.roles ?? []).flatMap(role => role.keys.map(key => ({...key, keyId: key.key_id, materialId: key.material_id, roleId: role.role_id})))
  requirePolicy(selection?.mode === 'transport_only' && config.network !== 'mainnet' && keys.length === 1, 'Transport activation requires an explicit non-mainnet mode and one key/role')
  const resolved = resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, selection})
  // Non-mainnet transport mode still verifies any explicitly selected policy receipts.
  const policy = selection.policyReceipts ? resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, selection: {...selection, mode: 'production_verifier_key_policy'}}).policy : resolved.policy
  const valuesFile = proofRegularFile(path.resolve(root, options.values))
  const valuesHash = proofFileHash(valuesFile)
  const expected = {...cubesignerPolicyEnvironment(resolved), DOGEOS_CUBESIGNER_SIGNER_NETWORK: config.network}
  const render = options.render ?? ((args, cwd) => execFileSync('helm', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000}))
  const documents: any[] = yaml.loadAll(render(['template', 'cubesigner-signer', options.chart, '--version', options.chartVersion, '--namespace', options.namespace, '--values', valuesFile], root))
  const workloads = documents.filter(doc => ['CronJob', 'DaemonSet', 'Deployment', 'Job', 'StatefulSet'].includes(doc?.kind))
  requirePolicy(workloads.length === 1 && ['Deployment', 'StatefulSet'].includes(workloads[0].kind) && (workloads[0].spec.replicas ?? 1) === 1 && !documents.some(doc => doc?.kind === 'HorizontalPodAutoscaler'), 'One signer instance per runtime session is required')
  const pod = workloads[0].spec.template.spec
  requirePolicy(pod.containers?.length === 1 && !pod.containers[0].envFrom?.length, 'Unexpected signer containers or envFrom')
  requirePolicy(!pod.containers[0].command?.length && !pod.containers[0].args?.length, 'Unreviewed signer command overrides are not allowed')
  validateSignerEnvironment(pod.containers[0].env, expected)
  validateSignerRuntimeManifest(workloads[0])
  const key = keys[0]
  const client = await options.connect()
  const observed: any = await client.key(key.roleId, key.keyId)
  const role: any = await client.role(key.roleId)
  requirePolicy(observed.key_id === key.keyId && observed.material_id === key.materialId && observed.enabled === true && role.role_id === key.roleId && role.enabled === true, 'Remote key/role is disabled or mismatched')
  requirePolicy(observed.key_type === 'SecpDogeTestAddr', 'Remote key type does not match the non-mainnet Dogecoin network')
  requirePolicy(key.public_key_compressed && normalizeCompressedSecp256k1PublicKey(observed.public_key, 'provider key') === key.public_key_compressed, 'Remote public key differs from the prepared Bridge key')
  const expectedPolicy: any[] = [{RequireRoleSession: [key.roleId]}]
  if (policy) {
    const refs = selection.policyReceipts!
    requirePolicy(client.organization === refs.organization && client.environment === refs.environment, 'Policy environment/organization mismatch')
    const [name, version] = policy.policyIdentifier.split('/')
    const remote: any = await client.policy(name, version)
    requirePolicy(remote.name === name && remote.version === Number(version.slice(1)) && remote.policy_type === 'Wasm' && /^NamedPolicy#[\da-f-]{36}$/.test(remote.policy_id) && remote.rules?.length === 1 && remote.rules[0].hash === policy.policyArtifactDigest.replace('sha256:', '0x'), 'Remote immutable policy differs from the approved release')
    requirePolicy(remote.attached_to?.some((entry: any) => entry.key_id === key.keyId), 'Policy does not confirm the key attachment')
    requirePolicy((await client.authorities()).includes(new URL(policy.proofResolverAuthority).host), 'Proof resolver is not allowed')
    expectedPolicy.push(`${remote.policy_id}/${version}`)
  }

  requirePolicy(Array.isArray(observed.policy) && observed.policy.length === expectedPolicy.length && expectedPolicy.every(entry => observed.policy.some((actual: any) => isDeepStrictEqual(entry, actual))), 'Remote policy drift: transport_only cannot bypass an attached policy; import matching receipts')
  const seedFile = proofRegularFile(path.join(root, 'secrets/cubesigner-signer-session.json'), 1024 * 1024)
  const seedBytes = fs.readFileSync(seedFile)
  const seed = JSON.parse(seedBytes.toString())
  const now = Date.now() / 1000
  requirePolicy(matchesCubesignerOrganization(seed.org_id, client) && seed.role_id === key.roleId && seed.env?.['Dev-CubeSignerStack']?.SignerApiRoot === client.apiRoot, 'Runtime session environment/org/role mismatch')
  const expiration = cubesignerSessionExpiration(seed)
  requirePolicy(typeof seed.token === 'string' && seed.token && (expiration === undefined || expiration > now) && seed.session_info?.refresh_token_exp > now, 'Runtime session is expired or incomplete; rotate it explicitly')
  const sessions = (await client.sessions(key.roleId)).filter(entry => entry.session_id === seed.session_info?.session_id)
  requirePolicy(sessions.length === 1 && sessions[0].exp > now, 'Runtime session is revoked, absent or expired')
  requirePolicy(Array.isArray(sessions[0].scopes) && sessions[0].scopes.length > 0 && sessions[0].scopes.every((scope: string) => ['sign:*', 'sign:btc:psbt:doge'].includes(scope)), 'Runtime session has unsupported scopes')
  const readSecret = options.readSecret ?? (name => JSON.parse(execFileSync('kubectl', ['--context', options.kubeContext, '-n', options.namespace, 'get', 'secret', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
  const readConfigMap = options.readConfigMap ?? (name => JSON.parse(execFileSync('kubectl', ['--context', options.kubeContext, '-n', options.namespace, 'get', 'configmap', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
  const context = fs.readFileSync(proofRegularFile(path.join(root, '.data/protocol_context.json')), 'utf8')
  requirePolicy(readConfigMap('protocol-context-config').data?.['protocol_context.json'] === context, 'Delivered protocol context differs from the prepared Bridge')
  for (const document of documents.filter(doc => doc?.kind === 'ConfigMap' && doc.metadata?.name === 'protocol-context-config')) requirePolicy(document.data?.['protocol_context.json'] === context, 'Helm would replace the verified protocol context')
  requirePolicy(Buffer.from(readSecret('cubesigner-signer-env').data?.DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID ?? '', 'base64').toString() === key.keyId, 'Delivered key Secret differs from the selected key')
  requirePolicy(Buffer.from(readSecret('cubesigner-signer-session').data?.['session.json'] ?? '', 'base64').equals(seedBytes), 'Delivered runtime session differs from the prepared seed')
  requirePolicy(proofFileHash(configFile) === configHash && proofFileHash(valuesFile) === valuesHash && fs.readFileSync(seedFile).equals(seedBytes), 'Activation inputs changed during verification')
  return {activation: 'verified', checkedAt: new Date().toISOString(), installed: 'not-verified', mode: resolved.mode, proofAcceptance: 'not-checked', runtimeCache: 'not-inspected'}
}
