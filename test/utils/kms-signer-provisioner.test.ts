import { expect } from 'chai'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getAttestationSignerKmsRole } from '../../src/utils/attestation-kms.js'
import { JsonOutputContext } from '../../src/utils/json-output.js'
import { KmsSignerProvisioner } from '../../src/utils/kms-signer-provisioner.js'

describe('KMS signer provisioner', () => {
  let originalPath: string | undefined
  let tempDir: string

  beforeEach(() => {
    originalPath = process.env.PATH
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-provisioner-'))
    const awsPath = path.join(tempDir, 'aws')
    fs.writeFileSync(awsPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$AWS_TEST_LOG"
case "$*" in
  "kms list-aliases"*) printf '%s\\n' '{"Aliases":[]}' ;;
  "kms create-key"*) printf '%s\\n' '{"KeyMetadata":{"Arn":"arn:aws:kms:us-west-2:123456789012:key/key-123","KeyId":"key-123"}}' ;;
  "kms create-alias"*) printf '%s\\n' '{}' ;;
  "kms get-public-key"*) printf '%s\\n' "$AWS_TEST_PUBLIC_KEY" ;;
  "sts get-caller-identity"*) printf '%s\\n' '123456789012' ;;
  "eks describe-cluster"*) printf '%s\\n' 'https://oidc.eks.us-west-2.amazonaws.com/id/EXAMPLE' ;;
  "iam get-role"*) printf '%s\\n' 'NoSuchEntity' >&2; exit 254 ;;
  "iam create-role"*) printf '%s\\n' '{}' ;;
  "iam put-role-policy"*) printf '%s\\n' '{}' ;;
  *) printf 'Unsupported fake AWS command: %s\\n' "$*" >&2; exit 2 ;;
