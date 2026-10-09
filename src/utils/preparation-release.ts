import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {digest, privateWrite} from './preparation-io.js'
import {parseImmutableProofImage} from './proof-materials.js'
import {readProofSoftwareRelease, validateProofSoftwareRelease} from './proof-software-release.js'

const RELEASE_REPOSITORY = 'DogeOS69/dogeos-core'
const MANIFEST = 'dogeos-proof-release-v1.json'

export interface ProofReleaseLookupOptions {
  cacheDirectory?: string
  fetch?: typeof fetch
}

/** Resolve a human version through the official release; the checksum is publisher-owned. */
export async function downloadProofRelease(version: string, options: ProofReleaseLookupOptions = {}): Promise<{manifest: string; sha256: string}> {
  if (!/^v\d+\.\d+\.\d+(?:-[\d.A-Za-z-]+)?$/.test(version)) throw new Error('proofRelease.version must be an explicit version such as v0.3.0-beta.6')
  const tag = `proof-release-${version}`
  const base = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const request = async (url: string, accept: string, limit: number): Promise<string> => {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(url, {headers: {Accept: accept, ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: AbortSignal.timeout(30_000)})
    } catch {throw new Error(`Unable to read official proof release ${tag}; check GitHub connectivity`)}

    if (response.status === 404) throw new Error(`Official proof release ${RELEASE_REPOSITORY}/${tag} is unavailable. The core release owner must publish its manifest and checksum (or check private-repository access); operators do not supply an invented SHA256.`)
    if (!response.ok) throw new Error(`Official proof release lookup failed (HTTP ${response.status}); check GitHub access/rate limits`)
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Proof release response is too large')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Proof release response is empty')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) {await reader.cancel(); throw new Error('Proof release response is too large')}
        chunks.push(value)
      }
    } finally {reader.releaseLock()}

    return Buffer.concat(chunks).toString('utf8')
  }

  const metadata = JSON.parse(await request(`${base}/tags/${tag}`, 'application/vnd.github+json', 1024 * 1024)) as {assets?: Array<{id: number; name: string}>; draft?: boolean; tag_name?: string}
  if (metadata.draft || metadata.tag_name !== tag || !Array.isArray(metadata.assets)) throw new Error('Official proof release metadata does not match the selected version')
  const assetUrl = (name: string): string => {
    const assets = metadata.assets!.filter(asset => asset.name === name)
    if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id) || assets[0].id <= 0) throw new Error(`Official proof release ${tag} is missing ${name}; the core release owner must publish it`)
    return `${base}/assets/${assets[0].id}`
  }

  const manifestUrl = assetUrl(MANIFEST); const checksumUrl = assetUrl(`${MANIFEST}.sha256`)
  const [text, checksum] = await Promise.all([request(manifestUrl, 'application/octet-stream', 4 * 1024 * 1024), request(checksumUrl, 'application/octet-stream', 4096)])
  const match = checksum.trim().match(/^([\da-f]{64})\s+\*?dogeos-proof-release-v1\.json$/)
  if (!match || digest(text) !== match[1]) throw new Error('Official proof release manifest digest mismatch')
  validateProofSoftwareRelease(JSON.parse(text))
  const cache = options.cacheDirectory ?? path.join(os.homedir(), '.cache/scrollsdk/proof-releases')
  const manifest = path.resolve(cache, match[1], MANIFEST)
  if (!fs.existsSync(manifest)) privateWrite(manifest, text)
  readProofSoftwareRelease(manifest, match[1])
  return {manifest, sha256: match[1]}
}

/** Plan may read GitHub and cache verified public artifacts; it never runs release tools. */
export async function resolvePreparationProofRelease(spec: DeploymentSpec, output: string, options: ProofReleaseLookupOptions = {}): Promise<DeploymentSpec> {
  const release = spec.preparation?.proofRelease
  if (!release) return spec
  if (!spec.proofTopology) throw new Error('proofRelease requires proofTopology')
  if (release.version !== undefined && (release.manifest !== undefined || release.sha256 !== undefined)) throw new Error('Choose proofRelease.version or offline manifest + sha256, not both')
  const pinned = release.version === undefined ? release : await downloadProofRelease(release.version, options)
  if (!pinned.manifest || !pinned.sha256) throw new Error('proofRelease requires version, or an offline manifest + sha256 pair')
  const selected = readProofSoftwareRelease(path.resolve(output, pinned.manifest), pinned.sha256)
  const result = structuredClone(spec)
  const topology = result.proofTopology!
  const compiler = parseImmutableProofImage(selected.manifest.images['dogeos-proof-topology'], 'release compiler')
  const worker = parseImmutableProofImage(selected.manifest.images['prover-worker-cuda'], 'release Worker')
  for (const [declared, expected, label] of [[topology.compiler?.image, compiler, 'compiler'], [topology.deployment.productionWorkerImage, worker, 'Worker']] as const) {
    if (declared && (declared.repository !== expected.repository || declared.digest !== expected.digest)) throw new Error(`Explicit ${label} image conflicts with proofRelease`)
  }

  topology.compiler = {image: compiler}
  topology.deployment.productionWorkerImage = worker
  result.preparation!.proofRelease = {manifest: selected.path, sha256: selected.sha256}
  return result
}
