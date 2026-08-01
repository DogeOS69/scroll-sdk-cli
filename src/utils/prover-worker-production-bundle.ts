import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const PROVER_WORKER_PRODUCTION_BUNDLE_DIR = 'prover-worker-production/docker-compose'
export const PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST = 'bundle-manifest.json'
export const PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST = 'worker-release.json'
export const PROVER_WORKER_PRODUCTION_TOKEN_FILE = 'prover-worker.token'
export const PROVER_WORKER_PRODUCTION_REQUIRED_CAPABILITIES = [
  '--enable-prove-scroll-chunk',
  '--enable-prove-scroll-batch',
  '--enable-prove-advance-l2-aggregation',
  '--enable-prove-bridge-transition',
] as const
export const PROVER_WORKER_PRODUCTION_CONVENTIONAL_PATHS = {
  advanceL2Aggregation: {
    appVmexe: 'bridge/batch-aggregation.vmexe',
    openvmConfig: 'bridge/batch-aggregation-openvm.toml',
  },
  bridgeArtifactManifest: 'bridge/bridge-artifact-manifest.json',
  bridgeGenesisContext: 'bridge/protocol_context.json',
  bridgeTransition: {
    appVmexe: 'bridge/bridge-state.vmexe',
    openvmConfig: 'bridge/openvm.toml',
  },
  scrollBatch: {
    appVmexe: 'batch/app.vmexe',
    openvmConfig: 'batch/openvm.toml',
  },
  scrollChunk: {
    appVmexe: 'chunk/app.vmexe',
    openvmConfig: 'chunk/openvm.toml',
  },
} as const

const IMMUTABLE_PROVER_IMAGE =
  /^dogeos69\/prover-worker-cuda@sha256:[\da-f]{64}$/
const SHA256 = /^[\da-f]{64}$/

export interface ProverWorkerReleaseFileV1 {
  path: string
  sha256: string
}

export interface ProverWorkerReleaseProgramV1 {
  appVmexe: ProverWorkerReleaseFileV1
  openvmConfig: ProverWorkerReleaseFileV1
}

/**
 * Release-owned compatibility contract for a real all-family prover.
 *
 * Deployment operators select a release root; they do not repeat individual
 * guest paths or image versions in DeploymentSpec. The release producer writes
 * this file after building and hashing the compatible image and artifacts.
 */
export interface ProverWorkerReleaseManifestV1 {
  artifacts: {
    advanceL2Aggregation: ProverWorkerReleaseProgramV1
    bridgeArtifactManifest: ProverWorkerReleaseFileV1
    bridgeGenesisContext: ProverWorkerReleaseFileV1
    bridgeTransition: ProverWorkerReleaseProgramV1
    scrollBatch: ProverWorkerReleaseProgramV1
    scrollChunk: ProverWorkerReleaseProgramV1
  }
  image: string
  schemaVersion: 1
}

export interface ProverWorkerProductionBundleManifest {
  bundleId: string
  credentialState: 'pending' | 'ready'
  files: {
    '.env': { sha256: string }
    [PROVER_WORKER_PRODUCTION_TOKEN_FILE]: {
      requiredMode: '0600'
      sensitive: true
    }
    'docker-compose.yml': { sha256: string }
  }
  /** Legacy v1 field. New manifests omit wall-clock data to stay reproducible. */
  generatedAt?: string
  generator: 'scrollsdk setup prep-charts'
  release: {
    files: Array<{
      path: string
      sha256: string
    }>
    manifestPath: string
    manifestSha256: string
  }
  requiredCapabilities: string[]
  schemaVersion: 1
}

export interface ProverWorkerProductionBundleResult {
  bundleDir: string
  bundleId: string
  files: string[]
  manifestFile: string
  releaseManifestFile: string
}

export interface ProverWorkerProductionBundleOptions {
  aggregationL2ChainId: number | string
  artifactReadBaseUrl: string
  coordinatorUrl: string
  dir?: string
  releaseManifestPath?: string
  releaseRoot: string
  workerToken?: string
}

