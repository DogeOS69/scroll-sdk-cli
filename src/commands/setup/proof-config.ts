import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import type { ProofFamily } from '../../utils/proof-configurator.js'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  DEFAULT_BRIDGE_BACKEND_PROFILE,
  DEFAULT_SCROLL_BATCH_BACKEND_PROFILE,
  configureProofValues,
} from '../../utils/proof-configurator.js'

export const DEFAULT_PROOF_ARTIFACT_MANIFEST = 'proof-artifacts/release.json'
export const DEFAULT_PROOF_COORDINATOR_CONFIG = 'proof-coordinator/ProofCoordinator.toml'
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
  static override description = 'Stage production proof topology without changing withdrawalProof.enabled'

  static override examples = [
    '# Use the standard proof-coordinator/, proof-artifacts/, and values/ layout',
    '<%= config.bin %> <%= command.id %> --signer-proof-artifact-base-url https://proofs.example.com/proof-topology',
    '',
    '# Override paths for a non-standard layout',
    '<%= config.bin %> <%= command.id %> --signer-proof-artifact-base-url https://proofs.example.com/proof-topology --artifact-manifest release.json --program-manifest chunk.json --program-manifest batch.json --program-manifest bridge.json',
  ]

  static override flags = {
    'artifact-manifest': Flags.string({ description: `Real-proving artifact manifest (default: ${DEFAULT_PROOF_ARTIFACT_MANIFEST})` }),
    'bridge-backend-profile': Flags.string({ default: DEFAULT_BRIDGE_BACKEND_PROFILE, description: 'Backend profile stamped onto bridge prove work' }),
    'coordinator-config': Flags.string({ default: DEFAULT_PROOF_COORDINATOR_CONFIG, description: 'Native ProofCoordinator.toml containing scrollsdk managed verifier markers' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'program-manifest': Flags.string({ description: 'ProofProgramManifestV1 JSON; repeat for a non-standard layout (defaults to proof-artifacts/manifests/*.json)', multiple: true }),
    'scroll-batch-backend-profile': Flags.string({ default: DEFAULT_SCROLL_BATCH_BACKEND_PROFILE, description: 'Backend profile stamped onto Scroll batch prove work' }),
    'signer-proof-artifact-base-url': Flags.string({ description: 'Stable public GET base used by attestation signers to fetch accepted proof objects', required: true }),
    'values-dir': Flags.string({ default: 'values', description: 'Directory containing *-production.yaml files' }),
    'verifier-id': Flags.string({ description: 'Optional FAMILY=ID override; repeat per family', multiple: true }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfig)
    const json = new JsonOutputContext('setup proof-config', flags.json)
    try {
      const result = configureProofValues({
        artifactManifestPath: path.resolve(flags['artifact-manifest'] || DEFAULT_PROOF_ARTIFACT_MANIFEST),
        bridgeBackendProfile: flags['bridge-backend-profile'],
        coordinatorConfigPath: path.resolve(flags['coordinator-config']),
        manifestPaths: (flags['program-manifest'] || DEFAULT_PROOF_PROGRAM_MANIFESTS).map(item => path.resolve(item)),
        scrollBatchBackendProfile: flags['scroll-batch-backend-profile'],
        signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'],
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
