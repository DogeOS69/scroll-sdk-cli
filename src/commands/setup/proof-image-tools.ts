import {Command, Flags} from '@oclif/core'

import {JsonOutputContext} from '../../utils/json-output.js'
import {runProofImageTools} from '../../utils/proof-image-tools.js'
import {prepareRealProofRelease} from '../../utils/proof-prepare-real.js'

export default class ProofImageTools extends Command {
  static description = 'Run pinned native proof image tools offline; export identities/materializers or derive Scroll identity evidence without deploying Workers'

  static flags = {
    action: Flags.string({default: 'export', options: ['export', 'derive-scroll', 'prepare-real']}),
    'artifact-root': Flags.string({description: 'Candidate release directory containing chunk/, batch/ and verifier/aggregate-vk'}),
    'coordinator-image': Flags.string({description: 'PC image containing the matching materialize-chunk-oneshot and scroll-runtime-materializer binaries'}),
    'deployment-dir': Flags.string({default: '.'}),
    'expected-core-revision': Flags.string({description: 'Full approved core Git SHA; every selected image and compiled Worker identity must match'}),
    json: Flags.boolean({default: false}),
    output: Flags.string({description: 'New output directory inside deployment-dir; existing output is never replaced', required: true}),
    'producer-image': Flags.string({description: 'CPU producer image with /usr/local/libexec/dogeos-proof-release-producer (derive-scroll only)'}),
    'protocol-context': Flags.string({description: 'Canonical deployment protocol_context.json (prepare-real only)'}),
    release: Flags.string({description: 'Immutable dogeos-proof-release-v1.json (prepare-real only)'}),
    'release-sha256': Flags.string({description: 'Expected release manifest SHA-256 (prepare-real only)'}),
    'require-real-materialization': Flags.boolean({default: false, description: 'Reject a placeholder Batch identity during export; use before real-materialization activation'}),
    'worker-image': Flags.string({description: 'CPU Worker/tool image providing --print-identity-json; no Worker service is started'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofImageTools)
    const output = new JsonOutputContext('setup proof-image-tools', flags.json)
    try {
      if (flags.action === 'prepare-real') {
        if (!flags.release || !flags['release-sha256'] || !flags['protocol-context']) throw new Error('prepare-real requires release, release-sha256 and protocol-context')
        if (flags['producer-image'] || flags['worker-image'] || flags['coordinator-image'] || flags['artifact-root'] || flags['require-real-materialization'] || flags['expected-core-revision']) throw new Error('prepare-real derives images and revision exclusively from the release manifest')
        output.success(prepareRealProofRelease({deploymentDir: flags['deployment-dir'], output: flags.output, protocolContext: flags['protocol-context'], release: flags.release, releaseSha256: flags['release-sha256']}))
        return
      }

      if (flags.release || flags['release-sha256'] || flags['protocol-context']) throw new Error('release flags require prepare-real')
      if (!flags['expected-core-revision']) throw new Error('expected-core-revision is required')
      if (flags.action === 'derive-scroll' && (flags['worker-image'] || flags['coordinator-image'] || flags['require-real-materialization'])) {
        throw new Error('derive-scroll accepts producer-image and artifact-root, not export flags')
      }

      if (flags.action === 'export' && (flags['producer-image'] || flags['artifact-root'])) throw new Error('export accepts worker-image and coordinator-image, not derive-scroll flags')
      const result = runProofImageTools({
        action: flags.action as 'derive-scroll' | 'export',
        artifactRoot: flags['artifact-root'],
        coordinatorImage: flags['coordinator-image'],
        deploymentDir: flags['deployment-dir'],
        expectedRevision: flags['expected-core-revision'],
        output: flags.output,
        producerImage: flags['producer-image'],
        requireRealMaterialization: flags['require-real-materialization'],
        workerImage: flags['worker-image'],
      })
      if (result.receipt.batchIdentityPlaceholder) output.addWarning('Exported identity has a placeholder Batch commitment; NOT ready for real materialization. No deployment config was changed.')
      output.logSuccess('Native image tool output recorded; this is not topology activation or end-to-end proof acceptance')
      output.success(result)
    } catch (error) {
      output.error('E717_PROOF_IMAGE_TOOL_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
