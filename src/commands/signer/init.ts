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
  ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  ATTESTATION_SIGNER_NETWORKS,
  ENDPOINT_PLACEHOLDER,
  assertCompressedSecp256k1PublicKey,
  normalizeSignerEndpoint,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

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
    '# policy bundle selects production_enforce; obtain them from the approved image.',
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

export class SignerInitCommand extends Command {
  static description = 'Signer-operator tool: set up key material and emit the descriptor + a complete deployment env file. Run this on YOUR infrastructure — secrets and AWS calls never leave it. Specify the TSO-reachable signer IP/domain with --endpoint. Production operators also pin the approved image release version and full git commit here. The output directory is the single source of truth for signer preflight and compose deployment.'

  static examples = [
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet --endpoint https://signer.partner-a.example:4040',
    '$ scrollsdk signer init --id partner-a-signer-0 --network mainnet --endpoint https://signer.partner-a.example:4040 --backend aws-kms --kms-key-id arn:aws:kms:... --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567',
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet --endpoint https://signer.partner-a.example:4040 --backend aws-kms --create-key --kms-region us-east-1 --allowed-release-version 0.1.0 --allowed-git-commit 0123456789abcdef0123456789abcdef01234567',
  ]

  static flags = {
    'allowed-git-commit': Flags.string({ description: 'Production release-policy pin: full 40-character git commit embedded in the approved signer image; must be paired with --allowed-release-version' }),
    'allowed-release-version': Flags.string({ description: 'Production release-policy pin: Cargo release version embedded in the approved signer image; must be paired with --allowed-git-commit' }),
    'allowed-signing-policy-version': Flags.string({ default: '1', description: 'Signer binary policy version approved by the operator (written to attestation-signer.env)' }),
    'aws-profile': Flags.string({ description: 'AWS CLI profile for KMS calls (aws-kms backend)' }),
    backend: Flags.string({ default: 'local', description: 'Key backend', options: ['local', 'aws-kms'] }),
    'create-key': Flags.boolean({ default: false, description: 'aws-kms backend: create the ECC_SECG_P256K1 signing key in your AWS account instead of passing --kms-key-id' }),
    endpoint: Flags.string({ description: 'HTTP(S) base URL reachable from the bridge operator/TSO network; use a TLS domain in production or a private IP in an isolated mock/VPN test (can be filled later via signer preflight)' }),
    force: Flags.boolean({ default: false, description: 'Overwrite an existing env file in the output directory' }),
    id: Flags.string({ description: 'Stable signer identifier (DNS-label shaped, agreed with the bridge operator)', required: true }),
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
      const descriptorFile = path.join(outDir, 'descriptor.json')
      fs.mkdirSync(outDir, { recursive: true })
      const existingEnv = fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8') : ''

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
      // assemble by hand. staging_scaffold is mandatory pre-genesis; the
      // bridge operator's policy bundle selects audited staging_scaffold for
      // mock proving or fail-closed production_enforce for production proving.
      const envLines = [
        `# Generated by scrollsdk signer init (${flags.id}). SECRET for the local`,
        '# backend — this file configures the signer\'s only key.',
        ...backendLines,
        ...releasePinLines,
        `ATTESTATION_SIGNER_NETWORK=${flags.network}`,
        'ATTESTATION_SIGNER_POLICY_MODE=staging_scaffold',
        'ATTESTATION_SIGNER_TSO_URL=http://tso-not-yet-configured.invalid',
      ]
      fs.writeFileSync(secretFile, `${envLines.join('\n')}\n`, { mode: 0o600 })

      const endpoint = flags.endpoint ? normalizeSignerEndpoint(flags.endpoint, '--endpoint') : ENDPOINT_PLACEHOLDER
      const descriptor = {
        endpoint,
        id: flags.id,
        network: flags.network,
        publicKey,
        schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
      }
      fs.writeFileSync(descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`)

      const result = {
        allowedGitCommit: flags['allowed-git-commit'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_GIT_COMMIT'),
        allowedReleaseVersion: flags['allowed-release-version'] || readEnvValue(existingEnv, 'ATTESTATION_SIGNER_ALLOWED_RELEASE_VERSION'),
        allowedSigningPolicyVersion: flags['allowed-signing-policy-version'],
        backend: flags.backend,
        descriptorFile,
        endpoint,
        id: flags.id,
        kmsKeyId,
        publicKey,
        secretFile,
      }
      if (flags.json) json.success(result)
      else {
        this.log(chalk.green(`Deployment env written to ${secretFile}${flags.backend === 'local' ? ' (keep this private; it holds the signing key)' : ''}.`))
        this.log(chalk.green(`Descriptor written to ${descriptorFile} — send THIS file to the bridge operator.`))
        this.log(chalk.green(`Next: deploy the signer, then run \`scrollsdk signer preflight --dir ${path.relative(process.cwd(), outDir) || '.'} --endpoint <url>\`.`))
        if (endpoint === ENDPOINT_PLACEHOLDER) {
          this.log(chalk.yellow('Endpoint is a placeholder; signer preflight will fill it in after deployment.'))
        }
      }
    } catch (error) {
      json.error('E802_SIGNER_INIT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default SignerInitCommand
