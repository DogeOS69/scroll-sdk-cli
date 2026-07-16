import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import {
  ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  ATTESTATION_SIGNER_NETWORKS,
  fetchSignerHealth,
  normalizeSignerEndpoint,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export class SignerPreflightCommand extends Command {
  static description = 'Signer-operator tool: probe a deployed attestation-signer over HTTP, verify its runtime public key, and emit the final descriptor to hand to the bridge operator. Works with any backend (local WIF or AWS KMS) because the public key is read from the running signer\'s /health.'

  static examples = [
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --out descriptor.json',
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --expected-public-key 02ab...',
  ]

  static flags = {
    endpoint: Flags.string({ description: 'Signer HTTP base URL to probe', required: true }),
    'expected-public-key': Flags.string({ description: 'Fail unless the runtime public key equals this compressed secp256k1 key (e.g. from signer init output)' }),
    id: Flags.string({ description: 'Stable signer identifier for the emitted descriptor', required: true }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    network: Flags.string({ description: 'Expected Dogecoin network (defaults to the network reported by /health)', options: [...ATTESTATION_SIGNER_NETWORKS] }),
    out: Flags.string({ description: 'Write the descriptor JSON to this path (default: print to stdout)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SignerPreflightCommand)
    const json = new JsonOutputContext('signer preflight', flags.json)
    try {
      const endpoint = normalizeSignerEndpoint(flags.endpoint, '--endpoint')
      const health = await fetchSignerHealth(endpoint)
      json.logSuccess(`Signer at ${endpoint} is healthy; runtime public key ${health.publicKey}`)

      const expected = flags['expected-public-key']?.toLowerCase()
      if (expected && expected !== health.publicKey) {
        throw new Error(`runtime public key ${health.publicKey} does not match --expected-public-key ${expected}`)
      }

      const network = flags.network || health.network
      if (!network) throw new Error('/health did not report a network; pass --network explicitly')
      if (!(ATTESTATION_SIGNER_NETWORKS as readonly string[]).includes(network)) {
        throw new Error(`network ${network} is not one of ${ATTESTATION_SIGNER_NETWORKS.join(', ')}`)
      }

      if (health.network && flags.network && health.network !== flags.network) {
        throw new Error(`/health reports network ${health.network}, but --network is ${flags.network}`)
      }

      const descriptor = {
        endpoint,
        id: flags.id,
        network,
        publicKey: health.publicKey,
        schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
      }
      const rendered = `${JSON.stringify(descriptor, null, 2)}\n`
      if (flags.out) {
        const outPath = path.resolve(flags.out)
        fs.writeFileSync(outPath, rendered)
        if (flags.json) json.success({ descriptor, descriptorFile: outPath })
        else this.log(chalk.green(`Descriptor written to ${outPath} — send this file to the bridge operator.`))
      } else if (flags.json) {
        json.success({ descriptor })
      } else {
        this.log(rendered)
        this.log(chalk.green('Preflight passed — send the descriptor above to the bridge operator.'))
      }
    } catch (error) {
      json.error('E803_SIGNER_PREFLIGHT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}

export default SignerPreflightCommand
