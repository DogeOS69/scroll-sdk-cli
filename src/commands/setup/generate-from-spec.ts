import { Command, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type BridgeInitValues,
  type ContractAddresses,
  type GeneratedConfigs,
  generateAllConfigs,
  loadDeploymentSpec,
  validateDeploymentSpec,
  writeGeneratedConfigs
} from '../../utils/deployment-spec-generator.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { type GeneratedValuesFiles, generateValuesFiles } from '../../utils/values-generator.js'

export default class GenerateFromSpec extends Command {
  static override description = 'Generate all configuration files from a DeploymentSpec YAML file'

  static override examples = [
    '# Generate configs in current directory',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml',
    '',
    '# Generate configs to specific output directory',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --output ./my-deployment',
    '',
    '# Generate with JSON output for automation',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --json',
    '',
    '# Dry run - validate and show what would be generated',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --dry-run',
    '',
    '# Generate only specific config types',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --config-only',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --values-only',
  ]

  static override flags = {
    'config-only': Flags.boolean({
      default: false,
      description: 'Only generate config.toml, doge-config.toml, setup_defaults.toml',
    }),
    'contract-addresses': Flags.string({
      char: 'c',
      description: 'Path to config-contracts.toml (for l1-interface contract addresses)',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Validate spec and show what would be generated without writing files',
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Overwrite existing files without warning',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    output: Flags.string({
      char: 'o',
      default: '.',
      description: 'Output directory for generated files',
    }),
    spec: Flags.string({
      char: 's',
      description: 'Path to DeploymentSpec YAML file',
      required: true,
    }),
    'values-only': Flags.boolean({
      default: false,
      description: 'Only generate values/*.yaml Helm files',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(GenerateFromSpec)
    const jsonCtx = new JsonOutputContext('setup generate-from-spec', flags.json)

    // Validate conflicting flags
    if (flags['config-only'] && flags['values-only']) {
      jsonCtx.error(
        'E601_CONFLICTING_FLAGS',
        'Cannot use both --config-only and --values-only',
        'CONFIGURATION',
        true,
        { flags: ['--config-only', '--values-only'] }
      )
    }

    // Check spec file exists
    const specPath = path.resolve(flags.spec)
    if (!fs.existsSync(specPath)) {
      jsonCtx.error(
        'E601_FILE_NOT_FOUND',
        `DeploymentSpec file not found: ${specPath}`,
        'CONFIGURATION',
        true,
        { path: specPath }
      )
    }

    jsonCtx.info('Loading DeploymentSpec...')
    jsonCtx.logKeyValue('Spec file', specPath)

    // Load and validate the spec
    let spec
    try {
      spec = loadDeploymentSpec(specPath)
    } catch (error) {
      jsonCtx.error(
        'E602_INVALID_SPEC',
        `Failed to load DeploymentSpec: ${error instanceof Error ? error.message : String(error)}`,
        'CONFIGURATION',
        true,
        { error: String(error), path: specPath }
      )
      return // TypeScript flow control
    }

    jsonCtx.logKeyValue('Deployment name', spec.metadata.name)
    jsonCtx.logKeyValue('Environment', spec.metadata.environment)
    jsonCtx.logKeyValue('Provider', spec.infrastructure.provider)

    // Validate the spec
    jsonCtx.info('Validating DeploymentSpec...')
    const validation = validateDeploymentSpec(spec)

    if (validation.warnings.length > 0) {
      jsonCtx.info('Validation warnings:')
      for (const warning of validation.warnings) {
        jsonCtx.addWarning(`${warning.path}: ${warning.message}`)
        if (warning.suggestion) {
          jsonCtx.info(`  Suggestion: ${warning.suggestion}`)
        }
      }
    }

    if (!validation.valid) {
      jsonCtx.info('Validation errors:')
      for (const error of validation.errors) {
        jsonCtx.info(`  [${error.code}] ${error.path}: ${error.message}`)
      }

      jsonCtx.error(
        'E603_VALIDATION_FAILED',
        `DeploymentSpec validation failed with ${validation.errors.length} error(s)`,
        'VALIDATION',
        true,
        { errors: validation.errors }
      )
      return
    }

    jsonCtx.logSuccess('DeploymentSpec is valid')

    // Resolve output directory
    const outputDir = path.resolve(flags.output)
    const valuesDir = path.join(outputDir, 'values')
    const dataDir = path.join(outputDir, '.data')

    // Check what files would be generated
    const generateConfigs = !flags['values-only']
    const generateValues = !flags['config-only']

    let configs: GeneratedConfigs | null = null
    let valuesFiles: GeneratedValuesFiles | null = null

    if (generateConfigs) {
      jsonCtx.info('Generating configuration files...')

      // Load contract addresses if provided or auto-detect
      let contractAddresses: ContractAddresses | undefined
      const contractsPath = flags['contract-addresses']
        ? path.resolve(flags['contract-addresses'])
        : path.join(outputDir, 'config-contracts.toml')

      if (fs.existsSync(contractsPath)) {
        try {
          const contractsContent = fs.readFileSync(contractsPath, 'utf8')
          const tomlModule = await import('@iarna/toml')
          const parsed = tomlModule.parse(contractsContent) as Record<string, string>
          contractAddresses = parsed as ContractAddresses
          jsonCtx.logKeyValue('Contract addresses', contractsPath)
        } catch {
          jsonCtx.addWarning(`Failed to parse contract addresses from ${contractsPath}`)
        }
      } else if (flags['contract-addresses']) {
        jsonCtx.addWarning(`Contract addresses file not found: ${contractsPath}`)
      }

      // Load bridge-init output if available (output-withdrawal-processor.toml)
      let bridgeInitValues: BridgeInitValues | undefined
      const bridgeInitPath = path.join(outputDir, '.data', 'output-withdrawal-processor.toml')
      if (fs.existsSync(bridgeInitPath)) {
        try {
          const bridgeContent = fs.readFileSync(bridgeInitPath, 'utf8')
          const tomlModule = await import('@iarna/toml')
          bridgeInitValues = tomlModule.parse(bridgeContent) as BridgeInitValues
          jsonCtx.logKeyValue('Bridge-init values', bridgeInitPath)
        } catch {
          jsonCtx.addWarning(`Failed to parse bridge-init output from ${bridgeInitPath}`)
        }
      } else {
        jsonCtx.addWarning('No bridge-init output found — withdrawal-processor will have placeholder bridge values. Run "scrollsdk doge bridge-init" first.')
      }

      configs = generateAllConfigs(spec, contractAddresses, bridgeInitValues)
    }

    if (generateValues) {
      jsonCtx.info('Generating Helm values files...')
      valuesFiles = generateValuesFiles(spec)
    }

    // Dry run - just show what would be generated
    if (flags['dry-run']) {
      jsonCtx.info('')
      jsonCtx.logSection('Dry run - files that would be generated:')

      if (configs) {
        jsonCtx.info('Configuration files:')
        jsonCtx.logKeyValue('  config.toml', path.join(outputDir, 'config.toml'))
        jsonCtx.logKeyValue('  doge-config.toml', path.join(dataDir, 'doge-config.toml'))
        jsonCtx.logKeyValue('  setup_defaults.toml', path.join(dataDir, 'setup_defaults.toml'))
        if (configs['l1-interface.toml']) {
          jsonCtx.logKeyValue('  l1-interface.toml', path.join(dataDir, 'l1-interface.toml'))
        }

        if (configs['da-publisher.toml']) {
          jsonCtx.logKeyValue('  da-publisher.toml', path.join(dataDir, 'da-publisher.toml'))
        }

        if (configs['fee-oracle.toml']) {
          jsonCtx.logKeyValue('  fee-oracle.toml', path.join(dataDir, 'fee-oracle.toml'))
        }

        if (configs['withdrawal-processor.toml']) {
          jsonCtx.logKeyValue('  withdrawal-processor.toml', path.join(dataDir, 'withdrawal-processor.toml'))
        }
      }

      if (valuesFiles) {
        jsonCtx.info('Helm values files:')
        for (const filename of Object.keys(valuesFiles)) {
          jsonCtx.logKeyValue(`  ${filename}`, path.join(valuesDir, filename))
        }
      }

      const configFileList = configs
        ? ['config.toml', 'doge-config.toml', 'setup_defaults.toml',
            ...(configs['l1-interface.toml'] ? ['l1-interface.toml'] : []),
            ...(configs['da-publisher.toml'] ? ['da-publisher.toml'] : []),
            ...(configs['fee-oracle.toml'] ? ['fee-oracle.toml'] : []),
            ...(configs['withdrawal-processor.toml'] ? ['withdrawal-processor.toml'] : [])]
        : []
      jsonCtx.success({
        configFiles: configFileList,
        dryRun: true,
        outputDir,
        specPath,
        validation: {
          valid: true,
          warningCount: validation.warnings.length
        },
        valuesFiles: valuesFiles ? Object.keys(valuesFiles) : []
      })
      return
    }

    // Check for existing files
    const existingFiles: string[] = []
    if (!flags.force) {
      if (configs) {
        if (fs.existsSync(path.join(outputDir, 'config.toml'))) {
          existingFiles.push('config.toml')
        }

        if (fs.existsSync(path.join(dataDir, 'doge-config.toml'))) {
          existingFiles.push('.data/doge-config.toml')
        }

        if (fs.existsSync(path.join(dataDir, 'setup_defaults.toml'))) {
          existingFiles.push('.data/setup_defaults.toml')
        }

        if (configs['l1-interface.toml'] && fs.existsSync(path.join(dataDir, 'l1-interface.toml'))) {
          existingFiles.push('.data/l1-interface.toml')
        }

        if (configs['da-publisher.toml'] && fs.existsSync(path.join(dataDir, 'da-publisher.toml'))) {
          existingFiles.push('.data/da-publisher.toml')
        }

        if (configs['fee-oracle.toml'] && fs.existsSync(path.join(dataDir, 'fee-oracle.toml'))) {
          existingFiles.push('.data/fee-oracle.toml')
        }

        if (configs['withdrawal-processor.toml'] && fs.existsSync(path.join(dataDir, 'withdrawal-processor.toml'))) {
          existingFiles.push('.data/withdrawal-processor.toml')
        }
      }

      if (valuesFiles) {
        for (const filename of Object.keys(valuesFiles)) {
          if (fs.existsSync(path.join(valuesDir, filename))) {
            existingFiles.push(`values/${filename}`)
          }
        }
      }

      if (existingFiles.length > 0) {
        jsonCtx.error(
          'E604_FILES_EXIST',
          `Some files already exist. Use --force to overwrite: ${existingFiles.join(', ')}`,
          'CONFIGURATION',
          true,
          { existingFiles }
        )
        return
      }
    }

    // Create directories
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    if (generateConfigs && !fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    if (generateValues && !fs.existsSync(valuesDir)) {
      fs.mkdirSync(valuesDir, { recursive: true })
    }

    // Write configuration files
    const writtenFiles: string[] = []

    if (configs) {
      const configFiles = writeGeneratedConfigs(configs, outputDir, dataDir)
      writtenFiles.push(...configFiles)
      for (const f of configFiles) {
        jsonCtx.logSuccess(`Generated ${f}`)
      }
    }

    if (valuesFiles) {
      for (const [filename, content] of Object.entries(valuesFiles)) {
        fs.writeFileSync(path.join(valuesDir, filename), content)
        writtenFiles.push(`values/${filename}`)
        jsonCtx.logSuccess(`Generated values/${filename}`)
      }
    }

    jsonCtx.info('')
    jsonCtx.logSection('Generation complete!')
    jsonCtx.logKeyValue('Output directory', outputDir)
    jsonCtx.logKeyValue('Files generated', String(writtenFiles.length))

    jsonCtx.success({
      filesWritten: writtenFiles,
      outputDir,
      specPath,
      validation: {
        valid: true,
        warningCount: validation.warnings.length
      }
    })
  }
}
