/* eslint-disable perfectionist/sort-object-types, perfectionist/sort-objects -- Keep emitted bundle contracts in operator-facing order. */
import * as yaml from 'js-yaml'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type {ProverWorkerContractV1} from './proof-topology-compiler.js'

export const COMPILED_PROVER_WORKER_BUNDLE_MANIFEST = 'bundle-manifest.json'
export const COMPILED_PROVER_WORKER_CONTRACT = 'prover-worker-v1.json'
export const COMPILED_PROVER_WORKER_GITIGNORE = '.gitignore'
export const COMPILED_PROVER_WORKER_TOKEN_FILE = 'prover-worker.token'
export const COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT = 'protocol_context.json'
export const PROVER_WORKER_EXECUTABLE = '/usr/local/bin/prover-worker'

export interface CompiledProverWorkerBundleFileV1 {
  path: string
  sha256: string
}

export interface CompiledProverWorkerRequiredResourceV1 {
  path: string
  runtimePath: string
  sha256?: string
  type: 'directory' | 'file'
}

export interface CompiledProverWorkerBundleManifestV1 {
  bundleId: string
  credentialState: 'pending' | 'ready'
  files: {
    '.env': {sha256: string}
    'docker-compose.yml': {sha256: string}
    [COMPILED_PROVER_WORKER_CONTRACT]: {sha256: string}
    [COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT]: {sha256: string}
    [COMPILED_PROVER_WORKER_TOKEN_FILE]: {requiredMode: '0600'; sensitive: true}
    materials: CompiledProverWorkerBundleFileV1[]
  }
  generator: 'scrollsdk setup prep-charts'
  image: string
  kind: 'compiled-proof-topology-worker'
  requiredBuildClass: ProverWorkerContractV1['required_build_class']
  requiredResources: CompiledProverWorkerRequiredResourceV1[]
  schemaVersion: 1
}

export interface CompiledProverWorkerBundleResult {
  bundleDir: string
  bundleId: string
  files: string[]
  manifestFile: string
}

export interface WriteCompiledProverWorkerBundleOptions {
  bundleDir: string
  contractFile: string
  generatedMaterialsDir: string
  generatedMaterialsRoot: string
  protocolContextPath: string
  protocolContextRuntimePath: string
  resourcesMountPath: string
  resourcesRoot: string
  worker: ProverWorkerContractV1
  workerToken?: string
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function sha256File(filePath: string): string {
  return sha256(fs.readFileSync(filePath))
}

function portable(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function requireFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} is not a file: ${resolved}`)
  }

  return resolved
}

function requireDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`)
  }

  return resolved
}

function requireAbsoluteRuntimePath(value: string, label: string): string {
  if (!path.posix.isAbsolute(value)) throw new Error(`${label} must be an absolute POSIX path`)
  if (/[\n\r:]/.test(value)) throw new Error(`${label} contains unsupported characters`)
  const normalized = path.posix.normalize(value)
  if (normalized === '/') throw new Error(`${label} must not be the filesystem root`)
  return normalized
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function runtimeRelative(runtimeRoot: string, value: string): string | undefined {
  const normalized = path.posix.normalize(value)
  const relative = path.posix.relative(runtimeRoot, normalized)
  if (relative === '' || (!relative.startsWith('../') && !path.posix.isAbsolute(relative))) {
    return relative
  }
}

function filesRecursively(root: string): Array<{absolute: string; relative: string}> {
  const files: Array<{absolute: string; relative: string}> = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        files.push({absolute, relative: portable(path.relative(root, absolute))})
      } else {
        throw new Error(`compiled Worker bundle input has unsupported entry: ${absolute}`)
      }
    }
  }

  visit(root)
  return files.sort((left, right) => left.relative.localeCompare(right.relative))
}

