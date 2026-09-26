import * as yaml from 'js-yaml'
import {createPrivateKey, randomBytes} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {DstackControllerConfig} from '../types/dstack-controller.js'

import {validateDstackControllerConfig} from './dstack-controller-values.js'

export type DstackProvider = 'gcp' | 'vastai'
export interface DstackCredentials {
  adminToken: string
  encryptionKey: string
  gcp?: {projectId: string; serviceAccount: string}
  project: string
  providers: DstackProvider[]
  vastaiApiKey?: string
  version: 1
}

export interface DstackSecret {
  apiVersion: 'v1'
  kind: 'Secret'
  metadata: {name: string; namespace?: string}
  stringData: Record<string, string>
  type: 'Opaque'
}

export const DSTACK_CREDENTIALS_FILE = '.data/dstack/credentials.json'

/** Never include parser errors: JSON/YAML error messages can contain credentials. */
export function parsePrivateJson(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value
  } catch {
    throw new Error('Invalid credential JSON; contents omitted')
  }
}

export function validateGcpServiceAccount(content: string): string {
  const account = parsePrivateJson(content)
  if (account.type !== 'service_account' || typeof account.project_id !== 'string' || !account.project_id
    || typeof account.client_email !== 'string' || !account.client_email.includes('@')
    || typeof account.private_key !== 'string') {
    throw new Error('GCP JSON must contain a service_account with project_id, client_email and private_key')
  }

  try {
    if (createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') throw new Error('invalid')
  } catch {
    throw new Error('GCP service account private_key is not a valid RSA private key')
  }

  return account.project_id
}

export function validateDstackCredentials(value: DstackCredentials): void {
  if (value.version !== 1 || !Array.isArray(value.providers) || value.providers.length === 0
    || value.providers.some(provider => !['gcp', 'vastai'].includes(provider))
    || new Set(value.providers).size !== value.providers.length) throw new Error('Invalid dstack credential state providers/version')
  if (typeof value.project !== 'string' || !/^[\w-]+$/.test(value.project)) throw new Error('Invalid dstack project name')
  if (typeof value.adminToken !== 'string' || value.adminToken.length < 16) throw new Error('Invalid stored dstack admin token; restore credential state from backup')
  if (typeof value.encryptionKey !== 'string' || !/^[\d+/A-Za-z]{43}=$/.test(value.encryptionKey)
    || Buffer.from(value.encryptionKey, 'base64').length !== 32) throw new Error('Invalid stored dstack encryption key; restore credential state from backup')
  if (value.providers.includes('vastai') && (typeof value.vastaiApiKey !== 'string' || !value.vastaiApiKey.trim() || /\s/.test(value.vastaiApiKey))) {
    throw new Error('Vast.ai API key is required and must not contain whitespace')
  }

  if (value.providers.includes('gcp')) {
    if (!value.gcp || typeof value.gcp.serviceAccount !== 'string' || !value.gcp.projectId?.trim()) throw new Error('GCP service account is required')
    validateGcpServiceAccount(value.gcp.serviceAccount)
  }
}

export function readDstackCredentials(directory = process.cwd()): DstackCredentials | undefined {
  const file = path.join(directory, DSTACK_CREDENTIALS_FILE)
  if (!fs.existsSync(file)) return undefined
  const value = parsePrivateJson(fs.readFileSync(file, 'utf8')) as unknown as DstackCredentials
  validateDstackCredentials(value)
  return value
}

/** Refuse symlink traversal when writing sensitive files, including dangling links. */
export function checkPrivatePath(file: string): void {
  let current = path.resolve(file)
  while (current.length > 0) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Credential output paths must not contain symbolic links')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function writePrivateFile(file: string, content: string): void {
  checkPrivatePath(file)
  fs.mkdirSync(path.dirname(file), {mode: 0o700, recursive: true})
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, content, {flag: 'wx', mode: 0o600})
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, {force: true})
  }
}

export function newDstackCredentials(): DstackCredentials {
  return {adminToken: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('base64'), project: 'main', providers: [], version: 1}
}

