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
})
