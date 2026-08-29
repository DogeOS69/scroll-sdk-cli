import Docker from 'dockerode'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  PreparedProofProductionInputs,
  ProofBridgeMaterialV1,
  ProofProductionInputsReceiptV1,
  ProofReleaseFileV1,
  ProofSoftwareReleaseV1,
} from '../types/proof-release.js'
import type {ProofTopologyImageReference, ProofTopologySpec} from '../types/proof-topology.js'

import {
  PROOF_BRIDGE_MATERIAL_SCHEMA,
  PROOF_PRODUCTION_INPUTS_SCHEMA,
  PROOF_SOFTWARE_RELEASE_SCHEMA,
} from '../types/proof-release.js'

export const DEFAULT_PROOF_PRODUCTION_ROOT = '.data/proof-production'
export const PROOF_SOFTWARE_RELEASE_MANIFEST = 'proof-software-release-v1.json'
export const PROOF_BRIDGE_MATERIAL_MANIFEST = 'proof-bridge-material-v1.json'
export const PROOF_PRODUCTION_INPUTS_RECEIPT = 'scrollsdk-proof-production-inputs-v1.json'

const SHA256_DIGEST = /^sha256:[\da-f]{64}$/
const PINNED_IMAGE = /^(\S+)@(sha256:[\da-f]{64})$/
const HEX_32 = /^0x[\da-f]{64}$/
const HEX_64 = /^0x[\da-f]{128}$/

export interface PrepareProofProductionInputsOptions {
  /** Existing Bridge manifest skips the CPU bake; intended for import/testing. */
  bridgeManifestPath?: string
  deploymentDir?: string
  dockerPlatform?: string
  log?: (message: string) => void
  outputRoot?: string
  protocolContextPath: string
  softwareManifestPath: string
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

function readJson(filePath: string, label: string): unknown {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) {
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

function assertImage(value: unknown, label: string): ProofTopologyImageReference {
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

function assertIdentity(value: unknown, label: string, kind: 'batch' | 'openvm' | 'scroll'): void {
  const raw = mapping(value, label)
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
      throw new Error(`${label}.${field} must be canonical lowercase 32-byte hex`)
    }
  }

  const rawField = kind === 'openvm' ? 'app_commit_raw' : 'program_commitment_le_raw'
  if (!HEX_64.test(requiredString(raw[rawField], `${label}.${rawField}`))) {
    throw new Error(`${label}.${rawField} must be canonical lowercase 64-byte hex`)
  }

  if (
    kind === 'batch'
    && !HEX_64.test(requiredString(raw.recursive_app_commit_raw, `${label}.recursive_app_commit_raw`))
  ) {
    throw new Error(`${label}.recursive_app_commit_raw must be canonical lowercase 64-byte hex`)
  }
}

function releaseFile(value: unknown, label: string): ProofReleaseFileV1 {
  const raw = mapping(value, label)
  assertKnownKeys(raw, ['path', 'sha256', 'size_bytes'], label)
  const sizeBytes = Number(raw.size_bytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`${label}.size_bytes must be a positive safe integer`)
  }

  return {
    path: requiredString(raw.path, `${label}.path`),
    sha256: digest(raw.sha256, `${label}.sha256`),
    size_bytes: sizeBytes,
  }
}

function sha256File(filePath: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`
}

function resolveReleaseFile(root: string, file: ProofReleaseFileV1, label: string): string {
  if (path.isAbsolute(file.path)) throw new Error(`${label}.path must be relative`)
  const normalized = path.posix.normalize(file.path.replaceAll('\\', '/'))
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== file.path.replaceAll('\\', '/')
  ) {
    throw new Error(`${label}.path must be a normalized relative path`)
  }

  const resolved = path.resolve(root, ...normalized.split('/'))
  const inside = path.relative(root, resolved)
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`${label}.path escapes its material root`)
  }

  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${resolved}`)
  }

  if (stat.size !== file.size_bytes) throw new Error(`${label}.size_bytes does not match ${resolved}`)
  if (sha256File(resolved) !== file.sha256) throw new Error(`${label}.sha256 does not match ${resolved}`)
  return resolved
}

