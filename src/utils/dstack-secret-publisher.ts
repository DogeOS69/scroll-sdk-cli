import * as yaml from 'js-yaml'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DstackControllerConfig} from '../types/dstack-controller.js'
import type {DstackSecret} from './dstack-credentials.js'

import {dstackSecretRefs, readDstackCredentials, renderDstackSecrets} from './dstack-credentials.js'
import {parseDatabaseUrl} from './dstack-database.js'

function privateYaml(content: string): unknown {
  try {
    return yaml.load(content)
  } catch {
    throw new Error('Invalid dstack YAML; contents omitted')
  }
}

/** Read the exact managed files, never glob arbitrary Secret manifests. */
export function loadDstackSecretPublication(config: DstackControllerConfig, valuesFile: string, namespace: string): DstackSecret[] {
  if (!/^[\da-z]([\da-z-]*[\da-z])?$/.test(namespace) || namespace.length > 63) throw new Error('Invalid Kubernetes namespace')
  const state = readDstackCredentials()
  if (!state) throw new Error('Run setup dstack-config and setup gen-secrets --dstack-only first')
  const refs = dstackSecretRefs(config, state)
  if (!fs.existsSync(valuesFile)) throw new Error('Dstack production values are missing; run setup prep-charts or setup generate-from-spec first')
  const values = privateYaml(fs.readFileSync(valuesFile, 'utf8')) as DstackControllerConfig
  // Values are chart input, not the public controller schema (which has enabled).
  const valuesRefs = dstackSecretRefs({
    auth: values?.auth, credentialSecrets: values?.credentialSecrets,
    database: values?.database?.type === 'sqlite' ? {type: 'sqlite'} : values?.database, serverConfig: values?.serverConfig,
  }, state)
  if (JSON.stringify(refs) !== JSON.stringify(valuesRefs)) throw new Error('Dstack Secret references differ from production values; regenerate values before publishing')
  const expected = renderDstackSecrets(config, state)
  if (refs.database) expected.push({apiVersion: 'v1', kind: 'Secret', metadata: {name: refs.database.name}, stringData: {}, type: 'Opaque'})
  return expected.map(template => {
    const file = path.join('secrets', `${template.metadata.name}.yaml`)
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run setup gen-secrets --dstack-only`)
    const secret = privateYaml(fs.readFileSync(file, 'utf8')) as DstackSecret
    if (!secret || secret.apiVersion !== 'v1' || secret.kind !== 'Secret' || secret.type !== 'Opaque'
      || secret.metadata?.name !== template.metadata.name || (secret.metadata.namespace && secret.metadata.namespace !== namespace)
      || !secret.stringData || typeof secret.stringData !== 'object' || Array.isArray(secret.stringData)) throw new Error(`Invalid dstack Secret manifest: ${file}`)
    const data = secret.stringData
    if (refs.database?.name === template.metadata.name) {
      if (Object.keys(data).length !== 1 || typeof data[refs.database.key] !== 'string') throw new Error('Invalid dstack database Secret data')
      const url = parseDatabaseUrl(data[refs.database.key])
      if (url.protocol !== 'postgresql+asyncpg:' || url.searchParams.has('sslmode')) throw new Error('Dstack database Secret requires asyncpg URL with ssl, not sslmode')
    } else if (Object.keys(data).length !== Object.keys(template.stringData).length
      || Object.entries(template.stringData).some(([key, value]) => data[key] !== value)) {
      throw new Error(`Stale dstack Secret file: ${file}; rerun setup gen-secrets --dstack-only`)
    }

    // Whitelist the outgoing object: input metadata/annotations cannot inject resources.
    return {...template, metadata: {name: template.metadata.name, namespace}, stringData: {...data}}
  })
}

export type KubectlRunner = (args: string[], stdin?: string) => Promise<string>

/** Use stdin, not shell/argv, for payloads. Suppress kubectl error bodies (may echo Secrets). */
export const runSecretKubectl: KubectlRunner = (args, stdin) => new Promise((resolve, reject) => {
  const child = spawn('kubectl', args, {stdio: ['pipe', 'pipe', 'pipe']})
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {stdout += chunk})
  child.stderr.resume()
  child.stdin.on('error', () => { /* Exit/error below reports a redacted failure. */ })
  child.on('error', () => reject(new Error('Unable to execute kubectl; check its installation and kubeconfig')))
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Kubectl failed (exit ${code}); response suppressed because it may contain credentials. Check context, namespace, RBAC and Secret field ownership.`)))
  child.stdin.end(stdin)
})

