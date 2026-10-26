import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {writeDeploymentKit} from '../../utils/deployment-kit.js'
import {DEPLOYMENT_KIT_PROTOCOL_CONTEXT, recordDeploymentKitPublication} from '../../utils/deployment-kit-record.js'
import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {DEFAULT_PROOF_DEPLOYMENT_CONTRACT, validateProofDeploymentContract} from '../../utils/proof-deployment-contract.js'
import {resolveProofIntent, validateProofIntentBinding} from '../../utils/proof-intent.js'
import {deriveTsoUrl} from '../../utils/signer-policy-derivation.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from '../../utils/withdrawal-config.js'

export class ExportDeploymentKitCommand extends Command {
  static description = 'Export the signer deployment kit from the selected proof deployment contract and its bound materials receipt; its version is derived from the signer-relevant inputs. Publish it unchanged, then record the publication with --published-url'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --published-url https://downloads.dogeos.example/deployment-kit-k-0123456789ab.tar.gz',
  ]

  static flags = {
    config: Flags.string({char: 'c', description: 'Path to doge-config.toml'}),
    contract: Flags.string({default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Selected deployment contract; binds the materials receipt and protocol context'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    out: Flags.string({description: 'Kit output directory [default: deployment-kit-<kit version>]; an existing one must already hold this exact kit'}),
    'protocol-context': Flags.string({default: '.data/protocol_context.json', description: 'Canonical protocol_context.json produced by setup bridge-init'}),
    'published-url': Flags.string({description: 'https URL where this exact kit is published; records it in doge-config [attestationSigner.deploymentKit]. Uses the deployment inputs only: not with --out, --tso-url or --signer-proof-artifact-base-url'}),
    'signer-proof-artifact-base-url': Flags.string({description: `Public GET base used by signers; default: compiler output in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}`}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]'}),
    'tso-url': Flags.string({description: 'TSO base URL reachable from signer networks; default: config.toml [ingress].TSO_HOST'}),
  }

  // Lower-level setup utility; retain direct access for focused maintenance.
  static override hidden = true

  async run(): Promise<void> {
    const {flags} = await this.parse(ExportDeploymentKitCommand)
    const output = new JsonOutputContext('setup export-deployment-kit', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const root = process.cwd()
      const intent = resolveProofIntent({deploymentDir: root, dogeConfig: loaded.config, dogeConfigPath: loaded.configPath, required: true, specPath: flags.spec})!
      const contract = validateProofDeploymentContract(root, flags.contract)
      validateProofIntentBinding(contract, intent)
      const publishedUrl = flags['published-url']
      // The recorded kit must be exactly what readiness rebuilds from the deployment inputs.
      if (publishedUrl && (flags.out || flags['tso-url'] || flags['signer-proof-artifact-base-url'] || flags['protocol-context'] !== DEPLOYMENT_KIT_PROTOCOL_CONTEXT)) throw new Error('--published-url records only the canonical kit built from the deployment inputs; drop --out, --tso-url, --signer-proof-artifact-base-url and --protocol-context, or update the deployment inputs and re-export')
      const tsoUrl = flags['tso-url'] || deriveTsoUrl()?.value
      if (!tsoUrl) throw new Error('config.toml has no [ingress].TSO_HOST; pass --tso-url')
      const record = writeDeploymentKit({config: loaded.config, contractPath: flags.contract, deploymentDir: root, output: flags.out, protocolContext: flags['protocol-context'], signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'], tsoUrl})
      const publication = publishedUrl ? recordDeploymentKitPublication(root, loaded.configPath, record, publishedUrl) : undefined
      output.logSuccess(`Deployment kit ${record.kitVersion} in ${record.kitDir}${publication ? `, recorded as published at ${publication.url}` : ''}`)
      output.info('Deployment record fields:')
      output.info(`  network:              ${record.network}`)
      output.info(`  protocol_instance_id: ${record.protocolInstanceId}`)
      output.info(`  kit_version:          ${record.kitVersion}`)
      output.info(`  manifest_sha256:      ${record.manifestSha256}`)
      if (!publication) output.info('Publish the kit directory (or an archive of it) unchanged at a new immutable https URL, put that URL and the manifest SHA-256 on the deployment record, then re-run with --published-url <URL>.')
      output.success({...record, contract: path.resolve(flags.contract), generationId: contract.generationId, ...(publication ? {publication} : {}), tsoUrl})
    } catch (error) {
      output.error('E804_DEPLOYMENT_KIT_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
export default ExportDeploymentKitCommand
