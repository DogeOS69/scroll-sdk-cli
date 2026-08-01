import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { AwsCliRunner } from './aws-cli.js'

/** Default docker-compose bundle directory in the deployment working directory. */
export const PROVER_WORKER_MOCK_BUNDLE_DIR = 'prover-worker-mock/docker-compose'
export const PROVER_WORKER_MOCK_BUNDLE_MANIFEST = 'bundle-manifest.json'
export const PROVER_WORKER_MOCK_REQUIRED_CAPABILITIES = [
  '--enable-prove-scroll-chunk',
  '--enable-prove-scroll-batch',
  '--enable-prove-advance-l2-aggregation',
  '--enable-prove-bridge-transition',
] as const

export interface ProverWorkerMockBundleOptions {
  /** Public GET base for claimed-task input refs (`GET {base}/{ref.key}`). */
  artifactReadBaseUrl: string
  /** Public base URL of the proof-coordinator `/v1/prover` gateway. */
  coordinatorUrl: string
  dir?: string
  imageTag?: string
  /** Worker bearer token; must equal the coordinator's prover-worker-token. */
  workerToken?: string
}

export interface ProverWorkerMockBundleResult {
  bundleDir: string
  bundleId: string
  files: string[]
  manifestFile: string
}

export interface ProverWorkerMockBundleManifest {
  bundleId: string
  /**
   * pending means prep-charts produced a distributable, non-secret bundle and
   * the worker credential still has to be injected explicitly.
   */
  credentialState?: 'pending' | 'ready'
  files: {
    '.env': { sha256: string }
    'docker-compose.yml': { sha256: string }
    'prover-worker.env': { requiredMode: '0600'; sensitive: true }
  }
  /** Legacy v1 field. New manifests omit wall-clock data to stay reproducible. */
  generatedAt?: string
  generator: 'scrollsdk setup prep-charts'
  requiredCapabilities: string[]
  schemaVersion: 1
}

/**
 * Read the prover-worker token from the Secrets Manager secret proof-aws-init
 * manages (`proof-work-token` + `prover-worker-token` JSON properties).
 */
export function readProverWorkerTokenFromSecretsManager(options: {
  awsProfile?: string
  awsRegion?: string
  secretName: string
}): string {
  const aws = new AwsCliRunner(options.awsProfile)
  const secretString = aws.text(
    ['secretsmanager', 'get-secret-value', '--secret-id', options.secretName],
    { query: 'SecretString', region: options.awsRegion }
  )
  const parsed = JSON.parse(secretString) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(`Secrets Manager secret ${options.secretName} is not a JSON property map`)
  }

  const token = parsed['prover-worker-token']
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error(`Secrets Manager secret ${options.secretName} has no prover-worker-token property`)
  }

  return token.trim()
}

const COMPOSE_YML = `# Mock prover-worker (dev/test only — deterministic, NON-cryptographic
# proofs; pairs with the mock proving topology staged by
# \`scrollsdk setup prep-charts\`).
#
# Dial-out only: claims work from the proof-coordinator's /v1/prover gateway
# and fetches/uploads artifacts over HTTPS. No inbound ports needed.
name: prover-worker-mock
services:
  prover-worker:
    image: dogeos69/prover-worker-mock:\${PROVER_WORKER_IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file:
      - prover-worker.env
    command:
      - prover-worker
      - --proof-coordinator-url
      - \${PROOF_COORDINATOR_URL:?set in .env or shell}
      - --artifact-read-base-url
      - \${ARTIFACT_READ_BASE_URL:?set in .env or shell}
      - --worker-id
      - ec2-mock-worker-0
      - --mode
      - mock
      - --allow-dev-mock-prover
      - --enable-prove-scroll-chunk
      - --enable-prove-scroll-batch
      - --enable-prove-advance-l2-aggregation
      - --enable-prove-bridge-transition
`

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function bundleIdentity(composeSha256: string, envSha256: string): string {
  return sha256(JSON.stringify({
    composeSha256,
    envSha256,
    requiredCapabilities: PROVER_WORKER_MOCK_REQUIRED_CAPABILITIES,
    schemaVersion: 1,
  }))
}