interface LiveSecret {
  data?: Record<string, string>
  metadata?: {name?: string}
}

/** Refuse accidental replacement of an existing controller's identity/encryption keys. */
export async function publishDstackSecrets(options: {
  config: DstackControllerConfig
  context: string
  dryRun?: boolean
  namespace: string
  /** Validate live identity and server-side admission before other upload destinations mutate. */
  preflightOnly?: boolean
  runner?: KubectlRunner
  valuesFile: string
}): Promise<{context: string; dryRun: boolean; namespace: string; secrets: string[]}> {
  if (!options.context.trim()) throw new Error('An explicit Kubernetes context is required')
  const secrets = loadDstackSecretPublication(options.config, options.valuesFile, options.namespace)
  const result = {context: options.context, dryRun: Boolean(options.dryRun), namespace: options.namespace, secrets: secrets.map(secret => secret.metadata.name)}
  if (options.dryRun) return result
  const runner = options.runner ?? runSecretKubectl
  const prefix = ['--context', options.context, '--namespace', options.namespace, '--request-timeout=30s']
  const state = readDstackCredentials()!
  const refs = dstackSecretRefs(options.config, state)
  const liveText = await runner([...prefix, 'get', 'secret', refs.server.name, refs.auth.name, '--ignore-not-found', '-o', 'json'])
  let live: {items?: LiveSecret[]}
  try {
    live = JSON.parse(liveText)
    if (!Array.isArray(live.items)) throw new Error('invalid')
  } catch {
    throw new Error('Invalid Kubernetes Secret readback; contents omitted')
  }

  for (const secret of live.items!) {
    if (secret.metadata?.name === refs.auth.name) {
      const token = Buffer.from(secret.data?.[refs.auth.key] ?? '', 'base64').toString('utf8')
      if (token !== state.adminToken) throw new Error('Existing controller admin token differs from local state; restore the matching credential state before publishing')
    }

    if (secret.metadata?.name === refs.server.name) {
      const content = Buffer.from(secret.data?.[refs.server.key] ?? '', 'base64').toString('utf8')
      const server = privateYaml(content) as {encryption?: {keys?: unknown}}
      const expectedKeys = [{name: 'primary', secret: state.encryptionKey, type: 'aes'}]
      // Compare parsed YAML semantically, independent of mapping field order.
      const keys = server?.encryption?.keys as Array<{name?: string; secret?: string; type?: string}> | undefined
      if (!Array.isArray(keys) || keys.length !== 1 || keys[0]?.name !== expectedKeys[0].name
        || keys[0]?.type !== 'aes' || keys[0]?.secret !== state.encryptionKey) {
        throw new Error('Existing controller encryption keys differ from local state; restore matching state before publishing')
      }
    }
  }

  // Server-side apply needs data rather than stringData for reliable field ownership.
  const items = secrets.map(({stringData, ...secret}) => ({...secret, data: Object.fromEntries(Object.entries(stringData).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))}))
  const payload = JSON.stringify({apiVersion: 'v1', items, kind: 'List'})
  const apply = [...prefix, 'apply', '--server-side', '--field-manager=scrollsdk-dstack', '-f', '-', '-o', 'name']
  await runner([...apply, '--dry-run=server'], payload)
  if (!options.preflightOnly) await runner(apply, payload)
  return result
}
