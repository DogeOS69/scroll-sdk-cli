import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import path from 'node:path'

import {inspectDeployment} from '../../utils/deployment-preflight.js'
import {checkClusterManifests, checkEthereumRpcBatch, checkSignerRpc} from '../../utils/deployment-runtime-preflight.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {checkProofDeployment} from '../../utils/proof-deployment-check.js'
import {checkRethStartup} from '../../utils/reth-startup-check.js'

export default class DeploymentPreflight extends Command {
  static description = 'Check prepared application inputs before Helm installation; optionally check installed workloads'
  static flags = {
    'deployment-dir': Flags.string({default: '.'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml'}),
    'dogecoin-rpc-env': Flags.string({dependsOn: ['signer-container'], description: 'Environment variable containing the authenticated Dogecoin RPC URL'}),
    'dstack-deployment': Flags.string({default: 'dstack-controller'}),
    'ethereum-chain-id': Flags.integer({default: 11_155_111, min: 1}),
    'ethereum-rpc-env': Flags.string({description: 'Environment variable containing an Ethereum RPC URL; checks a four-call batch and finalized-block quorum', multiple: true}),
    'ethereum-rpc-quorum': Flags.integer({default: 1, min: 1}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Explicit context for optional cluster checks'}),
    namespace: Flags.string({description: 'Namespace for application checks; defaults to default'}),
    proof: Flags.boolean({description: 'Require proof contract validation; automatic when proof configuration or a contract is present'}),
    'proof-live': Flags.boolean({dependsOn: ['kube-context'], description: 'After rollout: also require fresh authenticated TSO polls from every registered signer'}),
    'proof-scope': Flags.string({default: 'activation', description: 'Proof evidence scope; preparation does not authorize signer installation', options: ['activation', 'preparation']}),
    'rendered-manifest': Flags.string({dependsOn: ['kube-context'], description: 'Rendered Helm manifest to check against cluster resources and ALB prerequisites; repeat for each release', multiple: true}),
    'require-dstack': Flags.boolean({default: false, description: 'Require controller configuration; with kube-context also require its installed Deployment to be available'}),
    'reth-image': Flags.string({description: 'Run an isolated local startup canary for this exact Reth image with the deployment genesis; no network or persistent data'}),
    'signer-container': Flags.string({dependsOn: ['dogecoin-rpc-env'], description: 'Probe Dogecoin RPC from this running container network namespace using a disposable curl container'}),
    spec: Flags.string({description: 'Spec path for selected checks, relative to deployment-dir; defaults to saved intent or deployment-spec.yaml'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DeploymentPreflight)
    const output = new JsonOutputContext('setup deployment-preflight', flags.json)
    try {
      const root = path.resolve(flags['deployment-dir'])
      const namespace = flags.namespace ?? 'default'
      const kubeContext = flags['kube-context']
      const report = inspectDeployment({deploymentDir: flags['deployment-dir'], dogeConfig: flags['doge-config'], requireDstack: flags['require-dstack']})
      let dstackRuntime = 'not-checked'
      if (kubeContext && flags['require-dstack']) {
        try {
          const deployment = JSON.parse(execFileSync('kubectl', ['--context', kubeContext, '-n', namespace, 'get', 'deployment', flags['dstack-deployment'], '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}))
          if ((deployment.spec.replicas ?? 1) < 1 || (deployment.status?.availableReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.updatedReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.observedGeneration ?? 0) < deployment.metadata.generation) throw new Error('not available at current generation')
          dstackRuntime = 'available'
        } catch {
          dstackRuntime = 'unavailable'
          report.blockers.push('Cannot verify an available dstack Deployment in the selected context/namespace; check installation and Kubernetes access')
        }
      }

      const runtimeChecks: Record<string, unknown> = {cluster: 'not-checked', ethereumRpc: 'not-checked', proof: 'not-configured', proofLive: 'not-checked', rethStartup: 'not-checked', signerRpc: 'not-checked'}
      const env = (name: string): string => {
        if (!/^[A-Z_a-z]\w*$/.test(name) || !process.env[name]) throw new Error('RPC environment variable is invalid or unset; values omitted')
        return process.env[name]!
      }

      const check = async (name: string, run: () => Promise<unknown> | unknown) => {
        try {runtimeChecks[name] = await run()} catch {runtimeChecks[name] = 'failed'; report.blockers.push(`${name} runtime preflight failed; check the selected inputs, dependencies and connectivity (private diagnostics omitted)`)}
      }

      if (flags['proof-live'] && flags['proof-scope'] !== 'activation') throw new Error('--proof-live requires activation scope')
      if (report.proofConfigured || flags.proof || flags['proof-live']) await check('proof', async () => {
        const result = await checkProofDeployment({config: path.resolve(root, flags['doge-config']), deploymentDir: root, kubeContext, live: flags['proof-live'], namespace, scope: flags['proof-scope'] as 'activation' | 'preparation', spec: flags.spec ? path.resolve(root, flags.spec) : undefined})
        report.warnings.push(...result.warnings)
        if (flags['proof-live']) runtimeChecks.proofLive = result.liveSigners
        return result
      })
      if (flags['proof-live'] && runtimeChecks.proof === 'failed') runtimeChecks.proofLive = 'failed'
      if (flags['rendered-manifest']) await check('cluster', () => {
        const errors = checkClusterManifests(flags['kube-context']!, flags['rendered-manifest']!.map(file => path.resolve(flags['deployment-dir'], file)))
        report.blockers.push(...errors)
        return errors.length > 0 ? 'failed' : 'necessary-pod-fit-and-alb-prerequisites-checked'
      })
      if (flags['ethereum-rpc-env']) await check('ethereumRpc', () => checkEthereumRpcBatch(flags['ethereum-rpc-env']!.map(name => env(name)), flags['ethereum-chain-id'], flags['ethereum-rpc-quorum']))
      if (flags['signer-container']) await check('signerRpc', () => {checkSignerRpc(flags['signer-container']!, env(flags['dogecoin-rpc-env']!)); return 'reachable-from-container-network'})
      if (flags['reth-image']) await check('rethStartup', () => checkRethStartup(flags['reth-image']!, path.resolve(flags['deployment-dir'], '.data/genesis.json')))
      report.warnings.push('Runtime checks marked not-checked have not passed. Cluster fit excludes current utilization, affinity, taints, storage topology and aggregate capacity; Reth startup does not establish chain synchronization.')
      for (const warning of report.warnings) output.addWarning(warning)
      const metadata = {...report, dstackRuntime, runtimeChecks}
      if (report.blockers.length > 0) output.error('E817_DEPLOYMENT_PREFLIGHT', report.blockers.join('\n'), 'CONFIGURATION', true, metadata)
      output.success({...metadata, next: flags['proof-scope'] === 'preparation' ? 'Preparation checks do not authorize signer installation; rerun deployment-preflight in activation scope before installation' : 'Review any checks marked not-checked, then install Helm releases using the generated Makefile; configuration checks do not establish runtime acceptance'})
    } catch (error) {
      // Preserve already structured errors rather than emitting another envelope.
      if (error instanceof Error && error.name === 'CliExitError') throw error
      output.error('E817_DEPLOYMENT_PREFLIGHT', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
