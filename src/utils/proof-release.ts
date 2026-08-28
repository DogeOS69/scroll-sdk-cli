import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {
  ProofReleaseFileReference,
  ProofReleaseRealScrollFiles,
  ProofReleaseRealScrollIdentities,
  ProofReleaseV1,
} from '../types/proof-release.js'
import type {
  ProofTopologyImageReference,
  ProofTopologyRealScrollConfig,
  ProofTopologySpec,
} from '../types/proof-topology.js'

import {PROOF_RELEASE_SCHEMA} from '../types/proof-release.js'

export const DEFAULT_PROOF_RELEASE_FILES = [
  '.data/proof-release-v1.json',
  'proof-release-v1.json',
  'proof-artifacts/proof-release-v1.json',
] as const

const MOCK_PROFILES = [
  'cheap_scroll_chunk',
  'withdrawal_mock_prover',
  'withdrawal_mock_prover_real_materialize',
] as const
const PRODUCTION_PROFILES = [
  'real_scroll_prover',
  'real_scroll_withdrawal',
  'real_scroll_withdrawal_full_topology',
] as const

function sha256File(filePath: string, prefix = false): string {
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

  const value = hash.digest('hex')
  return prefix ? `sha256:${value}` : value
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (!isMapping(value)) throw new TypeError(`${label} must be a JSON object`)
  return value
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

  return value.trim()
}

function canonicalSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label)
  if (!/^sha256:[\da-f]{64}$/.test(digest)) {
    throw new Error(`${label} must match sha256:[0-9a-f]{64}`)
  }

  return digest
}

function canonicalHex(value: unknown, bytes: number, label: string): string {
  const hex = requiredString(value, label)
  if (!new RegExp(`^0x[\\da-f]{${bytes * 2}}$`).test(hex)) {
    throw new Error(`${label} must be 0x-prefixed lowercase hex encoding ${bytes} bytes`)
  }

  return hex
}

function image(value: unknown, label: string): ProofTopologyImageReference {
  const raw = mapping(value, label)
  assertKnownKeys(raw, ['digest', 'repository'], label)
  return {
    digest: canonicalSha256(raw.digest, `${label}.digest`),
    repository: requiredString(raw.repository, `${label}.repository`),
  }
}

