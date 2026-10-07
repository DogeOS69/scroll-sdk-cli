import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {parseImmutableProofImage} from './proof-materials.js'

export const PROOF_RELEASE_SCHEMA = 'dogeos/proof-release/v1'
/**
 * dogeos-core proof-release.yml pins these five images by digest, keyed by image name. Mock proofs
 * are produced inside proof-coordinator; mock generation takes its compiler identity from the bake.
 */
export const PROOF_RELEASE_IMAGE_NAMES = [
  'proof-preparation-producer',
  'prover-worker-cuda',
  'proof-coordinator',
  'dogeos-proof-topology',
  'proof-bundle-publisher',
] as const
export type ProofReleaseImageName = typeof PROOF_RELEASE_IMAGE_NAMES[number]
/** The publisher's fixed 11-file mapping (`dogeos.proof-bundle.mapping=v1-11-files`). */
export const PROOF_PUBLICATION_FILES = [
  ['DOGEOS_CHUNK_VMEXE', 'chunk/app.vmexe'],
  ['DOGEOS_CHUNK_CONFIG', 'chunk/openvm.toml'],
  ['DOGEOS_BATCH_VMEXE', 'batch/app.vmexe'],
  ['DOGEOS_BATCH_CONFIG', 'batch/openvm.toml'],
  ['DOGEOS_BRIDGE_VMEXE', 'bridge/bridge-state.vmexe'],
  ['DOGEOS_BRIDGE_CONFIG', 'bridge/openvm.toml'],
  ['DOGEOS_BRIDGE_MANIFEST', 'bridge/bridge-artifact-manifest.json'],
  ['DOGEOS_AGGREGATION_VMEXE', 'bridge/batch-aggregation.vmexe'],
  ['DOGEOS_AGGREGATION_CONFIG', 'bridge/batch-aggregation-openvm.toml'],
  ['DOGEOS_TAG5_MANIFEST', 'bridge/l2-range-aggregation-topology-program.json'],
  ['DOGEOS_PROTOCOL_CONTEXT', 'protocol_context.json'],
] as const

export interface ProofSoftwareRelease {
  /** repository@sha256 references; each image's revision label equals `revision`. */
  images: Record<ProofReleaseImageName, string>
  revision: string
  schema: typeof PROOF_RELEASE_SCHEMA
}

export function proofFileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Reject links in every existing path component, including parent directories. */
export function proofRegularFile(file: string, maxBytes = Number.MAX_SAFE_INTEGER): string {
  const resolved = path.resolve(file)
  let current = resolved
  while (current !== path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Proof input path contains a symlink: ${file}`)
    current = path.dirname(current)
  }

  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error(`Invalid proof input file: ${file}`)
  return resolved
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`${label} has missing or unknown fields`)
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || (pattern && !pattern.test(value))) throw new Error(`Invalid ${label}`)
  return value
}

export function validateProofSoftwareRelease(value: unknown): ProofSoftwareRelease {
  const root = object(value, 'proof release')
  exactKeys(root, ['schema', 'revision', 'images'], 'proof release')
  if (root.schema !== PROOF_RELEASE_SCHEMA) throw new Error('Unsupported proof release schema')
  text(root.revision, 'core revision', /^[\da-f]{40}$/)
  const images = object(root.images, 'images')
  exactKeys(images, PROOF_RELEASE_IMAGE_NAMES, 'images')
  for (const name of PROOF_RELEASE_IMAGE_NAMES) parseImmutableProofImage(text(images[name], `${name} reference`), name)
  return root as unknown as ProofSoftwareRelease
}

export function readProofSoftwareRelease(file: string, expectedSha256: string): {manifest: ProofSoftwareRelease; path: string; sha256: string} {
  const resolved = proofRegularFile(file, 4 * 1024 * 1024)
  const expected = expectedSha256.replace(/^sha256:/, '')
  if (!/^[\da-f]{64}$/.test(expected) || proofFileHash(resolved) !== expected) throw new Error('Proof release manifest digest mismatch')
  return {manifest: validateProofSoftwareRelease(JSON.parse(fs.readFileSync(resolved, 'utf8'))), path: resolved, sha256: expected}
}
