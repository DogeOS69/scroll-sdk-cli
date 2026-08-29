import Docker from 'dockerode'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  PreparedProofRelease,
  PreparedProofSoftwareRelease,
  ProofDeploymentReleaseLockV1,
  ProofReleaseImportV1,
  ProofSoftwareReleaseImportV1,
  ProofSoftwareReleaseV1,
} from '../types/proof-release.js'
import type {ProofTopologyImageReference, ProofTopologySpec} from '../types/proof-topology.js'

import {
  PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA,
  PROOF_RELEASE_IMPORT_SCHEMA,
  PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA,
  PROOF_SOFTWARE_RELEASE_SCHEMA,
} from '../types/proof-release.js'

export const DEFAULT_PROOF_RELEASES_ROOT = '.data/proof-releases'
export const PROOF_SOFTWARE_RELEASE_MANIFEST = 'proof-software-release-v1.json'
export const PROOF_DEPLOYMENT_RELEASE_LOCK = 'proof-deployment-release-lock-v1.json'
export const PROOF_RELEASE_IMPORT_RECEIPT = 'scrollsdk-proof-release-import-v1.json'
export const PROOF_SOFTWARE_RELEASE_IMPORT_RECEIPT =
  'scrollsdk-proof-software-release-import-v1.json'

const PINNED_IMAGE = /^([^\s@]+)@(sha256:[\da-f]{64})$/
const SHA256_DIGEST = /^sha256:[\da-f]{64}$/
const HEX_32 = /^0x[\da-f]{64}$/
const HEX_64 = /^0x[\da-f]{128}$/

export interface ProofReleaseCommandResult {
  status: number
  stderr: string
  stdout: string
}

export type ProofReleaseCommandRunner = (
  command: string,
  args: string[],
) => ProofReleaseCommandResult

export interface PrepareProofReleaseOptions {
  commandRunner?: ProofReleaseCommandRunner
  deploymentDir?: string
  dockerPlatform?: string
  imagePuller?: ProofReleaseImagePuller
  log?: (message: string) => void
  protocolContext?: string
  releaseImage: string
  releasesRoot?: string
}

export interface PrepareProofSoftwareReleaseOptions {
  commandRunner?: ProofReleaseCommandRunner
  deploymentDir?: string
  dockerPlatform?: string
  imagePuller?: ProofReleaseImagePuller
  log?: (message: string) => void
  releaseImage: string
  releasesRoot?: string
}

export type ProofReleaseImagePuller = (
  imageReference: string,
  platform: string,
  log?: (message: string) => void,
) => Promise<void>

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }

  return value as Record<string, unknown>
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`${label}.${key} is not supported`)
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }

  if (value !== value.trim()) throw new Error(`${label} must not have surrounding whitespace`)
  return value
}

function digest(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!SHA256_DIGEST.test(result)) throw new Error(`${label} must match sha256:[0-9a-f]{64}`)
  return result
}

function absolutePath(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!path.isAbsolute(result)) throw new Error(`${label} must be absolute`)
  return path.resolve(result)
}

function image(value: unknown, label: string): ProofTopologyImageReference {
  const raw = mapping(value, label)
  assertKnownKeys(raw, ['digest', 'repository'], label)
  const repository = requiredString(raw.repository, `${label}.repository`)
  if (repository.includes('@') || /\s/.test(repository)) {
    throw new Error(`${label}.repository must contain an untagged repository name`)
  }

  const lastSlash = repository.lastIndexOf('/')
  if (repository.lastIndexOf(':') > lastSlash) {
    throw new Error(`${label}.repository must not contain a mutable tag`)
  }

  return {digest: digest(raw.digest, `${label}.digest`), repository}
}

export function immutableProofImageReference(value: string, label = 'proof release image'): string {
  const match = PINNED_IMAGE.exec(value.trim())
  if (!match) throw new Error(`${label} must match repository@sha256:<64 lowercase hex>`)
  return `${match[1]}@${match[2]}`
}

function immutableImage(imageValue: ProofTopologyImageReference): string {
  return `${imageValue.repository}@${imageValue.digest}`
}

