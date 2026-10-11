import {execFileSync} from 'node:child_process'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {normalizeCompressedSecp256k1PublicKey} from './secp256k1-public-key.js'

type Lookup = (args: string[]) => Record<string, unknown>
const lookup: Lookup = args => {
  try {
    return JSON.parse(execFileSync('cs', args, {encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}))
  } catch {throw new Error('CubeSigner identity lookup failed; check cs authentication and role/key access (provider output omitted)')}
}

/** Resolve public facts only. The frozen result requires no CubeSigner access on apply. */
export function resolveCubesignerIdentity(input: DeploymentSpec, query: Lookup = lookup): DeploymentSpec {
  const reference = input.signing?.cubesigner?.identity
  if (!reference) return input
  if (typeof reference.roleId !== 'string' || !reference.roleId.trim() || reference.keyId !== undefined && (typeof reference.keyId !== 'string' || !reference.keyId.trim())) throw new Error('CubeSigner identity requires roleId and an optional non-empty keyId')
  if (input.signing.cubesigner?.roles?.length) throw new Error('Choose CubeSigner identity lookup or explicit roles, not both')
  const role = query(['role', 'get', `--role-id=${reference.roleId}`])
  if (role.role_id !== reference.roleId || !Array.isArray(role.keys)) throw new Error('CubeSigner returned an unexpected role')
  const keys = role.keys as Array<{key_id?: string}>
  const keyId = reference.keyId ?? (keys.length === 1 ? keys[0].key_id : undefined)
  if (!keyId || !keys.some(key => key.key_id === keyId)) throw new Error('Select a keyId belonging to the CubeSigner role; automatic selection requires exactly one key')
  const key = query(['key', 'get', `--key-id=${keyId}`, `--role-id=${reference.roleId}`])
  if (key.key_id !== keyId || typeof key.public_key !== 'string' || typeof key.key_type !== 'string' || typeof key.material_id !== 'string') throw new Error('CubeSigner returned incomplete or mismatched key metadata')
  const expectedType = input.dogecoin.network === 'mainnet' ? 'SecpDogeAddr' : 'SecpDogeTestAddr'
  if (key.key_type !== expectedType) throw new Error('CubeSigner key type does not match the selected Dogecoin network')
  const publicKey = normalizeCompressedSecp256k1PublicKey(key.public_key, 'CubeSigner public key')
  if (input.bridge.teePubkey && normalizeCompressedSecp256k1PublicKey(input.bridge.teePubkey, 'bridge.teePubkey') !== publicKey) throw new Error('bridge.teePubkey conflicts with the selected CubeSigner key')
  const spec = structuredClone(input)
  delete spec.signing.cubesigner!.identity
  spec.signing.cubesigner!.roles = [{keys: [{keyId, keyType: key.key_type, materialId: key.material_id, publicKey: key.public_key, publicKeyCompressed: publicKey}], name: typeof role.name === 'string' ? role.name : reference.roleId, roleId: reference.roleId}]
  spec.bridge.teePubkey = publicKey
  return spec
}