function copyTree(source: string, destination: string): CompiledProverWorkerBundleFileV1[] {
  const files = filesRecursively(source)
  for (const file of files) {
    const target = path.join(destination, file.relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.copyFileSync(file.absolute, target)
  }

  return files.map(file => ({path: file.relative, sha256: sha256File(file.absolute)}))
}

function argumentValue(worker: ProverWorkerContractV1, flag: string): string | undefined {
  const index = worker.argv.indexOf(flag)
  return index >= 0 ? worker.argv[index + 1] : undefined
}

function validateWorkerContract(worker: ProverWorkerContractV1): void {
  const placementMatchesState = worker.desired_state === 'external'
    ? worker.placement === 'external'
    : worker.placement === 'local_cpu' || worker.placement === 'local_cuda'
  if (worker.schema_version !== 1 || !placementMatchesState) {
    throw new Error(
      'compiled Compose bundle requires a schema-v1 Worker contract whose desired state matches its placement',
    )
  }

  if ('expected_topology_digest' in worker) {
    throw new Error(
      'compiled Worker contract contains retired expected_topology_digest; regenerate it with the post-#937 compiler flow',
    )
  }

  if (!/^sha256:[\da-f]{64}$/.test(worker.image.digest) || !worker.image.repository.trim()) {
    throw new Error('compiled Worker image must contain a repository and sha256 digest')
  }

  if (!Array.isArray(worker.argv) || worker.argv.length === 0) {
    throw new Error('compiled Worker argv must not be empty')
  }

  const names = new Set<string>()
  for (const item of worker.environment) {
    if (!/^[A-Z_][\dA-Z_]*$/.test(item.name) || names.has(item.name)) {
      throw new Error(`compiled Worker environment contains invalid or duplicate name: ${item.name}`)
    }

    names.add(item.name)
  }

  if (names.has('DOGEOS_PROOF_TOPOLOGY_DIGEST')) {
    throw new Error(
      'compiled Worker contract contains retired DOGEOS_PROOF_TOPOLOGY_DIGEST; regenerate it with the post-#937 compiler flow',
    )
  }
}

function requiredResources(
  worker: ProverWorkerContractV1,
  resourcesRoot: string,
  resourcesMountPath: string,
): CompiledProverWorkerRequiredResourceV1[] {
  const resources = new Map<string, CompiledProverWorkerRequiredResourceV1>()
  for (const value of worker.argv) {
    if (!path.posix.isAbsolute(value)) continue
    const relative = runtimeRelative(resourcesMountPath, value)
    if (relative === undefined || relative === '') continue
    const source = path.resolve(resourcesRoot, relative)
    const inside = path.relative(resourcesRoot, source)
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`compiled Worker resource escapes resourcesRoot: ${value}`)
    }

    if (!fs.existsSync(source)) {
      throw new Error(`compiled Worker resource is missing: ${source} (${value})`)
    }

    const stat = fs.statSync(source)
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`compiled Worker resource is not a regular file or directory: ${source}`)
    }

    resources.set(relative, {
      path: portable(relative),
      runtimePath: value,
      ...(stat.isFile() ? {sha256: sha256File(source)} : {}),
      type: stat.isFile() ? 'file' : 'directory',
    })
  }

  return [...resources.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function composeDocument(options: {
  generatedMaterialsRoot: string
  protocolContextRuntimePath: string
  resourcesMountPath: string
  tokenRuntimePath: string
  worker: ProverWorkerContractV1
}): Record<string, unknown> {
  const readinessDirectory = path.posix.dirname(options.worker.readiness_evidence_path)
  const environment = Object.fromEntries(
    options.worker.environment.map(item => [item.name, item.value]),
  )
  const service: Record<string, unknown> = {
    image: `${options.worker.image.repository}@${options.worker.image.digest}`,
    restart: 'unless-stopped',
    stop_grace_period: '7m',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    tmpfs: ['/tmp:rw,noexec,nosuid,size=1g'],
    command: [PROVER_WORKER_EXECUTABLE, ...options.worker.argv],
    environment,
    volumes: [
      `./${COMPILED_PROVER_WORKER_TOKEN_FILE}:${options.tokenRuntimePath}:ro`,
      `./${COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT}:${options.protocolContextRuntimePath}:ro`,
      `./materials:${options.generatedMaterialsRoot}:ro`,
      `\${PROOF_RESOURCES_ROOT:?missing PROOF_RESOURCES_ROOT}:${options.resourcesMountPath}:ro`,
      `prover-worker-readiness:${readinessDirectory}`,
    ],
    healthcheck: {
      test: [
        'CMD-SHELL',
        `test -s ${shellQuote(options.worker.readiness_evidence_path)}`,
      ],
      interval: '10s',
      timeout: '3s',
      retries: 12,
      start_period: '30s',
    },
  }
  if (
    options.worker.placement === 'local_cuda'
    || (options.worker.placement === 'external' && options.worker.required_build_class === 'production')
  ) service.gpus = 'all'
  return {
    name: 'dogeos-proof-topology-worker',
    services: {'prover-worker': service},
    volumes: {'prover-worker-readiness': {}},
  }
}

function stableManifestFields(
  manifest: Omit<CompiledProverWorkerBundleManifestV1, 'bundleId' | 'credentialState'>,
): Omit<CompiledProverWorkerBundleManifestV1, 'bundleId' | 'credentialState'> {
  return manifest
}

function bundleIdentity(
  manifest: Omit<CompiledProverWorkerBundleManifestV1, 'bundleId' | 'credentialState'>,
): string {
  return sha256(JSON.stringify(stableManifestFields(manifest)))
}

function readManifest(filePath: string): CompiledProverWorkerBundleManifestV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read compiled prover-worker bundle manifest ${filePath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const manifest = parsed as Partial<CompiledProverWorkerBundleManifestV1>
  if (
    manifest.schemaVersion !== 1
    || manifest.kind !== 'compiled-proof-topology-worker'
    || typeof manifest.bundleId !== 'string'
    || !manifest.files
    || !Array.isArray(manifest.requiredResources)
  ) {
    throw new Error(`${filePath}: unsupported or invalid compiled prover-worker bundle manifest`)
  }

  if ('topologyDigest' in manifest) {
    throw new Error(
      `${filePath}: retired topologyDigest is not supported; regenerate the bundle with the post-#937 flow`,
    )
  }

  return manifest as CompiledProverWorkerBundleManifestV1
}

function readEnvironment(filePath: string): Record<string, string> {
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

function verifyRequiredResources(
  manifest: CompiledProverWorkerBundleManifestV1,
  resourcesRoot: string,
): void {
  for (const resource of manifest.requiredResources) {
    if (path.isAbsolute(resource.path)) {
      throw new Error(`compiled Worker resource path must be relative: ${resource.path}`)
    }

    const source = path.resolve(resourcesRoot, resource.path)
    const inside = path.relative(resourcesRoot, source)
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`compiled Worker resource escapes resources root: ${resource.path}`)
    }

    if (!fs.existsSync(source)) throw new Error(`compiled Worker resource is missing: ${source}`)
    const stat = fs.statSync(source)
    if (resource.type === 'file') {
      if (!stat.isFile() || !resource.sha256 || sha256File(source) !== resource.sha256) {
        throw new Error(`compiled Worker resource SHA-256 mismatch: ${source}`)
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`compiled Worker resource directory is missing: ${source}`)
    }
  }
}

