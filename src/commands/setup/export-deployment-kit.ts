import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {writeDeploymentKit} from '../../utils/deployment-kit.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {DEFAULT_PROOF_DEPLOYMENT_CONTRACT, validateProofDeploymentContract} from '../../utils/proof-deployment-contract.js'
import {resolveProofIntent, validateProofIntentBinding} from '../../utils/proof-intent.js'
import {deriveTsoUrl} from '../../utils/signer-policy-derivation.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from '../../utils/withdrawal-config.js'

export class ExportDeploymentKitCommand extends Command {
  static description = 'Export a versioned signer deployment kit from the selected proof deployment contract and its bound materials receipt; publish it unchanged and record its manifest SHA-256'
  static examples = [
    '<%= config.bin %> <%= command.id %> --kit-version 1',
    '<%= config.bin %> <%= command.id %> --kit-version 2 --out kits/deployment-kit-2 --tso-url https://tso.dogeos.example',
  ]

  static flags = {
    config: Flags.string({char: 'c', description: 'Path to doge-config.toml'}),
    contract: Flags.string({default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Selected deployment contract; binds the materials receipt and protocol context'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'kit-version': Flags.string({description: 'Kit version recorded in the kit; never reuse a published version', required: true}),
    out: Flags.string({description: 'Kit output directory; must not exist [default: deployment-kit-<kit-version>]'}),
    'protocol-context': Flags.string({default: '.data/protocol_context.json', description: 'Canonical protocol_context.json produced by setup bridge-init'}),
    'signer-proof-artifact-base-url': Flags.string({description: `Public GET base used by signers; default: compiler output in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}`}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]'}),
    'tso-url': Flags.string({description: 'TSO base URL reachable from signer networks; default: config.toml [ingress].TSO_HOST'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ExportDeploymentKitCommand)
    const output = new JsonOutputContext('setup export-deployment-kit', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const root = process.cwd()
      const intent = resolveProofIntent({deploymentDir: root, dogeConfig: loaded.config, dogeConfigPath: loaded.configPath, required: true, specPath: flags.spec})!
      const contract = validateProofDeploymentContract(root, flags.contract)
      validateProofIntentBinding(contract, intent)
      const tsoUrl = flags['tso-url'] || deriveTsoUrl()?.value
      if (!tsoUrl) throw new Error('config.toml has no [ingress].TSO_HOST; pass --tso-url')
      const kitVersion = flags['kit-version']
      const record = writeDeploymentKit({config: loaded.config, contractPath: flags.contract, deploymentDir: root, kitVersion, output: flags.out ?? `deployment-kit-${kitVersion}`, protocolContext: flags['protocol-context'], signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'], tsoUrl})
      output.logSuccess(`Deployment kit written to ${record.kitDir}`)
      output.info('Deployment record fields:')
      output.info(`  network:              ${record.network}`)
      output.info(`  protocol_instance_id: ${record.protocolInstanceId}`)
      output.info(`  kit_version:          ${record.kitVersion}`)
      output.info(`  manifest_sha256:      ${record.manifestSha256}`)
      output.info('Publish the kit directory (or an archive of it) unchanged at a new immutable URL; signers import it with the manifest SHA-256 from the deployment record.')
      output.success({...record, contract: path.resolve(flags.contract), generationId: contract.generationId, tsoUrl})
    } catch (error) {
      output.error('E804_DEPLOYMENT_KIT_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
export default ExportDeploymentKitCommand
