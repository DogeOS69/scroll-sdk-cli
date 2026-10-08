import {runCommand} from '@oclif/test'
import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderSignerReleasePins } from '../../../src/commands/signer/init.js'
import { deriveCompressedSecp256k1PublicKeyFromSpkiDer } from '../../../src/utils/attestation-kms.js'
import { ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA } from '../../../src/utils/attestation-signer-descriptor.js'

// 2G: any valid compressed key distinct from the generated signing key.
const TRANSPORT_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

describe('signer init release pins', () => {
  it('renders the complete fail-closed production release identity', () => {
    const lines = renderSignerReleasePins({
      allowedGitCommit: '0123456789ABCDEF0123456789ABCDEF01234567',
      allowedReleaseVersion: '0.1.0',
      allowedSigningPolicyVersion: '1',
    })
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=0.1.0')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=0123456789abcdef0123456789abcdef01234567')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=1')
  })

  it('keeps explicit placeholders for mock/onboarding but still pins the policy version', () => {
    const lines = renderSignerReleasePins({ allowedSigningPolicyVersion: '1' })
    expect(lines).to.include('# ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=')
    expect(lines).to.include('# ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=')
    expect(lines).to.include('ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=1')
  })

  it('rejects partial or non-canonical release pins', () => {
    expect(() => renderSignerReleasePins({ allowedReleaseVersion: '0.1.0' }))
      .to.throw('must be provided together')
    expect(() => renderSignerReleasePins({
      allowedGitCommit: 'short',
      allowedReleaseVersion: '0.1.0',
    })).to.throw('full 40-character git commit')
  })
})

describe('signer init partner-owned V2 policy', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-init-v2-'))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('reuses the existing local key, release approvals, and reviewed policy without --force', async () => {
    const out = path.join(root, 'existing-signer')
    const args = ['signer', 'init', '--id', 'existing-signer', '--network', 'testnet', '--out', out]
    const first = await runCommand([...args,
      '--allowed-release-version', '0.3.0-beta.5c',
      '--allowed-git-commit', '0123456789abcdef0123456789abcdef01234567'])
    expect(first.error).to.equal(undefined)
    const envFile = path.join(out, 'attestation-signer.env')
    const descriptorFile = path.join(out, 'descriptor.json')
    const policyFile = path.join(out, 'attestation-signer.toml')
    const originalEnv = fs.readFileSync(envFile, 'utf8')
    expect(fs.existsSync(descriptorFile)).to.equal(false)
    const reviewed = '# Operator-approved policy must survive regeneration.\n'
    fs.writeFileSync(policyFile, reviewed)

    const second = await runCommand(args)
    expect(second.error).to.equal(undefined)
    expect(fs.readFileSync(envFile, 'utf8') === originalEnv).to.equal(true)
    expect(fs.readFileSync(policyFile, 'utf8')).to.equal(reviewed)
    expect(fs.statSync(envFile).mode % 0o1000).to.equal(0o600)
  })

  it('creates the current policy template once and preserves operator edits under --force', async () => {
    const out = path.join(root, 'partner-a')
    const args = [
      'signer', 'init',
      '--id', 'partner-a',
      '--network', 'testnet',
      '--out', out,
    ]
    await runCommand(args)

    const policyFile = path.join(out, 'attestation-signer.toml')
    const template = fs.readFileSync(policyFile, 'utf8')
    expect(template).to.include('[advance_l1_policy.terminal_anchor_sources]')
    expect(template).to.include('[advance_l2_policy.ethereum_sources]')
    expect(template).to.include('[rotation_policy]')

    const reviewed = `${template}\n# reviewed-partner-policy-marker\n`
    fs.writeFileSync(policyFile, reviewed)
    await runCommand([...args, '--force'])
    expect(fs.readFileSync(policyFile, 'utf8')).to.equal(reviewed)
  })
})