function readJson(filePath: string, label: string): unknown {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`)
  if (!fs.lstatSync(resolved).isFile() || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${resolved}`)
  }

  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `${resolved}: failed to decode ${label}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function assertIdentityShape(rawValue: unknown, label: string, kind: 'batch' | 'openvm' | 'scroll') {
  const raw = mapping(rawValue, label)
  const allowed = kind === 'openvm'
    ? ['app_commit_raw', 'program_commitment_hash', 'verification_key_hash']
    : kind === 'batch'
      ? [
          'program_commitment_hash',
          'program_commitment_le_raw',
          'recursive_app_commit_raw',
          'verification_key_hash',
        ]
      : ['program_commitment_hash', 'program_commitment_le_raw', 'verification_key_hash']
  assertKnownKeys(raw, allowed, label)
  for (const field of ['program_commitment_hash', 'verification_key_hash']) {
    if (!HEX_32.test(requiredString(raw[field], `${label}.${field}`))) {
      throw new Error(`${label}.${field} must be canonical 32-byte lowercase hex`)
    }
  }

  const rawField = kind === 'openvm' ? 'app_commit_raw' : 'program_commitment_le_raw'
  if (!HEX_64.test(requiredString(raw[rawField], `${label}.${rawField}`))) {
    throw new Error(`${label}.${rawField} must be canonical 64-byte lowercase hex`)
  }

  if (
    kind === 'batch'
    && !HEX_64.test(requiredString(raw.recursive_app_commit_raw, `${label}.recursive_app_commit_raw`))
  ) {
    throw new Error(`${label}.recursive_app_commit_raw must be canonical 64-byte lowercase hex`)
  }
}

function assertImagesShape(rawValue: unknown, label: string): void {
  const raw = mapping(rawValue, label)
  assertKnownKeys(
    raw,
    [
      'bridge_artifact_baker',
      'mock_worker',
      'production_worker',
      'proof_coordinator',
      'topology_compiler',
      'withdrawal_processor',
    ],
    label,
  )
  for (const field of [
    'bridge_artifact_baker',
    'mock_worker',
    'production_worker',
    'topology_compiler',
  ]) image(raw[field], `${label}.${field}`)
  if (raw.proof_coordinator !== undefined) image(raw.proof_coordinator, `${label}.proof_coordinator`)
  if (raw.withdrawal_processor !== undefined) {
    image(raw.withdrawal_processor, `${label}.withdrawal_processor`)
  }
}

export function readProofSoftwareRelease(filePath: string): ProofSoftwareReleaseV1 {
  const raw = mapping(readJson(filePath, 'proof software release'), filePath)
  assertKnownKeys(
    raw,
    [
      'build',
      'identities',
      'images',
      'materials',
      'release_digest',
      'release_id',
      'schema',
      'schema_version',
      'source_revisions',
    ],
    filePath,
  )
  if (raw.schema !== PROOF_SOFTWARE_RELEASE_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${filePath} must be dogeos/proof-software-release/v1 schema_version 1`)
  }

  requiredString(raw.release_id, `${filePath}.release_id`)
  digest(raw.release_digest, `${filePath}.release_digest`)
  assertImagesShape(raw.images, `${filePath}.images`)
  const identities = mapping(raw.identities, `${filePath}.identities`)
  assertKnownKeys(
    identities,
    ['aggregate_verification_key_hash', 'batch', 'chunk', 'l2_range'],
    `${filePath}.identities`,
  )
  if (!HEX_32.test(requiredString(
    identities.aggregate_verification_key_hash,
    `${filePath}.identities.aggregate_verification_key_hash`,
  ))) throw new Error(`${filePath}.identities.aggregate_verification_key_hash is invalid`)
  assertIdentityShape(identities.chunk, `${filePath}.identities.chunk`, 'scroll')
  assertIdentityShape(identities.batch, `${filePath}.identities.batch`, 'batch')
  assertIdentityShape(identities.l2_range, `${filePath}.identities.l2_range`, 'openvm')
  mapping(raw.materials, `${filePath}.materials`)
  mapping(raw.build, `${filePath}.build`)
  mapping(raw.source_revisions, `${filePath}.source_revisions`)
  return raw as unknown as ProofSoftwareReleaseV1
}

