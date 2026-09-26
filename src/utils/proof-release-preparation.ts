import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type {
  ProofReleasePreparationFileV1,
  ProofReleasePreparationV1,
} from '../types/proof-release-preparation.js'

import {PROOF_RELEASE_PREPARATION_SCHEMA} from '../types/proof-release-preparation.js'
import {parseProofIdentityEnv} from './proof-materials.js'

export const DEFAULT_PROOF_RELEASE_PREPARATION_RECEIPT = '.data/proof-release-preparation-v1.json'

const SHA256 = /^[\da-f]{64}$/
const CORE_REVISION = /^[\da-f]{40}$/

export interface CaptureProofReleasePreparationOptions {
  artifactRoot: string
  batchMaterializer?: string
  chunkMaterializer?: string
  expectedCoreRevision: string
  identityEnv?: string
  output: string
  producerManifest?: string
  protocolContext?: string
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`)
  return Number(value)
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function regularFile(file: string, label: string): string {
  const resolved = path.resolve(file)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(resolved)
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`)
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`${label} must be a nonempty regular, non-symlink file: ${resolved}`)
  }

  return resolved
}

function fingerprint(file: string, label: string): ProofReleasePreparationFileV1 {
  const resolved = regularFile(file, label)
  return {path: resolved, sha256: sha256(resolved), sizeBytes: fs.statSync(resolved).size}
}

function preparationFile(value: unknown, label: string): ProofReleasePreparationFileV1 {
  const object = mapping(value, label)
  const file = {
    path: requiredString(object.path, `${label}.path`),
    sha256: requiredString(object.sha256, `${label}.sha256`),
    sizeBytes: requiredSize(object.sizeBytes, `${label}.sizeBytes`),
  }
  if (!SHA256.test(file.sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`)
  const actual = fingerprint(file.path, label)
  if (actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) {
    throw new Error(`${label} content drift: ${file.path}`)
  }

  return {...file, path: actual.path}
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Could not parse ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function producerCoreRevision(file: string): string {
  const manifest = mapping(readJson(file, 'real-proving producer manifest'), 'real-proving producer manifest')
  const revision = requiredString(manifest.dogeos_core_commit, 'real-proving producer manifest.dogeos_core_commit')
  if (!CORE_REVISION.test(revision)) throw new Error('real-proving producer manifest.dogeos_core_commit must be a full lowercase Git SHA')
  return revision
}

function assertNewOutput(output: string): string {
  const resolved = path.resolve(output)
  if (fs.existsSync(resolved)) throw new Error(`Refusing to overwrite proof preparation receipt: ${resolved}`)
  let ancestor = path.dirname(resolved)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const realAncestor = fs.realpathSync(ancestor)
  if (!fs.statSync(realAncestor).isDirectory()) throw new Error(`Receipt parent is not a directory: ${realAncestor}`)
  return resolved
}

export function captureProofReleasePreparation(
  options: CaptureProofReleasePreparationOptions,
): {receipt: ProofReleasePreparationV1; receiptPath: string} {
  if (!CORE_REVISION.test(options.expectedCoreRevision)) {
    throw new Error('expectedCoreRevision must be the full lowercase dogeos-core Git SHA')
  }

  const root = path.resolve(options.artifactRoot)
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(root)
  } catch {
    throw new Error(`Artifact root does not exist: ${root}`)
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Artifact root must be a non-symlink directory: ${root}`)
  }

  const identityEnv = regularFile(options.identityEnv ?? path.join(root, 'identity-full.env'), 'Full identity env')
  parseProofIdentityEnv(fs.readFileSync(identityEnv, 'utf8'))
  const producerManifest = regularFile(
    options.producerManifest ?? path.join(root, 'real-proving-artifacts.json'),
    'Real-proving producer manifest',
  )
  const actualRevision = producerCoreRevision(producerManifest)
  if (actualRevision !== options.expectedCoreRevision) {
    throw new Error(`Producer manifest core revision ${actualRevision} does not match expected ${options.expectedCoreRevision}`)
  }

  const bridge = path.join(root, 'bridge')
  const receipt: ProofReleasePreparationV1 = {
    coreRevision: options.expectedCoreRevision,
    files: {
      batchMaterializer: fingerprint(
        options.batchMaterializer ?? path.join(root, 'bin/scroll-runtime-materializer'),
        'Batch materializer',
      ),
      bridge: {
        appConfig: fingerprint(path.join(bridge, 'openvm.toml'), 'Bridge OpenVM config'),
        appExe: fingerprint(path.join(bridge, 'bridge-state.vmexe'), 'Bridge app vmexe'),
        l2RangeAppConfig: fingerprint(path.join(bridge, 'batch-aggregation-openvm.toml'), 'L2-range OpenVM config'),
        l2RangeAppExe: fingerprint(path.join(bridge, 'batch-aggregation.vmexe'), 'L2-range app vmexe'),
        nativeManifest: fingerprint(path.join(bridge, 'bridge-artifact-manifest.json'), 'Bridge artifact manifest'),
        workerIdentityBundle: fingerprint(path.join(bridge, 'worker-identity-bundle.json'), 'Worker identity bundle'),
      },
      chunkMaterializer: fingerprint(
        options.chunkMaterializer ?? path.join(root, 'bin/materialize-chunk-oneshot'),
        'Chunk materializer',
      ),
      identityEnv: fingerprint(identityEnv, 'Full identity env'),
      producerManifest: fingerprint(producerManifest, 'Real-proving producer manifest'),
      protocolContext: fingerprint(
        options.protocolContext ?? path.join(root, 'protocol_context.json'),
        'Deployment protocol context',
      ),
    },
    generatedAt: new Date().toISOString(),
    schema: PROOF_RELEASE_PREPARATION_SCHEMA,
    schemaVersion: 1,
  }

  // Read it through the strict parser before persisting the handoff.
  validateProofReleasePreparation(receipt, 'new proof preparation receipt')
  const receiptPath = assertNewOutput(options.output)
  fs.mkdirSync(path.dirname(receiptPath), {recursive: true})
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx', mode: 0o600})
  return {receipt, receiptPath}
}

