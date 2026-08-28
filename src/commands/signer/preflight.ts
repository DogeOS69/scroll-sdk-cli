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
  fetchSignerJson,
  loadAttestationSignerDescriptor,
  normalizeSignerEndpoint,
} from '../../utils/attestation-signer-descriptor.js'
import { JsonOutputContext } from '../../utils/json-output.js'

const REQUIRED_PRODUCTION_V2_CAPABILITIES = [
  'advance_l1',
  'advance_l2',
  'rotate_key',
  'rotate_sequencer_signer',
] as const

export function assertProductionSignerV2Ready(options: {
  expectedNetwork: string
  expectedPublicKey: string
  policy: Record<string, unknown>
  ready: Record<string, unknown>
  readyStatus: number
}): void {
  const {policy, ready} = options
  if (policy.contract !== 'attestation_evidence_v2') {
    throw new Error(`/policy contract must be attestation_evidence_v2 (got ${JSON.stringify(policy.contract)})`)
  }

  if (policy.policy_mode !== 'production_enforce' || ready.mode !== 'production_enforce') {
    throw new Error('/policy and /ready must both report production_enforce')
  }

  const scaffoldFlags = policy.scaffold_flags as Record<string, unknown> | undefined
  if (scaffoldFlags?.allow_unimplemented_checks !== false
    || policy.scaffold_bypass_enabled !== false
    || ready.scaffold_bypass_enabled !== false) {
    throw new Error('production signer must disable unimplemented-check and scaffold bypasses')
  }

  if (policy.public_key !== options.expectedPublicKey) {
    throw new Error(`/policy public_key does not match /health (${String(policy.public_key)} != ${options.expectedPublicKey})`)
  }

  if (policy.network !== options.expectedNetwork) {
    throw new Error(`/policy network does not match /health (${String(policy.network)} != ${options.expectedNetwork})`)
  }

  if (!Array.isArray(policy.v2_capabilities)) throw new Error('/policy v2_capabilities must be an array')
  const rows = policy.v2_capabilities as Array<Record<string, unknown>>
  const names = rows.map(row => row.capability)
  const blocked: string[] = []
  for (const capability of REQUIRED_PRODUCTION_V2_CAPABILITIES) {
    const matches = rows.filter(row => row.capability === capability)
    if (matches.length !== 1) {
      throw new Error(`/policy must contain exactly one ${capability} capability row (found ${matches.length})`)
    }

    if (matches[0].production_serving !== true) {
      blocked.push(`${capability}=${String(matches[0].production_block || 'unknown')}`)
    }
  }

  if (new Set(names).size !== names.length) throw new Error('/policy contains duplicate V2 capability rows')
  if (options.readyStatus !== 200
    || policy.production_v2_ready !== true
    || ready.production_v2_ready !== true
    || blocked.length > 0) {
    throw new Error(
      `/ready returned HTTP ${options.readyStatus}; production V2 is not ready${blocked.length > 0 ? `; blocked: ${blocked.join(', ')}` : ''}`,
    )
  }
}

export class SignerPreflightCommand extends Command {
  static description = 'Probe a deployed attestation-signer and verify its runtime identity. Add --require-production-ready after applying a production bundle to require dogeos-core attestation_evidence_v2, fail-closed policy, and all four production capabilities.'

  static examples = [
    '$ scrollsdk signer preflight --dir signer-partner-a-signer-0 --endpoint https://signer.partner-a.example:4040',
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --out descriptor.json',
    '$ scrollsdk signer preflight --endpoint https://signer.partner-a.example:4040 --id partner-a-signer-0 --expected-public-key 02ab...',
    '$ scrollsdk signer preflight --dir signer-partner-a-signer-0 --require-production-ready',
  ]

  static flags = {
    dir: Flags.string({ description: 'signer init output directory; provides id/network/expected key from descriptor.json and receives the finalized descriptor' }),
    endpoint: Flags.string({ description: 'Signer HTTP base URL to probe (with --dir, defaults to the descriptor endpoint if already set)' }),
    'expected-public-key': Flags.string({ description: 'Fail unless the runtime public key equals this compressed secp256k1 key (with --dir, defaults to the descriptor publicKey)' }),
    id: Flags.string({ description: 'Stable signer identifier for the emitted descriptor (required without --dir)' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    network: Flags.string({ description: 'Expected Dogecoin network (defaults to descriptor network with --dir, else to the network reported by /health)', options: [...ATTESTATION_SIGNER_NETWORKS] }),
    out: Flags.string({ description: 'Write the descriptor JSON to this path (default with --dir: its descriptor.json; otherwise print to stdout)' }),
    'require-production-ready': Flags.boolean({default: false, description: 'Also require /ready and /policy to prove all four attestation_evidence_v2 production capabilities are serving'}),
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

      let productionReady = false
      if (flags['require-production-ready']) {
        const [ready, policy] = await Promise.all([
          fetchSignerJson(endpoint, '/ready'),
          fetchSignerJson(endpoint, '/policy'),
        ])
        if (policy.status !== 200) throw new Error(`${policy.url} returned HTTP ${policy.status}`)
        assertProductionSignerV2Ready({
          expectedNetwork: network,
          expectedPublicKey: health.publicKey,
          policy: policy.body,
          ready: ready.body,
          readyStatus: ready.status,
        })
        productionReady = true
        json.logSuccess('Signer reports fail-closed attestation_evidence_v2 production readiness')
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
        if (flags.json) json.success({descriptor, descriptorFile: outPath, productionReady})
        else this.log(chalk.green(`Descriptor written to ${outPath} — send this file to the bridge operator.`))
      } else if (flags.json) {
        json.success({descriptor, productionReady})
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
