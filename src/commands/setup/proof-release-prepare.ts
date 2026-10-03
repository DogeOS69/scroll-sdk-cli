import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_RELEASE_PREPARATION_RECEIPT,
  captureProofReleasePreparation,
} from '../../utils/proof-release-preparation.js'

export default class ProofReleasePrepare extends Command {
  static description = 'Validate and capture native dogeos-core real-proof preparation output as one immutable local handoff receipt'

  static examples = [
    '<%= config.bin %> <%= command.id %> --artifact-root /build/release --expected-core-revision <40-hex-sha>',
    '<%= config.bin %> <%= command.id %> --artifact-root /build/release --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --expected-core-revision <40-hex-sha>',
  ]

  static flags = {
    'artifact-root': Flags.string({description: 'Native preparation root containing identity-full.env, manifest, protocol context and bridge/', required: true}),
    'batch-materializer': Flags.string({description: 'Override artifact-root/bin/scroll-runtime-materializer'}),
    'chunk-materializer': Flags.string({description: 'Override artifact-root/bin/materialize-chunk-oneshot'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root used to resolve the output receipt'}),
    'expected-core-revision': Flags.string({description: 'Full approved dogeos-core Git SHA', required: true}),
    'identity-env': Flags.string({description: 'Override artifact-root/identity-full.env'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    output: Flags.string({default: DEFAULT_PROOF_RELEASE_PREPARATION_RECEIPT, description: 'New local preparation receipt; existing files are never replaced'}),
    'producer-manifest': Flags.string({description: 'Override artifact-root/real-proving-artifacts.json'}),
    'protocol-context': Flags.string({description: 'Override artifact-root/protocol_context.json'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofReleasePrepare)
    const output = new JsonOutputContext('setup proof-release-prepare', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const result = captureProofReleasePreparation({
        artifactRoot: path.resolve(flags['artifact-root']),
        batchMaterializer: flags['batch-materializer'],
        chunkMaterializer: flags['chunk-materializer'],
        expectedCoreRevision: flags['expected-core-revision'],
        identityEnv: flags['identity-env'],
        output: path.resolve(deploymentDir, flags.output),
        producerManifest: flags['producer-manifest'],
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
