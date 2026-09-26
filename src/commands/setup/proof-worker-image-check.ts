import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {parseProofIdentityEnv, resolveImmutableProofImage} from '../../utils/proof-materials.js'
import {readProofReleasePreparation} from '../../utils/proof-release-preparation.js'
import {
  DEFAULT_PROOF_WORKER_IMAGE_CHECK,
  checkProofWorkerImage,
} from '../../utils/proof-worker-image-check.js'

export default class ProofWorkerImageCheck extends Command {
  static description = 'Validate a digest-pinned production CUDA Worker image against native preparation identities without requiring a GPU'

  static examples = [
    '<%= config.bin %> <%= command.id %> --image dogeos69/prover-worker-cuda:TAG --preparation-receipt .data/proof-release-preparation-v1.json',
    '<%= config.bin %> <%= command.id %> --image repo/worker@sha256:... --identity-env /build/identity-full.env --expected-core-revision <40-hex-sha>',
  ]

  static flags = {
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    'expected-core-revision': Flags.string({description: 'Full approved dogeos-core Git SHA; implied by --preparation-receipt'}),
    'identity-env': Flags.string({description: 'Native full identity env; excludes --preparation-receipt'}),
    image: Flags.string({description: 'Production CUDA Worker tag or immutable digest', required: true}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    output: Flags.string({default: DEFAULT_PROOF_WORKER_IMAGE_CHECK, description: 'New image-check receipt; existing files are never replaced'}),
    'preparation-receipt': Flags.string({description: 'Validated proof-release-preparation-v1.json'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofWorkerImageCheck)
    const output = new JsonOutputContext('setup proof-worker-image-check', flags.json)
    try {
      if (flags['identity-env'] && flags['preparation-receipt']) {
        throw new Error('--identity-env and --preparation-receipt are mutually exclusive')
      }

      const deploymentDir = path.resolve(flags['deployment-dir'])
      const preparation = flags['preparation-receipt']
        ? readProofReleasePreparation(path.resolve(deploymentDir, flags['preparation-receipt']))
        : undefined
      const expectedCoreRevision = flags['expected-core-revision'] ?? preparation?.coreRevision
      if (!expectedCoreRevision) throw new Error('--expected-core-revision or --preparation-receipt is required')
      if (preparation && flags['expected-core-revision'] && preparation.coreRevision !== flags['expected-core-revision']) {
        throw new Error('--expected-core-revision does not match --preparation-receipt')
      }

      const identityEnv = preparation?.files.identityEnv.path
        ?? (flags['identity-env'] ? path.resolve(flags['identity-env']) : undefined)
      if (!identityEnv) throw new Error('--identity-env or --preparation-receipt is required')
      const identities = parseProofIdentityEnv(fs.readFileSync(identityEnv, 'utf8'))
      const result = checkProofWorkerImage({
        expectedBatchAggregationProgramCommitmentRaw: identities.DOGEOS_BATCH_AGGREGATION_PROGRAM_COMMITMENT_RAW,
        expectedBatchProgramCommitmentRaw: identities.DOGEOS_BATCH_PROGRAM_COMMITMENT_RAW,
        expectedCoreRevision,
        image: resolveImmutableProofImage(flags.image, '--image'),
        output: path.resolve(deploymentDir, flags.output),
      })
      output.logSuccess(`Validated production Worker image ${result.receipt.image.repository}@${result.receipt.image.digest}`)
      output.addWarning('This GPU-less label check does not run a proof or certify the target GPU architecture')
      output.success({
        coreRevision: result.receipt.coreRevision,
        cudaArchitectures: result.receipt.cudaArchitectures,
        image: result.receipt.image,
        receipt: result.receiptPath,
      })
    } catch (error) {
      output.error('E719_PROOF_WORKER_IMAGE_CHECK_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
