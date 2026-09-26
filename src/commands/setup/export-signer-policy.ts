import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {DEFAULT_PROOF_DEPLOYMENT_CONTRACT, validateProofDeploymentContract} from '../../utils/proof-deployment-contract.js'
import {resolveProofIntent} from '../../utils/proof-intent.js'
import {deriveTsoUrl} from '../../utils/signer-policy-derivation.js'
import {writeSignerPolicyHandoff} from '../../utils/signer-policy-handoff.js'
import {WITHDRAWAL_NATIVE_CONFIG_RELPATH} from '../../utils/withdrawal-config.js'

export class ExportSignerPolicyCommand extends Command {
  static description = 'Atomically export external signer policy from the selected proof deployment contract and its bound materials receipt'
  static flags = {
    config: Flags.string({char: 'c', description: 'Path to doge-config.toml'}),
    contract: Flags.string({default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Selected deployment contract; binds the materials receipt and protocol context'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    out: Flags.string({default: 'signer-policy-bundle', description: 'Bundle output directory'}),
    'protocol-context': Flags.string({default: '.data/protocol_context.json', description: 'Canonical protocol_context.json produced by setup bridge-init'}),
    'signer-proof-artifact-base-url': Flags.string({description: `Public GET base used by signers; default: compiler output in ${WITHDRAWAL_NATIVE_CONFIG_RELPATH}`}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]'}),
    'tso-url': Flags.string({description: 'TSO base URL reachable from signer networks; default: config.toml [ingress].TSO_HOST'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ExportSignerPolicyCommand)
    const output = new JsonOutputContext('setup export-signer-policy', flags.json)
    try {
      const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
      const root = process.cwd()
      const intent = resolveProofIntent({deploymentDir: root, dogeConfig: loaded.config, dogeConfigPath: loaded.configPath, required: true, specPath: flags.spec})!
      const contract = validateProofDeploymentContract(root, flags.contract)
      if (contract.intentSource.sha256 !== intent.source.sha256 || contract.mode !== intent.intent.mode || contract.generation !== intent.intent.generation || contract.enforcement !== intent.intent.enforcement) throw new Error('Selected proof contract differs from current intent; rerun prep-charts')
      const tsoUrl = flags['tso-url'] || deriveTsoUrl()?.value
      if (!tsoUrl) throw new Error('config.toml has no [ingress].TSO_HOST; pass --tso-url')
      const result = writeSignerPolicyHandoff({config: loaded.config, contractPath: flags.contract, deploymentDir: root, output: flags.out, protocolContext: flags['protocol-context'], signerProofArtifactBaseUrl: flags['signer-proof-artifact-base-url'], tsoUrl})
      output.logSuccess(`${contract.mode}/${contract.generation}/${contract.enforcement} signer bundle written to ${result.bundleDir}`)
      output.success({...result, contract: path.resolve(flags.contract), generationId: contract.generationId, signerPolicyMode: contract.enforcement, tsoUrl})
    } catch (error) {
      output.error('E804_SIGNER_POLICY_EXPORT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
export default ExportSignerPolicyCommand
