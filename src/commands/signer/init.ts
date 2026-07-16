import { Command, Flags } from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {
  ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  ATTESTATION_SIGNER_NETWORKS,
  normalizeSignerEndpoint,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

const { Networks, PrivateKey } = bitcore

const ENDPOINT_PLACEHOLDER = 'https://REPLACE-WITH-YOUR-SIGNER-ENDPOINT'

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

export class SignerInitCommand extends Command {
  static description = 'Signer-operator tool: generate a local attestation-signer key and emit the descriptor to hand to the bridge operator. Run this on YOUR infrastructure — the private key never leaves the output directory. For an AWS KMS backend, create the key yourself and use `scrollsdk signer preflight` against the running signer to emit the descriptor instead.'

  static examples = [
    '$ scrollsdk signer init --id partner-a-signer-0 --network testnet --endpoint https://signer.partner-a.example:4040',
    '$ scrollsdk signer init --id partner-a-signer-0 --network mainnet --out ./my-signer',
  ]

  static flags = {
    endpoint: Flags.string({ description: 'Public HTTPS base URL where the bridge operator and TSO will reach this signer (can be filled in later via signer preflight)' }),
    force: Flags.boolean({ default: false, description: 'Overwrite existing key material in the output directory' }),
    id: Flags.string({ description: 'Stable signer identifier (DNS-label shaped, agreed with the bridge operator)', required: true }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
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

      let wif: string
      const existing = fs.existsSync(secretFile)
        ? fs.readFileSync(secretFile, 'utf8').match(/^ATTESTATION_SIGNER_WIF=(.+)$/m)?.[1]
        : undefined
      if (existing && !flags.force) {
        wif = existing
        json.logSuccess(`Reusing existing key material in ${secretFile}`)
      } else {
        wif = generateWif(flags.network)
        fs.writeFileSync(secretFile, `ATTESTATION_SIGNER_WIF=${wif}\n`, { mode: 0o600 })
      }

      const publicKey = PrivateKey.fromWIF(wif).toPublicKey().toString().toLowerCase()
      const endpoint = flags.endpoint ? normalizeSignerEndpoint(flags.endpoint, '--endpoint') : ENDPOINT_PLACEHOLDER
      const descriptor = {
        endpoint,
        id: flags.id,
        network: flags.network,
        publicKey,
        schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
      }
      fs.writeFileSync(descriptorFile, `${JSON.stringify(descriptor, null, 2)}\n`)

      const result = { descriptorFile, endpoint, id: flags.id, publicKey, secretFile }
      if (flags.json) json.success(result)
      else {
        this.log(chalk.green(`Key material written to ${secretFile} (keep this private; it is the signer's only secret).`))
        this.log(chalk.green(`Descriptor written to ${descriptorFile} — send THIS file to the bridge operator.`))
        if (endpoint === ENDPOINT_PLACEHOLDER) {
          this.log(chalk.yellow('Endpoint is a placeholder. After deploying the signer, run `scrollsdk signer preflight --endpoint <url> ...` to verify it and finalize the descriptor.'))
        }
      }
    } catch (error) {
      json.error('E802_SIGNER_INIT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default SignerInitCommand
