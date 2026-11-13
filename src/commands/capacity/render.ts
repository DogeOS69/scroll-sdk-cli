import {Command} from '@oclif/core'

import {capacityFlags, startCapacityDocument} from '../../utils/capacity-command.js'
import {fixedFleetChanges, formatValueChange, renderCapacity} from '../../utils/capacity-runtime.js'
import {CliExitError, JsonOutputContext} from '../../utils/json-output.js'

export default class CapacityRender extends Command {
  static description = 'Render capacity.yaml into the deployment files for review, without deploying; changes nothing in the cluster'
  static examples = ['<%= config.bin %> capacity render --dir deployment']
  static flags = capacityFlags

  async run(): Promise<void> {
    const {flags} = await this.parse(CapacityRender)
    const output = new JsonOutputContext('capacity render', flags.json)
    try {
      if (startCapacityDocument(flags.dir, output)) return
      const result = await renderCapacity(flags.dir, {envFile: flags['env-file'], skipProviderCheck: flags['skip-provider-check']})
      for (const provider of result.removedProviders) output.addWarning(`The ${provider} backend is no longer listed: when the controller restarts, dstack deletes it from the project`)
      const fixed = fixedFleetChanges(result.fleets)
      if (fixed) output.addWarning(`${fixed}; capacity deploy refuses this change`)
      if (!flags.json) {
        output.logSuccess(`Rendered providers [${result.providers.join(', ')}]. Compared with the previous render:`)
        const {created, undeclared, updated} = result.fleets
        for (const fleet of created) output.info(`  fleet + ${fleet}`)
        for (const fleet of updated) output.info(`  fleet ~ ${fleet.name}: ${fleet.changes.map(change => formatValueChange(change)).join('; ')}`)
        for (const fleet of undeclared) output.info(`  fleet ! ${fleet} no longer declared`)
        output.info(`  config.yml ${result.serverConfigChanged ? 'changed' : 'unchanged'}`)
        output.info(`Review with git diff, then deploy with scrollsdk capacity deploy --dir ${flags.dir}`)
      }

      output.success(result)
    } catch (error) {
      if (error instanceof CliExitError) throw error
      output.error('E833_CAPACITY_RENDER', error instanceof Error ? error.message : 'Capacity render failed', 'CONFIGURATION', true)
    }
  }
}
