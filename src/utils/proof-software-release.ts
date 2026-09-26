import {createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {parseImmutableProofImage} from './proof-materials.js'

export const PROOF_RELEASE_SCHEMA = 'dogeos/proof-release/v1'
export const PROOF_RELEASE_IMAGE_NAMES = ['producer', 'publisher', 'topologyCompiler', 'mockWorker', 'coordinator', 'productionWorker'] as const
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
const GENERIC_FILES = ['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk']

export interface ProofSoftwareRelease {
  createdAt: string
  cuda: {architectures: string[]}
  genericBundle: {
    files: Record<string, {asset: string; sha256: string; sizeBytes: number; url: string}>
    openvmVersion: string
    rustToolchain: string
    schema: 'dogeos/scroll-program-bundle/v1'
    sourceRepository: string
    sourceRevision: string
    upstreamManifest: {sha256: string; url: string}
  }
  images: Record<typeof PROOF_RELEASE_IMAGE_NAMES[number], {coreRevision: string; reference: string}>
  producer: {contract: 'prepare-real-v1'}
  publisher: {contract: 'v1-11-files'; files: Array<{prefix: string; relativePath: string}>}
  schema: typeof PROOF_RELEASE_SCHEMA
  source: {repository: string; revision: string}
  toolchain: {openvm: string; rust: string; scrollRevision: string}
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

function https(value: unknown, label: string): string {
  const result = text(value, label)
  const url = new URL(result)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error(`${label} must be a credential-free HTTPS URL`)
  return result
}

export function validateProofSoftwareRelease(value: unknown): ProofSoftwareRelease {
  const root = object(value, 'proof release')
  exactKeys(root, ['schema', 'createdAt', 'source', 'toolchain', 'genericBundle', 'images', 'producer', 'publisher', 'cuda'], 'proof release')
  if (root.schema !== PROOF_RELEASE_SCHEMA) throw new Error('Unsupported proof release schema')
  if (!Number.isFinite(Date.parse(text(root.createdAt, 'createdAt')))) throw new Error('Invalid release timestamp')
  const source = object(root.source, 'source')
  exactKeys(source, ['repository', 'revision'], 'source')
  if (source.repository !== 'https://github.com/DogeOS69/dogeos-core') throw new Error('Unexpected proof release source repository')
  const revision = text(source.revision, 'core revision', /^[\da-f]{40}$/)
  const images = object(root.images, 'images')
  exactKeys(images, PROOF_RELEASE_IMAGE_NAMES, 'images')
  for (const name of PROOF_RELEASE_IMAGE_NAMES) {
    const image = object(images[name], name)
    exactKeys(image, ['reference', 'coreRevision'], name)
    parseImmutableProofImage(text(image.reference, `${name} reference`), name)
    if (image.coreRevision !== revision) throw new Error(`${name} core revision differs from release`)
  }

  const producer = object(root.producer, 'producer')
  exactKeys(producer, ['contract'], 'producer')
  if (producer.contract !== 'prepare-real-v1') throw new Error('Release lacks complete prepare-real producer')
  const publisher = object(root.publisher, 'publisher')
  exactKeys(publisher, ['contract', 'files'], 'publisher')
  if (publisher.contract !== 'v1-11-files' || !Array.isArray(publisher.files) || publisher.files.length !== 11) throw new Error('Unsupported publisher contract')
  for (const [index, item] of publisher.files.entries()) {
    const file = object(item, 'publication file')
    exactKeys(file, ['prefix', 'relativePath'], 'publication file')
    const [prefix, relativePath] = PROOF_PUBLICATION_FILES[index]
    if (file.prefix !== prefix || file.relativePath !== relativePath) throw new Error('Release publication file mapping differs from v1-11-files')
  }

  const bundle = object(root.genericBundle, 'genericBundle')
  exactKeys(bundle, ['schema', 'sourceRepository', 'sourceRevision', 'rustToolchain', 'openvmVersion', 'upstreamManifest', 'files'], 'genericBundle')
  if (bundle.schema !== 'dogeos/scroll-program-bundle/v1' || bundle.sourceRepository !== 'https://github.com/DogeOS69/scroll-zkvm-prover') throw new Error('Unsupported generic program provenance')
  text(bundle.sourceRevision, 'Scroll revision', /^[\da-f]{40}$/)
  text(bundle.rustToolchain, 'Rust toolchain', /^nightly-\d{4}-\d{2}-\d{2}$/)
  text(bundle.openvmVersion, 'OpenVM version', /^\d+\.\d+\.\d+$/)
  const upstream = object(bundle.upstreamManifest, 'upstreamManifest')
  exactKeys(upstream, ['url', 'sha256'], 'upstreamManifest')
  https(upstream.url, 'upstream manifest URL')
  text(upstream.sha256, 'upstream manifest digest', /^[\da-f]{64}$/)
  const files = object(bundle.files, 'generic files')
  exactKeys(files, GENERIC_FILES, 'generic files')
  for (const [name, item] of Object.entries(files)) {
    const file = object(item, name)
    exactKeys(file, ['asset', 'url', 'sha256', 'sizeBytes'], name)
    text(file.asset, `${name} asset`, /^[\w.-]+$/)
    https(file.url, `${name} URL`)
    text(file.sha256, `${name} digest`, /^[\da-f]{64}$/)
    if (!Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) <= 0) throw new Error(`Invalid ${name} size`)
  }

  const toolchain = object(root.toolchain, 'toolchain')
  exactKeys(toolchain, ['rust', 'openvm', 'scrollRevision'], 'toolchain')
  if (toolchain.rust !== bundle.rustToolchain || toolchain.openvm !== bundle.openvmVersion || toolchain.scrollRevision !== bundle.sourceRevision) throw new Error('Toolchain differs from program provenance')
  const cuda = object(root.cuda, 'cuda')
  exactKeys(cuda, ['architectures'], 'cuda')
  if (!Array.isArray(cuda.architectures) || cuda.architectures.length === 0 || cuda.architectures.some(item => typeof item !== 'string' || !/^\d{2,3}$/.test(item))) throw new Error('Explicit CUDA architectures required')
  return root as unknown as ProofSoftwareRelease
}

export function readProofSoftwareRelease(file: string, expectedSha256: string): {manifest: ProofSoftwareRelease; path: string; sha256: string} {
  const resolved = proofRegularFile(file, 4 * 1024 * 1024)
  const expected = expectedSha256.replace(/^sha256:/, '')
  if (!/^[\da-f]{64}$/.test(expected) || proofFileHash(resolved) !== expected) throw new Error('Proof release manifest digest mismatch')
  return {manifest: validateProofSoftwareRelease(JSON.parse(fs.readFileSync(resolved, 'utf8'))), path: resolved, sha256: expected}
}
