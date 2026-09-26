import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {captureProofReleasePreparation} from './proof-release-preparation.js'
import {proofFileHash, proofRegularFile, readProofSoftwareRelease} from './proof-software-release.js'

export interface PrepareRealOptions {
  deploymentDir: string
  output: string
  protocolContext: string
  release: string
  releaseSha256: string
  run?: (args: string[]) => string
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 3_600_000})
  if (result.error || result.status !== 0) throw new Error(`Preparation container failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}

export function prepareRealProofRelease(options: PrepareRealOptions): {outputDir: string; preparationReceipt: string; releaseSha256: string} {
  const root = fs.realpathSync(options.deploymentDir)
  const selected = readProofSoftwareRelease(path.resolve(root, options.release), options.releaseSha256)
  const context = proofRegularFile(path.resolve(root, options.protocolContext), 4 * 1024 * 1024)
  const contextHash = proofFileHash(context)
  const target = path.resolve(root, options.output)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.existsSync(target)) throw new Error('Preparation output must be a new directory inside deployment-dir')
  let ancestor = path.dirname(target)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error('Preparation output parent contains a symlink')
  fs.mkdirSync(path.dirname(target), {recursive: true})
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.proof-prepare-real-'))
  const candidate = path.join(stage, 'output/artifacts')
  const run = options.run ?? docker
  const image = selected.manifest.images.producer.reference
  const cid = path.join(stage, 'container.id')
  try {
    if (/[\n\r,]/.test(stage)) throw new Error('Unsupported container mount path')
    fs.mkdirSync(path.join(stage, 'input'))
    fs.mkdirSync(path.join(stage, 'output'))
    fs.copyFileSync(context, path.join(stage, 'input/protocol_context.json'))
    run(['pull', image])
    const revision = run(['image', 'inspect', image, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
    if (revision !== selected.manifest.source.revision) throw new Error('Producer OCI revision differs from release')
    const contract = run(['image', 'inspect', image, '--format', '{{ index .Config.Labels "dogeos.proof-release-producer.contract" }}']).trim()
    if (contract !== 'prepare-real-v1') throw new Error('Producer image does not implement prepare-real-v1')
    run([
      'run', '--rm', '--cidfile', cid, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=8g', '--tmpfs', '/app/target:rw,exec,nosuid,nodev,size=16g',
      '--mount', `type=bind,src=${path.join(stage, 'input')},dst=/input,readonly`,
      '--mount', `type=bind,src=${path.join(stage, 'output')},dst=/output`,
      '--entrypoint', '/usr/local/libexec/dogeos-proof-release-producer', image,
      'prepare-real', '--protocol-context', '/input/protocol_context.json', '--output', '/output/artifacts',
    ])
    const receipt = JSON.parse(fs.readFileSync(proofRegularFile(path.join(candidate, 'producer-receipt.json'), 4 * 1024 * 1024), 'utf8')) as {
      coreRevision: string; files: Record<string, {sha256: string; sizeBytes: number}>; protocolContextSha256: string; schema: string
    }
    if (receipt.schema !== 'dogeos/proof-preparation/v1' || receipt.coreRevision !== selected.manifest.source.revision || receipt.protocolContextSha256 !== contextHash) throw new Error('Producer receipt release/protocol binding mismatch')
    const seen = new Set<string>()
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Producer output contains a symlink')
        if (entry.isDirectory()) walk(file)
        else {
          const name = path.relative(candidate, file).split(path.sep).join('/')
          if (name === 'producer-receipt.json') continue
          proofRegularFile(file)
          const expected = receipt.files[name]
          if (!expected || proofFileHash(file) !== expected.sha256 || fs.statSync(file).size !== expected.sizeBytes) throw new Error(`Producer output hash/size mismatch: ${name}`)
          seen.add(name)
        }
      }
    }

    walk(candidate)
    if (Object.keys(receipt.files).some(name => !seen.has(name))) throw new Error('Producer receipt names missing or unsafe files')
    if (proofFileHash(path.join(candidate, 'protocol_context.json')) !== contextHash) throw new Error('Baked protocol context differs from selected input')
    for (const [file, expected] of Object.entries(selected.manifest.genericBundle.files)) {
      const actual = receipt.files[file]
      if (!actual || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) throw new Error(`Generic release file mismatch: ${file}`)
    }

    const worker = JSON.parse(fs.readFileSync(path.join(candidate, 'bridge/worker-identity-bundle.json'), 'utf8')) as {image_revision: string}
    if (worker.image_revision !== selected.manifest.source.revision) throw new Error('Baked Worker identity revision mismatch')
    const preparation = captureProofReleasePreparation({artifactRoot: candidate, expectedCoreRevision: selected.manifest.source.revision, output: path.join(candidate, 'proof-release-preparation-v1.json')})
    const rebase = (value: unknown): unknown => {
      if (typeof value === 'string' && value.startsWith(candidate + path.sep)) return target + value.slice(candidate.length)
      if (Array.isArray(value)) return value.map(item => rebase(item))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)]))
      return value
    }

    fs.writeFileSync(preparation.receiptPath, JSON.stringify(rebase(preparation.receipt), null, 2) + '\n')
    fs.copyFileSync(selected.path, path.join(candidate, 'dogeos-proof-release-v1.json'))
    if (proofFileHash(context) !== contextHash || proofFileHash(selected.path) !== selected.sha256) throw new Error('Preparation input changed during generation')
    fs.renameSync(candidate, target)
    return {outputDir: target, preparationReceipt: path.join(target, 'proof-release-preparation-v1.json'), releaseSha256: selected.sha256}
  } finally {
    if (fs.existsSync(cid)) {
      const id = fs.readFileSync(cid, 'utf8').trim()
      if (/^[\da-f]{64}$/.test(id)) {
        try { run(['rm', '--force', id]) } catch { /* --rm may already have removed it. */ }
      }
    }

    fs.rmSync(stage, {force: true, recursive: true})
  }
}
