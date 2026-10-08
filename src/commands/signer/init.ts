import { Command, Flags } from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {
  createKmsSigningKey,
  fetchKmsCompressedPublicKey,
} from '../../utils/attestation-kms.js'
import {
  ATTESTATION_SIGNER_NETWORKS,
  assertCompressedSecp256k1PublicKey,
  validateAttestationSignerIdentity,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {renderSignerOperatorPolicyTemplate} from '../../utils/signer-policy-bundle.js'

const { Networks, PrivateKey } = bitcore

function generateWif(network: string): string {
  const selected = network === 'mainnet'
    ? Networks.livenet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bitcore network registry is dynamic
    : network === 'regtest' && (Networks as any).regtest
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (Networks as any).regtest
      : Networks.testnet
  return new PrivateKey(null, selected).toWIF()
}

function readEnvValue(contents: string, name: string): string | undefined {
  return contents.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim()
}

export function renderSignerReleasePins(options: {
  allowedGitCommit?: string
  allowedReleaseVersion?: string
  allowedSigningPolicyVersion?: string
}): string[] {
  const releaseVersion = options.allowedReleaseVersion?.trim()
  const gitCommit = options.allowedGitCommit?.trim().toLowerCase()
  const signingPolicyVersion = options.allowedSigningPolicyVersion?.trim() || '1'

  if (Boolean(releaseVersion) !== Boolean(gitCommit)) {
    throw new Error('--allowed-release-version and --allowed-git-commit must be provided together')
  }

  if (releaseVersion && !/^\d+\.\d+\.\d+(?:[+-][\d.A-Za-z-]+)?$/.test(releaseVersion)) {
    throw new Error('--allowed-release-version must be a Cargo semver such as 0.1.0 or 0.1.0-rc.1')
  }

  if (gitCommit && !/^[\da-f]{40}$/.test(gitCommit)) {
    throw new Error('--allowed-git-commit must be the full 40-character git commit embedded in the approved image')
  }

  const policyVersion = Number(signingPolicyVersion)
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1 || policyVersion > 4_294_967_295) {
    throw new Error('--allowed-signing-policy-version must be a positive u32')
  }

  return [
    '# Image release-policy pins. The first two are mandatory when the post-genesis',
    '# policy bundle selects enforcement=enforce; obtain them from the approved image.',
    ...(releaseVersion && gitCommit
      ? [
          `ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=${releaseVersion}`,
          `ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=${gitCommit}`,
        ]
      : [
          '# ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION=',
          '# ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT=',
        ]),
    `ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION=${policyVersion}`,
  ]
}

/**
 * Wrap the signer's --print-identity output into descriptor.json after
 * checking it belongs to this signer's network and attestation key.
 */
