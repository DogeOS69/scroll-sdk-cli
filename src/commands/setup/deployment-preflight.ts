import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import path from 'node:path'

import {inspectDeployment} from '../../utils/deployment-preflight.js'
import {checkClusterManifests, checkEthereumRpcBatch, checkSignerRpc} from '../../utils/deployment-runtime-preflight.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {checkRethStartup} from '../../utils/reth-startup-check.js'

export default class DeploymentPreflight extends Command {
  static description = 'Check deployment inputs, with explicit optional cluster/RPC probes and isolated local Reth startup'
  static flags = {
    'deployment-dir': Flags.string({default: '.'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml'}),
    'dogecoin-rpc-env': Flags.string({dependsOn: ['signer-container'], description: 'Environment variable containing the authenticated Dogecoin RPC URL'}),
    'dstack-deployment': Flags.string({default: 'dstack-controller'}),
    'ethereum-chain-id': Flags.integer({default: 11_155_111, min: 1}),
    'ethereum-rpc-env': Flags.string({description: 'Environment variable containing an Ethereum RPC URL; checks a four-call batch and finalized-block quorum', multiple: true}),
    'ethereum-rpc-quorum': Flags.integer({default: 1, min: 1}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Explicit context for optional read-only dstack runtime check; omitted means no Kubernetes calls'}),
    namespace: Flags.string({default: 'default'}),
    'rendered-manifest': Flags.string({dependsOn: ['kube-context'], description: 'Rendered Helm manifest to check against cluster resources and ALB prerequisites; repeat for each release', multiple: true}),
    'require-dstack': Flags.boolean({default: false, description: 'Treat missing controller configuration/values as an error'}),
    'reth-image': Flags.string({description: 'Run an isolated local startup canary for this exact Reth image with the deployment genesis; no network or persistent data'}),
    'signer-container': Flags.string({dependsOn: ['dogecoin-rpc-env'], description: 'Probe Dogecoin RPC from this running container network namespace using a disposable curl container'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DeploymentPreflight)
    const output = new JsonOutputContext('setup deployment-preflight', flags.json)
    try {
      const report = inspectDeployment({deploymentDir: flags['deployment-dir'], dogeConfig: flags['doge-config'], requireDstack: flags['require-dstack']})
      let dstackRuntime = 'not-checked'
      if (flags['kube-context'] && (report.dstack.configured || flags['require-dstack'])) {
        try {
          const deployment = JSON.parse(execFileSync('kubectl', ['--context', flags['kube-context'], '-n', flags.namespace, 'get', 'deployment', flags['dstack-deployment'], '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}))
          if ((deployment.spec.replicas ?? 1) < 1 || (deployment.status?.availableReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.updatedReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.observedGeneration ?? 0) < deployment.metadata.generation) throw new Error('not available at current generation')
          dstackRuntime = 'available'
        } catch {
          dstackRuntime = 'unavailable'
          report.blockers.push('Cannot verify an available dstack Deployment in the selected context/namespace; check installation and Kubernetes access')
        }
      }

      const runtimeChecks: Record<string, unknown> = {cluster: 'not-checked', ethereumRpc: 'not-checked', rethStartup: 'not-checked', signerRpc: 'not-checked'}
      const env = (name: string): string => {
        if (!/^[A-Z_a-z]\w*$/.test(name) || !process.env[name]) throw new Error('RPC environment variable is invalid or unset; values omitted')
        return process.env[name]!
      }

      const check = async (name: string, run: () => Promise<unknown> | unknown) => {
        try {runtimeChecks[name] = await run()} catch {runtimeChecks[name] = 'failed'; report.blockers.push(`${name} runtime preflight failed; check the selected inputs, dependencies and connectivity (private diagnostics omitted)`)}
      }

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
      output.success({...metadata, next: 'Run proof-config-check and artifact-access checks before deployment'})
    } catch (error) {
      // Preserve already structured errors rather than emitting another envelope.
      if (error instanceof Error && error.name === 'CliExitError') throw error
      output.error('E817_DEPLOYMENT_PREFLIGHT', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