export function writeCompiledProverWorkerBundle(
  options: WriteCompiledProverWorkerBundleOptions,
): CompiledProverWorkerBundleResult {
  validateWorkerContract(options.worker)
  const bundleDir = path.resolve(options.bundleDir)
  const contractFile = requireFile(options.contractFile, 'compiled Worker contract')
  const materialsSource = requireDirectory(
    options.generatedMaterialsDir,
    'compiled Worker generated materials',
  )
  const resourcesRoot = requireDirectory(options.resourcesRoot, 'compiled Worker resourcesRoot')
  const protocolContext = requireFile(options.protocolContextPath, 'protocol context')
  const generatedMaterialsRoot = requireAbsoluteRuntimePath(
    options.generatedMaterialsRoot,
    'generatedMaterialsRoot',
  )
  const resourcesMountPath = requireAbsoluteRuntimePath(
    options.resourcesMountPath,
    'resourcesMountPath',
  )
  const protocolContextRuntimePath = requireAbsoluteRuntimePath(
    options.protocolContextRuntimePath,
    'protocolContextRuntimePath',
  )
  for (const [leftLabel, left, rightLabel, right] of [
    ['generatedMaterialsRoot', generatedMaterialsRoot, 'resourcesMountPath', resourcesMountPath],
  ]) {
    if (runtimeRelative(left, right) !== undefined || runtimeRelative(right, left) !== undefined) {
      throw new Error(`${leftLabel} and ${rightLabel} must not overlap`)
    }
  }

  const tokenRuntimePath = argumentValue(options.worker, '--worker-token-file')
  if (!tokenRuntimePath) throw new Error('compiled Worker argv has no --worker-token-file')
  requireAbsoluteRuntimePath(tokenRuntimePath, 'Worker token path')

  const parsedContract = JSON.parse(fs.readFileSync(contractFile, 'utf8')) as ProverWorkerContractV1
  if (JSON.stringify(parsedContract) !== JSON.stringify(options.worker)) {
    throw new Error('compiled Worker object does not match the compiler contract file')
  }

  fs.mkdirSync(bundleDir, {recursive: true})
  const composePath = path.join(bundleDir, 'docker-compose.yml')
  const compose = yaml.dump(composeDocument({
    generatedMaterialsRoot,
    protocolContextRuntimePath,
    resourcesMountPath,
    tokenRuntimePath,
    worker: options.worker,
  }), {lineWidth: -1, noRefs: true})
  fs.writeFileSync(composePath, compose)

  const defaultResourcesRoot = portable(path.relative(bundleDir, resourcesRoot)) || '.'
  const envPath = path.join(bundleDir, '.env')
  const env = [
    '# Generated by `scrollsdk setup prep-charts`.',
    '# Preserve the deployment layout when syncing, or replace this path on the Worker host.',
    `PROOF_RESOURCES_ROOT=${defaultResourcesRoot}`,
    '',
  ].join('\n')
  fs.writeFileSync(envPath, env)

  // The credential is hydrated after deterministic generation. Keep it out of
  // source control even when operators check in the generated bundle for
  // review or copy it through a deployment repository.
  const gitignorePath = path.join(bundleDir, COMPILED_PROVER_WORKER_GITIGNORE)
  fs.writeFileSync(gitignorePath, `${COMPILED_PROVER_WORKER_TOKEN_FILE}\n`)

  const copiedContract = path.join(bundleDir, COMPILED_PROVER_WORKER_CONTRACT)
  fs.copyFileSync(contractFile, copiedContract)
  const copiedProtocolContext = path.join(bundleDir, COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT)
  fs.copyFileSync(protocolContext, copiedProtocolContext)
  const materialsTarget = path.join(bundleDir, 'materials')
  fs.rmSync(materialsTarget, {force: true, recursive: true})
  fs.mkdirSync(materialsTarget, {recursive: true})
  const materials = copyTree(materialsSource, materialsTarget)

  const tokenPath = path.join(bundleDir, COMPILED_PROVER_WORKER_TOKEN_FILE)
  fs.rmSync(tokenPath, {force: true})
  if (options.workerToken) {
    if (!options.workerToken.trim()) throw new Error('worker token must be non-empty')
    fs.writeFileSync(tokenPath, `${options.workerToken.trim()}\n`, {mode: 0o600})
  }

  const stable: Omit<CompiledProverWorkerBundleManifestV1, 'bundleId' | 'credentialState'> = {
    files: {
      '.env': {sha256: sha256(env)},
      'docker-compose.yml': {sha256: sha256(compose)},
      [COMPILED_PROVER_WORKER_CONTRACT]: {sha256: sha256File(copiedContract)},
      [COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT]: {sha256: sha256File(copiedProtocolContext)},
      [COMPILED_PROVER_WORKER_TOKEN_FILE]: {requiredMode: '0600', sensitive: true},
      materials,
    },
    generator: 'scrollsdk setup prep-charts',
    image: `${options.worker.image.repository}@${options.worker.image.digest}`,
    kind: 'compiled-proof-topology-worker',
    requiredBuildClass: options.worker.required_build_class,
    requiredResources: requiredResources(options.worker, resourcesRoot, resourcesMountPath),
    schemaVersion: 1,
  }
  const manifest: CompiledProverWorkerBundleManifestV1 = {
    ...stable,
    bundleId: bundleIdentity(stable),
    credentialState: options.workerToken ? 'ready' : 'pending',
  }
  const manifestFile = path.join(bundleDir, COMPILED_PROVER_WORKER_BUNDLE_MANIFEST)
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  return options.workerToken
    ? verifyCompiledProverWorkerBundle({
        bundleDir,
        expectedBundleId: manifest.bundleId,
        resourcesRoot,
      })
    : {
        bundleDir,
        bundleId: manifest.bundleId,
        files: [
          composePath,
          envPath,
          gitignorePath,
          copiedContract,
          copiedProtocolContext,
          ...filesRecursively(materialsTarget).map(file => file.absolute),
          manifestFile,
        ],
        manifestFile,
      }
}

