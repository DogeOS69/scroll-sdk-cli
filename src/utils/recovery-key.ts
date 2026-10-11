/* eslint-disable no-bitwise -- POSIX file flags and permission checks. */
import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'
import path from 'node:path'

export type RecoveryNetwork = 'mainnet' | 'regtest' | 'testnet'
const PRIVATE_FILE = 'recovery-key.private.json'
const PUBLIC_FILE = 'recovery-key.public.json'
const PRIVATE_SCHEMA = 'dogeos/recovery-key-private/v1'
const PUBLIC_SCHEMA = 'dogeos/recovery-key-public/v1'

const networkOf = (network: RecoveryNetwork) => {
  if (network === 'mainnet') return bitcore.Networks.livenet
  if (network === 'testnet') return bitcore.Networks.testnet
  if (network === 'regtest') return bitcore.Networks.regtest
  throw new Error('Select mainnet, testnet or regtest')
}

function publicRecord(network: RecoveryNetwork, publicKey: string) {
  return {network, publicKey, schema: PUBLIC_SCHEMA}
}

function result(directory: string, network: RecoveryNetwork, publicKey: string) {
  return {...publicRecord(network, publicKey), privateFile: path.join(directory, PRIVATE_FILE), publicFile: path.join(directory, PUBLIC_FILE)}
}

/** No RPC or deployment configuration is needed. Never return private material. */
export function createRecoveryKey(output: string, network: RecoveryNetwork) {
  const selectedNetwork = networkOf(network)
  const directory = path.resolve(output)
  try {fs.mkdirSync(directory, {mode: 0o700})} catch {
    throw new Error('Use a new recovery-key directory under an existing private parent. Existing directories are never overwritten; use --action inspect for an existing key.')
  }

  try {
    // bitcore uses Node crypto.randomBytes and rejects invalid secp256k1 scalars.
    const key = new bitcore.PrivateKey(undefined, selectedNetwork)
    const publicKey = key.toPublicKey().toString()
    fs.writeFileSync(path.join(directory, PRIVATE_FILE), JSON.stringify({network, privateKeyWif: key.toWIF(), schema: PRIVATE_SCHEMA}, null, 2) + '\n', {flag: 'wx', mode: 0o600})
    fs.writeFileSync(path.join(directory, PUBLIC_FILE), JSON.stringify(publicRecord(network, publicKey), null, 2) + '\n', {flag: 'wx', mode: 0o600})
    return result(directory, network, publicKey)
  } catch {
    // Preserve any saved private key; a failed second write must not destroy it.
    throw new Error('Could not finish writing the recovery key. Preserve the output directory and any private file; no existing files were overwritten.')
  }
}

function readRecord(file: string, privateFile: boolean): Record<string, unknown> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096 || (privateFile && (stat.mode & 0o077) !== 0)) throw new Error('Invalid key file')
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally {fs.closeSync(fd)}
}

/** Verify a saved/backup key without rotating it or exposing its WIF in errors. */
export function inspectRecoveryKey(output: string, network: RecoveryNetwork) {
  const selectedNetwork = networkOf(network)
  const directory = path.resolve(output)
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('Invalid private directory')
    const saved = readRecord(path.join(directory, PRIVATE_FILE), true)
    if (saved.schema !== PRIVATE_SCHEMA || saved.network !== network || typeof saved.privateKeyWif !== 'string') throw new Error('Invalid key record')
    const key = bitcore.PrivateKey.fromWIF(saved.privateKeyWif)
    const publicKey = key.toPublicKey().toString()
    if (!/^(02|03)[\da-f]{64}$/.test(publicKey) || new bitcore.PrivateKey(key.toString(), selectedNetwork).toWIF() !== saved.privateKeyWif) throw new Error('Invalid key network or format')
    const shared = readRecord(path.join(directory, PUBLIC_FILE), false)
    if (shared.schema !== PUBLIC_SCHEMA || shared.network !== network || shared.publicKey !== publicKey) throw new Error('Public record mismatch')
    return result(directory, network, publicKey)
  } catch {
    throw new Error('Cannot verify recovery key: check both files, the selected network, directory permissions (0700), and private-file permissions (0600). Symlinks are not accepted. Private contents omitted.')
  }
}
