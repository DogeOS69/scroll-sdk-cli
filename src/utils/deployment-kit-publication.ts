import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {gzipSync} from 'node:zlib'

import type {ArtifactStore} from './artifact-stores.js'
import type {DeploymentKitRecord} from './deployment-kit.js'

import {AwsCliRunner} from './aws-cli.js'
import {DEPLOYMENT_KIT_MANIFEST_FILE, DEPLOYMENT_KIT_MANIFEST_SCHEMA, DEPLOYMENT_KIT_VERSION} from './deployment-kit.js'
import {digest, privateWrite} from './preparation-io.js'
import {normalizeProofBucketName, proofArtifactS3Endpoint} from './proof-aws-provisioner.js'
import {proofRegularFile} from './proof-software-release.js'

const FILES = ['advance-l2-agg-verifying-key.bin', 'deployment-kit.env', 'deployment-kit.json', 'protocol_context.json']
const MAX_BYTES = 64 * 1024 * 1024
type Policy = {Statement?: Record<string, unknown> | Record<string, unknown>[]; Version?: string}
export interface KitPublicationDependencies {
  anonymousRead?: (url: string) => Promise<Buffer>
  aws?: Pick<AwsCliRunner, 'json'>
}

/** Read exactly the already-exported kit, never adjacent operator files. */
export function readPublicationKit(kit: DeploymentKitRecord): Map<string, Buffer> {
  if (!DEPLOYMENT_KIT_VERSION.test(kit.kitVersion)) throw new Error('Invalid deployment kit version')
  const manifestBytes = fs.readFileSync(proofRegularFile(path.join(kit.kitDir, DEPLOYMENT_KIT_MANIFEST_FILE), MAX_BYTES))
  if (digest(manifestBytes) !== kit.manifestSha256) throw new Error('Deployment kit manifest changed')
  let manifest: {files: Array<{file: string; sha256: string; sizeBytes: number}>; schema: string}
  try {manifest = JSON.parse(manifestBytes.toString())} catch {throw new Error('Invalid kit manifest (contents omitted)')}
  const names = [...FILES, DEPLOYMENT_KIT_MANIFEST_FILE].sort()
  if (manifest.schema !== DEPLOYMENT_KIT_MANIFEST_SCHEMA || !Array.isArray(manifest.files)
    || !isDeepStrictEqual(manifest.files.map(entry => entry.file).sort(), FILES)
    || !isDeepStrictEqual(fs.readdirSync(kit.kitDir).sort(), names)) throw new Error('Deployment kit must contain exactly the canonical files')
  const files = new Map<string, Buffer>([[DEPLOYMENT_KIT_MANIFEST_FILE, manifestBytes]])
  let total = manifestBytes.length
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(proofRegularFile(path.join(kit.kitDir, entry.file), MAX_BYTES))
    total += bytes.length
    if (total > MAX_BYTES || entry.sizeBytes !== bytes.length || entry.sha256 !== `sha256:${digest(bytes)}`) throw new Error('Deployment kit content differs from its manifest')
    files.set(entry.file, bytes)
  }

  return files
}

/** Own a single version grant. Preserve all other policy statements exactly. */
export function kitReadPolicy(existing: Policy, bucket: string, version: string): Policy {
  normalizeProofBucketName(bucket)
  if (!DEPLOYMENT_KIT_VERSION.test(version)) throw new Error('Invalid deployment kit version')
  const statement = {
    Action: 's3:GetObject', Condition: {Bool: {'aws:SecureTransport': 'true'}}, Effect: 'Allow', Principal: '*',
    Resource: `arn:aws:s3:::${bucket}/deployment-kits/${version}/*`, Sid: `ScrollSdkKit${version.replaceAll('-', '')}`,
  }
  const statements = existing.Statement === undefined ? [] : Array.isArray(existing.Statement) ? existing.Statement : [existing.Statement]
  if (statements.some(value => !value || typeof value !== 'object')) throw new Error('Invalid bucket policy')
  const owned = statements.filter(value => value.Sid === statement.Sid)
  if (owned.length > 1 || (owned.length === 1 && !isDeepStrictEqual(owned[0], statement))) throw new Error('Deployment kit policy Sid conflicts with an existing statement')
  return {...existing, Statement: owned.length > 0 ? statements : [...statements, statement], Version: existing.Version ?? '2012-10-17'}
}

async function anonymousRead(url: string): Promise<Buffer> {
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(60_000)})
  if (!response.ok || !response.body) throw new Error('Published kit is not anonymously readable')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) throw new Error('Published kit exceeds the size limit')
      chunks.push(Buffer.from(value))
    }
  } finally {await reader.cancel()}

  return Buffer.concat(chunks)
}

