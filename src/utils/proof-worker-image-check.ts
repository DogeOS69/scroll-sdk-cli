import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {ProofTopologyImageReference} from '../types/proof-topology.js'
import type {ProofWorkerImageCheckV1} from '../types/proof-worker-image-check.js'

import {PROOF_WORKER_IMAGE_CHECK_SCHEMA} from '../types/proof-worker-image-check.js'
import {immutableProofImage} from './proof-materials.js'

export const DEFAULT_PROOF_WORKER_IMAGE_CHECK = '.data/proof-worker-image-check-v1.json'

const CORE_REVISION = /^[\da-f]{40}$/
const HEX64 = /^0x[\da-f]{128}$/
const SHA256 = /^sha256:[\da-f]{64}$/

export type ProofWorkerImageDockerRunner = (args: string[]) => string

export interface CheckProofWorkerImageOptions {
  expectedBatchAggregationProgramCommitmentRaw: string
  expectedBatchProgramCommitmentRaw: string
  expectedCoreRevision: string
  image: ProofTopologyImageReference
  output: string
  run?: ProofWorkerImageDockerRunner
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 600_000})
  if (result.error) throw new Error(`Docker Worker image check failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Docker Worker image check failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function exact(value: unknown, expected: string, label: string): void {
  const actual = requiredString(value, label)
  if (actual !== expected) throw new Error(`${label} ${actual} does not match expected ${expected}`)
}

function architectures(value: unknown, label: string): string[] {
  const raw = requiredString(value, label)
  const result = raw.split(',')
  if (result.some(item => !/^\d{2,3}$/.test(item)) || new Set(result).size !== result.length) {
    throw new Error(`${label} must be a unique comma-separated CUDA compute-capability list`)
  }

  return result
}

function assertNewOutput(output: string): string {
  const resolved = path.resolve(output)
  if (fs.existsSync(resolved)) throw new Error(`Refusing to overwrite Worker image check receipt: ${resolved}`)
  return resolved
}

export function checkProofWorkerImage(options: CheckProofWorkerImageOptions): {
  receipt: ProofWorkerImageCheckV1
  receiptPath: string
} {
  if (!CORE_REVISION.test(options.expectedCoreRevision)) throw new Error('expectedCoreRevision must be a full lowercase Git SHA')
  if (!HEX64.test(options.expectedBatchProgramCommitmentRaw)) throw new Error('expected Batch program commitment must be canonical lowercase 64-byte hex')
  if (!HEX64.test(options.expectedBatchAggregationProgramCommitmentRaw)) throw new Error('expected Batch aggregation program commitment must be canonical lowercase 64-byte hex')
  const reference = immutableProofImage(options.image)
  const run = options.run ?? docker
  run(['pull', reference])
  let labels: Record<string, unknown>
  try {
    labels = mapping(JSON.parse(run(['image', 'inspect', reference, '--format', '{{json .Config.Labels}}'])) as unknown, 'Worker image labels')
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Docker returned malformed Worker image label JSON')
    throw error
  }

  exact(labels['org.opencontainers.image.title'], 'prover-worker-cuda', 'Worker image title')
  exact(labels['org.opencontainers.image.revision'], options.expectedCoreRevision, 'Worker image revision')
  exact(labels['dogeos.component'], 'proving', 'Worker image component')
  exact(labels['dogeos.service'], 'prover-worker-cuda', 'Worker image service')
  exact(
    labels['dogeos.batch.program-commitment.raw'],
    options.expectedBatchProgramCommitmentRaw,
    'Worker image Batch commitment',
  )
  exact(
    labels['dogeos.batch-aggregation.program-commitment.raw'],
    options.expectedBatchAggregationProgramCommitmentRaw,
    'Worker image Batch aggregation commitment',
  )
  const cudaArchitectures = architectures(labels['dogeos.cuda.archs'], 'Worker image CUDA architectures')
  const receipt: ProofWorkerImageCheckV1 = {
    coreRevision: options.expectedCoreRevision,
    cudaArchitectures,
    identities: {
      batchAggregationProgramCommitmentRaw: options.expectedBatchAggregationProgramCommitmentRaw,
      batchProgramCommitmentRaw: options.expectedBatchProgramCommitmentRaw,
    },
    image: options.image,
    inspectedAt: new Date().toISOString(),
    schema: PROOF_WORKER_IMAGE_CHECK_SCHEMA,
    schemaVersion: 1,
  }
  const receiptPath = assertNewOutput(options.output)
  fs.mkdirSync(path.dirname(receiptPath), {recursive: true})
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx', mode: 0o600})
  return {receipt, receiptPath}
}

export function validateProofWorkerImageCheck(raw: unknown, label: string): ProofWorkerImageCheckV1 {
  const root = mapping(raw, label)
  if (root.schema !== PROOF_WORKER_IMAGE_CHECK_SCHEMA || root.schemaVersion !== 1) throw new Error(`${label} uses an unsupported schema`)
  const coreRevision = requiredString(root.coreRevision, `${label}.coreRevision`)
  if (!CORE_REVISION.test(coreRevision)) throw new Error(`${label}.coreRevision must be a full lowercase Git SHA`)
  const image = mapping(root.image, `${label}.image`)
  const parsedImage = {
    digest: requiredString(image.digest, `${label}.image.digest`),
    repository: requiredString(image.repository, `${label}.image.repository`),
  }
  if (!SHA256.test(parsedImage.digest)) throw new Error(`${label}.image.digest must be an immutable sha256 digest`)
  immutableProofImage(parsedImage)
  const identities = mapping(root.identities, `${label}.identities`)
  const batchProgramCommitmentRaw = requiredString(
    identities.batchProgramCommitmentRaw,
    `${label}.identities.batchProgramCommitmentRaw`,
  )
  const batchAggregationProgramCommitmentRaw = requiredString(
    identities.batchAggregationProgramCommitmentRaw,
    `${label}.identities.batchAggregationProgramCommitmentRaw`,
  )
  if (!HEX64.test(batchProgramCommitmentRaw) || !HEX64.test(batchAggregationProgramCommitmentRaw)) {
    throw new Error(`${label} contains a non-canonical compiled commitment`)
  }

  if (!Array.isArray(root.cudaArchitectures)) throw new Error(`${label}.cudaArchitectures must be an array`)
  const cudaArchitectures = architectures(root.cudaArchitectures.join(','), `${label}.cudaArchitectures`)
  return {
    coreRevision,
    cudaArchitectures,
    identities: {batchAggregationProgramCommitmentRaw, batchProgramCommitmentRaw},
    image: parsedImage,
    inspectedAt: requiredString(root.inspectedAt, `${label}.inspectedAt`),
    schema: PROOF_WORKER_IMAGE_CHECK_SCHEMA,
    schemaVersion: 1,
  }
}

export function readProofWorkerImageCheck(file: string): ProofWorkerImageCheckV1 {
  const resolved = path.resolve(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Could not read Worker image check receipt ${resolved}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return validateProofWorkerImageCheck(parsed, resolved)
}