/** Public refs only; prep-charts/generate-from-spec consume these without seeing keys. */
export function configureDstackCredentialRefs(config: DstackControllerConfig, state: DstackCredentials): DstackControllerConfig {
  validateDstackControllerConfig(config)
  const next = structuredClone(config)
  next.enabled = true
  if (state.providers.includes('gcp')) {
    next.credentialSecrets ??= []
    if (!next.credentialSecrets.some(ref => ref.name === 'gcp')) next.credentialSecrets.push({name: 'gcp', secretName: 'dstack-gcp-credentials'})
  } else if (next.credentialSecrets) {
    next.credentialSecrets = next.credentialSecrets.filter(ref => ref.name !== 'gcp')
  }

  // Validate all references and collisions before changing any files.
  dstackSecretRefs(next, state)
  return next
}

export function dstackSecretRefs(config: DstackControllerConfig, state: DstackCredentials): {
  auth: {key: string; name: string}
  database?: {key: string; name: string}
  gcp?: {key: string; name: string}
  server: {key: string; name: string}
} {
  validateDstackControllerConfig(config)
  if (config.enabled === false) throw new Error('Dstack controller is disabled')
  const refs = {
    auth: {key: config.auth?.key ?? 'admin-token', name: config.auth?.existingSecret ?? 'dstack-controller-auth'},
    database: config.database?.type === 'sqlite' ? undefined : {key: config.database?.key ?? 'database-url', name: config.database?.existingSecret ?? 'dstack-controller-database'},
    gcp: state.providers.includes('gcp') ? {key: 'service-account.json', name: config.credentialSecrets?.find(ref => ref.name === 'gcp')?.secretName ?? ''} : undefined,
    server: {key: config.serverConfig?.key ?? 'config.yml', name: config.serverConfig?.existingSecret ?? 'dstack-controller-config'},
  }
  const seen = new Set<string>()
  for (const ref of Object.values(refs)) {
    if (!ref) continue
    if (!/^[\da-z]([\d.a-z-]*[\da-z])?$/.test(ref.name) || ref.name.length > 253) throw new Error('Invalid or missing dstack Secret name; run setup dstack-config to configure references')
    if (!/^[\w.-]+$/.test(ref.key) || ref.key.length > 253) throw new Error('Invalid dstack Secret key')
    if (seen.has(ref.name)) throw new Error('Dstack config, auth, database and GCP Secrets must have distinct names')
    seen.add(ref.name)
  }

  for (const ref of config.credentialSecrets ?? []) {
    if (ref.name !== 'gcp' && seen.has(ref.secretName)) throw new Error('A credential mount conflicts with a managed dstack Secret')
  }

  return refs
}

export function renderDstackSecrets(config: DstackControllerConfig, state: DstackCredentials): DstackSecret[] {
  validateDstackCredentials(state)
  const refs = dstackSecretRefs(config, state)
  const backends: unknown[] = []
  if (state.providers.includes('vastai')) backends.push({creds: {api_key: state.vastaiApiKey, type: 'api_key'}, type: 'vastai'})
  if (state.providers.includes('gcp')) backends.push({creds: {filename: '/etc/dstack/credentials/gcp/service-account.json', type: 'service_account'}, project_id: state.gcp!.projectId, type: 'gcp'})
  const server = yaml.dump({
    encryption: {keys: [{name: 'primary', secret: state.encryptionKey, type: 'aes'}]},
    projects: [{backends, name: state.project}],
  }, {lineWidth: -1, noRefs: true})
  const make = (ref: {key: string; name: string}, content: string): DstackSecret => ({
    apiVersion: 'v1', kind: 'Secret', metadata: {name: ref.name}, stringData: {[ref.key]: content}, type: 'Opaque',
  })
  const secrets = [make(refs.server, server), make(refs.auth, state.adminToken)]
  if (refs.gcp) secrets.push(make(refs.gcp, state.gcp!.serviceAccount))
  return secrets
}

export function writeDstackCredentialSecrets(config: DstackControllerConfig, directory = process.cwd()): string[] {
  const state = readDstackCredentials(directory)
  if (!state) throw new Error('Dstack credentials are missing; run setup dstack-config first')
  const secrets = renderDstackSecrets(config, state)
  const files = secrets.map(secret => path.join(directory, 'secrets', `${secret.metadata.name}.yaml`))
  for (const file of files) checkPrivatePath(file)
  for (const [index, secret] of secrets.entries()) writePrivateFile(files[index], yaml.dump(secret, {lineWidth: -1, noRefs: true}))
  return files
}
