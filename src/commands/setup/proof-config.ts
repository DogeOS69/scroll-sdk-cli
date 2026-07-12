import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import type { ProofFamily } from '../../utils/proof-configurator.js'

import { JsonOutputContext } from '../../utils/json-output.js'
import { configureProofValues } from '../../utils/proof-configurator.js'

export const DEFAULT_PROOF_ARTIFACT_MANIFEST = 'proof-artifacts/release.json'
export const DEFAULT_PROOF_PROGRAM_MANIFESTS = [
  'proof-artifacts/manifests/scroll-chunk.json',
  'proof-artifacts/manifests/scroll-batch.json',
  'proof-artifacts/manifests/bridge-transition.json',
]

function parseVerifierIds(values: string[]): Partial<Record<ProofFamily, string>> {
  const result: Partial<Record<ProofFamily, string>> = {}
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator < 1) throw new Error(`Invalid --verifier-id ${value}; expected FAMILY=ID`)
    const family = value.slice(0, separator) as ProofFamily
    if (!['bridge_transition', 'scroll_batch', 'scroll_chunk'].includes(family)) {
      throw new Error(`Invalid proof family in --verifier-id: ${family}`)
    }

    result[family] = value.slice(separator + 1)
  }

  return result
}

export default class ProofConfig extends Command {
  static override description = 'Populate proof topology Helm values from cryptographic release manifests'

  static override examples = [
    '# Use the standard proof-artifacts/ and values/ layout',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Override paths for a non-standard layout',
    '<%= config.bin %> <%= command.id %> --artifact-manifest release.json --program-manifest chunk.json --program-manifest batch.json --program-manifest bridge.json',
  ]

  static override flags = {
    'artifact-manifest': Flags.string({ description: `Real-proving artifact manifest (default: ${DEFAULT_PROOF_ARTIFACT_MANIFEST})` }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'program-manifest': Flags.string({ description: 'ProofProgramManifestV1 JSON; repeat for a non-standard layout (defaults to proof-artifacts/manifests/*.json)', multiple: true }),
    'values-dir': Flags.string({ default: 'values', description: 'Directory containing *-production.yaml files' }),
    'verifier-id': Flags.string({ description: 'Optional FAMILY=ID override; repeat per family', multiple: true }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfig)
    const json = new JsonOutputContext('setup proof-config', flags.json)
    try {
      const result = configureProofValues({
        artifactManifestPath: path.resolve(flags['artifact-manifest'] || DEFAULT_PROOF_ARTIFACT_MANIFEST),
        manifestPaths: (flags['program-manifest'] || DEFAULT_PROOF_PROGRAM_MANIFESTS).map(item => path.resolve(item)),
        valuesDir: path.resolve(flags['values-dir']),
        verifierIds: parseVerifierIds(flags['verifier-id'] || []),
      })
      json.logSuccess(`Configured proof values for: ${result.families.join(', ')}`)
      json.success(result)
    } catch (error) {
      json.error('E701_PROOF_CONFIG_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