function writeDescriptor(identityFile: string, expected: {id: string; network: string; publicKey: string}, descriptorFile: string): Record<string, string> {
  const source = path.resolve(identityFile)
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(source, 'utf8'))
  } catch (error) {
    throw new Error(`${source}: failed to read identity: ${error instanceof Error ? error.message : String(error)}`)
  }

  const identity = validateAttestationSignerIdentity(raw, source)
  if (identity.network !== expected.network) throw new Error(`${source}: network ${identity.network} does not match --network ${expected.network}`)
  if (identity.publicKey !== expected.publicKey) throw new Error(`${source}: publicKey ${identity.publicKey} does not match this signer's key ${expected.publicKey}`)
  const descriptor = {...identity, id: expected.id}
  fs.writeFileSync(descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`)
  return descriptor
}

/**
 * The attestation key an existing signer env already records, re-validated
 * read-only: the local WIF's key, or the recorded KMS key's GetPublicKey
 * (which must still equal ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID).
 */
function recordedPublicKey(env: string, secretFile: string, flags: {'aws-profile'?: string; 'kms-key-id'?: string; network: string}): {backend: string; kmsKeyId?: string; publicKey: string} {
  const network = readEnvValue(env, 'ATTESTATION_SIGNER_NETWORK')
  if (network !== flags.network) throw new Error(`${secretFile} is for network ${String(network)}, not --network ${flags.network}`)
  const backend = readEnvValue(env, 'ATTESTATION_SIGNER_BACKEND')
  if (backend === 'aws_kms') {
    const kmsKeyId = readEnvValue(env, 'ATTESTATION_SIGNER_KMS_KEY_ID')
    const region = readEnvValue(env, 'ATTESTATION_SIGNER_KMS_REGION')
    const expected = readEnvValue(env, 'ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID')
    if (!kmsKeyId || !region || !expected) throw new Error(`${secretFile} does not record a complete KMS signer (key id, region, expected signer id)`)
    if (flags['kms-key-id'] && flags['kms-key-id'] !== kmsKeyId) throw new Error(`--kms-key-id ${flags['kms-key-id']} differs from the recorded ${kmsKeyId}; pass --force to reprovision`)
    const publicKey = assertCompressedSecp256k1PublicKey(fetchKmsCompressedPublicKey(kmsKeyId, region, flags['aws-profile']), 'KMS public key')
    if (publicKey !== expected.toLowerCase()) throw new Error(`KMS key ${kmsKeyId} now has public key ${publicKey}, not the recorded ${expected}`)
    return {backend: 'aws-kms', kmsKeyId, publicKey}
  }

  const wif = readEnvValue(env, 'ATTESTATION_SIGNER_WIF')
  if (backend !== 'local' || !wif) throw new Error(`${secretFile} records no usable signer backend`)
  return {backend: 'local', publicKey: PrivateKey.fromWIF(wif).toPublicKey().toString().toLowerCase()}
}

/** Where the partner-kit compose mounts the operator's transport.key. */
export const TRANSPORT_KEY_CONTAINER_PATH = '/etc/dogeos-partner/transport.key'

export class SignerInitCommand extends Command {
  static description = 'Signer-operator tool: create key material, secret deployment env, and a partner-owned V2 policy template; with --identity, wrap the signer\'s --print-identity output into the public descriptor. Run on your infrastructure; secrets and AWS calls never leave it. Send the descriptor before genesis, then deploy and preflight only after receiving the canonical-context policy bundle.'

  static examples = [
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet',
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet --identity signer-partner-a-signer-0/identity.json',
    '$ scrollsdk signer init --id partner-a-signer-0 --network mainnet --backend aws-kms --kms-key-id arn:aws:kms:... --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567',
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet --backend aws-kms --create-key --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567',
  ]

  static flags = {
    'allowed-git-commit': Flags.string({ description: 'Production release-policy pin: full 40-character git commit embedded in the approved signer image; must be paired with --allowed-release-version' }),
    'allowed-release-version': Flags.string({ description: 'Production release-policy pin: Cargo release version embedded in the approved signer image; must be paired with --allowed-git-commit' }),
    'allowed-signing-policy-version': Flags.string({ default: '1', description: 'Signer binary policy version approved by the operator (written to attestation-signer.env)' }),
    'aws-profile': Flags.string({ description: 'AWS CLI profile for KMS calls (aws-kms backend)' }),
    backend: Flags.string({ default: 'local', description: 'Key backend', options: ['local', 'aws-kms'] }),
    'create-key': Flags.boolean({ default: false, description: 'aws-kms backend: create the ECC_SECG_P256K1 signing key in your AWS account instead of passing --kms-key-id' }),
    force: Flags.boolean({ default: false, description: 'Overwrite an existing env file; generates a NEW signing key for the local backend. Do not use to preserve a local identity. Partner-owned TOML is always retained.' }),
    id: Flags.string({ description: 'Stable signer identifier (DNS-label shaped, agreed with the bridge operator)', required: true }),
    identity: Flags.string({ description: 'File holding the one-line JSON from `attestation_signer --print-identity`; its network and public key must match this signer. Writes descriptor.json (identity + id)' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'kms-key-id': Flags.string({ description: 'aws-kms backend: key id, ARN, or alias/... of your existing ECC_SECG_P256K1 signing key' }),
    'kms-region': Flags.string({ description: 'aws-kms backend: AWS region of the key' }),
    network: Flags.string({ default: 'testnet', description: 'Dogecoin network', options: [...ATTESTATION_SIGNER_NETWORKS] }),
    out: Flags.string({ description: 'Output directory (default: ./signer-<id>)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SignerInitCommand)
    const json = new JsonOutputContext('signer init', flags.json)
    try {
      const outDir = path.resolve(flags.out || `signer-${flags.id}`)
      const secretFile = path.join(outDir, 'attestation-signer.env')
      const policyFile = path.join(outDir, 'attestation-signer.toml')
      const descriptorFile = path.join(outDir, 'descriptor.json')
      fs.mkdirSync(outDir, { recursive: true })
      const existingEnv = fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : ''
      if (flags.identity && flags['create-key']) {
        throw new Error('--create-key cannot be combined with --identity: the identity was printed from an existing key')
      }

      // Second pass of onboarding: the signer already exists, so wrapping its
      // identity is read-only. Reuse the recorded backend; never reprovision
      // or rewrite the key env.
      if (flags.identity && existingEnv && !flags.force) {
        const recorded = recordedPublicKey(existingEnv, secretFile, flags)
        writeDescriptor(flags.identity, {id: flags.id, network: flags.network, publicKey: recorded.publicKey}, descriptorFile)
        if (flags.json) json.success({backend: recorded.backend, descriptorFile, id: flags.id, kmsKeyId: recorded.kmsKeyId, publicKey: recorded.publicKey, secretFile})
        else this.log(chalk.green(`Descriptor written to ${descriptorFile} — send THIS file to the bridge operator.`))
        return
      }


      const backendLines: string[] = []
      let publicKey: string
      let kmsKeyId: string | undefined
      if (flags.backend === 'aws-kms') {
        if (!flags['kms-region']) throw new Error('--kms-region is required with --backend aws-kms')
        if (flags['create-key'] && flags['kms-key-id']) throw new Error('--create-key and --kms-key-id are mutually exclusive')
        if (fs.existsSync(secretFile) && !flags.force) {
          throw new Error(`${secretFile} already exists; pass --force to regenerate it (the KMS key itself is never touched)`)
        }

        kmsKeyId = flags['create-key']
          ? createKmsSigningKey(`dogeos attestation signer ${flags.id}`, flags['kms-region'], flags['aws-profile'])
          : flags['kms-key-id']
        if (!kmsKeyId) throw new Error('pass --kms-key-id (or --create-key to create one) with --backend aws-kms')
        if (flags['create-key']) json.logSuccess(`Created KMS signing key ${kmsKeyId}`)

        publicKey = assertCompressedSecp256k1PublicKey(
          fetchKmsCompressedPublicKey(kmsKeyId, flags['kms-region'], flags['aws-profile']),
          'derived KMS public key'
        )
        backendLines.push(
          'ATTESTATION_SIGNER_BACKEND=aws_kms',
          `ATTESTATION_SIGNER_KMS_KEY_ID=${kmsKeyId}`,
          `ATTESTATION_SIGNER_KMS_REGION=${flags['kms-region']}`,
          `ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID=${publicKey}`,
          '# The container needs AWS credentials with kms:Sign + kms:GetPublicKey on',
          '# this key: an instance role, or uncomment static keys below.',
          '# AWS_ACCESS_KEY_ID=',
          '# AWS_SECRET_ACCESS_KEY=',
        )
      } else {
        for (const flag of ['kms-key-id', 'create-key'] as const) {
          if (flags[flag]) throw new Error(`--${flag} requires --backend aws-kms`)
        }

        let wif: string
        const existing = readEnvValue(existingEnv, 'ATTESTATION_SIGNER_WIF')
        if (existing && !flags.force) {
          wif = existing
          json.logSuccess(`Reusing existing key material in ${secretFile}`)
        } else {
          wif = generateWif(flags.network)
        }

        publicKey = PrivateKey.fromWIF(wif).toPublicKey().toString().toLowerCase()
        backendLines.push('ATTESTATION_SIGNER_BACKEND=local', `ATTESTATION_SIGNER_WIF=${wif}`)
      }

      const releasePinLines = renderSignerReleasePins({
        allowedGitCommit: flags['allowed-git-commit'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT'),
        allowedReleaseVersion: flags['allowed-release-version'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION'),
        allowedSigningPolicyVersion: flags['allowed-signing-policy-version']
          || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_SIGNING_POLICY_VERSION'),
      })

      // A complete deployment env: point the compose env_file directly at
      // this file (or copy it next to docker-compose.yml) — nothing else to
      // assemble by hand. The bridge operator's post-genesis policy bundle is
      // authoritative for observe/enforce. This bootstrap value is observe on
      // testnet and enforce on mainnet, where dogeos-core refuses observe.
      //
      // Do NOT put externally-supplied policy values here (e.g. TSO_URL).
      // Those belong in the bridge operator's signer-policy.env so that every
      // variable has a single source: this file holds operator-owned key/network
      // settings, signer-policy.env holds post-genesis bridge policy.
      const envLines = [
        `# Generated by scrollsdk signer init (${flags.id}). SECRET for the local`,
        '# backend — this file configures the signer\'s only key.',
        ...backendLines,
        ...releasePinLines,
        `ATTESTATION_SIGNER_NETWORK=${flags.network}`,
        `ATTESTATION_SIGNER_POLICY_MODE=${flags.network === 'mainnet' ? 'enforce' : 'observe'}`,
        '# The signer dials out to the TSO and signs every request with a separate',
        '# transport key: transport.key next to the compose file (32-byte hex,',
        '# mode 0600, generated with `openssl rand -hex 32`), mounted read-only here.',
        `ATTESTATION_SIGNER_TSO_TRANSPORT_KEY_FILE=${TRANSPORT_KEY_CONTAINER_PATH}`,
        'ATTESTATION_SIGNER_TSO_DELIVERY=pull',
      ]
      fs.writeFileSync(secretFile, `${envLines.join('\n')}\n`, { mode: 0o600 })

      // This is partner-owned policy. In particular, --force may rotate or
      // reconstruct key env without erasing reviewed RPC trust domains and
      // rotation targets, so the template is created exactly once.
      const createdPolicyTemplate = !fs.existsSync(policyFile)
      if (createdPolicyTemplate) {
        fs.writeFileSync(policyFile, renderSignerOperatorPolicyTemplate())
      }

      // The descriptor is the signer's own --print-identity output plus id.
      // It carries the transport key, which only the signer binary holds, so
      // without --identity no descriptor is written yet.
      const descriptor = flags.identity
        ? writeDescriptor(flags.identity, {id: flags.id, network: flags.network, publicKey}, descriptorFile)
        : undefined

      const result = {
        allowedGitCommit: flags['allowed-git-commit'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT'),
        allowedReleaseVersion: flags['allowed-release-version'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION'),
        allowedSigningPolicyVersion: flags['allowed-signing-policy-version'],
        backend: flags.backend,
        descriptorFile: descriptor ? descriptorFile : undefined,
        id: flags.id,
        kmsKeyId,
        policyFile,
        policyTemplateCreated: createdPolicyTemplate,
        publicKey,
        secretFile,
      }
      if (flags.json) json.success(result)
      else {
        this.log(chalk.green(`Deployment env written to ${secretFile}${flags.backend === 'local' ? ' (keep this private; it holds the signing key)' : ''}.`))
        this.log(chalk.green(`${createdPolicyTemplate ? 'Partner-owned V2 policy template written' : 'Existing partner-owned V2 policy preserved'} at ${policyFile}.`))
        if (descriptor) {
          this.log(chalk.green(`Descriptor written to ${descriptorFile} — send THIS file to the bridge operator.`))
          this.log(chalk.green('Next: send the descriptor to the bridge operator. Start the signer after receiving the canonical post-genesis policy bundle.'))
        } else {
          this.log(chalk.yellow('Next: generate the transport key with attestation_signer, save its `--print-identity` line to a file, and re-run signer init with --identity <file> to write descriptor.json.'))
        }
      }
    } catch (error) {
      json.error('E802_SIGNER_INIT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default SignerInitCommand
