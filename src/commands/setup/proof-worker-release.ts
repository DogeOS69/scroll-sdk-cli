import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST,
  writeProverWorkerReleaseManifest,
} from '../../utils/prover-worker-production-bundle.js'

export default class ProofWorkerRelease extends Command {
  static override description = 'Release-producer helper: hash the conventional all-family prover artifacts and write worker-release.json for deployment-side worker bundle generation'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --image dogeos69/prover-worker-cuda@sha256:<digest>',
    '<%= config.bin %> <%= command.id %> --release-root proof-releases/v2026.07.1 --image dogeos69/prover-worker-cuda@sha256:<digest>',
  ]

  static override flags = {
    image: Flags.string({
      description: 'Immutable all-family CUDA worker image digest',
      required: true,
    }),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'release-root': Flags.string({
      default: 'proof-artifacts',
      description: 'Release root containing chunk/, batch/, and bridge/ conventional artifacts',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ProofWorkerRelease)
    const json = new JsonOutputContext('setup proof-worker-release', flags.json)
    try {
      const releaseRoot = path.resolve(flags['release-root'])
      const manifestFile = writeProverWorkerReleaseManifest({
        image: flags.image,
        releaseRoot,
      })
      json.logSuccess(`Wrote ${PROVER_WORKER_PRODUCTION_RELEASE_MANIFEST}`)
      json.success({manifestFile, releaseRoot})
    } catch (error) {
      json.error(
        'E714_PROOF_WORKER_RELEASE_FAILED',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
      )
    }
  }
}
