import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {immutableProofImage, resolveImmutableProofImage, validateMockWorkerIdentity} from './proof-materials.js'

export type ProofToolRunner = (args: string[]) => string

const INPUT_FILES = ['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk'] as const

export interface ProofImageToolsOptions {
  action: 'derive-scroll' | 'export'
  artifactRoot?: string
  coordinatorImage?: string
  deploymentDir: string
  expectedRevision: string
  output: string
  producerImage?: string
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
  inputs?: Record<string, {sha256: string; sizeBytes: number}>
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
    if (options.action === 'export') {
      const worker = image(options.workerImage, 'worker')
      const coordinator = image(options.coordinatorImage, 'coordinator')
      const identity = execute('/usr/local/bin/prover-worker', worker, ['--print-identity-json'])
      validateMockWorkerIdentity(identity, 'native Worker identity output')
      const parsed = JSON.parse(identity) as {batch_guest: {app_commit_raw: string}; image_revision: string}
      if (parsed.image_revision !== options.expectedRevision) throw new Error('Worker compiled identity revision disagrees with image revision')
      receipt.batchIdentityPlaceholder = /^0x0{128}$/.test(parsed.batch_guest.app_commit_raw)
      if (options.requireRealMaterialization && receipt.batchIdentityPlaceholder) {
        throw new Error('Worker image has a placeholder batch_guest; export needs a CPU identity-tool build with derived Batch/Aggregation commitments. Runtime environment overrides cannot fix compiled identities.')
      }

      fs.writeFileSync(path.join(staged, 'worker-identity-bundle.json'), identity, {mode: 0o600})
      // Copy only known binaries from a NEW stopped container. Never start PC.
      const container = run(['create', '--network', 'none', coordinator]).trim()
      if (!/^[\da-f]{64}$/.test(container)) throw new Error('Docker create did not return a container ID')
      try {
        for (const binary of ['materialize-chunk-oneshot', 'scroll-runtime-materializer']) {
          const destination = path.join(staged, binary)
          run(['cp', `${container}:/usr/local/bin/${binary}`, destination])
          fingerprint(destination)
          fs.chmodSync(destination, 0o700)
        }
      } finally {
        run(['rm', container])
      }
    } else {
      const producer = image(options.producerImage, 'producer')
      if (!options.artifactRoot) throw new Error('artifactRoot is required for derive-scroll')
      const root = fs.realpathSync(options.artifactRoot)
      if ([root, staged].some(value => /[\n\r,]/.test(value))) throw new Error('Docker mount paths must not contain commas or newlines')
      receipt.inputs = {}
      // Stage only the five public artifacts, not arbitrary neighboring files.
      const inputDir = path.join(staged, 'input')
      fs.mkdirSync(inputDir)
      for (const file of INPUT_FILES) {
        const source = path.join(root, file)
        if (!fs.realpathSync(source).startsWith(root + path.sep)) throw new Error(`Artifact path escapes its root: ${file}`)
        receipt.inputs[file] = fingerprint(source)
        const destination = path.join(inputDir, file)
        fs.mkdirSync(path.dirname(destination), {recursive: true})
        fs.copyFileSync(source, destination)
      }

      const outputDir = path.join(staged, 'derived')
      fs.mkdirSync(outputDir)
      execute('/usr/local/libexec/dogeos-proof-release-producer', producer, [
        'derive-scroll-identities',
        '--chunk-app-vmexe', '/input/chunk/app.vmexe', '--chunk-openvm-config', '/input/chunk/openvm.toml',
        '--batch-app-vmexe', '/input/batch/app.vmexe', '--batch-openvm-config', '/input/batch/openvm.toml',
        '--aggregate-vk', '/input/verifier/aggregate-vk', '--output', '/output/proof-scroll-identities-v1.json',
      ], ['--mount', `type=bind,src=${inputDir},dst=/input,readonly`, '--mount', `type=bind,src=${outputDir},dst=/output`])
      const produced = path.join(outputDir, 'proof-scroll-identities-v1.json')
      fingerprint(produced)
      const evidence = JSON.parse(fs.readFileSync(produced, 'utf8')) as {schema?: string}
      if (evidence.schema !== 'dogeos/proof-scroll-identities/v1') throw new Error('Native producer returned an unsupported identity schema')
      fs.renameSync(produced, path.join(staged, 'proof-scroll-identities-v1.json'))
      fs.rmdirSync(outputDir)
      fs.rmSync(inputDir, {recursive: true})
    }

    for (const file of fs.readdirSync(staged)) receipt.files[file] = fingerprint(path.join(staged, file))
    fs.writeFileSync(path.join(staged, 'image-tools-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600})
    if (fs.existsSync(target)) throw new Error(`Output appeared while tools were running: ${target}`)
    fs.renameSync(staged, target)
    return {outputDir: target, receipt}
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, {recursive: true})
  }
}
