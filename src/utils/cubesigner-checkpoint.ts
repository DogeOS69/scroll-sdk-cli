import * as toml from '@iarna/toml'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {CubesignerRole, DogeConfig} from '../types/doge-config.js'

import {dogeConfigToToml} from './doge-config.js'
import {proofRegularFile} from './proof-software-release.js'
import {normalizeCompressedSecp256k1PublicKey} from './secp256k1-public-key.js'

const hash = (content: string): string => createHash('sha256').update(content).digest('hex')
interface Receipt {files: Record<string, string>; instance: string; keyId: string; organization: string; publicKey: string; roleId: string; schema: string; signerApiRoot: string}
interface Options {deploymentDir: string; directory: string; instance: string; organization: string; signerApiRoot: string}
function read(file: string): string {return fs.readFileSync(proofRegularFile(file, 4 * 1024 * 1024), 'utf8')}
function configToml(file: string): toml.JsonMap {
  const content = read(file)
  try {return toml.parse(content)} catch {throw new Error(`Invalid TOML in ${path.basename(file)}; contents omitted`)}
}

function json(content: string): Record<string, unknown> {
  try {
    const result = JSON.parse(content)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid')
    return result
  } catch {throw new Error('Invalid CubeSigner checkpoint JSON; contents omitted')}
}

