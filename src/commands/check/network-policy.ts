import {Command, Flags} from '@oclif/core'
import * as yaml from 'js-yaml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../../types/deployment-spec.js'

import {JsonOutputContext} from '../../utils/json-output.js'
import {checkNetworkPolicy} from '../../utils/network-policy-preflight.js'

export default class NetworkPolicy extends Command {
  static description = 'Read EKS network-policy controller, agent and workload bindings for an explicit deployment target'
  static examples = ['<%= config.bin %> <%= command.id %> --spec ./deployment-spec.yaml --phase infrastructure', '<%= config.bin %> <%= command.id %> --spec ./deployment-spec.yaml --phase workloads --json']
  static flags = {
    'aws-profile': Flags.string({description: 'AWS read credentials profile; otherwise use the default credential chain'}),
    json: Flags.boolean({default: false, description: 'Output structured results'}),
    phase: Flags.string({default: 'workloads', description: 'Check cluster prerequisites or also installed TSO/WP policy bindings', options: ['infrastructure', 'workloads']}),
    spec: Flags.string({description: 'Deployment spec with explicit provider and Kubernetes target', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(NetworkPolicy)
    const output = new JsonOutputContext('check network-policy', flags.json)
    try {
      let spec: DeploymentSpec
      try {spec = yaml.load(fs.readFileSync(flags.spec, 'utf8')) as DeploymentSpec} catch {throw new Error('Cannot read deployment spec YAML; contents omitted')}
      const result = checkNetworkPolicy(spec, {awsProfile: flags['aws-profile'], phase: flags.phase as 'infrastructure' | 'workloads'})
      output.logSuccess('Network-policy configuration checks passed for the selected target')
      output.addWarning('Packet enforcement, permitted caller paths, monitoring and business acceptance still require runtime tests; trafficVerified is false')
      output.success(result)
    } catch (error) {
      output.error('E_NETWORK_POLICY_PREFLIGHT', error instanceof Error ? error.message : 'Network-policy preflight failed', 'KUBERNETES', true)
    }
  }
}