function relativePath(value: unknown, label: string): string {
  const input = requiredString(value, label).replaceAll('\\', '/')
  if (path.posix.isAbsolute(input)) throw new Error(`${label} must be release-relative`)
  const normalized = path.posix.normalize(input)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} must remain inside the proof release directory`)
  }

  return normalized
}

function file(value: unknown, label: string): ProofReleaseFileReference {
  const raw = mapping(value, label)
  assertKnownKeys(raw, ['path', 'sha256'], label)
  return {
    path: relativePath(raw.path, `${label}.path`),
    sha256: canonicalSha256(raw.sha256, `${label}.sha256`),
  }
}

function files(value: unknown, label: string): ProofReleaseRealScrollFiles {
  const raw = mapping(value, label)
  const keys = [
    'aggVerifyingKey',
    'batchAppConfig',
    'batchAppExe',
    'batchMaterializerBinary',
    'bridgeAppConfig',
    'bridgeAppExe',
    'chunkAppConfig',
    'chunkAppExe',
    'chunkMaterializerBinary',
    'l2RangeAggregationAppConfig',
    'l2RangeAggregationAppExe',
  ] as const
  assertKnownKeys(raw, keys, label)
  const parsed = Object.fromEntries(
    keys.map(key => [key, file(raw[key], `${label}.${key}`)]),
  )
  const bridgeDirectory = path.posix.dirname(parsed.bridgeAppExe.path)
  if (path.posix.dirname(parsed.bridgeAppConfig.path) !== bridgeDirectory) {
    throw new Error(`${label}.bridgeAppExe and ${label}.bridgeAppConfig must share a directory`)
  }

  const expectedL2Exe = path.posix.join(bridgeDirectory, 'batch-aggregation.vmexe')
  const expectedL2Config = path.posix.join(bridgeDirectory, 'batch-aggregation-openvm.toml')
  if (parsed.l2RangeAggregationAppExe.path !== expectedL2Exe) {
    throw new Error(
      `${label}.l2RangeAggregationAppExe.path must be ${expectedL2Exe} because the `
      + 'dogeos-core Worker contract derives it from bridgeAppExe',
    )
  }

  if (parsed.l2RangeAggregationAppConfig.path !== expectedL2Config) {
    throw new Error(
      `${label}.l2RangeAggregationAppConfig.path must be ${expectedL2Config} because the `
      + 'dogeos-core Worker contract derives it from bridgeAppExe',
    )
  }

  return parsed as unknown as ProofReleaseRealScrollFiles
}

function identities(value: unknown, label: string): ProofReleaseRealScrollIdentities {
  const raw = mapping(value, label)
  const hashFields = [
    'batchProgramCommitmentHashHex',
    'batchVerificationKeyHashHex',
    'bridgeProgramCommitmentHashHex',
    'bridgeVerificationKeyHashHex',
    'chunkProgramCommitmentHashHex',
    'chunkVerificationKeyHashHex',
    'l2RangeAggregationProgramCommitmentHashHex',
    'l2RangeAggregationVerificationKeyHashHex',
  ] as const
  const rawCommitmentFields = [
    'batchProgramCommitmentHex',
    'bridgeAppCommitRawHex',
    'chunkProgramCommitmentHex',
    'l2RangeAggregationAppCommitRawHex',
  ] as const
  assertKnownKeys(raw, [...hashFields, ...rawCommitmentFields], label)
  const parsed: Record<string, string> = {}
  for (const field of hashFields) parsed[field] = canonicalHex(raw[field], 32, `${label}.${field}`)
  for (const field of rawCommitmentFields) {
    parsed[field] = canonicalHex(raw[field], 64, `${label}.${field}`)
  }

  if (
    parsed.l2RangeAggregationVerificationKeyHashHex
    !== parsed.bridgeVerificationKeyHashHex
  ) {
    throw new Error(
      `${label}.l2RangeAggregationVerificationKeyHashHex must equal `
      + `${label}.bridgeVerificationKeyHashHex`,
    )
  }

  const rawL2Commitment = Buffer.from(
    parsed.l2RangeAggregationAppCommitRawHex.slice(2),
    'hex',
  )
  const derivedL2Hash = `0x${createHash('sha256').update(rawL2Commitment).digest('hex')}`
  if (parsed.l2RangeAggregationProgramCommitmentHashHex !== derivedL2Hash) {
    throw new Error(
      `${label}.l2RangeAggregationProgramCommitmentHashHex does not match the SHA-256 `
      + `of ${label}.l2RangeAggregationAppCommitRawHex`,
    )
  }

  return parsed as unknown as ProofReleaseRealScrollIdentities
}

export function validateProofRelease(rawValue: unknown, label: string): ProofReleaseV1 {
  const raw = mapping(rawValue, label)
  assertKnownKeys(
    raw,
    ['compilerImage', 'profiles', 'realScroll', 'releaseId', 'schema', 'workerImages'],
    label,
  )
  if (raw.schema !== PROOF_RELEASE_SCHEMA) {
    throw new Error(`${label}.schema must be ${PROOF_RELEASE_SCHEMA}`)
  }

  const profiles = mapping(raw.profiles, `${label}.profiles`)
  assertKnownKeys(profiles, ['mock', 'production'], `${label}.profiles`)
  const mockProfile = requiredString(profiles.mock, `${label}.profiles.mock`)
  const productionProfile = requiredString(profiles.production, `${label}.profiles.production`)
  if (!(MOCK_PROFILES as readonly string[]).includes(mockProfile)) {
    throw new Error(`${label}.profiles.mock is not a supported mock profile`)
  }

  if (!(PRODUCTION_PROFILES as readonly string[]).includes(productionProfile)) {
    throw new Error(`${label}.profiles.production is not a supported production profile`)
  }

  const workers = mapping(raw.workerImages, `${label}.workerImages`)
  assertKnownKeys(workers, ['mock', 'production'], `${label}.workerImages`)
  const realScroll = mapping(raw.realScroll, `${label}.realScroll`)
  assertKnownKeys(realScroll, ['defaults', 'files', 'identities'], `${label}.realScroll`)
  const defaults = mapping(realScroll.defaults, `${label}.realScroll.defaults`)
  assertKnownKeys(
    defaults,
    [
      'batchBackendProfile',
      'batchProverRequirements',
      'chunkBackendProfile',
      'chunkProverRequirements',
    ],
    `${label}.realScroll.defaults`,
  )

  return {
    compilerImage: image(raw.compilerImage, `${label}.compilerImage`),
    profiles: {
      mock: mockProfile as ProofReleaseV1['profiles']['mock'],
      production: productionProfile as ProofReleaseV1['profiles']['production'],
    },
    realScroll: {
      defaults: {
        batchBackendProfile: requiredString(
          defaults.batchBackendProfile,
          `${label}.realScroll.defaults.batchBackendProfile`,
        ),
        ...(defaults.batchProverRequirements === undefined
          ? {}
          : {
              batchProverRequirements: requiredString(
                defaults.batchProverRequirements,
                `${label}.realScroll.defaults.batchProverRequirements`,
              ),
            }),
        chunkBackendProfile: requiredString(
          defaults.chunkBackendProfile,
          `${label}.realScroll.defaults.chunkBackendProfile`,
        ),
        ...(defaults.chunkProverRequirements === undefined
          ? {}
          : {
              chunkProverRequirements: requiredString(
                defaults.chunkProverRequirements,
                `${label}.realScroll.defaults.chunkProverRequirements`,
              ),
            }),
      },
      files: files(realScroll.files, `${label}.realScroll.files`),
      identities: identities(realScroll.identities, `${label}.realScroll.identities`),
    },
    releaseId: requiredString(raw.releaseId, `${label}.releaseId`),
    schema: PROOF_RELEASE_SCHEMA,
    workerImages: {
      mock: image(workers.mock, `${label}.workerImages.mock`),
      production: image(workers.production, `${label}.workerImages.production`),
    },
  }
}

export function readProofRelease(filePath: string): ProofReleaseV1 {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new Error(`proof release manifest not found: ${resolved}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  } catch (error) {
    throw new Error(
      `${resolved}: failed to parse proof release manifest: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return validateProofRelease(parsed, resolved)
}

export function proofReleaseManifestSha256(filePath: string): string {
  return sha256File(path.resolve(filePath))
}

export function discoverProofRelease(
  deploymentDir = '.',
  explicitPath?: string,
): string | undefined {
  if (explicitPath) return path.resolve(deploymentDir, explicitPath)
  const found = DEFAULT_PROOF_RELEASE_FILES
    .map(candidate => path.resolve(deploymentDir, candidate))
    .filter(candidate => fs.existsSync(candidate))
  if (found.length > 1) {
    throw new Error(
      `multiple conventional proof release manifests found: ${found.join(', ')}; `
      + 'pass --proof-release explicitly',
    )
  }

  return found[0]
}

function releaseFiles(release: ProofReleaseV1): ProofReleaseFileReference[] {
  return Object.values(release.realScroll.files)
}

export function verifyProofReleaseMaterials(
  release: ProofReleaseV1,
  resourcesRoot: string,
): void {
  const root = path.resolve(resourcesRoot)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`proof release resources directory not found: ${root}`)
  }

  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`proof release resources directory must not be a symlink: ${root}`)
  }

  const physicalRoot = fs.realpathSync(root)

  for (const reference of releaseFiles(release)) {
    const candidate = path.resolve(root, reference.path)
    const inside = path.relative(root, candidate)
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error(`proof release material escapes resources root: ${reference.path}`)
    }

    if (!fs.existsSync(candidate)) throw new Error(`proof release material not found: ${candidate}`)
    const stat = fs.lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`proof release material must be a regular non-symlink file: ${candidate}`)
    }

    const physicalCandidate = fs.realpathSync(candidate)
    const physicalInside = path.relative(physicalRoot, physicalCandidate)
    if (
      physicalInside === '..'
      || physicalInside.startsWith(`..${path.sep}`)
      || path.isAbsolute(physicalInside)
    ) {
      throw new Error(`proof release material resolves outside resources root: ${candidate}`)
    }

    const actual = sha256File(candidate, true)
    if (actual !== reference.sha256) {
      throw new Error(
        `proof release material digest mismatch for ${candidate}: `
        + `expected ${reference.sha256}, got ${actual}`,
      )
    }
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} does not match the pinned proof release: expected ${String(expected)}, `
      + `got ${String(actual)}`,
    )
  }
}