export function verifyCompiledProverWorkerBundle(options: {
  allowPendingCredential?: boolean
  bundleDir: string
  expectedBundleId?: string
  resourcesRoot?: string
}): CompiledProverWorkerBundleResult {
  const bundleDir = path.resolve(options.bundleDir)
  const manifestFile = path.join(bundleDir, COMPILED_PROVER_WORKER_BUNDLE_MANIFEST)
  const manifest = readManifest(manifestFile)
  const stable = {...manifest} as Partial<CompiledProverWorkerBundleManifestV1>
  delete stable.bundleId
  delete stable.credentialState
  const actualBundleId = bundleIdentity(
    stable as Omit<CompiledProverWorkerBundleManifestV1, 'bundleId' | 'credentialState'>,
  )
  if (actualBundleId !== manifest.bundleId) {
    throw new Error(`${manifestFile}: bundleId does not match manifest contents`)
  }

  if (options.expectedBundleId && options.expectedBundleId !== actualBundleId) {
    throw new Error(
      `compiled prover-worker bundle is stale: expected ${options.expectedBundleId}, got ${actualBundleId}`,
    )
  }

  const hashedFiles = [
    ['.env', manifest.files['.env'].sha256],
    ['docker-compose.yml', manifest.files['docker-compose.yml'].sha256],
    [COMPILED_PROVER_WORKER_CONTRACT, manifest.files[COMPILED_PROVER_WORKER_CONTRACT].sha256],
    [
      COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT,
      manifest.files[COMPILED_PROVER_WORKER_PROTOCOL_CONTEXT].sha256,
    ],
  ] as const
  for (const [relative, expected] of hashedFiles) {
    const filePath = requireFile(path.join(bundleDir, relative), relative)
    if (sha256File(filePath) !== expected) {
      throw new Error(`${filePath}: SHA-256 does not match ${COMPILED_PROVER_WORKER_BUNDLE_MANIFEST}`)
    }
  }

  for (const material of manifest.files.materials) {
    if (path.isAbsolute(material.path)) {
      throw new Error(`compiled Worker material path must be relative: ${material.path}`)
    }

    const filePath = requireFile(path.join(bundleDir, 'materials', material.path), 'Worker material')
    const relative = path.relative(path.join(bundleDir, 'materials'), filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative) || sha256File(filePath) !== material.sha256) {
      throw new Error(`compiled Worker material SHA-256 mismatch: ${material.path}`)
    }
  }

  const worker = JSON.parse(
    fs.readFileSync(path.join(bundleDir, COMPILED_PROVER_WORKER_CONTRACT), 'utf8'),
  ) as ProverWorkerContractV1
  validateWorkerContract(worker)
  if (
    `${worker.image.repository}@${worker.image.digest}` !== manifest.image
    || worker.required_build_class !== manifest.requiredBuildClass
  ) {
    throw new Error(`${manifestFile}: Worker contract disagrees with bundle identity`)
  }

  const environment = readEnvironment(path.join(bundleDir, '.env'))
  const resourcesRoot = path.resolve(
    options.resourcesRoot || path.join(bundleDir, environment.PROOF_RESOURCES_ROOT || ''),
  )
  requireDirectory(resourcesRoot, 'compiled Worker resourcesRoot')
  verifyRequiredResources(manifest, resourcesRoot)

  let tokenPath: string | undefined
  if (manifest.credentialState === 'pending') {
    if (!options.allowPendingCredential) {
      throw new Error(`${manifestFile}: worker credential is pending; run setup proof-worker first`)
    }
  } else if (manifest.credentialState === 'ready') {
    tokenPath = requireFile(
      path.join(bundleDir, COMPILED_PROVER_WORKER_TOKEN_FILE),
      'compiled Worker token',
    )
    // POSIX permission bits are intentionally expressed in octal.
    // eslint-disable-next-line no-bitwise
    const mode = fs.statSync(tokenPath).mode & 0o777
    if (mode !== 0o600) {
      throw new Error(`${tokenPath}: secret file mode must be 0600, got ${mode.toString(8).padStart(4, '0')}`)
    }

    if (!fs.readFileSync(tokenPath, 'utf8').trim()) {
      throw new Error(`${tokenPath}: worker token is empty`)
    }
  } else {
    throw new Error(`${manifestFile}: invalid credentialState`)
  }

  return {
    bundleDir,
    bundleId: actualBundleId,
    files: [
      ...hashedFiles.map(([relative]) => path.join(bundleDir, relative)),
      ...manifest.files.materials.map(item => path.join(bundleDir, 'materials', item.path)),
      ...(tokenPath ? [tokenPath] : []),
      manifestFile,
    ],
    manifestFile,
  }
}

