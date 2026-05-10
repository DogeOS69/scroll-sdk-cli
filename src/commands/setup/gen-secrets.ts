import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import SetupGenL2Artifacts from './gen-l2-artifacts.js'

export default class SetupGenSecrets extends SetupGenL2Artifacts {
  static override description = 'Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config-testnet.toml',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --doge-config .data/doge-config-testnet.toml',
  ]

  static override flags = {
    'doge-config': SetupGenL2Artifacts.flags['doge-config'],
    json: SetupGenL2Artifacts.flags.json,
    'non-interactive': SetupGenL2Artifacts.flags['non-interactive'],
  }

  public override async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenSecrets) as any

    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup gen-secrets', this.jsonMode)

    const dogeConfigResult = await loadDogeConfigWithSelection(
      flags['doge-config'],
      'scrollsdk setup doge-config'
    )

    this.dogeConfig = dogeConfigResult.config
    this.jsonCtx.info(`Using Dogecoin config file: ${dogeConfigResult.configPath}`)

    const bridgeOutputPath = path.join(process.cwd(), '.data', 'output-withdrawal-processor.toml')
    if (!fs.existsSync(bridgeOutputPath)) {
      this.jsonCtx.error(
        'E103_BRIDGE_INIT_OUTPUT_MISSING',
        `${bridgeOutputPath} not found. Run \`scrollsdk setup bridge-init\` before \`scrollsdk setup gen-secrets\`.`,
        'CONFIGURATION',
        true,
        { path: bridgeOutputPath }
      )
    }

    this.jsonCtx.info('Creating secrets folder...')
    this.createSecretsFolder()

    this.jsonCtx.info('Creating secrets environment files...')
    await this.createEnvFiles()

    this.jsonCtx.logSuccess('Secret generation completed.')

    if (this.jsonMode) {
      this.jsonCtx.success({
        bridgeOutputPath,
        dogeConfigPath: dogeConfigResult.configPath,
        secretsDir: path.join(process.cwd(), 'secrets'),
      })
    }
  }
}
