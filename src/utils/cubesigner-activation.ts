/* eslint-disable @typescript-eslint/no-explicit-any -- Provider and Helm documents are validated at the boundary. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import type {DogeConfig} from '../types/doge-config.js'
import type {ActivationClient} from './cubesigner-activation-client.js'

import {cubesignerPolicyEnvironment, resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'
import {normalizeCompressedSecp256k1PublicKey} from './secp256k1-public-key.js'

export class ActivationError extends Error {}
function requireActivation(value: unknown, message: string): asserts value {
  if (!value) throw new ActivationError(message)
}

export function validateSignerEnvironment(entries: unknown, expected: Record<string, string>): void {
  requireActivation(Array.isArray(entries), 'Signer environment must be an explicit array')
  const actual: Record<string, string> = {}
  for (const entry of entries) {
    requireActivation(entry && typeof entry.name === 'string' && !(entry.name in actual), 'Duplicate signer environment entry')
    if (entry.name in expected) requireActivation(typeof entry.value === 'string' && !entry.valueFrom, 'Policy pins must be explicit values')
    actual[entry.name] = entry.value
  }

  for (const [name, value] of Object.entries(expected)) requireActivation(actual[name] === value, `Rendered ${name} differs from the prepared configuration`)
}

/** Mode-aware, read-only installation gate. No policy attachment, session rotation or Helm install. */
export async function verifyCubesignerActivation(options: {
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
  requireActivation(selection?.mode && keys.length === 1, 'Explicit CubeSigner mode and one key/role are required')
  const resolved = resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, selection})
  // This branch supports receipt-backed production. An unknown attached policy is never bypassed in transport mode.
  const policy = selection.policyReceipts ? resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, selection: {...selection, mode: 'production_verifier_key_policy'}}).policy : resolved.policy
  const valuesFile = proofRegularFile(path.resolve(root, options.values))
  const valuesHash = proofFileHash(valuesFile)
  const expected = {...cubesignerPolicyEnvironment(resolved), DOGEOS_CUBESIGNER_SIGNER_NETWORK: config.network}
  const render = options.render ?? ((args, cwd) => execFileSync('helm', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000}))
  const documents: any[] = yaml.loadAll(render(['template', 'cubesigner-signer', options.chart, '--version', options.chartVersion, '--namespace', options.namespace, '--values', valuesFile], root))
  const workloads = documents.filter(doc => ['CronJob', 'DaemonSet', 'Deployment', 'Job', 'StatefulSet'].includes(doc?.kind))
  requireActivation(workloads.length === 1 && ['Deployment', 'StatefulSet'].includes(workloads[0].kind) && (workloads[0].spec.replicas ?? 1) === 1 && !documents.some(doc => doc?.kind === 'HorizontalPodAutoscaler'), 'One signer instance per runtime session is required')
  const pod = workloads[0].spec.template.spec
  requireActivation(pod.containers?.length === 1 && !pod.containers[0].envFrom?.length, 'Unexpected signer containers or envFrom')
  requireActivation(!pod.containers[0].command?.length && !pod.containers[0].args?.length, 'Unreviewed signer command overrides are not allowed')
  validateSignerEnvironment(pod.containers[0].env, expected)
  validateSignerRuntimeManifest(workloads[0])
  const key = keys[0]
  const client = await options.connect()
  const observed: any = await client.key(key.roleId, key.keyId)
  const role: any = await client.role(key.roleId)
  requireActivation(observed.key_id === key.keyId && observed.material_id === key.materialId && observed.enabled === true && role.role_id === key.roleId && role.enabled === true, 'Remote key/role is disabled or mismatched')
  requireActivation(observed.key_type === (config.network === 'mainnet' ? 'SecpDogeAddr' : 'SecpDogeTestAddr'), 'Remote key type does not match the Dogecoin network')
  requireActivation(key.public_key_compressed && normalizeCompressedSecp256k1PublicKey(observed.public_key, 'provider key') === key.public_key_compressed, 'Remote public key differs from the prepared Bridge key')
  const expectedPolicy: any[] = [{RequireRoleSession: [key.roleId]}]
  if (policy) {
    const refs = selection.policyReceipts!
    requireActivation(client.organization === refs.organization && client.environment === refs.environment, 'Policy environment/organization mismatch')
    const [name, version] = policy.policyIdentifier.split('/')
    const remote: any = await client.policy(name, version)
    requireActivation(remote.name === name && remote.version === Number(version.slice(1)) && remote.policy_type === 'Wasm' && /^NamedPolicy#[\da-f-]{36}$/.test(remote.policy_id) && remote.rules?.length === 1 && remote.rules[0].hash === policy.policyArtifactDigest.replace('sha256:', '0x'), 'Remote immutable policy differs from the approved release')
    requireActivation(remote.attached_to?.some((entry: any) => entry.key_id === key.keyId), 'Policy does not confirm the key attachment')
    requireActivation((await client.authorities()).includes(new URL(policy.proofResolverAuthority).host), 'Proof resolver is not allowed')
    expectedPolicy.push(`${remote.policy_id}/${version}`)
  }

  requireActivation(Array.isArray(observed.policy) && observed.policy.length === expectedPolicy.length && expectedPolicy.every(entry => observed.policy.some((actual: any) => isDeepStrictEqual(entry, actual))), 'Remote policy drift: transport_only cannot bypass an attached policy; import matching receipts')
  const seedFile = proofRegularFile(path.join(root, 'secrets/cubesigner-signer-session.json'), 1024 * 1024)
  const seedBytes = fs.readFileSync(seedFile)
  const seed = JSON.parse(seedBytes.toString())
  const now = Date.now() / 1000
  requireActivation(seed.org_id === client.organization && seed.role_id === key.roleId && seed.env?.['Dev-CubeSignerStack']?.SignerApiRoot === client.apiRoot, 'Runtime session environment/org/role mismatch')
  requireActivation(typeof seed.token === 'string' && seed.token && seed.session_exp > now && seed.session_info?.refresh_token_exp > now, 'Runtime session is expired or incomplete; rotate it explicitly')
  const sessions = (await client.sessions(key.roleId)).filter(entry => entry.session_id === seed.session_info?.session_id)
  requireActivation(sessions.length === 1 && sessions[0].exp > now, 'Runtime session is revoked, absent or expired')
  requireActivation(Array.isArray(sessions[0].scopes) && sessions[0].scopes.length > 0 && sessions[0].scopes.every((scope: string) => ['sign:*', 'sign:btc:psbt:doge'].includes(scope)), 'Runtime session has unsupported scopes')
  const readSecret = options.readSecret ?? (name => JSON.parse(execFileSync('kubectl', ['--context', options.kubeContext, '-n', options.namespace, 'get', 'secret', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
  const readConfigMap = options.readConfigMap ?? (name => JSON.parse(execFileSync('kubectl', ['--context', options.kubeContext, '-n', options.namespace, 'get', 'configmap', name, '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000})))
  const context = fs.readFileSync(proofRegularFile(path.join(root, '.data/protocol_context.json')), 'utf8')
  requireActivation(readConfigMap('protocol-context-config').data?.['protocol_context.json'] === context, 'Delivered protocol context differs from the prepared Bridge')
  for (const document of documents.filter(doc => doc.kind === 'ConfigMap' && doc.metadata?.name === 'protocol-context-config')) requireActivation(document.data?.['protocol_context.json'] === context, 'Helm would replace the verified protocol context')
  requireActivation(Buffer.from(readSecret('cubesigner-signer-env').data?.DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID ?? '', 'base64').toString() === key.keyId, 'Delivered key Secret differs from the selected key')
  requireActivation(Buffer.from(readSecret('cubesigner-signer-session').data?.['session.json'] ?? '', 'base64').equals(seedBytes), 'Delivered runtime session differs from the prepared seed')
  requireActivation(proofFileHash(configFile) === configHash && proofFileHash(valuesFile) === valuesHash && fs.readFileSync(seedFile).equals(seedBytes), 'Activation inputs changed during verification')
  return {activation: 'verified', checkedAt: new Date().toISOString(), installed: 'not-verified', mode: resolved.mode, proofAcceptance: 'not-checked', runtimeCache: 'not-inspected'}
}

/** Check the actual pod, including secret indirection and exclusive writable refresh state. */
export function validateSignerRuntimeManifest(workload: any): void {
  const pod = workload.spec.template.spec
  const container = pod.containers[0]
  requireActivation(!pod.initContainers?.length, 'Unreviewed init containers can alter signer runtime inputs')
  const env = Object.fromEntries(container.env.map((entry: any) => [entry.name, entry]))
  for (const name of ['DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_KEY_IDENTIFIER']) {
    requireActivation(isDeepStrictEqual(env[name]?.valueFrom, {secretKeyRef: {key: 'DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID', name: 'cubesigner-signer-env'}}) && env[name].value === undefined, 'Signer key must use the verified Secret reference')
  }

  const paths = {CS_SESSIONS_DIR: '/app/.sessions', DOGEOS_CUBESIGNER_SIGNER_CS_SESSION_PATH: '/etc/cubesigner/session.json', DOGEOS_CUBESIGNER_SIGNER_PROTOCOL_CONTEXT_JSON: '/app/protocol_context.json'}
  validateSignerEnvironment(container.env, paths)
  const mounts = container.volumeMounts ?? []
  const contextMount = mounts.filter((mount: any) => mount.mountPath === '/app/protocol_context.json')
  requireActivation(contextMount.length === 1 && contextMount[0].readOnly === true && contextMount[0].subPath === 'protocol_context.json' && !contextMount[0].subPathExpr, 'Protocol context must use the verified read-only ConfigMap path')
  const contextVolume = (pod.volumes ?? []).find((entry: any) => entry.name === contextMount[0].name)
  requireActivation(contextVolume?.configMap?.name === 'protocol-context-config' && !contextVolume.configMap.optional
    && (!contextVolume.configMap.items || isDeepStrictEqual(contextVolume.configMap.items, [{key: 'protocol_context.json', path: 'protocol_context.json'}])), 'Protocol context volume differs from the verified ConfigMap')
  const sessionMount = mounts.filter((mount: any) => mount.mountPath === '/etc/cubesigner')
  requireActivation(sessionMount.length === 1 && sessionMount[0].readOnly === true && !sessionMount[0].subPath && !sessionMount[0].subPathExpr, 'Session seed must be mounted read-only at the verified path')
  const volume = (pod.volumes ?? []).find((entry: any) => entry.name === sessionMount[0].name)
  requireActivation(volume?.secret?.secretName === 'cubesigner-signer-session' && !volume.secret.optional
    && (!volume.secret.items || isDeepStrictEqual(volume.secret.items, [{key: 'session.json', path: 'session.json'}])), 'Session volume differs from the verified Secret')
  const cache = mounts.filter((mount: any) => mount.mountPath === '/app/.sessions')
  requireActivation(cache.length === 1 && !cache[0].readOnly && !cache[0].subPath && !cache[0].subPathExpr, 'Signer requires one private writable refresh cache')
  const cacheVolume = (pod.volumes ?? []).find((entry: any) => entry.name === cache[0].name)
  const claim = (workload.spec.volumeClaimTemplates ?? []).find((entry: any) => entry.metadata?.name === cache[0].name)
  requireActivation(cacheVolume?.emptyDir || (workload.kind === 'StatefulSet' && isDeepStrictEqual(claim?.spec.accessModes, ['ReadWriteOnce'])), 'Shared or external session caches require a separately reviewed deployment; automatic activation refuses them')
  requireActivation(!mounts.some((mount: any) => ['/', '/app', '/etc'].includes(mount.mountPath) || mount.mountPath.startsWith('/etc/cubesigner/') || mount.mountPath.startsWith('/app/.sessions/')), 'Overlapping mounts can replace verified runtime inputs')
}
