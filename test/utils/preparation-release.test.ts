import {expect} from 'chai'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {downloadProofRelease, resolvePreparationProofRelease} from '../../src/utils/preparation-release.js'
import {PROOF_RELEASE_IMAGE_NAMES} from '../../src/utils/proof-software-release.js'

const manifestText = JSON.stringify({images: Object.fromEntries(PROOF_RELEASE_IMAGE_NAMES.map(name => [name, `example.invalid/${name}@sha256:${'b'.repeat(64)}`])), revision: 'a'.repeat(40), schema: 'dogeos/proof-release/v1'})
const sha256 = createHash('sha256').update(manifestText).digest('hex')
const name = 'dogeos-proof-release-v1.json'
const tag = 'proof-release-v0.3.0-beta.6'
const metadata = {assets: [{id: 1, name}, {id: 2, name: `${name}.sha256`}], draft: false, tag_name: tag}

async function rejected(action: () => Promise<unknown>, message: string): Promise<void> {
  let error: unknown
  try {await action()} catch (error_) {error = error_}
  expect(error).to.be.instanceOf(Error)
  expect((error as Error).message).to.include(message)
}

describe('official preparation proof release', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-lookup-'))})
  afterEach(() => {fs.rmSync(root, {force: true, recursive: true})})

  const responseFor = (url: string) => url.includes('/tags/') ? JSON.stringify(metadata) : url.endsWith('/1') ? manifestText : `${sha256}  ${name}\n`

  it('resolves a version, verifies the published checksum and freezes only local pins', async () => {
    const calls: string[] = []
    const fetcher = (async (input: Request | URL | string) => {calls.push(String(input)); return new Response(responseFor(String(input)))}) as typeof fetch
    const spec = {preparation: {proofRelease: {version: 'v0.3.0-beta.6'}}, proofTopology: {deployment: {}}} as DeploymentSpec
    const expanded = await resolvePreparationProofRelease(spec, root, {cacheDirectory: root, fetch: fetcher})
    expect(calls).to.have.length(3)
    expect(calls.every(url => url.startsWith('https://api.github.com/repos/DogeOS69/dogeos-core/releases/'))).to.equal(true)
    expect(calls[0].endsWith(`/tags/${tag}`)).to.equal(true)
    expect(expanded.preparation!.proofRelease!.sha256).to.equal(sha256)
    expect(expanded.preparation!.proofRelease).not.to.have.property('version')
    expect(expanded.proofTopology!.compiler.image.digest).to.equal(`sha256:${'b'.repeat(64)}`)
    expect(spec.preparation!.proofRelease!.version).to.equal('v0.3.0-beta.6')
    const file = expanded.preparation!.proofRelease!.manifest!
    expect(fs.statSync(file).mode.toString(8).slice(-3)).to.equal('600')
    await resolvePreparationProofRelease(expanded, root, {fetch: (async () => {throw new Error('must stay offline')}) as typeof fetch})
    fs.appendFileSync(file, ' ')
    await rejected(() => resolvePreparationProofRelease(expanded, root), 'digest mismatch')
  })

  it('reports unavailable releases and missing publisher assets without asking operators for a digest', async () => {
    await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: root, fetch: (async () => new Response('', {status: 404})) as typeof fetch}), 'core release owner must publish')
    await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: root, fetch: (async () => new Response(JSON.stringify({...metadata, assets: []}))) as typeof fetch}), `missing ${name}`)
    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('supports a symlinked cache root and freezes the physical manifest path', async () => {
    const cache = path.join(root, 'physical-cache')
    const linked = path.join(root, 'linked-cache')
    fs.mkdirSync(cache)
    fs.symlinkSync(cache, linked, 'dir')
    const fetcher = (async (input: Request | URL | string) => new Response(responseFor(String(input)))) as typeof fetch
    const selected = await downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: linked, fetch: fetcher})
    expect(selected.manifest).to.equal(path.join(fs.realpathSync(cache), sha256, name))
    expect(fs.readFileSync(selected.manifest, 'utf8')).to.equal(manifestText)
  })

  it('rejects linked artifact directories and files within the cache', async () => {
    const fetcher = (async (input: Request | URL | string) => new Response(responseFor(String(input)))) as typeof fetch
    const outside = path.join(root, 'outside')
    const cache = path.join(root, 'cache')
    fs.mkdirSync(outside)
    fs.mkdirSync(cache)
    fs.symlinkSync(outside, path.join(cache, sha256), 'dir')
    await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: cache, fetch: fetcher}), 'symlinks')
    expect(fs.readdirSync(outside)).to.deep.equal([])
    fs.unlinkSync(path.join(cache, sha256))
    fs.mkdirSync(path.join(cache, sha256))
    fs.writeFileSync(path.join(outside, name), manifestText)
    fs.symlinkSync(path.join(outside, name), path.join(cache, sha256, name))
    await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: cache, fetch: fetcher}), 'symlinks')
  })

  it('rejects changed manifest bytes and a checksum naming a different artifact', async () => {
    for (const checksum of [`${'0'.repeat(64)}  ${name}`, `${sha256}  other.json`]) {
      const fetcher = (async (input: Request | URL | string) => new Response(String(input).endsWith('/2') ? checksum : responseFor(String(input)))) as typeof fetch
      await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: root, fetch: fetcher}), 'digest mismatch')
    }

    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('rejects ambiguous selection and moving aliases before any network request', async () => {
    const fetcher = (async () => {throw new Error('must not fetch')}) as typeof fetch
    await rejected(() => downloadProofRelease('latest', {fetch: fetcher}), 'explicit version')
    const spec = {preparation: {proofRelease: {manifest: 'input.json', sha256, version: 'v0.3.0-beta.6'}}, proofTopology: {deployment: {}}} as DeploymentSpec
    await rejected(() => resolvePreparationProofRelease(spec, root, {fetch: fetcher}), 'not both')
  })

  it('rejects draft or mismatched releases and oversized responses', async () => {
    for (const invalid of [{...metadata, draft: true}, {...metadata, tag_name: 'other'}]) {
      await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: root, fetch: (async () => new Response(JSON.stringify(invalid))) as typeof fetch}), 'metadata')
    }

    await rejected(() => downloadProofRelease('v0.3.0-beta.6', {cacheDirectory: root, fetch: (async () => new Response('', {headers: {'content-length': '99999999'}})) as typeof fetch}), 'too large')
  })
})
