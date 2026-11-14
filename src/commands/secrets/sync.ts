import {Command, Flags} from '@oclif/core'

import {DEFAULT_DEPLOYMENT} from '../../utils/deployment-paths.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'
import {defaultSecretsSyncDeps, secretsKubeTarget, syncSecrets} from '../../utils/secrets-sync.js'

export default class SecretsSync extends Command {
  static description = 'Regenerate the secret files of a prepared deployment from its current inputs, upload only the changed ones and force their ExternalSecrets to sync; prints the restarts it needs'
  static examples = [
    '<%= config.bin %> secrets sync --dir deployment --kube-context my-cluster',
    '<%= config.bin %> secrets sync --dir deployment --kube-context my-cluster --apply',
  ]

  static flags = {
    apply: Flags.boolean({default: false, description: 'Upload the changed files and force-sync their ExternalSecrets; without it nothing is changed'}),
    dir: Flags.string({aliases: ['deployment-dir'], default: DEFAULT_DEPLOYMENT, description: 'Prepared deployment directory'}),
    'env-file': Flags.string({description: 'Private NAME=value file (default: the file saved by setup plan, or ./deployment.env)'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON; file and key names only, never values'}),
    'kube-context': Flags.string({description: 'Explicit Kubernetes context; must match the prepared target', required: true}),
    namespace: Flags.string({description: 'Namespace; defaults to the prepared target and must match it'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SecretsSync)
    const output = new JsonOutputContext('secrets sync', flags.json)
    try {
      const target = secretsKubeTarget(flags.dir, flags['kube-context'], flags.namespace)
      const result = await syncSecrets(flags.dir, {apply: flags.apply, context: target.context, envFile: flags['env-file'], namespace: target.namespace}, defaultSecretsSyncDeps(target.context, target.namespace))
      for (const item of result.externalSecrets.filter(entry => entry.synced === false)) output.addWarning(`ExternalSecret ${item.name} did not confirm a sync within 2 minutes; check it before restarting its readers`)
      if (!flags.json) {
        if (result.changes.length === 0) output.info('No secret file changed; nothing to upload.')
        for (const change of result.changes) output.info(`${change.status} ${change.file}${change.keys[0] === '*' ? '' : ` (${change.keys.join(', ')})`}${change.route === 'push' ? ` -> ${change.secret}` : change.route === 'manual' ? ' (not uploaded by secrets sync)' : ''}`)
        for (const line of result.manual) output.info(`Not uploaded: ${line}`)
        if (result.externalSecrets.length > 0) output.info(`ExternalSecrets: ${result.externalSecrets.map(item => item.name).join(', ')}`)
        if (result.restarts.length > 0) output.info(`${result.applied ? 'Restart' : 'After --apply, restart'} the readers one at a time, when it is safe for each service:\n  ${result.restarts.join('\n  ')}`)
        if (!result.applied && result.changes.some(change => change.route === 'push')) output.info('Nothing was changed. Rerun with --apply to upload.')
      }

      output.success(result)
    } catch (error) {
      if (error instanceof CliExitError) throw error
      output.error('E840_SECRETS_SYNC', error instanceof Error ? error.message : 'Secrets sync failed', 'CONFIGURATION', true)
    }
  }
}
