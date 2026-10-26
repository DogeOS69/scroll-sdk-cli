import {Command, Flags} from '@oclif/core'

import {prepareCubesignerRuntimeSecrets} from '../../../utils/cubesigner-runtime-secrets.js'
import {DEFAULT_DEPLOYMENT} from '../../../utils/deployment-paths.js'
import {JsonOutputContext} from '../../../utils/json-output.js'

export default class PrepareRuntimeSecrets extends Command {
  static description = 'Prepare only CubeSigner SecretStore/ExternalSecret objects and wait for delivery; does not start a signer or authorize activation'
  static flags = {
    chart: Flags.string({default: 'oci://ghcr.io/dogeos69/scroll-sdk/helm/cubesigner-signer'}),
    'chart-version': Flags.string({default: '0.1.9'}),
    dir: Flags.string({default: DEFAULT_DEPLOYMENT}),
    json: Flags.boolean({default: false}),
    'kube-context': Flags.string({required: true}),
    namespace: Flags.string({required: true}),
    values: Flags.string({default: 'values/cubesigner-signer-production.yaml'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PrepareRuntimeSecrets)
    const output = new JsonOutputContext('setup cubesigner-policy prepare-runtime-secrets', flags.json)
    try {
      output.success(await prepareCubesignerRuntimeSecrets({chart: flags.chart, chartVersion: flags['chart-version'], directory: flags.dir,
        kubeContext: flags['kube-context'], namespace: flags.namespace, values: flags.values}))
    } catch (error) {
      output.error('E744_CUBESIGNER_ACTIVATION_PENDING', `Runtime Secret delivery failed: ${error instanceof Error ? error.message : 'unknown error'}. Activation remains unverified.`, 'VALIDATION', true)
    }
  }
}
