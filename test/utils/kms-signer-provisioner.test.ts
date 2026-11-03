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
  let tags: any[]
  let lifecycle: any
  let keyState: string
  const metadata = () => ({Arn: keyArn, KeyId: 'fixture', KeySpec: 'ECC_SECG_P256K1', KeyState: keyState, KeyUsage: 'SIGN_VERIFY'})
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-resource-'))
    calls = []; exists = false; alias = undefined; tags = []; lifecycle = undefined
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

        case 'get-bucket-lifecycle-configuration': {
          if (!lifecycle) throw new Error('NoSuchLifecycleConfiguration')
          return lifecycle
        }

        default: { throw new Error(`Unexpected operation ${args[0]} ${args[1]}`)
        }
      }
    }

    provisioner.aws = (args: string[]) => {
      calls.push(args)
      if (args[1] === 'head-bucket') return ''
      throw new Error(`Unexpected operation ${args[0]} ${args[1]}`)
    }
  })
  // A key an earlier CLI version created for this deployment, found through its alias.
  const ownedKey = () => {
    exists = true; alias = 'fixture'
    tags = Object.entries({CatalogEntry: role.aliasSuffix, Cluster: identity.eksCluster, Deployment: identity.networkAlias, ManagedBy: 'scrollsdk'}).map(([TagKey, TagValue]) => ({TagKey, TagValue}))
  }

  const mutated = (from = 0) => calls.slice(from).some(args => /^(create|update|put|delete|tag)-/.test(args[1]))
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('never creates a missing signing key and points to the infrastructure template', async () => {
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('infrastructure signing-key template')}
    expect(mutated()).to.equal(false)
    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('reuses an existing deployment-owned key through its alias and pins it in a private record', async () => {
    ownedKey()
    const first = await provisioner.provision(role, identity)
    const second = await provisioner.provision(role, identity)
    expect(second).to.deep.equal(first)
    expect(first.owned).to.equal(true)
    expect(first.signerConfig.kmsKeyId).to.equal(keyArn)
    expect(first.signerConfig).not.to.have.property('serviceAccountRoleArn')
    expect(mutated()).to.equal(false)
    expect(calls.some(args => args[0] === 'iam')).to.equal(false)
    expect(fs.statSync(path.join(root, fs.readdirSync(root)[0])).mode % 0o1000).to.equal(0o600)
  })

  it('rejects a disabled saved key without creating a replacement', async () => {
    ownedKey()
    await provisioner.provision(role, identity)
    keyState = 'Disabled'
    expect(provisioner.inspectAddress(region, keyArn)).to.match(/^0x[\dA-Fa-f]{40}$/)
    const count = calls.length
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('must be enabled')}
    expect(mutated(count)).to.equal(false)
  })

  it('does not replace a saved key that has disappeared', async () => {
    ownedKey()
    await provisioner.provision(role, identity)
    exists = false; alias = undefined
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('NotFoundException')}
    expect(mutated()).to.equal(false)
  })

  it('refuses a saved key whose alias now points to a different key', async () => {
    ownedKey()
    await provisioner.provision(role, identity)
    alias = 'another-key'
    const count = calls.length
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('refusing to use it')}
    expect(mutated(count)).to.equal(false)
  })

  it('only implicitly reuses aliases belonging to this deployment', async () => {
    exists = true; alias = 'fixture'
    try {await provisioner.provision(role, identity); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('did not create')}
    expect(mutated()).to.equal(false)
  })

  it('resolves an explicitly supplied key to its ARN without changing the key or alias', async () => {
    exists = true
    const result = await provisioner.provision(role, identity, {kmsKeyId: 'alias/operator-owned'})
    expect(result.owned).to.equal(false)
    expect(result.signerConfig.kmsKeyId).to.equal(keyArn)
    expect(calls.map(args => args[1])).to.deep.equal(['describe-key'])
    expect(fs.readdirSync(root)).to.deep.equal([])
  })

  it('normalizes archive prefixes and checks the existing bucket and retention without writing', async () => {
    const archive = {bucket: 'fixture-bucket', created: false, enabled: true, keyPrefix: ' /instances//one/ '}
    await provisioner.provisionArchive(archive)
    expect(archive.keyPrefix).to.equal('instances/one')
    expect(calls.map(args => args[1])).to.deep.equal(['head-bucket', 'get-bucket-lifecycle-configuration'])
    lifecycle = {Rules: [{Expiration: {Days: 30}, Filter: {Prefix: 'instances/'}, ID: 'Expire', Status: 'Enabled'}]}
    try {await provisioner.provisionArchive(archive); expect.fail('must fail')} catch (error) {expect(String(error)).to.include('must be retained')}
    expect(mutated()).to.equal(false)
    expect(calls.some(args => args[0] === 'iam')).to.equal(false)
  })

  it('rejects unsafe archive prefixes before any AWS operation', async () => {
    for (const keyPrefix of ['instances/*', 'instances/../other', 'instances/%2f', 'instances/a b']) {
      try {await provisioner.provisionArchive({bucket: 'fixture-bucket', created: false, enabled: true, keyPrefix}); expect.fail('must fail')}
      catch (error) {expect(String(error)).to.include('S3 archive key prefix')}
    }

    expect(calls).to.have.length(0)
  })
})
