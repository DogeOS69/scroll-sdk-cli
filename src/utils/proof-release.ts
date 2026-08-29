import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  PreparedProofRelease,
  ProofDeploymentReleaseLockV1,
  ProofReleaseImportV1,
  ProofSoftwareReleaseV1,
} from '../types/proof-release.js'
import type {ProofTopologyImageReference, ProofTopologySpec} from '../types/proof-topology.js'

import {
  PROOF_DEPLOYMENT_RELEASE_LOCK_SCHEMA,
  PROOF_RELEASE_IMPORT_SCHEMA,
  PROOF_SOFTWARE_RELEASE_SCHEMA,
} from '../types/proof-release.js'

export const DEFAULT_PROOF_RELEASES_ROOT = '.data/proof-releases'
export const PROOF_SOFTWARE_RELEASE_MANIFEST = 'proof-software-release-v1.json'
export const PROOF_DEPLOYMENT_RELEASE_LOCK = 'proof-deployment-release-lock-v1.json'
export const PROOF_RELEASE_IMPORT_RECEIPT = 'scrollsdk-proof-release-import-v1.json'

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
  log?: (message: string) => void
  protocolContext?: string
  releaseImage: string
  releasesRoot?: string
}

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
  protocolContext: string,
  commandArgs: string[],
): void {
  checkedRun(
    runner,
    'docker',
    [
      'run',
      '--rm',
      ...dockerSecurityArgs(),
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '--mount',
      mountValue(rootSource, rootDestination),
      '--mount',
      mountValue(protocolContext, protocolContext, true),
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
  )
}

function writeReceipt(filePath: string, receipt: ProofReleaseImportV1): void {
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, undefined, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

export function prepareProofRelease(options: PrepareProofReleaseOptions): PreparedProofRelease {
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
  if (fs.existsSync(finalRoot)) {
    const prepared = readPreparedProofRelease(finalLock)
    if (prepared.receipt.release_image !== releaseImage) {
      throw new Error(`${finalRoot} was prepared from a different immutable release image`)
    }

    options.log?.(`Revalidating prepared proof release ${prepared.release.release_id}`)
    validatePreparedProofRelease(prepared, runner)
    return prepared
  }

  fs.mkdirSync(releasesRoot, {recursive: true})
  const stagingRoot = fs.mkdtempSync(path.join(releasesRoot, `.${key}.preparing-`))
  let containerId: string | undefined
  try {
    options.log?.(`Pulling immutable proof software release ${releaseImage}`)
    checkedRun(runner, 'docker', ['pull', releaseImage], 'docker pull proof release')
    containerId = checkedRun(
      runner,
      'docker',
      ['create', releaseImage, '/bin/true'],
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
    )

    options.log?.('Baking deployment-bound Bridge material on CPU; this can take several minutes')
    checkedRun(
      runner,
      'docker',
      [
        'run',
        '--rm',
        ...dockerSecurityArgs(),
        '--user',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '--mount',
        mountValue(stagingRoot, finalRoot),
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
        path.join(finalRoot, 'bridge'),
      ],
      'dogeos proof Bridge baker',
    )

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

export function verifyProofTopologyReleaseBinding(
  topology: ProofTopologySpec,
  prepared: PreparedProofRelease,
  deploymentDir = '.',
): void {
  const {projection} = prepared.lock
  const expectedCompiler = projection.images.topology_compiler
  const expectedMockWorker = projection.images.mock_worker
  const expectedProductionWorker = projection.images.production_worker
  const equalImage = (
    actual: ProofTopologyImageReference,
    expected: ProofTopologyImageReference,
    label: string,
  ) => {
    if (actual.repository !== expected.repository || actual.digest !== expected.digest) {
      throw new Error(`${label} does not match the prepared proof release`)
    }
  }

  equalImage(topology.compiler.image, expectedCompiler, 'proof_topology.compiler.image')
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

  equalImage(topology.mock.workerImage, expectedMockWorker, 'proof_topology.mock.workerImage')
  equalImage(
    topology.production.workerImage,
    expectedProductionWorker,
    'proof_topology.production.workerImage',
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
