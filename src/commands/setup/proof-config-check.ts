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
import {proofEnforcementReadiness} from '../../utils/proof-enforcement-readiness.js'
import {resolveProofIntent, validateProofIntentBinding} from '../../utils/proof-intent.js'
import {validateProofTopologyBundle} from '../../utils/proof-topology-compiler.js'
import {liveSignerAcceptance, readTsoMetrics} from '../../utils/tso-signer-polls.js'

export default class ProofConfigCheck extends Command {
  static description = 'Validate generated proof configs, bundle revision, two switches, Worker bundle and the published deployment kit; --live also requires every registered Attestation signer to be polling the TSO (the final acceptance check after rollout)'
  static flags = {
    config: Flags.string({char: 'c', description: 'doge-config.toml path'}),
    contract: Flags.string({default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Proof deployment contract path'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'kube-context': Flags.string({dependsOn: ['live'], description: 'Kubernetes context for --live'}),
    live: Flags.boolean({default: false, description: 'After rollout: also require a fresh authenticated TSO poll from every Attestation signer in the WP tsoSigners'}),
    namespace: Flags.string({default: 'default', dependsOn: ['live'], description: 'Kubernetes namespace for --live'}),
    scope: Flags.string({default: 'activation', description: 'Preparation validates expected policy materials; it never authorizes signer installation', options: ['activation', 'preparation']}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source'}),
  }

  static now = () => Date.now()

  /** Injectable for tests: the TSO metrics text and the clock. */
  static readMetrics = readTsoMetrics

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofConfigCheck)
    const output = new JsonOutputContext('setup proof-config-check', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const contract = validateProofDeploymentContract(deploymentDir, flags.contract)
      if (contract.mode === 'active' && contract.generation === 'real' && (!contract.inputs?.publication || !contract.artifactStoreReceipt)) {
        throw new Error('Final active/real configuration requires bound materials, protocol, artifact-store and program-publication receipts; finish proof-config publish or regenerate with the selected receipts')
      }

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
      validateProofIntentBinding(contract, intent)
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

      const readiness = proofEnforcementReadiness(deploymentDir, contract, config, flags.scope as 'activation' | 'preparation')
      if (contract.enforcement === 'enforce' && !readiness.ready) throw new Error(`Proof enforcement is blocked:\n- ${readiness.blockers.join('\n- ')}`)
      for (const blocker of readiness.blockers) output.addWarning(`Enforcement pending: ${blocker}`)
      if (flags.live && flags.scope !== 'activation') throw new Error('--live requires activation scope')
      const live = flags.live ? await liveSignerAcceptance({context: flags['kube-context'], deploymentDir, enforcement: contract.enforcement, namespace: flags.namespace, now: ProofConfigCheck.now, readMetrics: ProofConfigCheck.readMetrics}) : undefined

      output.logSuccess(`Verified ${contract.mode}/${contract.generation}/${contract.enforcement} proof deployment ${contract.generationId}`)
      output.success({
        bundleRevision: contract.topology.bundleRevision,
        contract: path.resolve(deploymentDir, flags.contract),
        enforcement: contract.enforcement,
        enforcementReadiness: readiness,
        generation: contract.generation,
        generationId: contract.generationId,
        ...(live ? {liveSigners: live} : {}),
        mode: contract.mode,
        workerBundleId,
      })
    } catch (error) {
      output.error('E712_PROOF_DEPLOYMENT_INVALID', error instanceof Error ? error.message : String(error), 'VALIDATION', true)
    }
  }
}