/** Explicit S3 publication, safe to resume. No IAM, bucket creation or public-access-block changes. */
export async function publishDeploymentKit(kit: DeploymentKitRecord, store: ArtifactStore, profile?: string, dependencies: KitPublicationDependencies = {}): Promise<{manifest_sha256: string; url: string}> {
  const bucket = normalizeProofBucketName(store.bucket)
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(store.region)) throw new Error('Kit publication requires a commercial AWS region')
  const endpoint = proofArtifactS3Endpoint(store.region)
  if (store.endpointUrl && store.endpointUrl.replace(/\/$/, '') !== endpoint) throw new Error('Kit publication requires the regional AWS S3 endpoint')
  const files = readPublicationKit(kit)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollsdk-kit-publication-'))
  const aws = dependencies.aws ?? new AwsCliRunner(profile)
  const json = (args: string[]) => aws.json(args, {region: store.region})
  const keyPrefix = `deployment-kits/${kit.kitVersion}/`
  const policy = (): Policy => {
    let result: {Policy?: string}
    try {result = json(['s3api', 'get-bucket-policy', '--bucket', bucket])} catch (error) {
      if (/\(NoSuchBucketPolicy\)/.test(String(error))) return {}
      throw new Error('Cannot read deployment kit bucket policy (provider details omitted)')
    }

    try {
      const parsed = JSON.parse(result.Policy ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid policy mapping')
      return parsed
    } catch {throw new Error('Invalid deployment kit bucket policy (contents omitted)')}
  }

  try {
    for (const [name, bytes] of files) privateWrite(path.join(temp, name), bytes)
    // GNU tar's fixed metadata plus gzip's deterministic header gives stable retries.
    const tar = execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=0644', '-cf', '-', '-C', temp, ...[...files.keys()].sort()], {maxBuffer: MAX_BYTES})
    const archive = `deployment-kit-${kit.kitVersion}.tar.gz`
    files.set(archive, gzipSync(tar))
    privateWrite(path.join(temp, archive), files.get(archive)!)
    const previousPolicy = policy()
    const nextPolicy = kitReadPolicy(previousPolicy, bucket, kit.kitVersion)
    const remote = path.join(temp, 'remote-object')
    const matches = (name: string): boolean => {
      try {json(['s3api', 'get-object', '--bucket', bucket, '--key', keyPrefix + name, remote])} catch (error) {
        if (/\(NoSuchKey\)|\(404\)/.test(String(error))) return false
        throw new Error('Cannot read existing kit object (provider details omitted)')
      }

      if (fs.statSync(remote).size !== files.get(name)!.length || !fs.readFileSync(remote).equals(files.get(name)!)) throw new Error(`Published kit object conflicts: ${name}; existing versions are never overwritten`)
      return true
    }

    // Check every existing object before the first write.
    const missing = [...files.keys()].filter(name => !matches(name))
    for (const name of missing) {
      try {json(['s3api', 'put-object', '--bucket', bucket, '--key', keyPrefix + name, '--body', path.join(temp, name), '--if-none-match', '*', '--content-type', name.endsWith('.tar.gz') ? 'application/gzip' : 'application/octet-stream'])} catch {
        // A concurrent identical publisher is safe; an ambiguous failure is not success.
        if (!matches(name)) throw new Error('Kit upload failed (provider details omitted)')
      }

      if (!matches(name)) throw new Error('Kit upload readback failed')
    }

    if (!isDeepStrictEqual(previousPolicy, nextPolicy)) {
      if (!isDeepStrictEqual(policy(), previousPolicy)) throw new Error('Bucket policy changed during publication; retry to preserve the new statements')
      privateWrite(path.join(temp, 'policy.json'), JSON.stringify(nextPolicy))
      try {json(['s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', `file://${path.join(temp, 'policy.json')}`])} catch {throw new Error('Cannot grant kit HTTPS reads; check bucket/account public-access policy (provider details omitted)')}
    }

    const base = `${endpoint}/${bucket}/${keyPrefix}`
    for (const [name, bytes] of files) {
      let fetched: Buffer
      try {fetched = await (dependencies.anonymousRead ?? anonymousRead)(base + name)} catch {throw new Error(`Anonymous kit readback failed: ${name}`)}
      if (!fetched.equals(bytes)) throw new Error(`Anonymous kit readback differs: ${name}`)
    }

    readPublicationKit(kit)
    return {manifest_sha256: kit.manifestSha256, url: base + archive}
  } finally {fs.rmSync(temp, {force: true, recursive: true})}
}