export function readProofSoftwareRelease(
  manifestPath: string,
  root = path.dirname(path.resolve(manifestPath)),
): ProofSoftwareReleaseV1 {
  const label = path.resolve(manifestPath)
  const raw = mapping(readJson(label, 'proof software release'), label)
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
    label,
  )
  if (raw.schema !== PROOF_SOFTWARE_RELEASE_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${label}: unsupported proof software release schema`)
  }

  requiredString(raw.release_id, `${label}.release_id`)
  digest(raw.release_digest, `${label}.release_digest`)
  const images = mapping(raw.images, `${label}.images`)
  assertKnownKeys(
    images,
    ['bridge_artifact_baker', 'mock_worker', 'production_worker', 'topology_compiler'],
    `${label}.images`,
  )
  for (const key of Object.keys(images)) assertImage(images[key], `${label}.images.${key}`)
  const identities = mapping(raw.identities, `${label}.identities`)
  assertKnownKeys(
    identities,
    ['aggregate_verification_key_hash', 'batch', 'chunk', 'l2_range'],
    `${label}.identities`,
  )
  if (!HEX_32.test(requiredString(
    identities.aggregate_verification_key_hash,
    `${label}.identities.aggregate_verification_key_hash`,
  ))) throw new Error(`${label}.identities.aggregate_verification_key_hash is invalid`)
  assertIdentity(identities.chunk, `${label}.identities.chunk`, 'scroll')
  assertIdentity(identities.batch, `${label}.identities.batch`, 'batch')
  assertIdentity(identities.l2_range, `${label}.identities.l2_range`, 'openvm')
  const materials = mapping(raw.materials, `${label}.materials`)
  const materialNames = [
    'aggregate_verification_key',
    'batch_app_vmexe',
    'batch_materializer',
    'batch_openvm_config',
    'chunk_app_vmexe',
    'chunk_materializer',
    'chunk_openvm_config',
    'l2_range_app_vmexe',
    'l2_range_openvm_config',
  ]
  assertKnownKeys(materials, materialNames, `${label}.materials`)
  for (const name of materialNames) {
    resolveReleaseFile(root, releaseFile(materials[name], `${label}.materials.${name}`), `materials.${name}`)
  }

  return raw as unknown as ProofSoftwareReleaseV1
}

export function readProofBridgeMaterial(
  manifestPath: string,
  root = path.dirname(path.resolve(manifestPath)),
): ProofBridgeMaterialV1 {
  const label = path.resolve(manifestPath)
  const raw = mapping(readJson(label, 'proof Bridge material'), label)
  assertKnownKeys(
    raw,
    [
      'bridge_material_digest',
      'files',
      'genesis_sequencer_outpoint_index',
      'genesis_state_hash',
      'identities',
      'openvm_version',
      'protocol_context_sha256',
      'root_verifier_asm_sha256',
      'schema',
      'schema_version',
      'software_release_digest',
    ],
    label,
  )
  if (raw.schema !== PROOF_BRIDGE_MATERIAL_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${label}: unsupported proof Bridge material schema`)
  }

  for (const field of [
    'bridge_material_digest',
    'protocol_context_sha256',
    'software_release_digest',
  ]) digest(raw[field], `${label}.${field}`)
  const files = mapping(raw.files, `${label}.files`)
  const fileNames = [
    'bridge_app_vmexe',
    'bridge_openvm_config',
    'l2_range_app_vmexe',
    'l2_range_openvm_config',
    'native_staged_manifest',
  ]
  assertKnownKeys(files, fileNames, `${label}.files`)
  for (const name of fileNames) {
    resolveReleaseFile(root, releaseFile(files[name], `${label}.files.${name}`), `files.${name}`)
  }

  const identities = mapping(raw.identities, `${label}.identities`)
  assertKnownKeys(identities, ['bridge', 'l2_range'], `${label}.identities`)
  assertIdentity(identities.bridge, `${label}.identities.bridge`, 'openvm')
  assertIdentity(identities.l2_range, `${label}.identities.l2_range`, 'openvm')
  return raw as unknown as ProofBridgeMaterialV1
}

function assertTreeHasNoSymlinks(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const candidate = path.join(directory, entry.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) throw new Error(`proof material tree contains a symlink: ${candidate}`)
      if (stat.isDirectory()) visit(candidate)
      else if (!stat.isFile()) throw new Error(`proof material tree contains a non-regular entry: ${candidate}`)
    }
  }

  visit(root)
}

export function immutableProofImageReference(
  image: ProofTopologyImageReference,
  label = 'proof image',
): string {
  const parsed = assertImage(image, label)
  return `${parsed.repository}@${parsed.digest}`
}

