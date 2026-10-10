import * as toml from '@iarna/toml'
import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../../types/doge-config.js'

import {savedDeploymentEnvFile} from '../../utils/deployment-paths.js'
import {writeGrafanaAdminSecret} from '../../utils/grafana-admin.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {writeMonitoringSlackSecret} from '../../utils/monitoring-slack.js'
import {prepareGrafanaAdmin} from '../../utils/preparation-grafana.js'
import {loadPreparationEnv} from '../../utils/preparation-io.js'

export default class MonitoringSecrets extends Command {
  static override description = 'Prepare Grafana credentials for push-secrets and optionally upload the Slack Kubernetes Secret'
  static override flags = {
    apply: Flags.boolean({default: false, dependsOn: ['kube-context', 'namespace']}),
    'deployment-dir': Flags.string({default: '.'}),
    'env-file': Flags.string({description: 'Private NAME=value file; defaults to the saved plan reference, then deployment.env in the deployment directory'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string(),
    namespace: Flags.string(),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(MonitoringSecrets)
    const output = new JsonOutputContext('setup monitoring-secrets', flags.json)
    try {
      const root = fs.realpathSync(path.resolve(flags['deployment-dir']))
      loadPreparationEnv(savedDeploymentEnvFile(root, flags['env-file']))
      // Validate Slack input before generating an unrelated admin identity.
      const read = () => toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as unknown as DogeConfig
      const files: string[] = []
      const slack = writeMonitoringSlackSecret(read().monitoring, root)
      if (slack) files.push(slack)
      await prepareGrafanaAdmin(root)
      const config = read()
      if (config.grafana) files.push(writeGrafanaAdminSecret(config.grafana, root))
      if (flags.apply) {
        // Stdin avoids credentials in process arguments; do not print kubectl
        // diagnostics because validation errors can echo a Secret document.
        const manifests = slack ? fs.readFileSync(slack, 'utf8') : ''
        if (manifests) {
          const args = ['--context', flags['kube-context']!, '-n', flags.namespace!, 'apply', '--server-side', '--field-manager=scrollsdk-monitoring-secrets', '-f', '-']
          try {
            execFileSync('kubectl', [...args, '--dry-run=server'], {input: manifests, stdio: ['pipe', 'pipe', 'pipe']})
            execFileSync('kubectl', args, {input: manifests, stdio: ['pipe', 'pipe', 'pipe']})
          } catch {throw new Error('Monitoring Secret upload failed; check the explicit Kubernetes destination, permissions and field ownership')}
        }
      }

      output.success({files: files.map(file => path.relative(root, file)), grafanaUpload: 'setup push-secrets --provider aws or vault', slackApplied: flags.apply && Boolean(slack)})
    } catch (error) {
      output.error('E_MONITORING_SECRETS', error instanceof Error ? error.message : 'Monitoring Secret preparation failed', 'CONFIGURATION', true)
    }
  }
}