interface VerifiedRelease {
  files: Array<{ path: string; sha256: string }>
  manifest: ProverWorkerReleaseManifestV1
  manifestFile: string
  manifestSha256: string
  releaseRoot: string
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function sha256File(filePath: string): string {
  return sha256(fs.readFileSync(filePath))
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function requirePositiveInteger(value: number | string, label: string): string {
  const normalized = String(value).trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${label} must be a non-zero decimal integer`)
  }

  return normalized
}

function requireHttpUrl(value: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an http(s) URL`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must be an http(s) URL`)
  }

  return value.replace(/\/+$/, '')
}

function releasePrograms(
  manifest: ProverWorkerReleaseManifestV1,
): ProverWorkerReleaseProgramV1[] {
  const programs = [
    manifest.artifacts.scrollChunk,
    manifest.artifacts.scrollBatch,
    manifest.artifacts.advanceL2Aggregation,
    manifest.artifacts.bridgeTransition,
  ]
  if (programs.some(program => !program || typeof program !== 'object')) {
    throw new Error('worker release manifest must define all four proof programs')
  }

  return programs
}

function releaseFiles(
  manifest: ProverWorkerReleaseManifestV1,
): ProverWorkerReleaseFileV1[] {
  return [
    ...releasePrograms(manifest).flatMap(program => [
      program.appVmexe,
      program.openvmConfig,
    ]),
    manifest.artifacts.bridgeArtifactManifest,
    manifest.artifacts.bridgeGenesisContext,
  ]
}

function readReleaseManifest(manifestFile: string): ProverWorkerReleaseManifestV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read production prover-worker release manifest ${manifestFile}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const manifest = parsed as Partial<ProverWorkerReleaseManifestV1>
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.image !== 'string'
    || !manifest.artifacts
  ) {
    throw new Error(`${manifestFile}: unsupported or invalid production worker release manifest`)
  }

  return manifest as ProverWorkerReleaseManifestV1
}

export function verifyProverWorkerRelease(options: {
  manifestPath?: string
  releaseRoot: string
}): VerifiedRelease {
  const releaseRoot = path.resolve(options.releaseRoot)
  const manifestFile = path.resolve(
    options.manifestPath
    || path.join(releaseRoot, PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST),
  )
  const relativeManifest = path.relative(releaseRoot, manifestFile)
  if (relativeManifest.startsWith('..') || path.isAbsolute(relativeManifest)) {
    throw new Error(
      `production prover-worker release manifest must be inside the release root: ${manifestFile}`,
    )
  }

  if (!fs.existsSync(manifestFile)) {
    throw new Error(
      `production prover-worker release manifest not found: ${manifestFile}; `
      + `the proof release producer must publish ${PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST}`,
    )
  }

  const manifest = readReleaseManifest(manifestFile)
  if (!IMMUTABLE_PROVER_IMAGE.test(manifest.image)) {
    throw new Error(
      `${manifestFile}: image must be dogeos69/prover-worker-cuda@sha256:<64 lowercase hex>`,
    )
  }

  const files = releaseFiles(manifest)
  if (files.length !== 10) {
    throw new Error(`${manifestFile}: all four proof programs, bridge manifest, and genesis context are required`)
  }

  const seen = new Set<string>()
  const verifiedFiles = files.map((item, index) => {
    if (
      !item
      || typeof item.path !== 'string'
      || item.path.trim() === ''
      || typeof item.sha256 !== 'string'
      || !SHA256.test(item.sha256)
    ) {
      throw new Error(`${manifestFile}: artifacts[${index}] must contain a relative path and lowercase SHA-256`)
    }

    if (path.isAbsolute(item.path)) {
      throw new Error(`${manifestFile}: artifact path must be relative to the release root: ${item.path}`)
    }

    const resolved = path.resolve(releaseRoot, item.path)
    const relative = path.relative(releaseRoot, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${manifestFile}: artifact path escapes the release root: ${item.path}`)
    }

    const portable = toPortablePath(relative)
    if (seen.has(portable)) {
      throw new Error(`${manifestFile}: duplicate artifact path: ${item.path}`)
    }

    seen.add(portable)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`${manifestFile}: release artifact not found: ${item.path}`)
    }

    const actualSha256 = sha256File(resolved)
    if (actualSha256 !== item.sha256) {
      throw new Error(
        `${manifestFile}: release artifact SHA-256 mismatch for ${item.path}; `
        + `expected ${item.sha256}, got ${actualSha256}`,
      )
    }

    return { path: portable, sha256: actualSha256 }
  })

  return {
    files: verifiedFiles,
    manifest,
    manifestFile,
    manifestSha256: sha256File(manifestFile),
    releaseRoot,
  }
}

