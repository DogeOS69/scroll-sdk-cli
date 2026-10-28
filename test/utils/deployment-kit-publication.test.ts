import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentKitRecord} from '../../src/utils/deployment-kit.js'

import {DEPLOYMENT_KIT_MANIFEST_FILE, DEPLOYMENT_KIT_MANIFEST_SCHEMA} from '../../src/utils/deployment-kit.js'
import {publishDeploymentKit} from '../../src/utils/deployment-kit-publication.js'
import {digest} from '../../src/utils/preparation-io.js'

describe('immutable S3 deployment kit publication', () => {
  let root: string
  let kit: DeploymentKitRecord
  let objects: Map<string, Buffer>
  let writes: string[]
  let policy: Record<string, unknown>
  const store = {bucket: 'fixture-kit-bucket', forcePathStyle: false, keyPrefix: 'proofs/isolated', region: 'us-east-1'}
  const unrelated = {Action: 's3:GetObject', Effect: 'Allow', Principal: {AWS: 'arn:aws:iam::000000000000:root'}, Resource: 'arn:aws:s3:::fixture-kit-bucket/private/*', Sid: 'Preserve'}
  const prefix = (version: string) => `proofs/isolated/deployment-kits/${version}/`
  const names = ['advance-l2-agg-verifying-key.bin', 'deployment-kit.env', 'deployment-kit.json', 'protocol_context.json']
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-publication-test-'))
    const files = names.map(file => {
      const bytes = Buffer.from(`public fixture ${file}\n`)
      fs.writeFileSync(path.join(root, file), bytes)
      return {file, sha256: `sha256:${digest(bytes)}`, sizeBytes: bytes.length}
    })
    const manifest = JSON.stringify({files, schema: DEPLOYMENT_KIT_MANIFEST_SCHEMA})
    fs.writeFileSync(path.join(root, DEPLOYMENT_KIT_MANIFEST_FILE), manifest)
    kit = {kitDir: root, kitVersion: 'k-0123456789ab', manifestSha256: digest(manifest), network: 'testnet', protocolInstanceId: 'unused'}
    objects = new Map(); writes = []; policy = {Statement: [unrelated], Version: '2012-10-17'}
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const aws = {json(args: string[]) {
    const value = (key: string) => args[args.indexOf(key) + 1]
    const key = value('--key')
    switch (args[1]) {
      case 'get-bucket-policy': { return {Policy: JSON.stringify(policy)}
      }

      case 'put-bucket-policy': { policy = JSON.parse(fs.readFileSync(value('--policy').slice(7), 'utf8')); writes.push('policy'); return {}
      }

      case 'get-object': {
        const bytes = objects.get(key)
        if (!bytes) throw new Error('(NoSuchKey) absent')
        fs.writeFileSync(args.at(-1)!, bytes); return {}
      }

      case 'put-object': {
        expect(value('--if-none-match')).to.equal('*')
        if (objects.has(key)) throw new Error('(PreconditionFailed) exists')
        objects.set(key, fs.readFileSync(value('--body'))); writes.push(key); return {}
      }

      default: { throw new Error('Unexpected cloud operation')
      }
    }
  }}
  const anonymousRead = async (url: string) => objects.get(new URL(url).pathname.split('/').slice(2).join('/'))!
  const run = (read = anonymousRead) => publishDeploymentKit(kit, store, undefined, {anonymousRead: read, aws})
  const failure = async (action: () => Promise<unknown>) => {try {await action(); return ''} catch (error) {return String(error)}}

  it('publishes only the five kit files and deterministic archive, preserves policy, verifies and reuses identical versions', async () => {
    const published = await run()
    expect(published).to.deep.equal({manifest_sha256: kit.manifestSha256, url: `https://s3.us-east-1.amazonaws.com/${store.bucket}/${prefix(kit.kitVersion)}deployment-kit-${kit.kitVersion}.tar.gz`})
    expect(objects.size).to.equal(6)
    expect([...objects.keys()].every(key => key.startsWith(`${prefix(kit.kitVersion)}`))).to.equal(true)
    expect(policy.Statement).to.deep.equal([unrelated])
    const tar = objects.get(`${prefix(kit.kitVersion)}deployment-kit-${kit.kitVersion}.tar.gz`)!
    expect(execFileSync('tar', ['-tzf', '-'], {encoding: 'utf8', input: tar}).trim().split('\n')).to.deep.equal([...names, DEPLOYMENT_KIT_MANIFEST_FILE].sort())
    const before = [...writes]
    expect(await run()).to.deep.equal(published)
    expect(writes).to.deep.equal(before)
  })

  it('rejects every existing conflicting object before any mutation', async () => {
    objects.set(`${prefix(kit.kitVersion)}protocol_context.json`, Buffer.from('other deployment'))
    expect(await failure(() => run())).to.include('conflicts')
    expect(writes).to.deep.equal([])
  })

  it('resumes partial uploads but refuses mismatched anonymous bytes', async () => {
    objects.set(`${prefix(kit.kitVersion)}deployment-kit.env`, fs.readFileSync(path.join(root, 'deployment-kit.env')))
    expect(await failure(() => run(async () => Buffer.from('wrong')))).to.include('readback differs')
    expect(objects.size).to.equal(6)
    expect((await run()).manifest_sha256).to.equal(kit.manifestSha256)
  })

  it('rejects extra private files, symlinks, changed bytes and manifest traversal before cloud calls', async () => {
    fs.writeFileSync(path.join(root, 'private.env'), 'NONFUNCTIONAL_TEST_SECRET')
    expect(await failure(() => run())).to.include('exactly the canonical files')
    fs.unlinkSync(path.join(root, 'private.env'))
    const file = path.join(root, names[0])
    const content = fs.readFileSync(file)
    fs.unlinkSync(file); fs.symlinkSync(path.join(root, names[1]), file)
    expect(await failure(() => run())).not.to.equal('')
    fs.unlinkSync(file); fs.writeFileSync(file, Buffer.concat([content, Buffer.from('changed')]))
    expect(await failure(() => run())).to.include('differs from its manifest')
    expect(writes).to.deep.equal([])
  })

  it('does not treat access denial as a missing policy or object and omits provider details', async () => {
    expect(await failure(() => publishDeploymentKit(kit, store, undefined, {aws: {json() {throw new Error('(AccessDenied) NONFUNCTIONAL_TEST_SECRET')}}}))).to.include('provider details omitted').and.not.to.include('NONFUNCTIONAL_TEST_SECRET')
    expect(writes).to.deep.equal([])
  })

})
