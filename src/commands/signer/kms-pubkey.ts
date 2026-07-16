import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { execFileSync } from 'node:child_process'

import { deriveCompressedSecp256k1PublicKeyFromSpkiDer } from '../../utils/attestation-kms.js'
import { assertCompressedSecp256k1PublicKey } from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export class SignerKmsPubkeyCommand extends Command {
  static description = 'Signer-operator tool: derive the compressed secp256k1 public key of an AWS KMS signing key (the value for ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID). Runs `aws kms get-public-key` with YOUR credentials; nothing is sent anywhere else.'

  static examples = [
    '$ scrollsdk signer kms-pubkey --key-id arn:aws:kms:us-east-1:123456789012:key/abcd-... --region us-east-1',
    '$ scrollsdk signer kms-pubkey --key-id alias/my-attestation-signer --region eu-west-1 --aws-profile signer-ops',
  ]

  static flags = {
    'aws-profile': Flags.string({ description: 'AWS CLI profile to use' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'key-id': Flags.string({ description: 'KMS key id, ARN, or alias/... of the ECC_SECG_P256K1 signing key', required: true }),
    region: Flags.string({ description: 'AWS region of the key', required: true }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SignerKmsPubkeyCommand)
    const json = new JsonOutputContext('signer kms-pubkey', flags.json)
    try {
      const args = ['kms', 'get-public-key', '--key-id', flags['key-id'], '--region', flags.region, '--query', 'PublicKey', '--output', 'text']
      if (flags['aws-profile']) args.push('--profile', flags['aws-profile'])
      let spkiBase64: string
      try {
        spkiBase64 = execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr?.trim()
        throw new Error(`aws kms get-public-key failed${stderr ? `: ${stderr}` : ''} (is the AWS CLI installed and are your credentials configured?)`)
      }

      const publicKey = assertCompressedSecp256k1PublicKey(
        deriveCompressedSecp256k1PublicKeyFromSpkiDer(spkiBase64),
        'derived KMS public key'
      )

      if (flags.json) json.success({ keyId: flags['key-id'], publicKey, region: flags.region })
      else {
        this.log(publicKey)
        this.log(chalk.green('Use this as ATTESTATION_SIGNER_KMS_EXPECTED_SIGNER_ID in attestation-signer.env.'))
      }
    } catch (error) {
      json.error('E805_SIGNER_KMS_PUBKEY_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default SignerKmsPubkeyCommand
