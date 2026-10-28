import * as path from 'node:path'

import {loadDogeConfigWithSelection} from './doge-config.js'
import {
  DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  resolveContractFile,
  validateProofDeploymentContract,
} from './proof-deployment-contract.js'
import {proofEnforcementReadiness} from './proof-enforcement-readiness.js'
import {resolveProofIntent, validateProofIntentBinding} from './proof-intent.js'
import {validateProofTopologyBundle} from './proof-topology-compiler.js'
import {liveSignerAcceptance, readTsoMetrics} from './tso-signer-polls.js'

/** Shared by staged rendering and the deployment preflight; never writes resources. */
export async function checkProofDeployment(options: {
  config?: string; contract?: string; deploymentDir: string; kubeContext?: string; live?: boolean;
  namespace?: string; now?: () => number; readMetrics?: typeof readTsoMetrics; scope?: 'activation' | 'preparation'; spec?: string
}) {
  const scope = options.scope ?? 'activation'
  const deploymentDir = path.resolve(options.deploymentDir)
  const contract = validateProofDeploymentContract(deploymentDir, options.contract ?? DEFAULT_PROOF_DEPLOYMENT_CONTRACT)
  if (contract.mode === 'active' && contract.generation === 'real' && (!contract.inputs?.publication || !contract.artifactStoreReceipt)) {
    throw new Error('Final active/real configuration requires bound materials, protocol, artifact-store and program-publication receipts; finish setup proof-publish and setup render')
  }

  const configPath = options.config
    || (contract.intentSource.kind === 'doge-config'
      ? resolveContractFile(deploymentDir, contract.intentSource.path)
      : path.join(deploymentDir, '.data/doge-config.toml'))
  const {config, configPath: loadedPath} = await loadDogeConfigWithSelection(configPath, 'scrollsdk setup render')
  const intent = resolveProofIntent({
    deploymentDir,
    dogeConfig: config,
    dogeConfigPath: loadedPath,
    required: true,
    specPath: options.spec || (contract.intentSource.kind === 'deployment-spec' ? contract.intentSource.path : undefined),
  })!
  validateProofIntentBinding(contract, intent)
  const bundle = validateProofTopologyBundle(resolveContractFile(deploymentDir, contract.topology.bundleDir), {preflightOnly: false})
  if (bundle.manifest.bundle_revision !== contract.topology.bundleRevision) throw new Error('compiler bundle revision does not match deployment contract')
  const readiness = proofEnforcementReadiness(deploymentDir, contract, config, scope)
  if (contract.enforcement === 'enforce' && !readiness.ready) throw new Error(`Proof enforcement is blocked:\n- ${readiness.blockers.join('\n- ')}`)
  const warnings = readiness.blockers.map(blocker => `Enforcement pending: ${blocker}`)
  if (options.live && scope !== 'activation') throw new Error('--proof-live requires activation scope')
  const live = options.live ? await liveSignerAcceptance({context: options.kubeContext, deploymentDir, enforcement: contract.enforcement, namespace: options.namespace ?? 'default', now: options.now ?? Date.now, readMetrics: options.readMetrics ?? readTsoMetrics}) : undefined

  return {
    bundleRevision: contract.topology.bundleRevision,
    contract: path.resolve(deploymentDir, options.contract ?? DEFAULT_PROOF_DEPLOYMENT_CONTRACT),
    enforcement: contract.enforcement,
    enforcementReadiness: readiness,
    generation: contract.generation,
    generationId: contract.generationId,
    scope,
    warnings,
    ...(live ? {liveSigners: live} : {}),
    mode: contract.mode,
  }
}
