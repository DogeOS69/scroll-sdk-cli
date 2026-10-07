import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_RELEASE_PREPARATION_RECEIPT,
  captureProofReleasePreparation,
} from '../../utils/proof-release-preparation.js'

export default class ProofReleasePrepare extends Command {
  static description = 'Validate and capture a proof-preparation-producer (prepare-real) output tree as one immutable local handoff receipt'

  static examples = [
    '<%= config.bin %> <%= command.id %> --artifact-root /build/release --expected-core-revision <40-hex-sha>',
  ]

  static flags = {
    'artifact-root': Flags.string({description: 'prepare-real output containing chunk/, batch/, verifier/, bridge/, protocol_context.json and real-identity.env', required: true}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root used to resolve the output receipt'}),
    'expected-core-revision': Flags.string({description: 'Full approved dogeos-core Git SHA', required: true}),
    'identity-env': Flags.string({description: 'Override artifact-root/real-identity.env'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    output: Flags.string({default: DEFAULT_PROOF_RELEASE_PREPARATION_RECEIPT, description: 'New local preparation receipt; existing files are never replaced'}),
    'protocol-context': Flags.string({description: 'Override artifact-root/protocol_context.json'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofReleasePrepare)
    const output = new JsonOutputContext('setup proof-release-prepare', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const result = captureProofReleasePreparation({
        artifactRoot: path.resolve(flags['artifact-root']),
        expectedCoreRevision: flags['expected-core-revision'],
        identityEnv: flags['identity-env'],
        output: path.resolve(deploymentDir, flags.output),
        protocolContext: flags['protocol-context'],
      })
      output.logSuccess(`Captured proof preparation ${result.receiptPath}`)
      output.addWarning('This receipt validates a native preparation handoff; it does not build a CUDA image, upload artifacts, start a Worker, or activate a topology')
      output.success({coreRevision: result.receipt.coreRevision, receipt: result.receiptPath, schema: result.receipt.schema})
    } catch (error) {
      output.error('E718_PROOF_RELEASE_PREPARE_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
