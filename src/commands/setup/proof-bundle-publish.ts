import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {DEFAULT_PROOF_AWS_CONFIG} from '../../utils/proof-aws-config.js'
import {DEFAULT_PROOF_MATERIALS_RECEIPT} from '../../utils/proof-materials.js'
import {
  DEFAULT_PROOF_PROGRAM_PUBLICATION_RECEIPT,
  planProofProgramPublication,
  publishProofProgramBundle,
} from '../../utils/proof-program-publication.js'
import {DEFAULT_PROOF_TOPOLOGY_OUTPUT} from '../../utils/proof-topology-compiler.js'

export default class ProofBundlePublish extends Command {
  static description = 'Plan or publish the complete content-addressed 11-file real-proof program bundle; shared bucket policy is never modified'

  static examples = [
    '<%= config.bin %> <%= command.id %> --core-dir /data/dogeos-core',
    '<%= config.bin %> <%= command.id %> --core-dir /data/dogeos-core --apply --aws-profile devnet',
  ]

  static flags = {
    apply: Flags.boolean({default: false, description: 'Perform S3 writes and anonymous readback; omission prints a read-only plan'}),
    'aws-profile': Flags.string({description: 'AWS profile used by the dogeos-core publisher'}),
    'core-dir': Flags.string({description: 'Clean dogeos-core checkout matching the materials source revision', required: true}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    materials: Flags.string({default: DEFAULT_PROOF_MATERIALS_RECEIPT, description: 'Real proof-materials-v1.json'}),
    output: Flags.string({default: DEFAULT_PROOF_PROGRAM_PUBLICATION_RECEIPT, description: 'New publication receipt written only after all public GET checks pass'}),
    'proof-aws-config': Flags.string({default: DEFAULT_PROOF_AWS_CONFIG, description: 'proof-aws.json containing the canonical shared artifact store'}),
    'topology-bundle': Flags.string({default: DEFAULT_PROOF_TOPOLOGY_OUTPUT, description: 'Installable active/real compiler bundle containing the tag-5 manifest'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofBundlePublish)
    const output = new JsonOutputContext('setup proof-bundle-publish', flags.json)
    try {
      const common = {
        coreDir: path.resolve(flags['core-dir']),
        deploymentDir: path.resolve(flags['deployment-dir']),
        materialsReceipt: flags.materials,
        proofAwsConfig: flags['proof-aws-config'],
        topologyBundle: flags['topology-bundle'],
      }
      if (!flags.apply) {
        const plan = planProofProgramPublication(common)
        output.logSuccess('Validated real-proof publication plan; no files were uploaded')
        output.addWarning('Re-run with --apply to publish. The command always preserves the existing shared-bucket policy.')
        output.success({
          apply: false,
          artifactStore: plan.artifactStore,
          bundleId: plan.bundleId,
          coreRevision: plan.coreRevision,
          files: plan.files.map(file => ({relativePath: file.relativePath, sha256: file.sha256, sizeBytes: file.sizeBytes})),
          proofTopologyBundleRevision: plan.proofTopologyBundleRevision,
        })
        return
      }

      const result = await publishProofProgramBundle({
        ...common,
        awsProfile: flags['aws-profile'],
        output: flags.output,
      })
      output.logSuccess(`Published and publicly verified proof program bundle ${result.receipt.bundleId}`)
      output.success({
        artifactStore: result.receipt.artifactStore,
        bundleId: result.receipt.bundleId,
        files: Object.keys(result.receipt.files).length,
        receipt: result.receiptPath,
        verification: result.receipt.verification,
      })
    } catch (error) {
      output.error('E720_PROOF_BUNDLE_PUBLISH_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
