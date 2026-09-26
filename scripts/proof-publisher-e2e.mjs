#!/usr/bin/env node
// Opt-in integration test: real prepared CLI files + the selected publisher
// image against a disposable MinIO on an internal Docker network. This is not
// a production publication receipt or a real-proof/signer acceptance result.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {publishProofConfig} from '../dist/utils/proof-config-transaction.js'

const [receipt, receiptSha256, reportPath] = process.argv.slice(2)
if (!receipt || !/^[a-f0-9]{64}$/.test(receiptSha256 ?? '') || !reportPath) {
  throw new Error('Usage: node scripts/proof-publisher-e2e.mjs PREPARED_RECEIPT SHA256 NEW_REPORT_PATH (run yarn build first)')
}
if (fs.existsSync(reportPath)) throw new Error('Report must be new')
const {publicationPlan: plan} = await publishProofConfig({apply: false, receipt, receiptSha256})
assert.match(plan.publisherImage, /^dogeos69\/proof-bundle-publisher@sha256:[a-f0-9]{64}$/)
assert.equal(plan.files.length, 11)
const root = path.dirname(path.resolve(receipt))
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-publisher-e2e-'))
const name = `proof-publisher-e2e-${randomBytes(6).toString('hex')}`
const minio = 'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e'
const bucket = 'proof-publisher-e2e'
const prefix = `programs/${plan.bundleId}`
const endpoint = 'http://proof-store:9000'
// Pass only disposable test credentials into the containers, never host AWS
// profiles, tokens, deployment endpoints, or a mounted Docker socket.
const env = {...process.env, AWS_ACCESS_KEY_ID: 'e2e-only', AWS_SECRET_ACCESS_KEY: randomBytes(32).toString('hex'), AWS_REGION: 'us-east-1'}
env.MINIO_ROOT_USER = env.AWS_ACCESS_KEY_ID
env.MINIO_ROOT_PASSWORD = env.AWS_SECRET_ACCESS_KEY
function docker(args, options = {}) {
  return (execFileSync('docker', args, {encoding: 'utf8', env, timeout: 600_000, maxBuffer: 4 * 1024 * 1024, ...options}) ?? '').trim()
}
const hash = body => createHash('sha256').update(body).digest('hex')
const containers = new Set()
let networkCreated = false
let storeCreated = false
const run = (args) => {
  const id = `${name}-${randomBytes(4).toString('hex')}`
  containers.add(id)
  try { return docker(['run', '--rm', '--name', id, ...args]) }
  finally { try { docker(['rm', '-f', id], {stdio: 'ignore'}) } catch {} }
}
const aws = args => run([
  '--network', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--user', `${process.getuid()}:${process.getgid()}`,
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
  '-e', 'AWS_ACCESS_KEY_ID', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'AWS_REGION', '-e', 'AWS_EC2_METADATA_DISABLED=true',
  '--mount', `type=bind,src=${temporary},dst=/input,readonly`,
  '--entrypoint', 'aws', plan.publisherImage, '--endpoint-url', endpoint, 's3api', ...args,
])
try {
  const bundle = path.join(temporary, 'bundle')
  for (const file of plan.files) {
    const source = path.resolve(root, file.source)
    const destination = path.resolve(bundle, file.relativePath)
    assert.ok(source.startsWith(root + path.sep) && destination.startsWith(bundle + path.sep))
    const body = fs.readFileSync(source)
    assert.equal(hash(body), file.sha256)
    assert.equal(body.length, file.sizeBytes)
    fs.mkdirSync(path.dirname(destination), {recursive: true})
    fs.writeFileSync(destination, body, {flag: 'wx'})
  }
  docker(['pull', minio])
  docker(['pull', plan.publisherImage])
  const metadata = JSON.parse(docker(['image', 'inspect', plan.publisherImage]))[0]
  assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], plan.coreRevision)
  assert.equal(metadata.Config.Labels['dogeos.proof-bundle.mapping'], 'v1-11-files')
  docker(['network', 'create', '--internal', '--label', 'dogeos.e2e.scope=cli-proof-publisher', name])
  networkCreated = true
  docker(['run', '-d', '--name', name, '--network', name, '--network-alias', 'proof-store',
    '--label', 'dogeos.e2e.scope=cli-proof-publisher',
    '-e', 'MINIO_ROOT_USER', '-e', 'MINIO_ROOT_PASSWORD',
    '--tmpfs', '/data:rw,nosuid,nodev,size=1g', minio, 'server', '/data'])
  storeCreated = true
  const address = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Networks[name].IPAddress
  assert.ok(address, 'isolated MinIO has no network address')
  const local = `http://${address}:9000`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(`${local}/minio/health/ready`, {signal: AbortSignal.timeout(1000)})).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(ready, 'isolated MinIO did not become ready')
  aws(['create-bucket', '--bucket', bucket])
  fs.writeFileSync(path.join(temporary, 'policy.json'), JSON.stringify({Version: '2012-10-17', Statement: [
    {Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`]},
  ]}))
  aws(['put-bucket-policy', '--bucket', bucket, '--policy', 'file:///input/policy.json'])
  const output = run([
    '--network', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', `type=bind,src=${bundle},dst=/bundle,readonly`,
    '-e', 'AWS_ACCESS_KEY_ID', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'AWS_REGION', '-e', 'AWS_EC2_METADATA_DISABLED=true',
    plan.publisherImage, '--bundle-dir', '/bundle', '--bucket', bucket, '--key-prefix', prefix,
    '--endpoint-url', endpoint, '--public-endpoint-url', endpoint, '--skip-bucket-setup',
  ])
  const pairs = output.split('\n').map(line => {
    const match = /^(DOGEOS_[A-Z0-9_]+_(?:URL|SHA256))=(\S+)$/.exec(line)
    assert.ok(match, 'unexpected publisher stdout')
    return [match[1], match[2]]
  })
  assert.equal(pairs.length, 22)
  const emitted = new Map(pairs)
  assert.equal(emitted.size, 22)
  for (const file of plan.files) {
    const objectPath = `/${bucket}/${prefix}/${file.relativePath}`
    assert.equal(emitted.get(`${file.prefix}_URL`), endpoint + objectPath)
    assert.equal(emitted.get(`${file.prefix}_SHA256`), file.sha256)
    const response = await fetch(local + objectPath, {signal: AbortSignal.timeout(30_000)})
    assert.equal(response.status, 200)
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(body.length, file.sizeBytes)
    assert.equal(hash(body), file.sha256)
  }
  const objects = JSON.parse(aws(['list-objects-v2', '--bucket', bucket, '--prefix', prefix])).Contents
  assert.deepEqual(objects.map(item => item.Key).sort(), plan.files.map(file => `${prefix}/${file.relativePath}`).sort())
  // A negative transport check ensures public readback wasn't accidentally
  // authenticated by the test process or an inherited AWS credential.
  aws(['delete-bucket-policy', '--bucket', bucket])
  assert.equal((await fetch(`${local}/${bucket}/${prefix}/${plan.files[0].relativePath}`, {signal: AbortSignal.timeout(5000)})).status, 403)
  const report = {
    schema: 'scrollsdk/proof-publisher-isolated-e2e/v1', result: 'passed', createdAt: new Date().toISOString(),
    preparedReceiptSha256: receiptSha256, releaseSha256: plan.releaseSha256, publisherImage: plan.publisherImage, minioImage: minio,
    fileCount: 11, verification: {authenticatedPublisherReadback: 'passed', anonymousReadback: 'passed', anonymousDeniedWithoutPolicy: 'passed'},
    scope: 'CLI frozen plan and publisher image; isolated MinIO. No CLI apply/final contract, GPU proof, CubeSigner, or existing deployment mutation.',
  }
  // Persist only after cleanup succeeds below.
  fs.writeFileSync(path.join(temporary, 'report.json'), JSON.stringify(report, null, 2) + '\n')
} finally {
  const failures = []
  for (const id of containers) {
    try { docker(['rm', '-f', id], {stdio: 'ignore'}) } catch {
      try { docker(['inspect', id], {stdio: 'ignore'}); failures.push(id) } catch {}
    }
  }
  if (storeCreated) { try { docker(['rm', '-f', name], {stdio: 'ignore'}) } catch { failures.push(name) } }
  if (networkCreated) { try { docker(['network', 'rm', name], {stdio: 'ignore'}) } catch { failures.push(`network ${name}`) } }
  if (failures.length) throw new Error(`E2E cleanup failed: ${failures.join(', ')}`)
  const report = path.join(temporary, 'report.json')
  if (fs.existsSync(report)) fs.copyFileSync(report, reportPath, fs.constants.COPYFILE_EXCL)
  fs.rmSync(temporary, {recursive: true, force: true})
}
console.log(`Isolated publisher E2E passed; report: ${reportPath}`)
