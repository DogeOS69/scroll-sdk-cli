import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {immutableProofImage, resolveImmutableProofImage, validateMockWorkerIdentity} from './proof-materials.js'

export type ProofToolRunner = (args: string[]) => string

/** Proof Coordinator image binaries, in its /usr/local/bin. */
export const COORDINATOR_MATERIALIZERS = {batchMaterializer: 'scroll-runtime-materializer', chunkMaterializer: 'materialize-chunk-oneshot'} as const

export interface ProofImageToolsOptions {
  action: 'export'
  coordinatorImage?: string
  deploymentDir: string
  expectedRevision: string
  output: string
  requireRealMaterialization?: boolean
  run?: ProofToolRunner
  workerImage?: string
}

export interface ProofImageToolsReceipt {
  action: ProofImageToolsOptions['action']
  batchIdentityPlaceholder?: boolean
  coreRevision: string
  files: Record<string, {sha256: string; sizeBytes: number}>
  images: Record<string, string>
  // These tools do not certify a complete proof topology or change its mode.
  schema: 'dogeos/proof-image-tools/v1'
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600_000})
  if (result.error) throw new Error(`Docker proof tool failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Docker proof tool failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

function fingerprint(file: string): {sha256: string; sizeBytes: number} {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Expected a nonempty regular proof material file: ${file}`)
  return {sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sizeBytes: stat.size}
}

/** Copy the materializers out of a NEW stopped container; Proof Coordinator never starts. */
function copyCoordinatorMaterializers(reference: string, outputDir: string, run: ProofToolRunner): Record<keyof typeof COORDINATOR_MATERIALIZERS, string> {
  const container = run(['create', '--network', 'none', reference]).trim()
  if (!/^[\da-f]{64}$/.test(container)) throw new Error('Docker create did not return a container ID')
  try {
    const copied = {} as Record<keyof typeof COORDINATOR_MATERIALIZERS, string>
    for (const [key, binary] of Object.entries(COORDINATOR_MATERIALIZERS) as Array<[keyof typeof COORDINATOR_MATERIALIZERS, string]>) {
      const destination = path.join(outputDir, binary)
      run(['cp', `${container}:/usr/local/bin/${binary}`, destination])
      fingerprint(destination)
      fs.chmodSync(destination, 0o700)
      copied[key] = destination
    }

    return copied
  } finally {
    run(['rm', container])
  }
}

/** The release's coordinator owns the materializers the topology compiler validates and Kubernetes installs. */
export function exportCoordinatorMaterializers(options: {expectedRevision: string; image: string; outputDir: string; run?: ProofToolRunner}): Record<keyof typeof COORDINATOR_MATERIALIZERS, string> {
  const run = options.run ?? docker
  run(['pull', options.image])
  const revision = run(['image', 'inspect', options.image, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
  if (revision !== options.expectedRevision) throw new Error(`coordinator image revision ${revision} does not match expected ${options.expectedRevision}`)
  fs.mkdirSync(options.outputDir, {mode: 0o700, recursive: true})
  return copyCoordinatorMaterializers(options.image, options.outputDir, run)
}

/** No daemon, GPU, network, protocol context or credentials are mounted. */
function offlineRun(entrypoint: string, reference: string, args: string[], mounts: string[] = []): string[] {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', ...mounts,
    '--entrypoint', entrypoint, reference, ...args,
  ]
}

export function runProofImageTools(options: ProofImageToolsOptions): {outputDir: string; receipt: ProofImageToolsReceipt} {
  if (!/^[\da-f]{40}$/.test(options.expectedRevision)) throw new Error('expectedRevision must be the full approved dogeos-core Git SHA')
  const run = options.run ?? docker
  const deploymentDir = fs.realpathSync(options.deploymentDir)
  const target = path.resolve(deploymentDir, options.output)
  const relative = path.relative(deploymentDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('output must be a new directory inside deploymentDir')
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite proof tool output: ${target}`)
  let ancestor = path.dirname(target)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const ancestorRelative = path.relative(deploymentDir, fs.realpathSync(ancestor))
  if (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative)) throw new Error('output parent must not escape deploymentDir through a symlink')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const actualParent = fs.realpathSync(path.dirname(target))
  const parentRelative = path.relative(deploymentDir, actualParent)
  if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) throw new Error('output parent must not escape deploymentDir through a symlink')
  const staged = fs.mkdtempSync(path.join(actualParent, '.proof-image-tools-'))
  const receipt: ProofImageToolsReceipt = {
    action: options.action,
    coreRevision: options.expectedRevision,
    files: {},
    images: {},
    schema: 'dogeos/proof-image-tools/v1',
  }
  const image = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`${name} image is required`)
    // Resolve a tag exactly once. All execution and receipts use immutable digests.
    const reference = immutableProofImage(resolveImmutableProofImage(value, name))
    run(['pull', reference])
    const revision = run(['image', 'inspect', reference, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
    if (revision !== options.expectedRevision) throw new Error(`${name} image revision ${revision} does not match expected ${options.expectedRevision}`)
    receipt.images[name] = reference
    return reference
  }

  const execute = (entrypoint: string, reference: string, args: string[], mounts: string[] = []): string => {
    const cidFile = path.join(staged, 'tool-container.id')
    try {
      return run(offlineRun(entrypoint, reference, args, ['--cidfile', cidFile, ...mounts]))
    } finally {
      // A timed-out Docker client may leave its container running. Only remove
      // the container allocated by this invocation, never a caller-selected ID.
      if (fs.existsSync(cidFile)) {
        const id = fs.readFileSync(cidFile, 'utf8').trim()
        if (/^[\da-f]{64}$/.test(id)) {
          let present = false
          try {
            run(['container', 'inspect', id])
            present = true
          } catch {
            // --rm normally removes it before the client returns.
          }

          if (present) run(['rm', '--force', id])
        }

        fs.unlinkSync(cidFile)
      }
    }
  }

  try {
    const worker = image(options.workerImage, 'worker')
    const coordinator = image(options.coordinatorImage, 'coordinator')
    const identity = execute('/usr/local/bin/prover-worker', worker, ['--print-identity-json'])
    validateMockWorkerIdentity(identity, 'native Worker identity output')
    const parsed = JSON.parse(identity) as {batch_guest: {app_commit_raw: string}; image_revision: string}
    if (parsed.image_revision !== options.expectedRevision) throw new Error('Worker compiled identity revision disagrees with image revision')
    receipt.batchIdentityPlaceholder = /^0x0{128}$/.test(parsed.batch_guest.app_commit_raw)
    if (options.requireRealMaterialization && receipt.batchIdentityPlaceholder) {
      throw new Error('Worker image has a placeholder batch_guest; export needs a release mock built with the producer\'s Batch/Aggregation commitments. Runtime environment overrides cannot fix compiled identities.')
    }

    fs.writeFileSync(path.join(staged, 'worker-identity-bundle.json'), identity, {mode: 0o600})
    copyCoordinatorMaterializers(coordinator, staged, run)

    for (const file of fs.readdirSync(staged)) receipt.files[file] = fingerprint(path.join(staged, file))
    fs.writeFileSync(path.join(staged, 'image-tools-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600})
    if (fs.existsSync(target)) throw new Error(`Output appeared while tools were running: ${target}`)
    fs.renameSync(staged, target)
    return {outputDir: target, receipt}
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, {recursive: true})
  }
}
