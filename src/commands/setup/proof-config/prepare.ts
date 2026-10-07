import {Command, Flags} from '@oclif/core'
import fs from 'node:fs'
import path from 'node:path'

import {JsonOutputContext} from '../../../utils/json-output.js'
import {prepareProofConfig} from '../../../utils/proof-config-transaction.js'
import {proofRegularFile} from '../../../utils/proof-software-release.js'

export default class ProofConfigPrepare extends Command {
  static description = 'Prepare a complete isolated proof configuration generation; no S3 writes, Kubernetes calls or provider mutations'
  static flags = {
    'deployment-dir': Flags.string({default: '.', description: 'Existing deployment inputs and chart values'}),
    json: Flags.boolean({default: false}),
    output: Flags.string({description: 'New candidate deployment directory; existing outputs are never overwritten', required: true}),
    release: Flags.string({description: 'Immutable dogeos-proof-release-v1.json', required: true}),
    'release-sha256': Flags.string({description: 'Expected release manifest SHA-256', required: true}),
    request: Flags.string({description: 'JSON containing deploymentName, mode, generation, enforcement and runtime/Worker placement', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofConfigPrepare)
    const output = new JsonOutputContext('setup proof-config prepare', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      const request = JSON.parse(fs.readFileSync(proofRegularFile(path.resolve(root, flags.request), 1024 * 1024), 'utf8'))
      const result = prepareProofConfig({deploymentDir: root, output: flags.output, release: flags.release, releaseSha256: flags['release-sha256'], request})
      for (const warning of result.warnings) output.addWarning(warning)
      output.logSuccess(`Prepared complete proof configuration in ${result.directory}`)
      output.success(result)
    } catch (error) { output.error('E730_PROOF_CONFIG_PREPARE_FAILED', String(error), 'CONFIGURATION', true) }
  }
}
