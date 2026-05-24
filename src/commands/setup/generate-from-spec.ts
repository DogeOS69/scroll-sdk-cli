import { Command, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type GeneratedConfigs,
  generateAllConfigs,
  loadDeploymentSpec,
  validateDeploymentSpec,
  writeGeneratedConfigs
} from '../../utils/deployment-spec-generator.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { type GeneratedValuesFiles, generateValuesFiles } from '../../utils/values-generator.js'

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

function loadEnvFile(filePath: string): string[] {
  const loadedKeys: string[] = []
  const content = fs.readFileSync(filePath, 'utf8')

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/)
    if (!match) continue

    const key = match[1]
    if (process.env[key] !== undefined) continue

    process.env[key] = parseEnvValue(match[2])
    loadedKeys.push(key)
  }

  return loadedKeys
}

function collectEnvRefs(content: string): string[] {
  const refs = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const searchable = line.split('#', 1)[0]
    for (const match of searchable.matchAll(/\$ENV:([A-Z_a-z]\w*)/g)) {
      refs.add(match[1])
    }
  }

  return [...refs].sort()
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(candidate => path.resolve(candidate)))]
}

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
    '# Load private keys/passwords from an env file before deriving account addresses',
    '<%= config.bin %> <%= command.id %> --spec deployment-spec.yaml --env-file .env.local',
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
    'dry-run': Flags.boolean({
      default: false,
      description: 'Validate spec and show what would be generated without writing files',
    }),
    'env-file': Flags.string({
      description: 'Load dotenv-style environment variables before parsing the spec. Defaults to .env.local/.env next to the spec and current directory when present.',
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
    const specContent = fs.readFileSync(specPath, 'utf8')
    const envRefs = collectEnvRefs(specContent)

    const envFiles = flags['env-file']
      ? [path.resolve(flags['env-file'])]
      : uniquePaths([
        path.join(path.dirname(specPath), '.env.local'),
        path.join(path.dirname(specPath), '.env'),
        path.join(process.cwd(), '.env.local'),
        path.join(process.cwd(), '.env'),
      ])

    const loadedEnvFiles: string[] = []
    for (const envFile of envFiles) {
      if (fs.existsSync(envFile)) {
        const loadedKeys = loadEnvFile(envFile)
        loadedEnvFiles.push(envFile)
        jsonCtx.info(`Loaded env file: ${envFile} (${loadedKeys.length} new variable(s))`)
      } else if (flags['env-file']) {
        jsonCtx.error(
          'E601_FILE_NOT_FOUND',
          `Env file not found: ${envFile}`,
          'CONFIGURATION',
          true,
          { path: envFile }
        )
      }
    }

    if (!flags['env-file'] && loadedEnvFiles.length === 0 && envRefs.length > 0) {
      const exampleEnvPath = path.join(process.cwd(), '.env.example')
      const suggestion = fs.existsSync(exampleEnvPath)
        ? `Create .env from .env.example, fill real values, then rerun this command. Example: cp .env.example .env`
        : `Create .env or .env.local with the required variables, or pass --env-file /path/to/env.`
      jsonCtx.addWarning(
        `No env file loaded. Looked for: ${envFiles.join(', ')}. Spec references ${envRefs.length} env variable(s): ${envRefs.join(', ')}. ${suggestion}`
      )
    }

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
        configFiles: configs ? ['config.toml', 'doge-config.toml', 'setup_defaults.toml'] : [],
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