function assertRealScrollRelease(
  actual: ProofTopologyRealScrollConfig | undefined,
  release: ProofReleaseV1,
  label: string,
): void {
  if (!actual) throw new Error(`${label} is required by the pinned proof release`)
  const {defaults, files: releaseFiles, identities: releaseIdentities} = release.realScroll
  const paths: Array<[keyof ProofTopologyRealScrollConfig, string]> = [
    ['aggVerifyingKeyPath', releaseFiles.aggVerifyingKey.path],
    ['batchAppConfig', releaseFiles.batchAppConfig.path],
    ['batchAppExe', releaseFiles.batchAppExe.path],
    ['batchMaterializerBinaryPath', releaseFiles.batchMaterializerBinary.path],
    ['chunkAppConfig', releaseFiles.chunkAppConfig.path],
    ['chunkAppExe', releaseFiles.chunkAppExe.path],
    ['chunkMaterializerBinaryPath', releaseFiles.chunkMaterializerBinary.path],
  ]
  for (const [field, expected] of paths) {
    assertEqual(actual[field], expected, `${label}.${field}`)
  }

  for (const [field, expected] of Object.entries(releaseIdentities)) {
    assertEqual(
      actual[field as keyof ProofTopologyRealScrollConfig],
      expected,
      `${label}.${field}`,
    )
  }

  assertEqual(actual.batchBackendProfile, defaults.batchBackendProfile, `${label}.batchBackendProfile`)
  assertEqual(actual.chunkBackendProfile, defaults.chunkBackendProfile, `${label}.chunkBackendProfile`)
  assertEqual(
    actual.batchProverRequirements,
    defaults.batchProverRequirements,
    `${label}.batchProverRequirements`,
  )
  assertEqual(
    actual.chunkProverRequirements,
    defaults.chunkProverRequirements,
    `${label}.chunkProverRequirements`,
  )
}