function selectedRole(config: Pick<DogeConfig, 'cubesigner'>): {keys: Array<{public_key_compressed: string} & CubesignerRole['keys'][number]>} & CubesignerRole {
  const roles = config.cubesigner?.roles
  if (roles?.length !== 1 || roles[0].keys?.length !== 1) throw new Error('Checkpoint requires exactly one CubeSigner role and key')
  const role = roles[0]
  if (!/^Role#[\w-]+$/.test(role.role_id) || !/^Key#[\w-]+$/.test(role.keys[0].key_id) || !role.keys[0].material_id) throw new Error('Invalid CubeSigner key/role identity')
  const publicKey = role.keys[0].public_key_compressed
  if (typeof publicKey !== 'string' || normalizeCompressedSecp256k1PublicKey(publicKey, 'CubeSigner public key') !== publicKey) throw new Error('CubeSigner key must use canonical compressed encoding')
  return role as {keys: Array<{public_key_compressed: string} & CubesignerRole['keys'][number]>} & CubesignerRole
}

function checkSession(content: string, role: CubesignerRole, options: Options): void {
  const session = json(content)
  const env = session.env as {'Dev-CubeSignerStack'?: {SignerApiRoot?: string}} | undefined
  const api = new URL(options.signerApiRoot)
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error('signer-api-root must be a credential-free HTTPS origin')
  if (env?.['Dev-CubeSignerStack']?.SignerApiRoot?.replace(/\/$/, '') !== api.origin || session.org_id !== options.organization || session.role_id !== role.role_id) throw new Error('Session environment, organization or role does not match checkpoint selection')
  const expiration = session.session_exp ?? session.expiration
  const info = session.session_info as {refresh_token_exp?: number} | undefined
  if (typeof expiration !== 'number' || expiration <= Date.now() / 1000 || typeof info?.refresh_token_exp !== 'number' || info.refresh_token_exp <= Date.now() / 1000) throw new Error('CubeSigner signing session or refresh token is expired; run cubesigner-refresh with management login')
  if (typeof session.token !== 'string' || !session.token || typeof session.refresh_token !== 'string' || !session.refresh_token) throw new Error('CubeSigner signing session is incomplete')
}

export function exportCubesignerCheckpoint(options: Options): Receipt {
  const root = fs.realpathSync(options.deploymentDir)
  const target = path.resolve(root, options.directory)
  if (!options.instance.trim()) throw new Error('instance is required')
  if (fs.existsSync(target)) throw new Error('Checkpoint output already exists; choose a new directory')
  const config = configToml(path.join(root, '.data/doge-config.toml')) as unknown as DogeConfig
  const role = selectedRole(config)
  const session = read(path.join(root, 'secrets/cubesigner-signer-session.json'))
  checkSession(session, role, options)
  const setup = configToml(path.join(root, '.data/setup_defaults.toml'))
  if (setup.tee_pubkey !== role.keys[0].public_key_compressed) throw new Error('setup_defaults TEE key does not match CubeSigner')
  const identity = JSON.stringify({role}, null, 2) + '\n'
  const receipt: Receipt = {files: {'identity.json': hash(identity), 'session.json': hash(session)}, instance: options.instance, keyId: role.keys[0].key_id, organization: options.organization, publicKey: role.keys[0].public_key_compressed, roleId: role.role_id, schema: 'dogeos/cubesigner-checkpoint/v1', signerApiRoot: new URL(options.signerApiRoot).origin}
  fs.mkdirSync(path.dirname(target), {recursive: true})
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Checkpoint output parent must not contain symlinks')
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.cubesigner-checkpoint-'))
  try {
    fs.chmodSync(stage, 0o700)
    for (const [name, content] of Object.entries({'identity.json': identity, 'receipt.json': JSON.stringify(receipt, null, 2) + '\n', 'session.json': session})) fs.writeFileSync(path.join(stage, name), content, {flag: 'wx', mode: 0o600})
    fs.renameSync(stage, target)
  } finally {fs.rmSync(stage, {force: true, recursive: true})}

  return receipt
}

export function importCubesignerCheckpoint(options: Options): Receipt {
  const root = fs.realpathSync(options.deploymentDir)
  const directory = path.resolve(root, options.directory)
  const receipt = json(read(path.join(directory, 'receipt.json'))) as unknown as Receipt
  if (receipt.schema !== 'dogeos/cubesigner-checkpoint/v1' || receipt.instance !== options.instance || receipt.organization !== options.organization || receipt.signerApiRoot !== new URL(options.signerApiRoot).origin) throw new Error('Checkpoint instance/environment/organization mismatch')
  const identity = read(path.join(directory, 'identity.json'))
  const session = read(path.join(directory, 'session.json'))
  if (receipt.files?.['identity.json'] !== hash(identity) || receipt.files?.['session.json'] !== hash(session)) throw new Error('CubeSigner checkpoint file digest mismatch')
  const role = json(identity).role as CubesignerRole
  selectedRole({cubesigner: {roles: [role]}})
  if (role.role_id !== receipt.roleId || role.keys[0].key_id !== receipt.keyId || role.keys[0].public_key_compressed !== receipt.publicKey) throw new Error('Checkpoint identity does not match receipt')
  checkSession(session, role, options)
  const configFile = path.join(root, '.data/doge-config.toml')
  const setupFile = path.join(root, '.data/setup_defaults.toml')
  const config = configToml(configFile) as unknown as DogeConfig
  const setup = configToml(setupFile)
  if (config.cubesigner?.roles?.length) {
    const current = selectedRole(config)
    if (current.role_id !== role.role_id || current.keys[0].key_id !== role.keys[0].key_id || current.keys[0].public_key_compressed !== receipt.publicKey || current.keys[0].material_id !== role.keys[0].material_id) throw new Error('Refuse to overwrite a different active CubeSigner identity')
  }

  if (setup.tee_pubkey && setup.tee_pubkey !== receipt.publicKey) throw new Error('Refuse to overwrite a different setup_defaults TEE key')
  config.cubesigner = {...config.cubesigner, roles: [role]}
  setup.tee_pubkey = receipt.publicKey
  const writes = [
    [configFile, dogeConfigToToml(config)], [setupFile, toml.stringify(setup)],
    [path.join(root, 'secrets/cubesigner-signer-session.json'), session],
    [path.join(root, 'secrets/cubesigner-signer.env'), `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${receipt.keyId}"\n`],
  ]
  fs.mkdirSync(path.join(root, 'secrets'), {mode: 0o700, recursive: true})
  if (fs.realpathSync(path.join(root, 'secrets')) !== path.join(root, 'secrets')) throw new Error('Secret output directory contains symlinks')
  for (const [file] of writes) if (fs.existsSync(file)) proofRegularFile(file, 4 * 1024 * 1024)
  const previous = writes.map(([file]) => fs.existsSync(file) ? fs.readFileSync(file) : undefined)
  try {
    for (const [file, content] of writes) {fs.writeFileSync(file, content, {mode: 0o600}); fs.chmodSync(file, 0o600)}
  } catch (error) {
    for (const [index, [file]] of writes.entries()) {
      if (previous[index]) fs.writeFileSync(file, previous[index]!, {mode: 0o600})
      else fs.rmSync(file, {force: true})
    }

    throw error
  }

  return receipt
}