describe('signer init descriptor', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-init-identity-'))
  })

  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('wraps --print-identity output with the id after checking network and key', async () => {
    const out = path.join(root, 'partner-a')
    const args = ['signer', 'init', '--id', 'partner-a', '--network', 'testnet', '--out', out]
    expect((await runCommand(args)).error).to.equal(undefined)
    const wif = /ATTESTATION_SIGNER_WIF=(\S+)/.exec(fs.readFileSync(path.join(out, 'attestation-signer.env'), 'utf8'))![1]
    const {default: bitcore} = await import('bitcore-lib-doge')
    const publicKey = bitcore.PrivateKey.fromWIF(wif).toPublicKey().toString().toLowerCase()
    const identity = {network: 'testnet', publicKey, schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA, transportPubkey: TRANSPORT_PUBKEY}
    const identityFile = path.join(root, 'identity.json')

    fs.writeFileSync(identityFile, JSON.stringify({...identity, network: 'mainnet'}))
    expect((await runCommand([...args, '--identity', identityFile])).error?.message).to.match(/does not match --network/)
    fs.writeFileSync(identityFile, JSON.stringify({...identity, publicKey: TRANSPORT_PUBKEY, transportPubkey: publicKey}))
    expect((await runCommand([...args, '--identity', identityFile])).error?.message).to.match(/does not match this signer's key/)
    expect(fs.existsSync(path.join(out, 'descriptor.json'))).to.equal(false)

    fs.writeFileSync(identityFile, `${JSON.stringify(identity)}\n`)
    expect((await runCommand([...args, '--identity', identityFile])).error).to.equal(undefined)
    const descriptor = JSON.parse(fs.readFileSync(path.join(out, 'descriptor.json'), 'utf8'))
    expect(descriptor).to.deep.equal({...identity, id: 'partner-a'})
    expect(descriptor).not.to.have.property('endpoint')
  })
})

describe('signer init KMS onboarding', () => {
  let root: string
  let originalPath: string | undefined
  let publicKey: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-init-kms-'))
    // A fake `aws` CLI: create-key returns an ARN, get-public-key the SPKI of
    // a fixed secp256k1 key, and every call is logged.
    const {publicKey: spki} = generateKeyPairSync('ec', {namedCurve: 'secp256k1'})
    const der = spki.export({format: 'der', type: 'spki'}).toString('base64')
    publicKey = deriveCompressedSecp256k1PublicKeyFromSpkiDer(der)
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'aws'), [
      '#!/bin/sh',
      `echo "$@" >> "${root}/aws.log"`,
      'case "$2" in',
      '  create-key) echo \'{"KeyMetadata":{"Arn":"arn:aws:kms:us-east-1:123456789012:key/created"}}\' ;;',
      `  get-public-key) echo "${der}" ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), {mode: 0o755})
    originalPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    fs.rmSync(root, {force: true, recursive: true})
  })

  function awsCalls(): string[] {
    return fs.existsSync(path.join(root, 'aws.log')) ? fs.readFileSync(path.join(root, 'aws.log'), 'utf8').trim().split('\n') : []
  }

  for (const [label, keyFlags] of [
    ['a key created by the first pass', ['--create-key']],
    ['an existing key', ['--kms-key-id', 'arn:aws:kms:us-east-1:123456789012:key/existing']],
  ] as const) {
    it(`wraps the identity for ${label} without reprovisioning`, async () => {
      const out = path.join(root, 'partner-k')
      const base = ['signer', 'init', '--id', 'partner-k', '--network', 'testnet', '--out', out, '--backend', 'aws-kms', '--kms-region', 'us-east-1']
      expect((await runCommand([...base, ...keyFlags])).error).to.equal(undefined)
      const envFile = path.join(out, 'attestation-signer.env')
      const env = fs.readFileSync(envFile, 'utf8')
      expect(env).to.include(`ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID=${publicKey}`)
      const identityFile = path.join(root, 'identity.json')
      fs.writeFileSync(identityFile, JSON.stringify({network: 'testnet', publicKey, schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA, transportPubkey: TRANSPORT_PUBKEY}))

      // Repeating the generated command with --create-key is refused outright.
      expect((await runCommand([...base, '--create-key', '--identity', identityFile])).error?.message).to.match(/--create-key cannot be combined with --identity/)
      const callsBefore = awsCalls().length
      // The second pass reuses the recorded backend even with only --identity.
      expect((await runCommand(['signer', 'init', '--id', 'partner-k', '--network', 'testnet', '--out', out, '--identity', identityFile])).error).to.equal(undefined)
      const newCalls = awsCalls().slice(callsBefore)
      expect(newCalls).to.have.length(1)
      expect(newCalls[0]).to.match(/^kms get-public-key --key-id arn:aws:kms:us-east-1:123456789012:key\/(created|existing) --region us-east-1/)
      expect(fs.readFileSync(envFile, 'utf8')).to.equal(env)
      expect(JSON.parse(fs.readFileSync(path.join(out, 'descriptor.json'), 'utf8'))).to.deep.equal({id: 'partner-k', network: 'testnet', publicKey, schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA, transportPubkey: TRANSPORT_PUBKEY})
    })
  }
})