export function readProofDeploymentReleaseLock(filePath: string): ProofDeploymentReleaseLockV1 {
  const raw = mapping(readJson(filePath, 'proof deployment release lock'), filePath)
  assertKnownKeys(
    raw,
    [
      'bridge_material_digest',
      'bridge_material_manifest',
      'bridge_material_root',
      'lock_digest',
      'projection',
      'schema',
      'schema_version',
      'software_release_digest',
      'software_release_manifest',
      'software_release_root',
    ],
    filePath,
  )
  if (raw.schema !== PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${filePath} must be dogeos/proof-deployment-release-lock/v1 schema_version 1`)
  }

  for (const field of ['bridge_material_digest', 'lock_digest', 'software_release_digest']) {
    digest(raw[field], `${filePath}.${field}`)
  }

  for (const field of [
    'bridge_material_manifest',
    'bridge_material_root',
    'software_release_manifest',
    'software_release_root',
  ]) absolutePath(raw[field], `${filePath}.${field}`)
  const projection = mapping(raw.projection, `${filePath}.projection`)
  assertKnownKeys(
    projection,
    [
      'aggregate_verification_key',
      'batch_app_vmexe',
      'batch_materializer',
      'batch_openvm_config',
      'bridge_app_vmexe',
      'bridge_openvm_config',
      'chunk_app_vmexe',
      'chunk_materializer',
      'chunk_openvm_config',
      'identities',
      'images',
      'l2_range_app_vmexe',
      'l2_range_openvm_config',
    ],
    `${filePath}.projection`,
  )
  for (const field of [
    'aggregate_verification_key',
    'batch_app_vmexe',
    'batch_materializer',
    'batch_openvm_config',
    'bridge_app_vmexe',
    'bridge_openvm_config',
    'chunk_app_vmexe',
    'chunk_materializer',
    'chunk_openvm_config',
    'l2_range_app_vmexe',
    'l2_range_openvm_config',
  ]) absolutePath(projection[field], `${filePath}.projection.${field}`)
  assertImagesShape(projection.images, `${filePath}.projection.images`)
  const identities = mapping(projection.identities, `${filePath}.projection.identities`)
  assertKnownKeys(
    identities,
    ['aggregate_verification_key_hash', 'batch', 'bridge', 'chunk', 'l2_range'],
    `${filePath}.projection.identities`,
  )
  if (!HEX_32.test(requiredString(
    identities.aggregate_verification_key_hash,
    `${filePath}.projection.identities.aggregate_verification_key_hash`,
  ))) {
    throw new Error(
      `${filePath}.projection.identities.aggregate_verification_key_hash is invalid`,
    )
  }

  assertIdentityShape(identities.chunk, `${filePath}.projection.identities.chunk`, 'scroll')
  assertIdentityShape(identities.batch, `${filePath}.projection.identities.batch`, 'batch')
  assertIdentityShape(identities.bridge, `${filePath}.projection.identities.bridge`, 'openvm')
  assertIdentityShape(identities.l2_range, `${filePath}.projection.identities.l2_range`, 'openvm')
  return raw as unknown as ProofDeploymentReleaseLockV1
}

export function readProofReleaseImport(filePath: string): ProofReleaseImportV1 {
  const raw = mapping(readJson(filePath, 'scroll-sdk proof release import receipt'), filePath)
  assertKnownKeys(
    raw,
    [
      'deployment_lock',
      'deployment_lock_digest',
      'protocol_context',
      'protocol_context_sha256',
      'release_id',
      'release_image',
      'schema',
      'schema_version',
      'software_release_digest',
    ],
    filePath,
  )
  if (raw.schema !== PROOF_RELEASE_IMPORT_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${filePath} must be ${PROOF_RELEASE_IMPORT_SCHEMA} schema_version 1`)
  }

  immutableProofImageReference(requiredString(raw.release_image, `${filePath}.release_image`))
  absolutePath(raw.deployment_lock, `${filePath}.deployment_lock`)
  absolutePath(raw.protocol_context, `${filePath}.protocol_context`)
  for (const field of ['deployment_lock_digest', 'protocol_context_sha256', 'software_release_digest']) {
    digest(raw[field], `${filePath}.${field}`)
  }

  requiredString(raw.release_id, `${filePath}.release_id`)
  return raw as unknown as ProofReleaseImportV1
}

export function readProofSoftwareReleaseImport(
  filePath: string,
): ProofSoftwareReleaseImportV1 {
  const raw = mapping(readJson(filePath, 'scroll-sdk proof software release import receipt'), filePath)
  assertKnownKeys(
    raw,
    [
      'release_id',
      'release_image',
      'schema',
      'schema_version',
      'software_release_digest',
      'software_release_manifest',
    ],
    filePath,
  )
  if (raw.schema !== PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${filePath} must be ${PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA} schema_version 1`)
  }

  immutableProofImageReference(requiredString(raw.release_image, `${filePath}.release_image`))
  absolutePath(raw.software_release_manifest, `${filePath}.software_release_manifest`)
  digest(raw.software_release_digest, `${filePath}.software_release_digest`)
  requiredString(raw.release_id, `${filePath}.release_id`)
  return raw as unknown as ProofSoftwareReleaseImportV1
}

export function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }

  return `sha256:${hash.digest('hex')}`
}

function ensureInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside prepared proof release root ${resolvedRoot}`)
  }

  return resolved
}

export function readPreparedProofRelease(lockPath: string): PreparedProofRelease {
  const resolvedLock = path.resolve(lockPath)
  const resourcesRoot = path.dirname(resolvedLock)
  const importPath = path.join(resourcesRoot, PROOF_RELEASE_IMPORT_RECEIPT)
  const lock = readProofDeploymentReleaseLock(resolvedLock)
  const receipt = readProofReleaseImport(importPath)
  if (path.resolve(receipt.deployment_lock) !== resolvedLock) {
    throw new Error(`${importPath}.deployment_lock does not name ${resolvedLock}`)
  }

  if (receipt.deployment_lock_digest !== lock.lock_digest) {
    throw new Error(`${importPath}.deployment_lock_digest does not match the deployment lock`)
  }

  for (const [label, candidate] of [
    ['software_release_manifest', lock.software_release_manifest],
    ['software_release_root', lock.software_release_root],
    ['bridge_material_manifest', lock.bridge_material_manifest],
    ['bridge_material_root', lock.bridge_material_root],
    ...Object.entries(lock.projection).filter(([key]) => key !== 'identities' && key !== 'images'),
  ] as Array<[string, string]>) ensureInside(resourcesRoot, candidate, label)
  const release = readProofSoftwareRelease(lock.software_release_manifest)
  if (
    release.release_digest !== lock.software_release_digest
    || release.release_digest !== receipt.software_release_digest
  ) throw new Error('prepared proof release software digest binding is inconsistent')
  if (release.release_id !== receipt.release_id) {
    throw new Error('prepared proof release release_id binding is inconsistent')
  }

  if (sha256File(receipt.protocol_context) !== receipt.protocol_context_sha256) {
    throw new Error(`protocol context changed after proof release preparation: ${receipt.protocol_context}`)
  }

  return {importPath, lock, lockPath: resolvedLock, receipt, release, resourcesRoot}
}

