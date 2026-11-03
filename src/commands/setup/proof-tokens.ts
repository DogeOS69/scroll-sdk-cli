import {Command, Flags} from '@oclif/core'

import {AwsCliRunner} from '../../utils/aws-cli.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {ensureProofTokenSecret} from '../../utils/proof-token-secret.js'

export default class SetupProofTokens extends Command {
  static description = 'Initialize, complete or rotate the proof-work token and coordinator-only prover-worker master in an existing proof token Secret (created by the infrastructure proof-secret.yaml template). Writes only the Secret value; never prints tokens.'
  static examples = [
    '<%= config.bin %> <%= command.id %> --secret-name scroll/example/proof-coordinator-secrets --aws-region us-west-2',
    '<%= config.bin %> <%= command.id %> --secret-name scroll/example/proof-coordinator-secrets --aws-region us-west-2 --rotate',
  ]

  static flags = {
    'aws-profile': Flags.string({description: 'AWS CLI profile'}),
    'aws-region': Flags.string({description: 'Region of the proof token Secret', required: true}),
    json: Flags.boolean({default: false}),
    rotate: Flags.boolean({default: false, description: 'Replace both tokens in an existing Secret (drain Workers first; restart the coordinator, WP and capacity manager, then re-mint every Worker credential)'}),
    'secret-name': Flags.string({description: 'Secrets Manager secret holding proof-work-token and prover-worker-master; match preparation.proofAws.secretName', required: true}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SetupProofTokens)
    const output = new JsonOutputContext('setup proof-tokens', flags.json)
    try {
      const action = ensureProofTokenSecret(new AwsCliRunner(flags['aws-profile']), flags['aws-region'], flags['secret-name'], flags.rotate, message => output.info(message))
      output.success({action, region: flags['aws-region'], secretName: flags['secret-name']})
    } catch (error) {
      output.error('E820_PROOF_TOKENS', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