function readBundleManifest(manifestPath: string): ProverWorkerMockBundleManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read mock prover-worker bundle manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const manifest = parsed as Partial<ProverWorkerMockBundleManifest>
  if (manifest?.schemaVersion !== 1 || typeof manifest.bundleId !== 'string' || !manifest.files) {
    throw new Error(`${manifestPath}: unsupported or invalid mock prover-worker bundle manifest`)
  }

  return manifest as ProverWorkerMockBundleManifest
}

/**
 * Verify a generated bundle without reading or printing the bearer token.
 * Run this both before sync and on the worker host; expectedBundleId detects a
 * remote directory that was generated from stale endpoints/capabilities.
 */
export function verifyProverWorkerMockBundle(options: {
  dir?: string
  expectedBundleId?: string
} = {}): ProverWorkerMockBundleResult {
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_MOCK_BUNDLE_DIR)
  const composePath = path.join(bundleDir, 'docker-compose.yml')
  const envPath = path.join(bundleDir, '.env')
  const tokenPath = path.join(bundleDir, 'prover-worker.env')
  const manifestPath = path.join(bundleDir, PROVER_WORKER_MOCK_BUNDLE_MANIFEST)
  const manifest = readBundleManifest(manifestPath)

  const compose = fs.readFileSync(composePath)
  const env = fs.readFileSync(envPath)
  const composeSha256 = sha256(compose)
  const envSha256 = sha256(env)
  if (manifest.files['docker-compose.yml']?.sha256 !== composeSha256) {
    throw new Error(`${composePath}: SHA-256 does not match ${PROVER_WORKER_MOCK_BUNDLE_MANIFEST}; regenerate or resync the bundle`)
  }

  if (manifest.files['.env']?.sha256 !== envSha256) {
    throw new Error(`${envPath}: SHA-256 does not match ${PROVER_WORKER_MOCK_BUNDLE_MANIFEST}; regenerate or resync the bundle`)
  }

  if (JSON.stringify(manifest.requiredCapabilities) !== JSON.stringify(PROVER_WORKER_MOCK_REQUIRED_CAPABILITIES)) {
    throw new Error(`${manifestPath}: requiredCapabilities do not match this scrollsdk release`)
  }

  if (manifest.credentialState === 'pending') {
    throw new Error(
      `${manifestPath}: worker credential is pending; hydrate prover-worker.env before running proof-worker-check`,
    )
  }

  const computedBundleId = bundleIdentity(composeSha256, envSha256)
  if (manifest.bundleId !== computedBundleId) {
    throw new Error(`${manifestPath}: bundleId does not match the verified bundle files`)
  }

  if (options.expectedBundleId && options.expectedBundleId !== computedBundleId) {
    throw new Error(`mock prover-worker bundle is stale: expected bundleId ${options.expectedBundleId}, got ${computedBundleId}`)
  }

  const composeText = compose.toString('utf8')
  for (const capability of PROVER_WORKER_MOCK_REQUIRED_CAPABILITIES) {
    if (!composeText.includes(capability)) throw new Error(`${composePath}: required capability is missing: ${capability}`)
  }

  // POSIX permission bits are intentionally expressed in octal.
  // eslint-disable-next-line no-bitwise
  const tokenMode = fs.statSync(tokenPath).mode & 0o777
  if (tokenMode !== 0o600) {
    throw new Error(`${tokenPath}: secret file mode must be 0600, got ${tokenMode.toString(8).padStart(4, '0')}`)
  }

  return {
    bundleDir,
    bundleId: computedBundleId,
    files: [composePath, envPath, tokenPath, manifestPath],
    manifestFile: manifestPath,
  }
}

/**
 * Write the prover-worker-mock docker-compose bundle. Without workerToken this
 * creates only deterministic, non-secret files and records credentialState as
 * pending. A later explicit external-host preparation step may call it again
 * with the token to hydrate prover-worker.env without changing bundleId.
 */
