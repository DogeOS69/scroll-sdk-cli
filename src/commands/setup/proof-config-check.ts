import {Command, Flags} from '@oclif/core'
import * as path from 'node:path'

import {verifyCompiledProverWorkerBundle} from '../../utils/compiled-prover-worker-bundle.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  resolveContractFile,
  validateProofDeploymentContract,
} from '../../utils/proof-deployment-contract.js'
import {resolveProofIntent} from '../../utils/proof-intent.js'
import {validateProofTopologyBundle} from '../../utils/proof-topology-compiler.js'

export default class ProofConfigCheck extends Command {
  static description = 'Validate generated proof configs, bundle revision, two switches, and Worker bundle without contacting Kubernetes'

  static flags = {
    config: Flags.string({char: 'c', description: 'doge-config.toml path'}),
    contract: Flags.string({default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Proof deployment contract path'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofConfigCheck)
    const output = new JsonOutputContext('setup proof-config-check', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const contract = validateProofDeploymentContract(deploymentDir, flags.contract)
      const configPath = flags.config
        || (contract.intentSource.kind === 'doge-config'
          ? resolveContractFile(deploymentDir, contract.intentSource.path)
          : path.join(deploymentDir, '.data/doge-config.toml'))
      const {config, configPath: loadedPath} = await loadDogeConfigWithSelection(configPath, 'scrollsdk setup prep-charts')
      const intent = resolveProofIntent({
        deploymentDir,
        dogeConfig: config,
        dogeConfigPath: loadedPath,
        required: true,
        specPath: flags.spec || (contract.intentSource.kind === 'deployment-spec' ? contract.intentSource.path : undefined),
      })!
      if (intent.source.sha256 !== contract.intentSource.sha256) throw new Error('proof intent changed after prep-charts; rerun prep-charts')
      if (
        intent.intent.mode !== contract.mode
        || intent.intent.generation !== contract.generation
        || intent.intent.enforcement !== contract.enforcement
      ) throw new Error('proof mode/generation/enforcement do not match the generated deployment contract')
      const bundle = validateProofTopologyBundle(resolveContractFile(deploymentDir, contract.topology.bundleDir), {preflightOnly: false})
      if (bundle.manifest.bundle_revision !== contract.topology.bundleRevision) throw new Error('compiler bundle revision does not match deployment contract')
      let workerBundleId: string | undefined
      if (['compiled-compose', 'compiled-external'].includes(contract.worker.kind)) {
        const result = verifyCompiledProverWorkerBundle({
          allowPendingCredential: true,
          bundleDir: resolveContractFile(deploymentDir, contract.worker.bundleDir!),
          expectedBundleId: contract.worker.bundleId,
        })
        workerBundleId = result.bundleId
      }

      output.logSuccess(`Verified ${contract.mode}/${contract.generation}/${contract.enforcement} proof deployment ${contract.generationId}`)
      output.success({
        bundleRevision: contract.topology.bundleRevision,
        contract: path.resolve(deploymentDir, flags.contract),
        enforcement: contract.enforcement,
        generation: contract.generation,
        generationId: contract.generationId,
        mode: contract.mode,
        workerBundleId,
      })
    } catch (error) {
      output.error('E712_PROOF_DEPLOYMENT_INVALID', error instanceof Error ? error.message : String(error), 'VALIDATION', true)
    }
  }
}
