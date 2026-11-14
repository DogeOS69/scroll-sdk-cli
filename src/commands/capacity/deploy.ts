import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'

import {capacityFlags, startCapacityDocument} from '../../utils/capacity-command.js'
import {CapacityDeployError, defaultCapacityDeployDeps, deployCapacity} from '../../utils/capacity-deploy.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'

export default class CapacityDeploy extends Command {
  static description = 'Deploy capacity.yaml: render it, show the changes against the running deployment, then upload the dstack Secrets and upgrade dstack-controller and capacity-manager'
  static examples = [
    '<%= config.bin %> capacity deploy --dir deployment',
    '<%= config.bin %> capacity deploy --dir deployment --restart-controller',
  ]

  static flags = {
    ...capacityFlags,
    'kube-context': Flags.string({description: 'Kubernetes context; must match the prepared target when one is recorded'}),
    'restart-controller': Flags.boolean({default: false, description: 'Restart dstack-controller even if its config did not change, so dstack retries creating backends after a credential fix'}),
    yes: Flags.boolean({char: 'y', default: false, description: 'Deploy without asking for confirmation'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(CapacityDeploy)
    const output = new JsonOutputContext('capacity deploy', flags.json)
    // Kept for the error context, so a --json run that stops for confirmation still reports what it would change.
    let summary: object | undefined
    try {
      if (startCapacityDocument(flags.dir, output)) return
      const result = await deployCapacity(flags.dir, {
        envFile: flags['env-file'], interactive: !flags.json && Boolean(process.stdin.isTTY), kubeContext: flags['kube-context'],
        restartController: flags['restart-controller'], skipProviderCheck: flags['skip-provider-check'], yes: flags.yes,
      }, {
        ...defaultCapacityDeployDeps,
        confirm: () => confirm({default: false, message: 'Deploy these changes?'}),
        show(lines, changes) {
          summary = changes
          if (!flags.json) for (const line of lines) output.info(line)
        },
      })
      if (!flags.json) {
        output.logSuccess(result.applied ? 'Capacity deployed.' : 'Nothing to deploy.')
        for (const note of result.notes) output.info(note)
      }

      output.success(result)
    } catch (error) {
      if (error instanceof CliExitError) throw error
      const context = {...(error instanceof CapacityDeployError ? {step: error.step} : {}), ...(summary ? {summary} : {})}
      output.error('E832_CAPACITY_DEPLOY', error instanceof Error ? error.message : 'Capacity deploy failed', 'CONFIGURATION', true, context)
    }
  }
}
