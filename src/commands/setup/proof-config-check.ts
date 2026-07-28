import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  validateProofDeploymentContract,
} from '../../utils/proof-deployment-contract.js'
import { verifyProverWorkerMockBundle } from '../../utils/prover-worker-mock-bundle.js'

export default class ProofConfigCheck extends Command {
  static override description = 'Validate the proof deployment contract, generated values/native configs, mode consistency, and mock worker bundle without contacting Kubernetes or printing secrets'

  static override flags = {
    config: Flags.string({ char: 'c', description: 'Advanced doge-config.toml override' }),
    contract: Flags.string({ default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Proof deployment contract path relative to the deployment root' }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfigCheck)
    const json = new JsonOutputContext('setup proof-config-check', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const contract = validateProofDeploymentContract(deploymentDir, flags.contract)
      const configPath = flags.config || path.join(deploymentDir, '.data/doge-config.toml')
      const { config } = await loadDogeConfigWithSelection(configPath, 'scrollsdk setup proof-config')
      const configuredMode = config.proofSystem?.mode || config.proofSystem?.provingMode || 'disabled'
      if (configuredMode !== contract.mode) {
        throw new Error(`doge-config proof mode ${configuredMode} does not match deployment contract mode ${contract.mode}`)
      }

      let workerBundleId: string | undefined
      if (contract.mode === 'mock') {
        const result = verifyProverWorkerMockBundle({
          dir: path.resolve(deploymentDir, contract.worker.bundleDir!),
          expectedBundleId: contract.worker.bundleId,
        })
        workerBundleId = result.bundleId
      }

      json.logSuccess(`Verified ${contract.mode} proof deployment contract ${contract.generationId}`)
      json.success({
        contract: path.resolve(deploymentDir, flags.contract),
        generationId: contract.generationId,
        mode: contract.mode,
        workerBundleId,
      })
    } catch (error) {
      json.error(
        'E712_PROOF_DEPLOYMENT_INVALID',
        error instanceof Error ? error.message : String(error),
        'VALIDATION',
        true
      )
    }
  }
}