export function hydrateCompiledProverWorkerBundle(options: {
  bundleDir: string
  expectedBundleId?: string
  workerToken: string
}): CompiledProverWorkerBundleResult {
  if (!options.workerToken.trim()) throw new Error('worker token must be non-empty')
  const bundleDir = path.resolve(options.bundleDir)
  const manifestFile = path.join(bundleDir, COMPILED_PROVER_WORKER_BUNDLE_MANIFEST)
  verifyCompiledProverWorkerBundle({
    allowPendingCredential: true,
    bundleDir,
    expectedBundleId: options.expectedBundleId,
  })
  const manifest = readManifest(manifestFile)
  const tokenPath = path.join(bundleDir, COMPILED_PROVER_WORKER_TOKEN_FILE)
  const originalManifest = fs.readFileSync(manifestFile)
  const originalToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath) : undefined
  const originalTokenMode = fs.existsSync(tokenPath)
    // POSIX permission bits are intentionally expressed in octal.
    // eslint-disable-next-line no-bitwise
    ? fs.statSync(tokenPath).mode & 0o777
    : undefined
  const tokenTemporary = `${tokenPath}.tmp-${process.pid}`
  const manifestTemporary = `${manifestFile}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tokenTemporary, `${options.workerToken.trim()}\n`, {mode: 0o600})
    manifest.credentialState = 'ready'
    fs.writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.renameSync(tokenTemporary, tokenPath)
    fs.renameSync(manifestTemporary, manifestFile)
    return verifyCompiledProverWorkerBundle({
      bundleDir,
      expectedBundleId: options.expectedBundleId || manifest.bundleId,
    })
  } catch (error) {
    fs.rmSync(tokenTemporary, {force: true})
    fs.rmSync(manifestTemporary, {force: true})
    fs.writeFileSync(manifestFile, originalManifest)
    if (originalToken === undefined) fs.rmSync(tokenPath, {force: true})
    else fs.writeFileSync(tokenPath, originalToken, {mode: originalTokenMode})
    throw error
  }
}
