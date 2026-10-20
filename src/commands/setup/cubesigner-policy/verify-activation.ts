import {Command, Flags} from '@oclif/core'

import {ActivationError, verifyCubesignerActivation} from '../../../utils/cubesigner-activation.js'
import {connectActivationClient} from '../../../utils/cubesigner-activation-client.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class VerifyActivation extends Command {
  static description = 'Read-only check of signer mode, rendered workload, remote policy/key/session and delivered Secrets before installation'
  static flags = {
    chart: Flags.string({default: 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer'}),
    'chart-version': Flags.string({default: '0.1.9'}),
    dir: Flags.string({default: '.'}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({required: true}),
    namespace: Flags.string({default: 'default'}),
    'session-file': Flags.string({description: 'Management session file; credentials are never printed'}),
    values: Flags.string({default: 'values/cubesigner-signer-production.yaml'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(VerifyActivation)
    const output = new JsonOutputContext('setup cubesigner-policy verify-activation', flags.json)
    try {
      if (!flags['kube-context'].trim()) throw new ActivationError('An explicit nonempty Kubernetes context is required')
      output.success(await verifyCubesignerActivation({chart: flags.chart, chartVersion: flags['chart-version'], connect: () => connectActivationClient(flags['session-file']), directory: flags.dir,
        kubeContext: flags['kube-context'], namespace: flags.namespace, values: flags.values}))
    } catch (error) {
      output.error('E744_CUBESIGNER_ACTIVATION_PENDING', error instanceof ActivationError ? error.message : 'Activation verification failed; check prepared policy receipts, Helm rendering, provider read access and delivered Secrets. Private diagnostics omitted.', 'VALIDATION', true)
    }
  }
}
