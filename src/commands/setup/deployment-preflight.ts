import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

import {inspectDeployment} from '../../utils/deployment-preflight.js'
import {JsonOutputContext} from '../../utils/json-output.js'

export default class DeploymentPreflight extends Command {
  static description = 'Read-only check of current deployment inputs and optional Kubernetes dstack controller availability'
  static flags = {
    'deployment-dir': Flags.string({default: '.'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml'}),
    'dstack-deployment': Flags.string({default: 'dstack-controller'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Explicit context for optional read-only dstack runtime check; omitted means no Kubernetes calls'}),
    namespace: Flags.string({default: 'default'}),
    'require-dstack': Flags.boolean({default: false, description: 'Treat missing controller configuration/values as an error'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DeploymentPreflight)
    const output = new JsonOutputContext('setup deployment-preflight', flags.json)
    try {
      const report = inspectDeployment({deploymentDir: flags['deployment-dir'], dogeConfig: flags['doge-config'], requireDstack: flags['require-dstack']})
      let dstackRuntime = 'not-checked'
      if (flags['kube-context']) {
        try {
          const deployment = JSON.parse(execFileSync('kubectl', ['--context', flags['kube-context'], '-n', flags.namespace, 'get', 'deployment', flags['dstack-deployment'], '-o', 'json'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}))
          if ((deployment.spec.replicas ?? 1) < 1 || (deployment.status?.availableReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.updatedReplicas ?? 0) < (deployment.spec.replicas ?? 1) || (deployment.status?.observedGeneration ?? 0) < deployment.metadata.generation) throw new Error('not available at current generation')
          dstackRuntime = 'available'
        } catch {
          dstackRuntime = 'unavailable'
          report.blockers.push('Cannot verify an available dstack Deployment in the selected context/namespace; check installation and Kubernetes access')
        }
      }

      for (const warning of report.warnings) output.addWarning(warning)
      const metadata = {...report, dstackRuntime}
      if (report.blockers.length > 0) output.error('E817_DEPLOYMENT_PREFLIGHT', report.blockers.join('\n'), 'CONFIGURATION', true, metadata)
      output.success({...metadata, next: 'Run proof-config-check and artifact-access checks before deployment'})
    } catch (error) {
      // Preserve already structured errors rather than emitting another envelope.
      if (error instanceof Error && error.name === 'CliExitError') throw error
      output.error('E817_DEPLOYMENT_PREFLIGHT', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