esac
`, { mode: 0o755 })
    process.env.PATH = `${tempDir}:${originalPath}`
    process.env.AWS_TEST_LOG = path.join(tempDir, 'aws.log')
    process.env.AWS_TEST_PUBLIC_KEY = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
      .publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  })

  afterEach(() => {
    process.env.PATH = originalPath
    delete process.env.AWS_TEST_LOG
    delete process.env.AWS_TEST_PUBLIC_KEY
    fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('creates a KMS key, alias, and IRSA role when overrides are omitted', async () => {
    const provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true), 'test-profile')
    const result = await provisioner.provision(
      getAttestationSignerKmsRole(0),
      {
        awsRegion: 'us-west-2',
        eksCluster: 'dogeos-testnet-cluster',
        namespace: 'default',
        networkAlias: 'testnet',
      }
    )

    expect(result.signerConfig.kmsKeyId).to.equal('alias/dogeos/testnet/dogeos-testnet-cluster/attestation-signer-0')
    expect(result.roleArn).to.equal('arn:aws:iam::123456789012:role/dogeos-testnet-dogeos-testnet-cluster-attestation-signer-0-kms')
    expect(result.serviceAccount).to.equal('attestation-signer-0')
    expect(result.publicKeyBase64).to.equal(process.env.AWS_TEST_PUBLIC_KEY)

    const calls = fs.readFileSync(process.env.AWS_TEST_LOG as string, 'utf8')
    expect(calls).to.include('kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY')
    expect(calls).to.include('kms create-alias --alias-name alias/dogeos/testnet/dogeos-testnet-cluster/attestation-signer-0')
    expect(calls).to.include('iam create-role --role-name dogeos-testnet-dogeos-testnet-cluster-attestation-signer-0-kms')
    expect(calls).to.include('system:serviceaccount:default:attestation-signer-0')
    expect(calls).to.include('iam put-role-policy --role-name dogeos-testnet-dogeos-testnet-cluster-attestation-signer-0-kms')
    expect(calls).to.include('kms:GetPublicKey')
    expect(calls).to.include('kms:Sign')
    expect(calls).to.include('--profile test-profile')
  })

  it('uses the native normalized prefix for standalone archive grants and supports an explicit bucket-root archive', async () => {
    const provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true)) as any
    const calls: string[][] = []
    provisioner.awsJson = (args: string[]) => { calls.push(args); return {} }
    const archive = {bucket: 'shared-bucket', created: false, enabled: true, keyPrefix: ' /instances//new/ '}
    await provisioner.provisionArchive(archive, {createBucket: false, roleArn: 'arn:aws:iam::123456789012:role/archive-writer'})
    const policy = JSON.parse(calls[0][calls[0].indexOf('--policy-document') + 1])
    expect(archive.keyPrefix).to.equal('instances/new')
    expect(policy.Statement[0]).to.deep.equal({Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: 'arn:aws:s3:::shared-bucket/instances/new/*'})
    expect(policy.Statement[1].Condition.StringLike['s3:prefix']).to.deep.equal(['instances/new', 'instances/new/*'])
    expect(JSON.stringify(policy)).not.to.include('DeleteObject')

    await provisioner.provisionArchive({...archive, keyPrefix: ''}, {createBucket: false, roleArn: 'arn:aws:iam::123456789012:role/root-archive-writer'})
    const rootPolicy = JSON.parse(calls[1][calls[1].indexOf('--policy-document') + 1])
    expect(rootPolicy.Statement[0].Resource).to.equal('arn:aws:s3:::shared-bucket/*')
    expect(rootPolicy.Statement[1]).not.to.have.property('Condition')
  })

  it('scopes newly created signer roles to the configured archive prefix', async () => {
    const provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true))
    await provisioner.provision({...getAttestationSignerKmsRole(0), service: 'eth-da-submitter'},
      {awsRegion: 'us-west-2', eksCluster: 'test', namespace: 'default', networkAlias: 'test'},
      {archive: {bucket: 'shared-bucket', created: false, enabled: true, keyPrefix: 'instances/new'}, createArchiveBucket: false})
    const calls = fs.readFileSync(process.env.AWS_TEST_LOG as string, 'utf8')
    expect(calls).to.include('arn:aws:s3:::shared-bucket/instances/new/*')
    expect(calls).not.to.include('arn:aws:s3:::shared-bucket/*')
    expect(calls).to.include('s3:ListBucket')
  })

  it('rejects unsafe archive prefixes before any AWS operation', async () => {
    const provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true)) as any
    let calls = 0
    provisioner.awsJson = () => { calls++; return {} }
    provisioner.ensureS3Bucket = () => { calls++; return false }
    provisioner.ensureKmsKey = () => { calls++; throw new Error('unexpected KMS call') }
    for (const keyPrefix of ['instances/*', 'instances/../other', 'instances/%2f', 'instances/a b']) {
      for (const standalone of [true, false]) {
        const archive = {bucket: 'shared-bucket', created: false, enabled: true, keyPrefix}
        let failure: unknown
        try {
          await (standalone ? provisioner.provisionArchive(archive, {createBucket: true}) : provisioner.provision(getAttestationSignerKmsRole(0),
            {awsRegion: 'us-west-2', eksCluster: 'test', namespace: 'default', networkAlias: 'test'}, {archive}));
        } catch (error) { failure = error }

        expect(String(failure)).to.include('S3 archive key prefix')
      }
    }

    expect(calls).to.equal(0)
  })

  it('grants the requested archive prefix when reusing a role without replacing its other policies', async () => {
    const provisioner = new KmsSignerProvisioner(new JsonOutputContext('test', true)) as any
    const roleArn = 'arn:aws:iam::123456789012:role/existing-da-role'
    const calls: string[][] = []
    provisioner.ensureKmsKey = () => ({keyArn: 'existing-key', keyId: 'existing-key', kmsKeyIdForConfig: 'existing-key'})
    provisioner.fetchKmsPublicKey = () => process.env.AWS_TEST_PUBLIC_KEY
    provisioner.awsJson = (args: string[]) => {
      calls.push(args)
      return args[1] === 'get-role' ? {Role: {Arn: roleArn}} : {}
    }

    await provisioner.provision({...getAttestationSignerKmsRole(0), service: 'eth-da-submitter'},
      {awsRegion: 'us-west-2', eksCluster: 'test', namespace: 'default', networkAlias: 'test'},
      {archive: {bucket: 'shared-bucket', created: false, enabled: true, keyPrefix: 'instances/new'}, createArchiveBucket: false, kmsKeyId: 'existing-key',
        roleArn})
    expect(calls.map(args => args[1])).to.deep.equal(['get-role', 'put-role-policy'])
    const put = calls[1]
    expect(put[put.indexOf('--policy-name') + 1]).to.match(/^eth-da-submitter-archive-[\da-f]{16}$/)
    const policy = JSON.parse(put[put.indexOf('--policy-document') + 1])
    expect(policy.Statement[0].Resource).to.equal('arn:aws:s3:::shared-bucket/instances/new/*')
    expect(policy.Statement[1].Condition.StringLike['s3:prefix']).to.deep.equal(['instances/new', 'instances/new/*'])
  })
})
