import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

import {JsonOutputContext} from '../../utils/json-output.js'
import {checkSignerNetworks} from '../../utils/signer-network-check.js'

export default class SignerNetworkCheck extends Command {
  static description = 'Read-only IPv4 overlap check on the Docker signer host, including unused networks; run before deploying signer Compose'
  static flags = {
    'cluster-cidr': Flags.string({description: 'VPC, pod or service IPv4 CIDR; repeat for each route the signer must reach', multiple: true, required: true}),
    json: Flags.boolean({default: false}),
    'proposed-subnet': Flags.string({description: 'Also check an explicit IPv4 subnet planned for a new Compose network'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SignerNetworkCheck)
    const output = new JsonOutputContext('signer network-check', flags.json)
    try {
      // Validate input before invoking Docker. Honor the host's Docker context;
      // no SSH, container stop, network deletion or Compose mutation occurs.
      checkSignerNetworks([], flags['cluster-cidr'], flags['proposed-subnet'])
      const run = (args: string[]): string => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim()
      const ids = run(['network', 'ls', '--quiet']).split(/\s+/).filter(Boolean)
      const networks = ids.length > 0 ? JSON.parse(run(['network', 'inspect', ...ids])) : []
      if (!Array.isArray(networks)) throw new Error('Invalid Docker network inventory')
      const report = checkSignerNetworks(networks, flags['cluster-cidr'], flags['proposed-subnet'])
      if (report.conflicts.length > 0 || report.proposedConflicts.length > 0) output.error('E818_SIGNER_NETWORK_OVERLAP', 'Docker subnets overlap required cluster routes or the proposed subnet. Select explicit non-overlapping Compose IPAM; remove old networks only after checking ownership and attached containers.', 'NETWORK', true, report)
      output.success({...report, ipv4Only: true, networksChecked: ids.length})
    } catch (error) {
      if (error instanceof Error && error.name === 'CliExitError') throw error
      output.error('E818_SIGNER_NETWORK_CHECK', error instanceof Error ? error.message : String(error), 'NETWORK', true)
    }
  }
}
