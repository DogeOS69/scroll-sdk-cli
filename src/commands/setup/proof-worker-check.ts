import { Command, Flags } from '@oclif/core'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  PROVER_WORKER_MOCK_BUNDLE_DIR,
  verifyProverWorkerMockBundle,
} from '../../utils/prover-worker-mock-bundle.js'

export default class ProofWorkerCheck extends Command {
  static override description = 'Verify a generated mock prover-worker bundle checksum, required proof capabilities, secret-file mode, and optional expected bundle ID without reading or printing the bearer token'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --bundle-dir /home/ubuntu/prover-worker-mock/docker-compose --expected-bundle-id <sha256>',
  ]

  static override flags = {
    'bundle-dir': Flags.string({ default: PROVER_WORKER_MOCK_BUNDLE_DIR, description: 'Directory containing docker-compose.yml, .env, prover-worker.env, and bundle-manifest.json' }),
    'expected-bundle-id': Flags.string({ description: 'Expected bundle ID printed by proof-config; use on the worker host to reject a stale synchronized bundle' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofWorkerCheck)
    const json = new JsonOutputContext('setup proof-worker-check', flags.json)
    try {
      const result = verifyProverWorkerMockBundle({
        dir: flags['bundle-dir'],
        expectedBundleId: flags['expected-bundle-id'],
      })
      json.logSuccess(`Verified mock prover-worker bundle ${result.bundleId} at ${result.bundleDir}`)
      json.success(result)
    } catch (error) {
      json.error(
        'E711_PROOF_WORKER_BUNDLE_INVALID',
        error instanceof Error ? error.message : String(error),
        'VALIDATION',
        true
      )
    }
  }
}
