import { Command, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'
import {
  PROVER_WORKER_MOCK_BUNDLE_DIR,
  verifyProverWorkerMockBundle,
} from '../../utils/prover-worker-mock-bundle.js'
import {
  verifyProverWorkerProductionBundle,
} from '../../utils/prover-worker-production-bundle.js'

export default class ProofWorkerCheck extends Command {
  static override description = 'Auto-detect and verify a generated mock or production prover-worker bundle, release artifacts, capabilities, secret-file mode, and optional expected bundle ID'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --bundle-dir /home/ubuntu/prover-worker-mock/docker-compose --expected-bundle-id <sha256>',
    '<%= config.bin %> <%= command.id %> --bundle-dir /srv/dogeos/prover-worker-production/docker-compose --release-root /srv/dogeos/proof-artifacts --expected-bundle-id <sha256>',
  ]

  static override flags = {
    'bundle-dir': Flags.string({ default: PROVER_WORKER_MOCK_BUNDLE_DIR, description: 'Generated mock or production Compose bundle directory; defaults to the mock bundle convention' }),
    'expected-bundle-id': Flags.string({ description: 'Expected bundle ID written by prep-charts; use on the worker host to reject a stale synchronized bundle' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'release-root': Flags.string({ description: 'Production release root on this worker host; defaults to PROVER_WORKER_RELEASE_ROOT from the generated .env' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofWorkerCheck)
    const json = new JsonOutputContext('setup proof-worker-check', flags.json)
    try {
      const bundleDir = path.resolve(flags['bundle-dir'])
      const manifestPath = path.join(bundleDir, 'bundle-manifest.json')
      let manifest: {release?: unknown}
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {release?: unknown}
      } catch (error) {
        throw new Error(
          `cannot read prover-worker bundle manifest ${manifestPath}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const production = Boolean(manifest.release)
      const result = production
        ? verifyProverWorkerProductionBundle({
            dir: bundleDir,
            expectedBundleId: flags['expected-bundle-id'],
            releaseRoot: flags['release-root'],
          })
        : verifyProverWorkerMockBundle({
            dir: bundleDir,
            expectedBundleId: flags['expected-bundle-id'],
          })
      const mode = production ? 'production' : 'mock'
      json.logSuccess(`Verified ${mode} prover-worker bundle ${result.bundleId} at ${result.bundleDir}`)
      json.success({...result, mode})
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