export function readPreparedProofSoftwareRelease(
  manifestPath: string,
): PreparedProofSoftwareRelease {
  const resolvedManifest = path.resolve(manifestPath)
  const softwareRoot = path.dirname(resolvedManifest)
  const resourcesRoot = path.dirname(softwareRoot)
  const importPath = path.join(resourcesRoot, PROOF_SOFTWARE_RELEASE_IMPORT_RECEIPT)
  ensureInside(resourcesRoot, resolvedManifest, 'software_release_manifest')
  const receipt = readProofSoftwareReleaseImport(importPath)
  if (path.resolve(receipt.software_release_manifest) !== resolvedManifest) {
    throw new Error(`${importPath}.software_release_manifest does not name ${resolvedManifest}`)
  }

  const release = readProofSoftwareRelease(resolvedManifest)
  if (release.release_digest !== receipt.software_release_digest) {
    throw new Error('prepared proof software release digest binding is inconsistent')
  }

  if (release.release_id !== receipt.release_id) {
    throw new Error('prepared proof software release release_id binding is inconsistent')
  }

  return {importPath, manifestPath: resolvedManifest, receipt, release, resourcesRoot, softwareRoot}
}

export function discoverPreparedProofRelease(
  deploymentDir = '.',
  explicitLock?: string,
): string | undefined {
  if (explicitLock) return path.resolve(deploymentDir, explicitLock)
  const found = listPreparedProofReleaseLocks(deploymentDir)
  if (found.length > 1) {
    throw new Error(
      `multiple prepared proof releases found: ${found.join(', ')}; `
      + 'pass --proof-release-lock explicitly',
    )
  }

  return found[0]
}

export function listPreparedProofReleaseLocks(deploymentDir = '.'): string[] {
  const releasesRoot = path.resolve(deploymentDir, DEFAULT_PROOF_RELEASES_ROOT)
  if (!fs.existsSync(releasesRoot)) return []
  return fs.readdirSync(releasesRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(releasesRoot, entry.name, PROOF_DEPLOYMENT_RELEASE_LOCK))
    .filter(candidate => fs.existsSync(candidate))
}

export function discoverPreparedProofSoftwareRelease(
  deploymentDir = '.',
  explicitManifest?: string,
): string | undefined {
  if (explicitManifest) return path.resolve(deploymentDir, explicitManifest)
  const found = listPreparedProofSoftwareReleaseManifests(deploymentDir)
  if (found.length > 1) {
    throw new Error(
      `multiple prepared proof software releases found: ${found.join(', ')}; `
      + 'pass --proof-software-release explicitly',
    )
  }

  return found[0]
}

export function listPreparedProofSoftwareReleaseManifests(deploymentDir = '.'): string[] {
  const releasesRoot = path.resolve(deploymentDir, DEFAULT_PROOF_RELEASES_ROOT)
  if (!fs.existsSync(releasesRoot)) return []
  return fs.readdirSync(releasesRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(releasesRoot, entry.name))
    .filter(root => fs.existsSync(path.join(root, PROOF_SOFTWARE_RELEASE_IMPORT_RECEIPT)))
    .map(root => path.join(root, 'software', PROOF_SOFTWARE_RELEASE_MANIFEST))
    .filter(candidate => fs.existsSync(candidate))
}

function defaultCommandRunner(command: string, args: string[]): ProofReleaseCommandResult {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
  })
  if (child.error) throw child.error
  return {
    status: child.status ?? 1,
    stderr: child.stderr || '',
    stdout: child.stdout || '',
  }
}

