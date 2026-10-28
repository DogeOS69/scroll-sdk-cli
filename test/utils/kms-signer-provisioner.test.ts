/* eslint-disable @typescript-eslint/no-explicit-any -- In-memory KMS and S3 responses. */
import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {getAttestationSignerKmsRole} from '../../src/utils/attestation-kms.js'
import {JsonOutputContext} from '../../src/utils/json-output.js'
import {KmsSignerProvisioner} from '../../src/utils/kms-signer-provisioner.js'

const region = 'us-west-2'
const keyArn = `arn:aws:kms:${region}:000000000000:key/fixture`
const role = getAttestationSignerKmsRole(0)
const identity = {awsRegion: region, eksCluster: 'cluster', namespace: 'fixture', networkAlias: 'fixture'}
const aliasName = 'alias/dogeos/fixture/cluster/attestation-signer-0'

describe('KMS resource preparation', () => {
  let root: string
  let provisioner: any
  let calls: string[][]
  let exists: boolean
  let alias: string | undefined
  let failAlias: boolean
  let tags: any[]
  let lifecycle: any
  let keyState: string
  const metadata = () => ({Arn: keyArn, KeyId: 'fixture', KeySpec: 'ECC_SECG_P256K1', KeyState: keyState, KeyUsage: 'SIGN_VERIFY'})
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-resource-'))
    calls = []; exists = false; alias = undefined; failAlias = false; tags = []; lifecycle = undefined
    keyState = 'Enabled'
    provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true), undefined, root)
    const publicKey = generateKeyPairSync('ec', {namedCurve: 'secp256k1'}).publicKey.export({format: 'der', type: 'spki'}).toString('base64')
    provisioner.fetchKmsPublicKey = () => publicKey
    provisioner.awsJson = (args: string[]) => {
      calls.push(args)
      switch (args[1]) {
        case 'list-aliases': { return {Aliases: alias ? [{AliasName: aliasName, TargetKeyId: alias}] : []}
        }

        case 'describe-key': {
          if (!exists) throw new Error('NotFoundException')
          return {KeyMetadata: metadata()}
        }

        case 'list-resource-tags': { return {Tags: tags}
        }

        case 'create-key': {
          exists = true
          tags = JSON.parse(args[args.indexOf('--tags') + 1])
          return {KeyMetadata: metadata()}
        }

        case 'create-alias': {
          // The immutable identity must be durable before an alias write.
          expect(JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), 'utf8')).keyArn).to.equal(keyArn)
          if (failAlias) throw new Error('Injected alias failure')
          alias = 'fixture'
          return {}
        }

        case 'get-bucket-lifecycle-configuration': {
          if (!lifecycle) throw new Error('NoSuchLifecycleConfiguration')
          return lifecycle
        }

        case 'put-bucket-lifecycle-configuration': {
          lifecycle = JSON.parse(args[args.indexOf('--lifecycle-configuration') + 1]); return {}
        }

        default: { throw new Error(`Unexpected operation ${args[0]} ${args[1]}`)
        }
      }
    }
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('reuses one immutable key across alias failure and repeated successful preparation', async () => {
    failAlias = true
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('Injected alias failure')}
    expect(exists).to.equal(true)
    failAlias = false
    const first = await provisioner.provision(role, identity)
    const second = await provisioner.provision(role, identity)
    expect(second).to.deep.equal(first)
    expect(first.signerConfig.kmsKeyId).to.equal(keyArn)
    expect(first.signerConfig).not.to.have.property('serviceAccountRoleArn')
    expect(calls.filter(args => args[1] === 'create-key')).to.have.length(1)
    expect(calls.some(args => args[0] === 'iam')).to.equal(false)
    expect(fs.statSync(path.join(root, fs.readdirSync(root)[0])).mode % 0o1000).to.equal(0o600)
  })

  it('rejects a disabled saved key without creating a replacement', async () => {
    await provisioner.provision(role, identity)
    keyState = 'Disabled'
    expect(provisioner.inspectAddress(region, keyArn)).to.match(/^0x[\dA-Fa-f]{40}$/)
    const count = calls.length
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('must be enabled')}
    expect(calls.slice(count).some(args => /^(create|update|put|delete)-/.test(args[1]))).to.equal(false)
  })

  it('does not replace a saved key that has disappeared', async () => {
    await provisioner.provision(role, identity)
    exists = false; alias = undefined
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('NotFoundException')}
    expect(calls.filter(args => args[1] === 'create-key')).to.have.length(1)
  })

  it('refuses to retarget an alias away from a different key', async () => {
    await provisioner.provision(role, identity)
    alias = 'another-key'
    const count = calls.length
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('refusing to retarget')}
    expect(calls.slice(count).some(args => /^(create|update|put|delete)-/.test(args[1]))).to.equal(false)
  })

  it('only implicitly reuses aliases belonging to this deployment', async () => {
    exists = true; alias = 'fixture'
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('did not create')}
    expect(calls.some(args => /^(create|update|put|delete)-/.test(args[1]))).to.equal(false)
  })

  it('resolves an explicitly supplied key to its ARN without changing the key or alias', async () => {
    exists = true
    const result = await provisioner.provision(role, identity, {kmsKeyId: 'alias/operator-owned'})
    expect(result.owned).to.equal(false)
    expect(result.signerConfig.kmsKeyId).to.equal(keyArn)
    expect(calls.map(args => args[1])).to.deep.equal(['describe-key'])
    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('normalizes archive prefixes and reconciles retention without writing IAM grants', async () => {
    const archive = {bucket: 'fixture-bucket', created: false, enabled: true, keyPrefix: ' /instances//one/ '}
    await provisioner.provisionArchive(archive, {createBucket: false})
    const before = structuredClone(lifecycle)
    await provisioner.provisionArchive(archive, {createBucket: false})
    expect(archive.keyPrefix).to.equal('instances/one')
    expect(lifecycle).to.deep.equal(before)
    expect(calls.filter(args => args[1] === 'put-bucket-lifecycle-configuration')).to.have.length(1)
    expect(calls.some(args => args[0] === 'iam')).to.equal(false)
  })

  it('rejects unsafe archive prefixes before any AWS operation', async () => {
    for (const keyPrefix of ['instances/*', 'instances/../other', 'instances/%2f', 'instances/a b']) {
      try {await provisioner.provisionArchive({bucket: 'fixture-bucket', created: false, enabled: true, keyPrefix}, {createBucket: true}); expect.fail('must fail')}
      catch (error) {expect(String(error)).to.include('S3 archive key prefix')}
    }

    expect(calls).to.have.length(0)
  })
})
