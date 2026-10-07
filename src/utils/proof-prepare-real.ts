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
  const {revision} = selected.manifest
  const image = selected.manifest.images['proof-preparation-producer']
  const cid = path.join(stage, 'container.id')
  try {
    if (/[\n\r,]/.test(stage)) throw new Error('Unsupported container mount path')
    fs.mkdirSync(path.join(stage, 'input'))
    fs.mkdirSync(path.join(stage, 'output'))
    fs.copyFileSync(context, path.join(stage, 'input/protocol_context.json'))
    run(['pull', image])
    const imageRevision = run(['image', 'inspect', image, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']).trim()
    if (imageRevision !== revision) throw new Error('Producer OCI revision differs from release')
    // The producer's own invocation: offline, writing a new directory it chowns to the mount's owner.
    run([
      'run', '--rm', '--cidfile', cid, '--network', 'none',
      '--mount', `type=bind,src=${path.join(stage, 'input/protocol_context.json')},dst=/in/protocol_context.json,readonly`,
      '--mount', `type=bind,src=${path.join(stage, 'output')},dst=/out`,
      image, '/in/protocol_context.json', '/out/artifacts',
    ])
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Producer output contains a symlink')
        if (entry.isDirectory()) walk(file)
        else proofRegularFile(file)
      }
    }

    walk(candidate)
    if (proofFileHash(path.join(candidate, 'protocol_context.json')) !== contextHash) throw new Error('Baked protocol context differs from selected input')
    const preparation = captureProofReleasePreparation({artifactRoot: candidate, expectedCoreRevision: revision, output: path.join(candidate, 'proof-release-preparation-v1.json')})
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
