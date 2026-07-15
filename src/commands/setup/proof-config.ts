import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import type { ProofFamily } from '../../utils/proof-configurator.js'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  DEFAULT_BRIDGE_BACKEND_PROFILE,
  DEFAULT_SCROLL_BATCH_BACKEND_PROFILE,
  configureProofValues,
} from '../../utils/proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from '../../utils/proof-coordinator-scaffold.js'

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
  static override description = 'Stage production proof topology across withdrawal-processor, proof-coordinator, and attestation-signer values; withdrawalProof.enabled is only changed with an explicit --enable-withdrawal-proof'

  static override examples = [
    '# Use the standard proof-coordinator/, proof-artifacts/, and values/ layout',
    '<%= config.bin %> <%= command.id %> --signer-proof-artifact-base-url https://proofs.example.com/proof-topology',
    '',
    '# Generate ProofCoordinator.toml when missing, then stage and activate in one pass',
    '<%= config.bin %> <%= command.id %> --signer-proof-artifact-base-url https://proofs.example.com/proof-topology --scaffold-coordinator-config --enable-withdrawal-proof',
    '',
    '# Override paths for a non-standard layout',
    '<%= config.bin %> <%= command.id %> --signer-proof-artifact-base-url https://proofs.example.com/proof-topology --artifact-manifest release.json --program-manifest chunk.json --program-manifest batch.json --program-manifest bridge.json',
  ]

  static override flags = {
    'artifact-manifest': Flags.string({ description: `Real-proving artifact manifest (default: ${DEFAULT_PROOF_ARTIFACT_MANIFEST})` }),
    'bridge-backend-profile': Flags.string({ default: DEFAULT_BRIDGE_BACKEND_PROFILE, description: 'Backend profile stamped onto bridge prove work' }),
    'coordinator-config': Flags.string({ default: DEFAULT_PROOF_COORDINATOR_CONFIG, description: 'Native ProofCoordinator.toml containing scrollsdk managed verifier markers' }),
    'enable-withdrawal-proof': Flags.boolean({ default: false, description: 'Set withdrawalProof.enabled=true after staging; without this flag the activation switch is preserved as-is' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'program-manifest': Flags.string({ description: 'ProofProgramManifestV1 JSON; repeat for a non-standard layout (defaults to proof-artifacts/manifests/*.json)', multiple: true }),
    'scaffold-coordinator-config': Flags.boolean({ default: false, description: 'Generate ProofCoordinator.toml from the prepared withdrawal-processor values when the file does not exist yet' }),
    'scroll-batch-backend-profile': Flags.string({ default: DEFAULT_SCROLL_BATCH_BACKEND_PROFILE, description: 'Backend profile stamped onto Scroll batch prove work' }),
    'signer-proof-artifact-base-url': Flags.string({ description: 'Stable public GET base used by attestation signers to fetch accepted proof objects', required: true }),
    'skip-attestation-signers': Flags.boolean({ default: false, description: 'Do not project the proof-triple allowlist into attestation-signer values files' }),
    'values-dir': Flags.string({ default: 'values', description: 'Directory containing *-production.yaml files' }),
    'verifier-id': Flags.string({ description: 'Optional FAMILY=ID override; repeat per family', multiple: true }),
    'withdrawal-config': Flags.string({ description: 'Native WithdrawalProcessor.toml (default: withdrawal-processor/WithdrawalProcessor.toml next to the values dir); when it exists the managed proof block is written there instead of inline values' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfig)
    const json = new JsonOutputContext('setup proof-config', flags.json)
    try {
      const coordinatorConfigPath = path.resolve(flags['coordinator-config'])
      const valuesDir = path.resolve(flags['values-dir'])
      const withdrawalConfigPath = flags['withdrawal-config']
        ? path.resolve(flags['withdrawal-config'])
        : undefined
      let scaffolded = false
      if (flags['scaffold-coordinator-config']) {
        const scaffold = scaffoldProofCoordinatorConfig({ coordinatorConfigPath, valuesDir, withdrawalConfigPath })
        scaffolded = scaffold.created
        json.logSuccess(scaffold.created
          ? `Scaffolded ${scaffold.configFile} from the withdrawal-processor deployment configuration`
          : `${scaffold.configFile} already exists; scaffold skipped`)
      }

      const result = configureProofValues({
        artifactManifestPath: path.resolve(flags['artifact-manifest'] || DEFAULT_PROOF_ARTIFACT_MANIFEST),
        bridgeBackendProfile: flags['bridge-backend-profile'],
        coordinatorConfigPath,
        enableWithdrawalProof: flags['enable-withdrawal-proof'],
        manifestPaths: (flags['program-manifest'] || DEFAULT_PROOF_PROGRAM_MANIFESTS).map(item => path.resolve(item)),
        scrollBatchBackendProfile: flags['scroll-batch-backend-profile'],
        signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'],
        skipAttestationSigners: flags['skip-attestation-signers'],
        valuesDir,
        verifierIds: parseVerifierIds(flags['verifier-id'] || []),
        withdrawalConfigPath,
      })
      json.logSuccess(`Configured proof values for: ${result.families.join(', ')}`)
      if (flags['enable-withdrawal-proof']) {
        json.logSuccess('withdrawalProof.enabled set to true — verify coordinator readiness, S3 identity, and prover workers before deploying')
      }

      json.success({ ...result, scaffoldedCoordinatorConfig: scaffolded })
    } catch (error) {
      json.error('E701_PROOF_CONFIG_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
