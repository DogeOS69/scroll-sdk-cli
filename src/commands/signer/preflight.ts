import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type { AttestationSignerDescriptor } from '../../utils/attestation-signer-descriptor.js'

import {
  ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
  ATTESTATION_SIGNER_NETWORKS,
  ENDPOINT_PLACEHOLDER,
  fetchSignerHealth,
  loadAttestationSignerDescriptor,
  normalizeSignerEndpoint,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export class SignerPreflightCommand extends Command {
  static description = 'Signer-operator tool: probe a deployed attestation-signer over HTTP, verify its runtime public key, and emit the final descriptor to hand to the bridge operator. With --dir (a directory from signer init) the id, network, and expected public key are read from its descriptor.json and the verified endpoint is written back in place — no values to retype. Works with any backend because the public key is read from the running signer\'s /health.'

  static examples = [
    '$ scrollsdk signer preflight --dir signer-partner-a-signer-0 --endpoint https://signer.partner-a.example:4040',
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --out descriptor.json',
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --expected-public-key 02ab...',
  ]

  static flags = {
    dir: Flags.string({ description: 'signer init output directory; provides id/network/expected key from descriptor.json and receives the finalized descriptor' }),
    endpoint: Flags.string({ description: 'Signer HTTP base URL to probe (with --dir, defaults to the descriptor endpoint if already set)' }),
    'expected-public-key': Flags.string({ description: 'Fail unless the runtime public key equals this compressed secp256k1 key (with --dir, defaults to the descriptor publicKey)' }),
    id: Flags.string({ description: 'Stable signer identifier for the emitted descriptor (required without --dir)' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    network: Flags.string({ description: 'Expected Dogecoin network (defaults to descriptor network with --dir, else to the network reported by /health)', options: [...ATTESTATION_SIGNER_NETWORKS] }),
    out: Flags.string({ description: 'Write the descriptor JSON to this path (default with --dir: its descriptor.json; otherwise print to stdout)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SignerPreflightCommand)
    const json = new JsonOutputContext('signer preflight', flags.json)
    try {
      let fromDir: AttestationSignerDescriptor | undefined
      let dirDescriptorFile: string | undefined
      if (flags.dir) {
        dirDescriptorFile = path.join(path.resolve(flags.dir), 'descriptor.json')
        if (!fs.existsSync(dirDescriptorFile)) throw new Error(`${dirDescriptorFile} not found; is --dir a signer init output directory?`)
        // Placeholder endpoints are expected here — that is exactly what
        // preflight finalizes — so parse leniently and only reuse fields.
        const raw = JSON.parse(fs.readFileSync(dirDescriptorFile, 'utf8')) as AttestationSignerDescriptor
        fromDir = raw
      }

      const id = flags.id || fromDir?.id
      if (!id) throw new Error('--id is required (or pass --dir pointing at a signer init directory)')

      const endpointInput = flags.endpoint
        || (fromDir && fromDir.endpoint !== ENDPOINT_PLACEHOLDER ? fromDir.endpoint : undefined)
      if (!endpointInput) throw new Error('--endpoint is required (the descriptor does not carry a real endpoint yet)')
      const endpoint = normalizeSignerEndpoint(endpointInput, '--endpoint')

      const health = await fetchSignerHealth(endpoint)
      json.logSuccess(`Signer at ${endpoint} is healthy; runtime public key ${health.publicKey}`)

      const expected = (flags['expected-public-key'] || fromDir?.publicKey)?.toLowerCase()
      if (expected && expected !== health.publicKey) {
        throw new Error(`runtime public key ${health.publicKey} does not match the expected key ${expected}${flags['expected-public-key'] ? '' : ` from ${dirDescriptorFile}`}`)
      }

      const network = flags.network || fromDir?.network || health.network
      if (!network) throw new Error('/health did not report a network; pass --network explicitly')
      if (!(ATTESTATION_SIGNER_NETWORKS as readonly string[]).includes(network)) {
        throw new Error(`network ${network} is not one of ${ATTESTATION_SIGNER_NETWORKS.join(', ')}`)
      }

      if (health.network && health.network !== network) {
        throw new Error(`/health reports network ${health.network}, but the expected network is ${network}`)
      }

      const descriptor = {
        endpoint,
        id,
        network,
        publicKey: health.publicKey,
        schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA,
      }
      const rendered = `${JSON.stringify(descriptor, null, 2)}\n`
      const outPath = flags.out ? path.resolve(flags.out) : dirDescriptorFile
      if (outPath) {
        fs.writeFileSync(outPath, rendered)
        // Re-validate the finalized file end-to-end (placeholder rejection included).
        loadAttestationSignerDescriptor(outPath)
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