export function parseImmutableProofImageReference(
  value: string,
  label = 'proof image',
): ProofTopologyImageReference {
  const match = PINNED_IMAGE.exec(value.trim())
  if (!match) throw new Error(`${label} must match repository@sha256:<64 lowercase hex>`)
  return assertImage({digest: match[2], repository: match[1]}, label)
}

async function ensureDockerImage(
  docker: Docker,
  imageReference: string,
  platform: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    const local = await docker.getImage(imageReference).inspect()
    if (`${local.Os}/${local.Architecture}` === platform) {
      log?.(`Docker image already present for ${platform}: ${imageReference}`)
      return
    }
  } catch (error) {
    const status = error && typeof error === 'object' && 'statusCode' in error
      ? Number(error.statusCode)
      : undefined
    if (status !== 404) throw error
  }

  log?.(`Pulling Bridge baker image for ${platform}: ${imageReference}`)
  const stream = await docker.pull(imageReference, {platform})
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, error => error ? reject(error) : resolve())
  })
}

async function runBridgeBaker(
  imageReference: string,
  softwareRoot: string,
  protocolContext: string,
  outputParent: string,
  scratch: string,
  platform: string,
  log?: (message: string) => void,
): Promise<void> {
  const docker = new Docker()
  const hostUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? `${process.getuid()}:${process.getgid()}`
    : undefined
  try {
    await ensureDockerImage(docker, imageReference, platform, log)
    const container = await docker.createContainer({
      Cmd: [
        'bake-bridge',
        '--protocol-context',
        '/input/protocol_context.json',
        '--software-release',
        `/software/${PROOF_SOFTWARE_RELEASE_MANIFEST}`,
        '--software-release-root',
        '/software',
        '--output',
        '/output/bridge',
      ],
      HostConfig: {
        Binds: [
          `${softwareRoot}:/software:ro`,
          `${protocolContext}:/input/protocol_context.json:ro`,
          `${outputParent}:/output`,
          `${scratch}:/tmp`,
        ],
        CapDrop: ['ALL'],
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges'],
      },
      Image: imageReference,
      User: hostUser,
      platform,
    })
    try {
      await container.start()
      const result = await container.wait()
      const logs = await container.logs({stderr: true, stdout: true})
      const detail = Buffer.isBuffer(logs) ? logs.toString('utf8').trim() : ''
      if (result.StatusCode !== 0) {
        throw new Error(
          `dogeos-proof-artifact-baker exited with status ${result.StatusCode}`
          + (detail ? `: ${detail}` : ''),
        )
      }

      if (detail) log?.(detail.replaceAll(/\r?\n/g, ' | '))
    } finally {
      try {
        await container.remove({force: true})
      } catch (error) {
        const status = error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode)
          : undefined
        if (status !== 404) {
          log?.(
            `Warning: failed to remove completed Bridge baker container: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  } finally {
    const modem = docker.modem as unknown as {agent?: {destroy?: () => void}}
    modem.agent?.destroy?.()
  }
}

function relativeInside(root: string, candidate: string, label: string): string {
  const relative = path.relative(root, path.resolve(candidate))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${root}`)
  }

  return (relative || '.').replaceAll(path.sep, '/')
}

function writeReceipt(filePath: string, receipt: ProofProductionInputsReceiptV1): void {
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, undefined, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

export function readPreparedProofProductionInputs(
  receiptOrRoot: string,
): PreparedProofProductionInputs {
  const candidate = path.resolve(receiptOrRoot)
  const receiptPath = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, PROOF_PRODUCTION_INPUTS_RECEIPT)
    : candidate
  const raw = mapping(readJson(receiptPath, 'prepared proof production input receipt'), receiptPath)
  assertKnownKeys(
    raw,
    [
      'bridge_material_digest',
      'bridge_material_manifest',
      'bridge_material_root',
      'protocol_context',
      'protocol_context_sha256',
      'release_id',
      'resources_root',
      'schema',
      'schema_version',
      'software_release_digest',
      'software_release_manifest',
      'software_release_root',
    ],
    receiptPath,
  )
  if (raw.schema !== PROOF_PRODUCTION_INPUTS_SCHEMA || raw.schema_version !== 1) {
    throw new Error(`${receiptPath}: unsupported proof production input receipt schema`)
  }

  const receipt = raw as unknown as ProofProductionInputsReceiptV1
  const resourcesRoot = path.resolve(requiredString(receipt.resources_root, 'resources_root'))
  const softwareRoot = path.resolve(requiredString(receipt.software_release_root, 'software_release_root'))
  const bridgeRoot = path.resolve(requiredString(receipt.bridge_material_root, 'bridge_material_root'))
  const softwareManifestPath = path.resolve(
    requiredString(receipt.software_release_manifest, 'software_release_manifest'),
  )
  const bridgeManifestPath = path.resolve(
    requiredString(receipt.bridge_material_manifest, 'bridge_material_manifest'),
  )
  const protocolContextPath = path.resolve(requiredString(receipt.protocol_context, 'protocol_context'))
  for (const [label, value] of [
    ['software_release_root', softwareRoot],
    ['bridge_material_root', bridgeRoot],
    ['software_release_manifest', softwareManifestPath],
    ['bridge_material_manifest', bridgeManifestPath],
  ]) relativeInside(resourcesRoot, value, label)
  if (sha256File(protocolContextPath) !== receipt.protocol_context_sha256) {
    throw new Error(`protocol context changed after production proof preparation: ${protocolContextPath}`)
  }

  const release = readProofSoftwareRelease(softwareManifestPath, softwareRoot)
  const bridge = readProofBridgeMaterial(bridgeManifestPath, bridgeRoot)
  if (
    receipt.release_id !== release.release_id
    || receipt.software_release_digest !== release.release_digest
    || receipt.bridge_material_digest !== bridge.bridge_material_digest
    || bridge.software_release_digest !== release.release_digest
    || bridge.protocol_context_sha256 !== receipt.protocol_context_sha256
  ) {
    throw new Error(`${receiptPath}: production proof input bindings are inconsistent`)
  }

  return {
    bridge,
    bridgeManifestPath,
    bridgeRoot,
    protocolContextPath,
    receipt,
    receiptPath,
    release,
    resourcesRoot,
    softwareManifestPath,
    softwareRoot,
  }
}

export function discoverPreparedProofProductionInputs(
  deploymentDir = '.',
  explicit?: string,
): string | undefined {
  if (explicit) return path.resolve(deploymentDir, explicit)
  const candidate = path.resolve(
    deploymentDir,
    DEFAULT_PROOF_PRODUCTION_ROOT,
    PROOF_PRODUCTION_INPUTS_RECEIPT,
  )
  return fs.existsSync(candidate) ? candidate : undefined
}

export async function prepareProofProductionInputs(
  options: PrepareProofProductionInputsOptions,
): Promise<PreparedProofProductionInputs> {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  const finalRoot = path.resolve(deploymentDir, options.outputRoot || DEFAULT_PROOF_PRODUCTION_ROOT)
  const existingReceipt = path.join(finalRoot, PROOF_PRODUCTION_INPUTS_RECEIPT)
  if (fs.existsSync(finalRoot)) {
    if (!fs.existsSync(existingReceipt)) {
      throw new Error(`proof production output already exists without a receipt: ${finalRoot}`)
    }

    const prepared = readPreparedProofProductionInputs(existingReceipt)
    const requestedSoftwareManifest = path.resolve(deploymentDir, options.softwareManifestPath)
    const requestedSoftware = readProofSoftwareRelease(
      requestedSoftwareManifest,
      path.dirname(requestedSoftwareManifest),
    )
    const requestedProtocolContext = path.resolve(deploymentDir, options.protocolContextPath)
    if (!fs.existsSync(requestedProtocolContext)) {
      throw new Error(`protocol_context.json not found: ${requestedProtocolContext}`)
    }

    const requestedProtocolContextDigest = sha256File(requestedProtocolContext)
    if (
      requestedSoftware.release_digest !== prepared.release.release_digest
      || requestedProtocolContextDigest !== prepared.receipt.protocol_context_sha256
    ) {
      throw new Error(
        `prepared production proof inputs at ${finalRoot} do not match the requested `
        + 'software release and protocol context; choose another --output-root',
      )
    }

    if (options.bridgeManifestPath) {
      const requestedBridgeManifest = path.resolve(deploymentDir, options.bridgeManifestPath)
      const requestedBridge = readProofBridgeMaterial(
        requestedBridgeManifest,
        path.dirname(requestedBridgeManifest),
      )
      if (requestedBridge.bridge_material_digest !== prepared.bridge.bridge_material_digest) {
        throw new Error(
          `prepared production proof inputs at ${finalRoot} do not match the requested `
          + 'Bridge material; choose another --output-root',
        )
      }
    }

    options.log?.(`Reusing prepared production proof inputs ${prepared.release.release_id}`)
    return prepared
  }

  const sourceManifest = path.resolve(deploymentDir, options.softwareManifestPath)
  const sourceRoot = path.dirname(sourceManifest)
  assertTreeHasNoSymlinks(sourceRoot)
  const sourceRelease = readProofSoftwareRelease(sourceManifest, sourceRoot)
  const protocolContext = path.resolve(deploymentDir, options.protocolContextPath)
  if (
    !fs.existsSync(protocolContext)
    || !fs.lstatSync(protocolContext).isFile()
    || fs.lstatSync(protocolContext).isSymbolicLink()
  ) {
    throw new Error(`protocol_context.json not found: ${protocolContext}`)
  }

  const parent = path.dirname(finalRoot)
  fs.mkdirSync(parent, {recursive: true})
  const stagingRoot = fs.mkdtempSync(path.join(parent, '.proof-production-'))
  fs.chmodSync(stagingRoot, 0o700)
  try {
    const softwareRoot = path.join(stagingRoot, 'software')
    fs.cpSync(sourceRoot, softwareRoot, {errorOnExist: true, force: false, recursive: true})
    const copiedSoftwareManifest = path.join(softwareRoot, path.basename(sourceManifest))
    const softwareManifest = path.join(softwareRoot, PROOF_SOFTWARE_RELEASE_MANIFEST)
    if (copiedSoftwareManifest !== softwareManifest) {
      if (fs.existsSync(softwareManifest)) {
        throw new Error(
          `software release contains a conflicting ${PROOF_SOFTWARE_RELEASE_MANIFEST}`,
        )
      }

      fs.renameSync(copiedSoftwareManifest, softwareManifest)
    }

    const release = readProofSoftwareRelease(softwareManifest, softwareRoot)
    if (release.release_digest !== sourceRelease.release_digest) {
      throw new Error('proof software release changed while it was copied')
    }

    const bridgeRoot = path.join(stagingRoot, 'bridge')
    if (options.bridgeManifestPath) {
      const sourceBridgeManifest = path.resolve(deploymentDir, options.bridgeManifestPath)
      const sourceBridgeRoot = path.dirname(sourceBridgeManifest)
      assertTreeHasNoSymlinks(sourceBridgeRoot)
      fs.cpSync(sourceBridgeRoot, bridgeRoot, {errorOnExist: true, force: false, recursive: true})
      const copiedBridgeManifest = path.join(bridgeRoot, path.basename(sourceBridgeManifest))
      const normalizedBridgeManifest = path.join(bridgeRoot, PROOF_BRIDGE_MATERIAL_MANIFEST)
      if (copiedBridgeManifest !== normalizedBridgeManifest) {
        if (fs.existsSync(normalizedBridgeManifest)) {
          throw new Error(
            `Bridge material contains a conflicting ${PROOF_BRIDGE_MATERIAL_MANIFEST}`,
          )
        }

        fs.renameSync(copiedBridgeManifest, normalizedBridgeManifest)
      }
    } else {
      const outputParent = path.join(stagingRoot, 'baker-output')
      const scratch = path.join(stagingRoot, 'baker-scratch')
      fs.mkdirSync(outputParent)
      fs.mkdirSync(scratch)
      await runBridgeBaker(
        immutableProofImageReference(release.images.bridge_artifact_baker, 'Bridge baker image'),
        softwareRoot,
        protocolContext,
        outputParent,
        scratch,
        options.dockerPlatform || 'linux/amd64',
        options.log,
      )
      fs.renameSync(path.join(outputParent, 'bridge'), bridgeRoot)
      fs.rmSync(outputParent, {recursive: true})
      fs.rmSync(scratch, {recursive: true})
    }

    const bridgeManifest = path.join(bridgeRoot, PROOF_BRIDGE_MATERIAL_MANIFEST)
    const bridge = readProofBridgeMaterial(bridgeManifest, bridgeRoot)
    const protocolContextDigest = sha256File(protocolContext)
    if (
      bridge.software_release_digest !== release.release_digest
      || bridge.protocol_context_sha256 !== protocolContextDigest
    ) {
      throw new Error('Bridge material does not bind the selected software release and protocol context')
    }

    const receipt: ProofProductionInputsReceiptV1 = {
      bridge_material_digest: bridge.bridge_material_digest,
      bridge_material_manifest: bridgeManifest,
      bridge_material_root: bridgeRoot,
      protocol_context: protocolContext,
      protocol_context_sha256: protocolContextDigest,
      release_id: release.release_id,
      resources_root: stagingRoot,
      schema: PROOF_PRODUCTION_INPUTS_SCHEMA,
      schema_version: 1,
      software_release_digest: release.release_digest,
      software_release_manifest: softwareManifest,
      software_release_root: softwareRoot,
    }
    const stagedReceipt = path.join(stagingRoot, PROOF_PRODUCTION_INPUTS_RECEIPT)
    writeReceipt(stagedReceipt, receipt)
    fs.renameSync(stagingRoot, finalRoot)

    // Rewrite staging absolute paths after the atomic directory rename.
    const finalReceipt: ProofProductionInputsReceiptV1 = {
      ...receipt,
      bridge_material_manifest: path.join(finalRoot, 'bridge', PROOF_BRIDGE_MATERIAL_MANIFEST),
      bridge_material_root: path.join(finalRoot, 'bridge'),
      resources_root: finalRoot,
      software_release_manifest: path.join(finalRoot, 'software', PROOF_SOFTWARE_RELEASE_MANIFEST),
      software_release_root: path.join(finalRoot, 'software'),
    }
    fs.writeFileSync(
      path.join(finalRoot, PROOF_PRODUCTION_INPUTS_RECEIPT),
      `${JSON.stringify(finalReceipt, undefined, 2)}\n`,
      {encoding: 'utf8', mode: 0o600},
    )
    return readPreparedProofProductionInputs(finalRoot)
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, {force: true, recursive: true})
    throw error
  }
}

export function productionReleaseForTopology(
  prepared: PreparedProofProductionInputs,
  deploymentDir = '.',
): NonNullable<ProofTopologySpec['production']>['release'] {
  const root = path.resolve(deploymentDir)
  const resourcesRoot = relativeInside(root, prepared.resourcesRoot, 'proof resources root')
  return {
    bridgeManifest: relativeInside(prepared.resourcesRoot, prepared.bridgeManifestPath, 'Bridge manifest'),
    bridgeMaterialDigest: prepared.bridge.bridge_material_digest,
    bridgeRoot: relativeInside(prepared.resourcesRoot, prepared.bridgeRoot, 'Bridge root'),
    resourcesRoot,
    softwareManifest: relativeInside(
      prepared.resourcesRoot,
      prepared.softwareManifestPath,
      'software manifest',
    ),
    softwareReleaseDigest: prepared.release.release_digest,
    softwareRoot: relativeInside(prepared.resourcesRoot, prepared.softwareRoot, 'software root'),
  }
}

export function verifyProductionReleaseBinding(
  topology: ProofTopologySpec,
  deploymentDir = '.',
): PreparedProofProductionInputs | undefined {
  const binding = topology.production?.release
  if (!binding) return undefined
  const resourcesRoot = path.resolve(deploymentDir, binding.resourcesRoot)
  const receipt = readPreparedProofProductionInputs(resourcesRoot)
  const expected = productionReleaseForTopology(receipt, deploymentDir)
  if (
    binding.bridgeManifest !== expected.bridgeManifest
    || binding.bridgeMaterialDigest !== expected.bridgeMaterialDigest
    || binding.bridgeRoot !== expected.bridgeRoot
    || binding.resourcesRoot !== expected.resourcesRoot
    || binding.softwareManifest !== expected.softwareManifest
    || binding.softwareReleaseDigest !== expected.softwareReleaseDigest
    || binding.softwareRoot !== expected.softwareRoot
  ) {
    throw new Error('proof_topology.production.release does not match the prepared two-manifest inputs')
  }

  if (
    topology.compiler.image.repository !== receipt.release.images.topology_compiler.repository
    || topology.compiler.image.digest !== receipt.release.images.topology_compiler.digest
  ) {
    throw new Error(
      'production software release compiler image does not match proof_topology.compiler.image',
    )
  }

  return receipt
}