export function validateProofReleasePreparation(raw: unknown, label: string): ProofReleasePreparationV1 {
  const root = mapping(raw, label)
  if (root.schema !== PROOF_RELEASE_PREPARATION_SCHEMA || root.schemaVersion !== 1) {
    throw new Error(`${label} uses an unsupported schema`)
  }

  const coreRevision = requiredString(root.coreRevision, `${label}.coreRevision`)
  if (!CORE_REVISION.test(coreRevision)) throw new Error(`${label}.coreRevision must be a full lowercase Git SHA`)
  const files = mapping(root.files, `${label}.files`)
  const bridge = mapping(files.bridge, `${label}.files.bridge`)
  const receipt: ProofReleasePreparationV1 = {
    coreRevision,
    files: {
      batchMaterializer: preparationFile(files.batchMaterializer, `${label}.files.batchMaterializer`),
      bridge: {
        appConfig: preparationFile(bridge.appConfig, `${label}.files.bridge.appConfig`),
        appExe: preparationFile(bridge.appExe, `${label}.files.bridge.appExe`),
        l2RangeAppConfig: preparationFile(bridge.l2RangeAppConfig, `${label}.files.bridge.l2RangeAppConfig`),
        l2RangeAppExe: preparationFile(bridge.l2RangeAppExe, `${label}.files.bridge.l2RangeAppExe`),
        nativeManifest: preparationFile(bridge.nativeManifest, `${label}.files.bridge.nativeManifest`),
        workerIdentityBundle: preparationFile(bridge.workerIdentityBundle, `${label}.files.bridge.workerIdentityBundle`),
      },
      chunkMaterializer: preparationFile(files.chunkMaterializer, `${label}.files.chunkMaterializer`),
      identityEnv: preparationFile(files.identityEnv, `${label}.files.identityEnv`),
      producerManifest: preparationFile(files.producerManifest, `${label}.files.producerManifest`),
      protocolContext: preparationFile(files.protocolContext, `${label}.files.protocolContext`),
    },
    generatedAt: requiredString(root.generatedAt, `${label}.generatedAt`),
    schema: PROOF_RELEASE_PREPARATION_SCHEMA,
    schemaVersion: 1,
  }
  parseProofIdentityEnv(fs.readFileSync(receipt.files.identityEnv.path, 'utf8'))
  const manifestRevision = producerCoreRevision(receipt.files.producerManifest.path)
  if (manifestRevision !== receipt.coreRevision) {
    throw new Error(`${label} producer manifest revision does not match coreRevision`)
  }

  return receipt
}

export function readProofReleasePreparation(file: string): ProofReleasePreparationV1 {
  const resolved = path.resolve(file)
  return validateProofReleasePreparation(readJson(resolved, 'proof preparation receipt'), resolved)
}