/**
 * Create worker-release.json from the dogeos-core conventional artifact
 * layout. This is intended for the release-producing pipeline: the deployment
 * user then selects only the release root.
 */
export function writeProverWorkerReleaseManifest(options: {
  image: string
  releaseRoot: string
}): string {
  const releaseRoot = path.resolve(options.releaseRoot)
  if (!IMMUTABLE_PROVER_IMAGE.test(options.image)) {
    throw new Error(
      'image must be dogeos69/prover-worker-cuda@sha256:<64 lowercase hex>',
    )
  }

  const file = (relative: string): ProverWorkerReleaseFileV1 => {
    const resolved = path.resolve(releaseRoot, relative)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`production prover-worker release artifact not found: ${resolved}`)
    }

    return {path: toPortablePath(relative), sha256: sha256File(resolved)}
  }

  const conventional = PROVER_WORKER_PRODUCTION_CONVENTIONAL_PATHS
  const manifest: ProverWorkerReleaseManifestV1 = {
    artifacts: {
      advanceL2Aggregation: {
        appVmexe: file(conventional.advanceL2Aggregation.appVmexe),
        openvmConfig: file(conventional.advanceL2Aggregation.openvmConfig),
      },
      bridgeArtifactManifest: file(conventional.bridgeArtifactManifest),
      bridgeGenesisContext: file(conventional.bridgeGenesisContext),
      bridgeTransition: {
        appVmexe: file(conventional.bridgeTransition.appVmexe),
        openvmConfig: file(conventional.bridgeTransition.openvmConfig),
      },
      scrollBatch: {
        appVmexe: file(conventional.scrollBatch.appVmexe),
        openvmConfig: file(conventional.scrollBatch.openvmConfig),
      },
      scrollChunk: {
        appVmexe: file(conventional.scrollChunk.appVmexe),
        openvmConfig: file(conventional.scrollChunk.openvmConfig),
      },
    },
    image: options.image,
    schemaVersion: 1,
  }
  fs.mkdirSync(releaseRoot, {recursive: true})
  const manifestFile = path.join(
    releaseRoot,
    PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST,
  )
  const temporary = `${manifestFile}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.renameSync(temporary, manifestFile)
  verifyProverWorkerRelease({releaseRoot})
  return manifestFile
}

function containerArtifactPath(item: ProverWorkerReleaseFileV1): string {
  return `/dogeos/artifacts/${toPortablePath(item.path)}`
}

function composeVariable(expression: string): string {
  return `${String.fromCodePoint(36)}{${expression}}`
}

function composeYaml(release: VerifiedRelease): string {
  const {artifacts} = release.manifest
  const workerArguments = [
    '      - prover-worker',
    '      - --mode',
    '      - real',
    '      - --proof-coordinator-url',
    `      - ${composeVariable('PROOF_COORDINATOR_URL:?missing PROOF_COORDINATOR_URL')}`,
    '      - --artifact-read-base-url',
    `      - ${composeVariable('ARTIFACT_READ_BASE_URL:?missing ARTIFACT_READ_BASE_URL')}`,
    '      - --worker-token-file',
    `      - /run/secrets/${PROVER_WORKER_PRODUCTION_TOKEN_FILE}`,
    '      - --worker-id',
    `      - ${composeVariable('PROVER_WORKER_ID:-prover-worker-0')}`,
    '      - --enable-prove-scroll-chunk',
    '      - --chunk-app-exe',
    `      - ${containerArtifactPath(artifacts.scrollChunk.appVmexe)}`,
    '      - --chunk-app-config',
    `      - ${containerArtifactPath(artifacts.scrollChunk.openvmConfig)}`,
    '      - --enable-prove-scroll-batch',
    '      - --batch-app-exe',
    `      - ${containerArtifactPath(artifacts.scrollBatch.appVmexe)}`,
    '      - --batch-app-config',
    `      - ${containerArtifactPath(artifacts.scrollBatch.openvmConfig)}`,
    '      - --enable-prove-advance-l2-aggregation',
    '      - --aggregation-app-exe',
    `      - ${containerArtifactPath(artifacts.advanceL2Aggregation.appVmexe)}`,
    '      - --aggregation-app-config',
    `      - ${containerArtifactPath(artifacts.advanceL2Aggregation.openvmConfig)}`,
    '      - --aggregation-l2-chain-id',
    `      - ${composeVariable('AGGREGATION_L2_CHAIN_ID:?missing AGGREGATION_L2_CHAIN_ID')}`,
    '      - --enable-prove-bridge-transition',
    '      - --bridge-app-exe',
    `      - ${containerArtifactPath(artifacts.bridgeTransition.appVmexe)}`,
    '      - --bridge-app-config',
    `      - ${containerArtifactPath(artifacts.bridgeTransition.openvmConfig)}`,
  ]
  const common = [
    `    image: ${release.manifest.image}`,
    '    gpus: all',
    '    environment:',
    '      DOGEOS_BRIDGE_GENESIS_CONTEXT_PATH: '
      + containerArtifactPath(artifacts.bridgeGenesisContext),
    '    volumes:',
    `      - "${composeVariable('PROVER_WORKER_RELEASE_ROOT:?missing PROVER_WORKER_RELEASE_ROOT')}:/dogeos/artifacts:ro"`,
    `      - "./${PROVER_WORKER_PRODUCTION_TOKEN_FILE}:/run/secrets/${PROVER_WORKER_PRODUCTION_TOKEN_FILE}:ro"`,
  ]

  return [
    '# Production all-family prover-worker. Generated from worker-release.json.',
    '# The image digest and release artifact hashes are fail-closed by proof-worker-check.',
    'name: prover-worker-production',
    'services:',
    '  preflight:',
    '    profiles: ["tools"]',
    ...common,
    '    command:',
    ...workerArguments,
    '      - --preflight',
    '  prover-worker:',
    '    restart: unless-stopped',
    '    stop_grace_period: 7m',
    ...common,
    '    command:',
    ...workerArguments,
    '',
  ].join('\n')
}

function bundleIdentity(input: {
  composeSha256: string
  envSha256: string
  releaseManifestSha256: string
}): string {
  return sha256(JSON.stringify({
    ...input,
    requiredCapabilities: PROVER_WORKER_PRODUCTION_REQUIRED_CAPABILITIES,
    schemaVersion: 1,
  }))
}

function readBundleEnvironment(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    let value = trimmed.slice(separator + 1)
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value) as string
      } catch {
        // Invalid values are reported by their field validation below.
      }
    }

    result[trimmed.slice(0, separator)] = value
  }

  return result
}

function readBundleManifest(manifestFile: string): ProverWorkerProductionBundleManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read production prover-worker bundle manifest ${manifestFile}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const manifest = parsed as Partial<ProverWorkerProductionBundleManifest>
  if (
    manifest.schemaVersion !== 1
    || typeof manifest.bundleId !== 'string'
    || !manifest.files
    || !manifest.release
  ) {
    throw new Error(`${manifestFile}: unsupported or invalid production prover-worker bundle manifest`)
  }

  return manifest as ProverWorkerProductionBundleManifest
}

function pendingBundleResult(
  bundleDir: string,
  bundleId: string,
  manifestFile: string,
  releaseManifestFile: string,
): ProverWorkerProductionBundleResult {
  return {
    bundleDir,
    bundleId,
    files: [
      path.join(bundleDir, 'docker-compose.yml'),
      path.join(bundleDir, '.env'),
      manifestFile,
    ],
    manifestFile,
    releaseManifestFile,
  }
}

export function writeProverWorkerProductionBundle(
  options: ProverWorkerProductionBundleOptions,
): ProverWorkerProductionBundleResult {
  if (options.workerToken !== undefined && !options.workerToken.trim()) {
    throw new Error('worker token must be a non-empty string')
  }

  const release = verifyProverWorkerRelease({
    manifestPath: options.releaseManifestPath,
    releaseRoot: options.releaseRoot,
  })
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_PRODUCTION_BUNDLE_DIR)
  fs.mkdirSync(bundleDir, {recursive: true})

  const compose = composeYaml(release)
  const composeFile = path.join(bundleDir, 'docker-compose.yml')
  fs.writeFileSync(composeFile, compose)

  const relativeReleaseRoot = toPortablePath(path.relative(bundleDir, release.releaseRoot) || '.')
  const env = [
    '# Generated by `scrollsdk setup prep-charts` from worker-release.json.',
    `PROOF_COORDINATOR_URL=${JSON.stringify(requireHttpUrl(options.coordinatorUrl, 'coordinatorUrl'))}`,
    `ARTIFACT_READ_BASE_URL=${JSON.stringify(requireHttpUrl(options.artifactReadBaseUrl, 'artifactReadBaseUrl'))}`,
    `AGGREGATION_L2_CHAIN_ID=${requirePositiveInteger(options.aggregationL2ChainId, 'aggregationL2ChainId')}`,
    `PROVER_WORKER_RELEASE_ROOT=${JSON.stringify(relativeReleaseRoot)}`,
    '# Override per host without editing this file: PROVER_WORKER_ID=<stable-id> docker compose up -d',
    'PROVER_WORKER_ID=prover-worker-0',
    '',
  ].join('\n')
  const envFile = path.join(bundleDir, '.env')
  fs.writeFileSync(envFile, env)

  const tokenFile = path.join(bundleDir, PROVER_WORKER_PRODUCTION_TOKEN_FILE)
  if (options.workerToken === undefined) {
    fs.rmSync(tokenFile, {force: true})
  } else {
    fs.rmSync(tokenFile, {force: true})
    fs.writeFileSync(tokenFile, `${options.workerToken.trim()}\n`, {mode: 0o600})
  }

  const composeSha256 = sha256(compose)
  const envSha256 = sha256(env)
  const bundleId = bundleIdentity({
    composeSha256,
    envSha256,
    releaseManifestSha256: release.manifestSha256,
  })
  const manifestFile = path.join(bundleDir, PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST)
  const manifest: ProverWorkerProductionBundleManifest = {
    bundleId,
    credentialState: options.workerToken === undefined ? 'pending' : 'ready',
    files: {
      '.env': {sha256: envSha256},
      [PROVER_WORKER_PRODUCTION_TOKEN_FILE]: {
        requiredMode: '0600',
        sensitive: true,
      },
      'docker-compose.yml': {sha256: composeSha256},
    },
    generator: 'scrollsdk setup prep-charts',
    release: {
      files: release.files,
      manifestPath: toPortablePath(path.relative(release.releaseRoot, release.manifestFile)),
      manifestSha256: release.manifestSha256,
    },
    requiredCapabilities: [...PROVER_WORKER_PRODUCTION_REQUIRED_CAPABILITIES],
    schemaVersion: 1,
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  return options.workerToken === undefined
    ? pendingBundleResult(bundleDir, bundleId, manifestFile, release.manifestFile)
    : verifyProverWorkerProductionBundle({dir: bundleDir, expectedBundleId: bundleId})
}

export function verifyProverWorkerProductionBundle(options: {
  dir?: string
  expectedBundleId?: string
  releaseRoot?: string
} = {}): ProverWorkerProductionBundleResult {
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_PRODUCTION_BUNDLE_DIR)
  const composeFile = path.join(bundleDir, 'docker-compose.yml')
  const envFile = path.join(bundleDir, '.env')
  const tokenFile = path.join(bundleDir, PROVER_WORKER_PRODUCTION_TOKEN_FILE)
  const manifestFile = path.join(bundleDir, PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST)
  const manifest = readBundleManifest(manifestFile)
  const compose = fs.readFileSync(composeFile)
  const env = fs.readFileSync(envFile)
  const composeSha256 = sha256(compose)
  const envSha256 = sha256(env)
  if (manifest.files['docker-compose.yml']?.sha256 !== composeSha256) {
    throw new Error(`${composeFile}: SHA-256 does not match ${PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST}`)
  }

  if (manifest.files['.env']?.sha256 !== envSha256) {
    throw new Error(`${envFile}: SHA-256 does not match ${PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST}`)
  }

  if (manifest.credentialState === 'pending') {
    throw new Error(`${manifestFile}: worker credential is pending; run scrollsdk setup proof-worker`)
  }

  const environment = readBundleEnvironment(envFile)
  const releaseRoot = path.resolve(
    options.releaseRoot
    || path.resolve(bundleDir, environment.PROVER_WORKER_RELEASE_ROOT || ''),
  )
  const releaseManifestFile = path.resolve(releaseRoot, manifest.release.manifestPath)
  const release = verifyProverWorkerRelease({
    manifestPath: releaseManifestFile,
    releaseRoot,
  })
  if (release.manifestSha256 !== manifest.release.manifestSha256) {
    throw new Error(`${releaseManifestFile}: SHA-256 does not match the worker bundle manifest`)
  }

  if (JSON.stringify(release.files) !== JSON.stringify(manifest.release.files)) {
    throw new Error(`${manifestFile}: verified release artifact set does not match the worker bundle`)
  }

  requirePositiveInteger(environment.AGGREGATION_L2_CHAIN_ID || '', 'AGGREGATION_L2_CHAIN_ID')
  requireHttpUrl(environment.PROOF_COORDINATOR_URL || '', 'PROOF_COORDINATOR_URL')
  requireHttpUrl(environment.ARTIFACT_READ_BASE_URL || '', 'ARTIFACT_READ_BASE_URL')
  if (
    JSON.stringify(manifest.requiredCapabilities)
    !== JSON.stringify(PROVER_WORKER_PRODUCTION_REQUIRED_CAPABILITIES)
  ) {
    throw new Error(`${manifestFile}: requiredCapabilities do not match this scrollsdk release`)
  }

  const computedBundleId = bundleIdentity({
    composeSha256,
    envSha256,
    releaseManifestSha256: release.manifestSha256,
  })
  if (computedBundleId !== manifest.bundleId) {
    throw new Error(`${manifestFile}: bundleId does not match the verified bundle files`)
  }

  if (options.expectedBundleId && options.expectedBundleId !== computedBundleId) {
    throw new Error(
      `production prover-worker bundle is stale: expected bundleId `
      + `${options.expectedBundleId}, got ${computedBundleId}`,
    )
  }

  const composeText = compose.toString('utf8')
  for (const capability of PROVER_WORKER_PRODUCTION_REQUIRED_CAPABILITIES) {
    if (!composeText.includes(capability)) {
      throw new Error(`${composeFile}: required capability is missing: ${capability}`)
    }
  }

  if (!composeText.includes(`--worker-token-file`)) {
    throw new Error(`${composeFile}: production worker token must be passed by file, not argv or environment`)
  }

  // POSIX permission bits are intentionally expressed in octal.
  // eslint-disable-next-line no-bitwise
  const tokenMode = fs.statSync(tokenFile).mode & 0o777
  if (tokenMode !== 0o600) {
    throw new Error(
      `${tokenFile}: secret file mode must be 0600, got `
      + `${tokenMode.toString(8).padStart(4, '0')}`,
    )
  }

  if (fs.readFileSync(tokenFile, 'utf8').trim() === '') {
    throw new Error(`${tokenFile}: worker token file must not be empty`)
  }

  return {
    bundleDir,
    bundleId: computedBundleId,
    files: [composeFile, envFile, tokenFile, manifestFile],
    manifestFile,
    releaseManifestFile,
  }
}

export function hydrateProverWorkerProductionBundle(options: {
  dir?: string
  workerToken: string
}): ProverWorkerProductionBundleResult {
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_PRODUCTION_BUNDLE_DIR)
  const envFile = path.join(bundleDir, '.env')
  const manifestFile = path.join(bundleDir, PROVER_WORKER_PRODUCTION_BUNDLE_MANIFEST)
  if (!fs.existsSync(envFile) || !fs.existsSync(manifestFile)) {
    throw new Error(
      `production prover-worker bundle not found at ${bundleDir}; run setup prep-charts first`,
    )
  }

  const manifest = readBundleManifest(manifestFile)
  const environment = readBundleEnvironment(envFile)
  const releaseRoot = path.resolve(bundleDir, environment.PROVER_WORKER_RELEASE_ROOT || '')
  const releaseManifestFile = path.resolve(releaseRoot, manifest.release.manifestPath)
  return writeProverWorkerProductionBundle({
    aggregationL2ChainId: environment.AGGREGATION_L2_CHAIN_ID || '',
    artifactReadBaseUrl: environment.ARTIFACT_READ_BASE_URL || '',
    coordinatorUrl: environment.PROOF_COORDINATOR_URL || '',
    dir: bundleDir,
    releaseManifestPath: releaseManifestFile,
    releaseRoot,
    workerToken: options.workerToken,
  })
}