function checkedRun(
  runner: ProofReleaseCommandRunner,
  command: string,
  args: string[],
  label: string,
): string {
  const result = runner(command, args)
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${label} failed with status ${result.status}${detail ? `: ${detail}` : ''}`)
  }

  return result.stdout.trim()
}

async function pullProofImage(
  imageReference: string,
  platform: string,
  log?: (message: string) => void,
): Promise<void> {
  const docker = new Docker()
  try {
    try {
      const local = await docker.getImage(imageReference).inspect()
      const localPlatform = `${local.Os}/${local.Architecture}`
      if (localPlatform === platform) {
        log?.(`Docker image already present for ${platform}: ${imageReference}`)
        return
      }

      log?.(`Docker image is ${localPlatform}; pulling ${platform}: ${imageReference}`)
    } catch (error) {
      const statusCode = error && typeof error === 'object' && 'statusCode' in error
        ? Number(error.statusCode)
        : undefined
      if (statusCode !== 404) throw error
      log?.(`Pulling Docker image for ${platform}: ${imageReference}`)
    }

    const stream = await docker.pull(imageReference, {platform})
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, error => {
        if (error) reject(error)
        else resolve()
      })
    })
    log?.(`Docker image ready for ${platform}: ${imageReference}`)
  } finally {
    const modem = docker.modem as unknown as {agent?: {destroy?: () => void}}
    modem.agent?.destroy?.()
  }
}

function dockerSecurityArgs(): string[] {
  return [
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '4096',
  ]
}

function mountValue(source: string, destination: string, readonly = false): string {
  for (const value of [source, destination]) {
    if (value.includes(',')) throw new Error(`Docker bind-mount paths must not contain commas: ${value}`)
  }

  return `type=bind,src=${source},dst=${destination}${readonly ? ',readonly' : ''}`
}

function runReleaseTool(
  runner: ProofReleaseCommandRunner,
  imageReference: string,
  rootSource: string,
  rootDestination: string,
  protocolContext: string | undefined,
  commandArgs: string[],
  dockerPlatform = 'linux/amd64',
): void {
  checkedRun(
    runner,
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      dockerPlatform,
      ...dockerSecurityArgs(),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '--mount',
      mountValue(rootSource, rootDestination),
      ...(protocolContext
        ? ['--mount', mountValue(protocolContext, protocolContext, true)]
        : []),
      '--entrypoint',
      'dogeos-proof-release',
      imageReference,
      ...commandArgs,
    ],
    `dogeos-proof-release ${commandArgs[0]}`,
  )
}

export function validatePreparedProofRelease(
  prepared: PreparedProofRelease,
  commandRunner: ProofReleaseCommandRunner = defaultCommandRunner,
  dockerPlatform = 'linux/amd64',
): void {
  const topologyImage = immutableImage(prepared.release.images.topology_compiler)
  runReleaseTool(
    commandRunner,
    topologyImage,
    prepared.resourcesRoot,
    prepared.resourcesRoot,
    prepared.receipt.protocol_context,
    [
      'validate-deployment',
      '--lock',
      prepared.lockPath,
      '--protocol-context',
      prepared.receipt.protocol_context,
    ],
    dockerPlatform,
  )
}

export function validatePreparedProofSoftwareRelease(
  prepared: PreparedProofSoftwareRelease,
  commandRunner: ProofReleaseCommandRunner = defaultCommandRunner,
  dockerPlatform = 'linux/amd64',
): void {
  const topologyImage = immutableImage(prepared.release.images.topology_compiler)
  runReleaseTool(
    commandRunner,
    topologyImage,
    prepared.resourcesRoot,
    prepared.resourcesRoot,
    undefined,
    [
      'validate-software',
      '--manifest',
      prepared.manifestPath,
      '--root',
      prepared.softwareRoot,
    ],
    dockerPlatform,
  )
}

function writeReceipt(
  filePath: string,
  receipt: ProofReleaseImportV1 | ProofSoftwareReleaseImportV1,
): void {
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, undefined, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

export async function prepareProofSoftwareRelease(
  options: PrepareProofSoftwareReleaseOptions,
): Promise<PreparedProofSoftwareRelease> {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const releaseImage = immutableProofImageReference(options.releaseImage)
  const match = PINNED_IMAGE.exec(releaseImage)!
  const releasesRoot = path.resolve(
    deploymentDir,
    options.releasesRoot || DEFAULT_PROOF_RELEASES_ROOT,
  )
  const key = `software-${match[2].replace(':', '-')}`
  const finalRoot = path.join(releasesRoot, key)
  const finalManifest = path.join(finalRoot, 'software', PROOF_SOFTWARE_RELEASE_MANIFEST)
  const runner = options.commandRunner || defaultCommandRunner
  const dockerPlatform = options.dockerPlatform || 'linux/amd64'
  const imagePuller = options.imagePuller || pullProofImage
  if (fs.existsSync(finalRoot)) {
    const prepared = readPreparedProofSoftwareRelease(finalManifest)
    if (prepared.receipt.release_image !== releaseImage) {
      throw new Error(`${finalRoot} was prepared from a different immutable release image`)
    }

    options.log?.(`Revalidating prepared proof software release ${prepared.release.release_id}`)
    await imagePuller(
      immutableImage(prepared.release.images.topology_compiler),
      dockerPlatform,
      options.log,
    )
    validatePreparedProofSoftwareRelease(prepared, runner, dockerPlatform)
    return prepared
  }

  fs.mkdirSync(releasesRoot, {recursive: true})
  const stagingRoot = fs.mkdtempSync(path.join(releasesRoot, `.${key}.preparing-`))
  fs.chmodSync(stagingRoot, 0o755)
  let containerId: string | undefined
  try {
    await imagePuller(releaseImage, dockerPlatform, options.log)
    containerId = checkedRun(
      runner,
      'docker',
      ['create', '--platform', dockerPlatform, releaseImage, '/bin/true'],
      'docker create proof software release',
    ).split(/\s+/)[0]
    if (!containerId) throw new Error('docker create did not return a container ID')
    const softwareStaging = path.join(stagingRoot, 'software')
    fs.mkdirSync(softwareStaging)
    checkedRun(
      runner,
      'docker',
      ['cp', `${containerId}:/proof-release/.`, softwareStaging],
      'docker copy proof software release',
    )
    checkedRun(runner, 'docker', ['rm', '-f', containerId], 'docker remove proof release container')
    containerId = undefined

    const stagedManifest = path.join(softwareStaging, PROOF_SOFTWARE_RELEASE_MANIFEST)
    const release = readProofSoftwareRelease(stagedManifest)
    const topologyImage = immutableImage(release.images.topology_compiler)
    await imagePuller(topologyImage, dockerPlatform, options.log)
    options.log?.(`Validating proof software release ${release.release_id}`)
    runReleaseTool(
      runner,
      topologyImage,
      stagingRoot,
      finalRoot,
      undefined,
      [
        'validate-software',
        '--manifest',
        finalManifest,
        '--root',
        path.join(finalRoot, 'software'),
      ],
      dockerPlatform,
    )
    const receipt: ProofSoftwareReleaseImportV1 = {
      release_id: release.release_id,
      release_image: releaseImage,
      schema: PROOF_SOFTWARE_RELEASE_IMPORT_SCHEMA,
      schema_version: 1,
      software_release_digest: release.release_digest,
      software_release_manifest: finalManifest,
    }
    writeReceipt(path.join(stagingRoot, PROOF_SOFTWARE_RELEASE_IMPORT_RECEIPT), receipt)
    if (fs.existsSync(finalRoot)) throw new Error(`proof release destination appeared: ${finalRoot}`)
    fs.renameSync(stagingRoot, finalRoot)
    const prepared = readPreparedProofSoftwareRelease(finalManifest)
    if (prepared.release.release_digest !== release.release_digest) {
      throw new Error('proof software release changed while it was installed')
    }

    return prepared
  } finally {
    if (containerId) runner('docker', ['rm', '-f', containerId])
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, {force: true, recursive: true})
  }
}

export async function prepareProofRelease(
  options: PrepareProofReleaseOptions,
): Promise<PreparedProofRelease> {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const protocolContext = path.resolve(
    deploymentDir,
    options.protocolContext || '.data/protocol_context.json',
  )
  if (!fs.existsSync(protocolContext) || !fs.statSync(protocolContext).isFile()) {
    throw new Error(
      `canonical protocol context not found: ${protocolContext}; `
      + 'run scrollsdk setup bridge-init --step 5-protocol-context first',
    )
  }

  const releaseImage = immutableProofImageReference(options.releaseImage)
  const match = PINNED_IMAGE.exec(releaseImage)!
  const protocolContextSha256 = sha256File(protocolContext)
  const releasesRoot = path.resolve(
    deploymentDir,
    options.releasesRoot || DEFAULT_PROOF_RELEASES_ROOT,
  )
  const key = `${match[2].replace(':', '-')}-${protocolContextSha256.slice('sha256:'.length, 29)}`
  const finalRoot = path.join(releasesRoot, key)
  const finalLock = path.join(finalRoot, PROOF_DEPLOYMENT_RELEASE_LOCK)
  const runner = options.commandRunner || defaultCommandRunner
  const dockerPlatform = options.dockerPlatform || 'linux/amd64'
  const imagePuller = options.imagePuller || pullProofImage
  if (fs.existsSync(finalRoot)) {
    const prepared = readPreparedProofRelease(finalLock)
    if (prepared.receipt.release_image !== releaseImage) {
      throw new Error(`${finalRoot} was prepared from a different immutable release image`)
    }

    options.log?.(`Revalidating prepared proof release ${prepared.release.release_id}`)
    await imagePuller(
      immutableImage(prepared.release.images.topology_compiler),
      dockerPlatform,
      options.log,
    )
    validatePreparedProofRelease(prepared, runner, dockerPlatform)
    return prepared
  }

  fs.mkdirSync(releasesRoot, {recursive: true})
  const stagingRoot = fs.mkdtempSync(path.join(releasesRoot, `.${key}.preparing-`))
  // Node creates mkdtemp directories as 0700. The source-bearing baker runs
  // through Docker and may be subject to daemon user-namespace remapping, so
  // it must be able to traverse this host directory to read the bind-mounted
  // public release material. No secret is stored in this tree; the only local
  // receipt is still written as 0600 below.
  fs.chmodSync(stagingRoot, 0o755)
  let containerId: string | undefined
  try {
    await imagePuller(releaseImage, dockerPlatform, options.log)
    containerId = checkedRun(
      runner,
      'docker',
      ['create', '--platform', dockerPlatform, releaseImage, '/bin/true'],
      'docker create proof release',
    ).split(/\s+/)[0]
    if (!containerId) throw new Error('docker create did not return a container ID')
    const softwareStaging = path.join(stagingRoot, 'software')
    fs.mkdirSync(softwareStaging)
    checkedRun(
      runner,
      'docker',
      ['cp', `${containerId}:/proof-release/.`, softwareStaging],
      'docker copy proof release',
    )
    checkedRun(runner, 'docker', ['rm', '-f', containerId], 'docker remove proof release container')
    containerId = undefined

    const softwareManifest = path.join(finalRoot, 'software', PROOF_SOFTWARE_RELEASE_MANIFEST)
    const release = readProofSoftwareRelease(
      path.join(stagingRoot, 'software', PROOF_SOFTWARE_RELEASE_MANIFEST),
    )
    const topologyImage = immutableImage(release.images.topology_compiler)
    const bakerImage = immutableImage(release.images.bridge_artifact_baker)
    await imagePuller(topologyImage, dockerPlatform, options.log)
    options.log?.(`Validating proof software release ${release.release_id}`)
    runReleaseTool(
      runner,
      topologyImage,
      stagingRoot,
      finalRoot,
      protocolContext,
      [
        'validate-software',
        '--manifest',
        softwareManifest,
        '--root',
        path.join(finalRoot, 'software'),
      ],
      dockerPlatform,
    )

    await imagePuller(bakerImage, dockerPlatform, options.log)
    options.log?.('Baking deployment-bound Bridge material on CPU; this can take several minutes')
    containerId = checkedRun(
      runner,
      'docker',
      [
        'create',
        '--platform',
        dockerPlatform,
        ...dockerSecurityArgs(),
        '--mount',
        mountValue(stagingRoot, finalRoot, true),
        '--mount',
        mountValue(protocolContext, protocolContext, true),
        bakerImage,
        'bake-bridge',
        '--protocol-context',
        protocolContext,
        '--software-release',
        softwareManifest,
        '--software-release-root',
        path.join(finalRoot, 'software'),
        '--output',
        '/baker-output/bridge',
      ],
      'docker create dogeos proof Bridge baker',
    ).split(/\s+/)[0]
    if (!containerId) throw new Error('docker create did not return a Bridge baker container ID')
    checkedRun(
      runner,
      'docker',
      ['start', '--attach', containerId],
      'dogeos proof Bridge baker',
    )
    checkedRun(
      runner,
      'docker',
      ['cp', `${containerId}:/baker-output/bridge`, stagingRoot],
      'docker copy Bridge material',
    )
    checkedRun(runner, 'docker', ['rm', '-f', containerId], 'docker remove Bridge baker')
    containerId = undefined

    const lockPath = path.join(finalRoot, PROOF_DEPLOYMENT_RELEASE_LOCK)
    runReleaseTool(
      runner,
      topologyImage,
      stagingRoot,
      finalRoot,
      protocolContext,
      [
        'lock-deployment',
        '--software-manifest',
        softwareManifest,
        '--software-root',
        path.join(finalRoot, 'software'),
        '--bridge-manifest',
        path.join(finalRoot, 'bridge', 'proof-bridge-material-v1.json'),
        '--bridge-root',
        path.join(finalRoot, 'bridge'),
        '--protocol-context',
        protocolContext,
        '--output',
        lockPath,
      ],
      dockerPlatform,
    )
    const stagedLock = readProofDeploymentReleaseLock(
      path.join(stagingRoot, PROOF_DEPLOYMENT_RELEASE_LOCK),
    )
    const receipt: ProofReleaseImportV1 = {
      deployment_lock: lockPath,
      deployment_lock_digest: stagedLock.lock_digest,
      protocol_context: protocolContext,
      protocol_context_sha256: protocolContextSha256,
      release_id: release.release_id,
      release_image: releaseImage,
      schema: PROOF_RELEASE_IMPORT_SCHEMA,
      schema_version: 1,
      software_release_digest: release.release_digest,
    }
    writeReceipt(path.join(stagingRoot, PROOF_RELEASE_IMPORT_RECEIPT), receipt)
    // The lock intentionally records final absolute paths. Validate it through
    // the same final-path container mount before installing the staged tree.
    runReleaseTool(
      runner,
      topologyImage,
      stagingRoot,
      finalRoot,
      protocolContext,
      ['validate-deployment', '--lock', lockPath, '--protocol-context', protocolContext],
      dockerPlatform,
    )
    if (fs.existsSync(finalRoot)) throw new Error(`proof release destination appeared: ${finalRoot}`)
    fs.renameSync(stagingRoot, finalRoot)
    const prepared = readPreparedProofRelease(finalLock)
    if (prepared.lock.lock_digest !== stagedLock.lock_digest) {
      throw new Error('proof deployment lock changed while it was installed')
    }

    return prepared
  } finally {
    if (containerId) runner('docker', ['rm', '-f', containerId])
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, {force: true, recursive: true})
  }
}

function relativeProjectionPath(
  prepared: PreparedProofRelease,
  absolute: string,
  label: string,
): string {
  const candidate = ensureInside(prepared.resourcesRoot, absolute, label)
  return path.relative(prepared.resourcesRoot, candidate).replaceAll(path.sep, '/')
}

function assertProofImageBinding(
  actual: ProofTopologyImageReference,
  expected: ProofTopologyImageReference,
  label: string,
  authority: string,
): void {
  if (actual.repository !== expected.repository || actual.digest !== expected.digest) {
    throw new Error(`${label} does not match the ${authority}`)
  }
}

export function verifyProofTopologyReleaseBinding(
  topology: ProofTopologySpec,
  prepared: PreparedProofRelease,
  deploymentDir = '.',
): void {
  const {projection} = prepared.lock
  const expectedCompiler = projection.images.topology_compiler
  const expectedMockWorker = projection.images.mock_worker
  const expectedProductionWorker = projection.images.production_worker
  assertProofImageBinding(
    topology.compiler.image,
    expectedCompiler,
    'proof_topology.compiler.image',
    'prepared proof release',
  )
  if (!topology.mock || !topology.production) {
    throw new Error('proof_topology must stage both mock and production profiles')
  }

  if (topology.mock.profile !== 'withdrawal_mock_prover' || topology.mock.realScroll) {
    throw new Error(
      'proof_topology.mock must use the release-backed withdrawal_mock_prover profile',
    )
  }

  if (topology.production.profile !== 'real_scroll_withdrawal_full_topology') {
    throw new Error(
      'proof_topology.production must use real_scroll_withdrawal_full_topology',
    )
  }

  assertProofImageBinding(
    topology.mock.workerImage,
    expectedMockWorker,
    'proof_topology.mock.workerImage',
    'prepared proof release',
  )
  assertProofImageBinding(
    topology.production.workerImage,
    expectedProductionWorker,
    'proof_topology.production.workerImage',
    'prepared proof release',
  )
  const real = topology.production.realScroll
  const identityFields: Array<[keyof typeof real, string]> = [
    ['batchProgramCommitmentHashHex', projection.identities.batch.program_commitment_hash],
    ['batchProgramCommitmentHex', projection.identities.batch.program_commitment_le_raw],
    ['batchVerificationKeyHashHex', projection.identities.batch.verification_key_hash],
    ['bridgeAppCommitRawHex', projection.identities.bridge.app_commit_raw],
    ['bridgeProgramCommitmentHashHex', projection.identities.bridge.program_commitment_hash],
    ['bridgeVerificationKeyHashHex', projection.identities.bridge.verification_key_hash],
    ['chunkProgramCommitmentHashHex', projection.identities.chunk.program_commitment_hash],
    ['chunkProgramCommitmentHex', projection.identities.chunk.program_commitment_le_raw],
    ['chunkVerificationKeyHashHex', projection.identities.chunk.verification_key_hash],
    ['l2RangeAggregationAppCommitRawHex', projection.identities.l2_range.app_commit_raw],
    [
      'l2RangeAggregationProgramCommitmentHashHex',
      projection.identities.l2_range.program_commitment_hash,
    ],
    [
      'l2RangeAggregationVerificationKeyHashHex',
      projection.identities.l2_range.verification_key_hash,
    ],
  ]
  for (const [field, expected] of identityFields) {
    if (real[field] !== expected) {
      throw new Error(`proof_topology.production.realScroll.${field} does not match release lock`)
    }
  }

  const expectedPaths: Array<[keyof typeof real, string]> = [
    ['aggVerifyingKeyPath', projection.aggregate_verification_key],
    ['batchAppConfig', projection.batch_openvm_config],
    ['batchAppExe', projection.batch_app_vmexe],
    ['batchMaterializerBinaryPath', projection.batch_materializer],
    ['chunkAppConfig', projection.chunk_openvm_config],
    ['chunkAppExe', projection.chunk_app_vmexe],
    ['chunkMaterializerBinaryPath', projection.chunk_materializer],
  ]
  for (const [field, absolute] of expectedPaths) {
    const expected = relativeProjectionPath(prepared, absolute, String(field))
    if (real[field] !== expected) throw new Error(`proof_topology.production.realScroll.${field} does not match release lock`)
  }

  const configuredRoot = path.resolve(deploymentDir, real.resourcesRoot)
  if (configuredRoot !== prepared.resourcesRoot) {
    throw new Error('proof_topology production resourcesRoot does not match prepared release root')
  }

  const expectedBridgeAppExe = relativeProjectionPath(
    prepared,
    projection.bridge_app_vmexe,
    'bridge_app_vmexe',
  )
  const expectedBridgeAppConfig = relativeProjectionPath(
    prepared,
    projection.bridge_openvm_config,
    'bridge_openvm_config',
  )
  if (topology.deployment?.bridgeStagedAppExe !== expectedBridgeAppExe) {
    throw new Error('proof_topology.deployment.bridgeStagedAppExe does not match release lock')
  }

  if (topology.deployment.bridgeStagedAppConfig !== expectedBridgeAppConfig) {
    throw new Error('proof_topology.deployment.bridgeStagedAppConfig does not match release lock')
  }
}

export function verifyMockProofTopologySoftwareBinding(
  topology: ProofTopologySpec,
  prepared: PreparedProofSoftwareRelease,
): void {
  if (topology.mode === 'production' || topology.production) {
    throw new Error(
      'a software-only proof release cannot authorize production; '
      + 'run setup proof-release-init --scope production first',
    )
  }

  assertProofImageBinding(
    topology.compiler.image,
    prepared.release.images.topology_compiler,
    'proof_topology.compiler.image',
    'prepared proof software release',
  )
  if (!topology.mock) throw new Error('proof_topology.mock must be staged')
  if (topology.mock.profile !== 'withdrawal_mock_prover' || topology.mock.realScroll) {
    throw new Error(
      'software-only proof_topology.mock must use withdrawal_mock_prover without realScroll',
    )
  }

  assertProofImageBinding(
    topology.mock.workerImage,
    prepared.release.images.mock_worker,
    'proof_topology.mock.workerImage',
    'prepared proof software release',
  )
}