export function writeProverWorkerMockBundle(options: ProverWorkerMockBundleOptions): ProverWorkerMockBundleResult {
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_MOCK_BUNDLE_DIR)
  fs.mkdirSync(bundleDir, { recursive: true })

  const composePath = path.join(bundleDir, 'docker-compose.yml')
  fs.writeFileSync(composePath, COMPOSE_YML)

  const envPath = path.join(bundleDir, '.env')
  const envContent = [
    '# Generated by `scrollsdk setup prep-charts`.',
    `PROOF_COORDINATOR_URL=${options.coordinatorUrl}`,
    `ARTIFACT_READ_BASE_URL=${options.artifactReadBaseUrl}`,
    ...(options.imageTag ? [`PROVER_WORKER_IMAGE_TAG=${options.imageTag}`] : []),
    '',
  ].join('\n')
  fs.writeFileSync(envPath, envContent)

  const tokenPath = path.join(bundleDir, 'prover-worker.env')
  if (options.workerToken) {
    // writeFileSync only applies `mode` on creation; an existing world-readable
    // placeholder must not silently keep its permissions once it holds the token.
    fs.rmSync(tokenPath, { force: true })
    fs.writeFileSync(tokenPath, [
      '# Generated by `scrollsdk setup prep-charts`. SECRET —',
      "# matches the coordinator's prover-worker-token (AWS Secrets Manager).",
      `DOGEOS_PROVER_WORKER_TOKEN=${options.workerToken}`,
      '',
    ].join('\n'), { mode: 0o600 })
  } else {
    // Never leave a credential from an older generation attached to a newly
    // rendered endpoint bundle.
    fs.rmSync(tokenPath, { force: true })
  }

  const composeSha256 = sha256(COMPOSE_YML)
  const envSha256 = sha256(envContent)
  const manifestPath = path.join(bundleDir, PROVER_WORKER_MOCK_BUNDLE_MANIFEST)
  const manifest: ProverWorkerMockBundleManifest = {
    bundleId: bundleIdentity(composeSha256, envSha256),
    credentialState: options.workerToken ? 'ready' : 'pending',
    files: {
      '.env': { sha256: envSha256 },
      'docker-compose.yml': { sha256: composeSha256 },
      'prover-worker.env': { requiredMode: '0600', sensitive: true },
    },
    generator: 'scrollsdk setup prep-charts',
    requiredCapabilities: [...PROVER_WORKER_MOCK_REQUIRED_CAPABILITIES],
    schemaVersion: 1,
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return options.workerToken
    ? verifyProverWorkerMockBundle({ dir: bundleDir, expectedBundleId: manifest.bundleId })
    : {
        bundleDir,
        bundleId: manifest.bundleId,
        files: [composePath, envPath, manifestPath],
        manifestFile: manifestPath,
      }
}

function readBundleEnvironment(filePath: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    result[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }

  return result
}

/**
 * Hydrate a credential-pending bundle without asking the worker operator to
 * repeat coordinator/artifact endpoints. Re-rendering is safe because bundleId
 * intentionally covers only deterministic, non-secret inputs.
 */
export function hydrateProverWorkerMockBundle(options: {
  dir?: string
  workerToken: string
}): ProverWorkerMockBundleResult {
  const bundleDir = path.resolve(options.dir || PROVER_WORKER_MOCK_BUNDLE_DIR)
  const envPath = path.join(bundleDir, '.env')
  if (!fs.existsSync(envPath)) {
    throw new Error(`mock prover-worker endpoint environment not found: ${envPath}; run setup prep-charts first`)
  }

  const env = readBundleEnvironment(envPath)
  const coordinatorUrl = env.PROOF_COORDINATOR_URL
  const artifactReadBaseUrl = env.ARTIFACT_READ_BASE_URL
  if (!coordinatorUrl || !artifactReadBaseUrl) {
    throw new Error(`${envPath}: PROOF_COORDINATOR_URL and ARTIFACT_READ_BASE_URL are required`)
  }

  if (!options.workerToken.trim()) {
    throw new Error('worker token must be a non-empty string')
  }

  return writeProverWorkerMockBundle({
    artifactReadBaseUrl,
    coordinatorUrl,
    dir: bundleDir,
    imageTag: env.PROVER_WORKER_IMAGE_TAG,
    workerToken: options.workerToken.trim(),
  })
}
