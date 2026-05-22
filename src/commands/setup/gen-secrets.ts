import { Flags } from '@oclif/core'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import SetupGenL2Artifacts from './gen-l2-artifacts.js'

export default class SetupGenSecrets extends SetupGenL2Artifacts {
  static override description = 'Generate local secret files from config.toml, Dogecoin config, and bridge initialization outputs'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config.toml',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --doge-config .data/doge-config.toml',
  ]

  static override flags = {
    'configs-dir': Flags.string({
      default: 'values',
      description: 'Directory containing generated values files',
      required: false,
    }),
    'doge-config': Flags.string({
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
      required: false,
    }),
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
    this.extractRollupExplorerBackendSecret(flags['configs-dir'])

    this.jsonCtx.logSuccess('Secret generation completed.')

    if (this.jsonMode) {
      this.jsonCtx.success({
        bridgeOutputPath,
        configsDir: flags['configs-dir'],
        dogeConfigPath: dogeConfigResult.configPath,
        secretsDir: path.join(process.cwd(), 'secrets'),
      })
    }
  }

  private extractRollupExplorerBackendSecret(configsDir: string): void {
    const sourcePath = path.join(process.cwd(), configsDir, 'rollup-explorer-backend-config.yaml')
    if (!fs.existsSync(sourcePath)) {
      this.jsonCtx.addWarning(`${sourcePath} not found. Skipping rollup-explorer-backend-secret.json generation.`)
      return
    }

    try {
      const yamlFileContent = fs.readFileSync(sourcePath, 'utf8')
      const parsedYaml = yaml.load(yamlFileContent) as { scrollConfig?: unknown } | null
      if (!parsedYaml || typeof parsedYaml.scrollConfig !== 'string') {
        this.jsonCtx.addWarning(`Could not find string scrollConfig in ${sourcePath}. Skipping rollup-explorer-backend-secret.json generation.`)
        return
      }

      const scrollConfigObject = JSON.parse(parsedYaml.scrollConfig)
      const jsonOutputPath = path.join(process.cwd(), 'secrets', 'rollup-explorer-backend-secret.json')
      fs.writeFileSync(jsonOutputPath, JSON.stringify(scrollConfigObject, null, 2))
      fs.unlinkSync(sourcePath)
      this.jsonCtx.logSuccess(`Created ${jsonOutputPath}`)
    } catch (error) {
      this.jsonCtx.error(
        'E602_INVALID_CONFIG_FORMAT',
        `Failed to generate rollup-explorer-backend-secret.json from ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        'CONFIGURATION',
        false,
        { path: sourcePath }
      )
    }
  }
}
