import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import {verifyCompiledProverWorkerBundle} from '../../utils/compiled-prover-worker-bundle.js'
import { JsonOutputContext } from '../../utils/json-output.js'

export default class ProofWorkerCheck extends Command {
  static override description = 'Verify a compiler-generated Docker Compose prover-worker bundle, selected resources, secret-file mode, and optional expected bundle ID'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --bundle-dir /srv/dogeos/prover-worker-production/docker-compose --resources-root /srv/dogeos/proof-resources --expected-bundle-id <sha256>',
  ]

  static override flags = {
    'bundle-dir': Flags.string({ description: 'Compiler-generated Worker Compose bundle directory', required: true }),
    'expected-bundle-id': Flags.string({ description: 'Expected bundle ID written by prep-charts; use on the worker host to reject a stale synchronized bundle' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'resources-root': Flags.string({
      description: 'Compiler-backed Worker resources root on this host; defaults to PROOF_RESOURCES_ROOT from the bundle .env',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofWorkerCheck)
    const json = new JsonOutputContext('setup proof-worker-check', flags.json)
    try {
      const bundleDir = path.resolve(flags['bundle-dir'])
      const result = verifyCompiledProverWorkerBundle({
        bundleDir,
        expectedBundleId: flags['expected-bundle-id'],
        resourcesRoot: flags['resources-root'],
      })
      json.logSuccess(`Verified compiled prover-worker bundle ${result.bundleId} at ${result.bundleDir}`)
      json.success({...result, mode: 'compiled'})
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
