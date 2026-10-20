import {Command, Flags} from '@oclif/core'

import {verifyCubesignerActivation} from '../../../utils/cubesigner-activation.js'
import {connectActivationClient} from '../../../utils/cubesigner-activation-client.js'
import {GOVERNANCE_INPUT, PolicyValidationError} from '../../../utils/cubesigner-governance.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class VerifyActivation extends Command {
  static description = 'Check current rendered signer values, remote attachment, Council evidence and runtime session before installation; read-only provider calls, no Helm mutation'
  static flags = {
    chart: Flags.string({default: 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer'}),
    'chart-version': Flags.string({default: '0.1.9'}),
    dir: Flags.string({default: DEFAULT_DEPLOYMENT}),
    governance: Flags.string({default: GOVERNANCE_INPUT}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({description: 'Cluster context used by the installation target'}),
    namespace: Flags.string({default: 'default'}),
    'policy-only': Flags.boolean({default: false, description: 'Verify policy before preparing credentials; reports activation pending and cannot authorize installation'}),
    'session-file': Flags.string({description: 'Management session file; credentials are never printed'}),
    values: Flags.string({default: 'values/cubesigner-signer-production.yaml'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(VerifyActivation)
    const output = new JsonOutputContext('setup cubesigner-policy verify-activation', flags.json)
    try {
      const result = await verifyCubesignerActivation({chart: flags.chart, chartVersion: flags['chart-version'], connect: () => connectActivationClient(flags['session-file']), directory: flags.dir,
        governance: flags.governance, kubeContext: flags['kube-context'], namespace: flags.namespace, policyOnly: flags['policy-only'],
        values: flags.values})
      output.success(result)
      if (result.activation !== 'verified') process.exitCode = 2
    } catch (error) {
      output.error('E744_CUBESIGNER_ACTIVATION_PENDING', (error instanceof PolicyValidationError ? error.message + '. ' : '') + 'Activation pending or invalid. Check expected artifacts, effective Helm values, executed attachment, fresh governance evidence and runtime credentials. Do not install cubesigner-signer.', 'VALIDATION', true)
    }
  }
}