export function verifyProofTopologyReleaseBinding(
  topology: ProofTopologySpec,
  release: ProofReleaseV1,
  deploymentDir = '.',
): void {
  assertEqual(
    topology.compiler.image.repository,
    release.compilerImage.repository,
    'proof_topology.compiler.image.repository',
  )
  assertEqual(
    topology.compiler.image.digest,
    release.compilerImage.digest,
    'proof_topology.compiler.image.digest',
  )
  if (!topology.mock || !topology.production) {
    throw new Error('proof_topology must stage both mock and production release profiles')
  }

  assertEqual(topology.mock.profile, release.profiles.mock, 'proof_topology.mock.profile')
  assertEqual(
    topology.mock.workerImage.repository,
    release.workerImages.mock.repository,
    'proof_topology.mock.workerImage.repository',
  )
  assertEqual(
    topology.mock.workerImage.digest,
    release.workerImages.mock.digest,
    'proof_topology.mock.workerImage.digest',
  )
  assertEqual(
    topology.production.profile,
    release.profiles.production,
    'proof_topology.production.profile',
  )
  assertEqual(
    topology.production.workerImage.repository,
    release.workerImages.production.repository,
    'proof_topology.production.workerImage.repository',
  )
  assertEqual(
    topology.production.workerImage.digest,
    release.workerImages.production.digest,
    'proof_topology.production.workerImage.digest',
  )
  assertEqual(
    topology.deployment?.bridgeStagedAppExe,
    release.realScroll.files.bridgeAppExe.path,
    'proof_topology.deployment.bridgeStagedAppExe',
  )
  assertEqual(
    topology.deployment?.bridgeStagedAppConfig,
    release.realScroll.files.bridgeAppConfig.path,
    'proof_topology.deployment.bridgeStagedAppConfig',
  )
  assertRealScrollRelease(
    topology.production.realScroll,
    release,
    'proof_topology.production.realScroll',
  )
  if (release.profiles.mock === 'withdrawal_mock_prover_real_materialize') {
    assertRealScrollRelease(topology.mock.realScroll, release, 'proof_topology.mock.realScroll')
  }

  const resourcesRoot = path.resolve(
    deploymentDir,
    topology.production.realScroll.resourcesRoot,
  )
  verifyProofReleaseMaterials(release, resourcesRoot)
}
