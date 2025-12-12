import { Command, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  loadDeploymentSpec,
  validateDeploymentSpec,
  generateAllConfigs,
  writeGeneratedConfigs,
  type GeneratedConfigs
} from '../../utils/deployment-spec-generator.js'
import { generateValuesFiles, type GeneratedValuesFiles } from '../../utils/values-generator.js'

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
    spec: Flags.string({
      char: 's',
      description: 'Path to DeploymentSpec YAML file',
      required: true,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output directory for generated files',
      default: '.',
    }),
    'dry-run': Flags.boolean({
      description: 'Validate spec and show what would be generated without writing files',
      default: false,
    }),
    'config-only': Flags.boolean({
      description: 'Only generate config.toml, doge-config.toml, setup_defaults.toml',
      default: false,
    }),
    'values-only': Flags.boolean({
      description: 'Only generate values/*.yaml Helm files',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Overwrite existing files without warning',
      default: false,
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
        { path: specPath, error: String(error) }
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
      configs = generateAllConfigs(spec)
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
      }

      if (valuesFiles) {
        jsonCtx.info('Helm values files:')
        for (const filename of Object.keys(valuesFiles)) {
          jsonCtx.logKeyValue(`  ${filename}`, path.join(valuesDir, filename))
        }
      }

      jsonCtx.success({
        dryRun: true,
        specPath,
        outputDir,
        configFiles: configs ? ['config.toml', 'doge-config.toml', 'setup_defaults.toml'] : [],
        valuesFiles: valuesFiles ? Object.keys(valuesFiles) : [],
        validation: {
          valid: true,
          warningCount: validation.warnings.length
        }
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
      writeGeneratedConfigs(configs, outputDir, dataDir)
      writtenFiles.push('config.toml', '.data/doge-config.toml', '.data/setup_defaults.toml')
      jsonCtx.logSuccess('Generated config.toml')
      jsonCtx.logSuccess('Generated .data/doge-config.toml')
      jsonCtx.logSuccess('Generated .data/setup_defaults.toml')
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
      specPath,
      outputDir,
      filesWritten: writtenFiles,
      validation: {
        valid: true,
        warningCount: validation.warnings.length
      }
    })
  }
}
