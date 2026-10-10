import { Command, Flags } from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {DEFAULT_SDK, DEFAULT_SPEC, deploymentEnvFile} from '../../utils/deployment-paths.js'
import {
  type GeneratedConfigs,
  generateAllConfigs,
  loadDeploymentSpec,
  validateDeploymentSpec,
  writeGeneratedConfigs
} from '../../utils/deployment-spec-generator.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {loadPreparationEnv} from '../../utils/preparation-io.js'
import {resolvePreparationProofRelease} from '../../utils/preparation-release.js'
import {archiveRetiredGethValues} from '../../utils/retired-geth.js'
import {archiveRetiredServiceFiles} from '../../utils/retired-services.js'
import {loadSdkTemplateFiles, mergeBootstrapValues, planSpecBootstrap} from '../../utils/spec-bootstrap.js'
import {resolveCubesignerIdentity} from '../../utils/spec-cubesigner.js'
import { type GeneratedValuesFiles, generateValuesFiles } from '../../utils/values-generator.js'

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

export default class GenerateFromSpec extends Command {
  static override description = 'Generate configuration files from a DeploymentSpec YAML file'

  static override examples = [
    '# Generate configs in current directory',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Generate configs to specific output directory',
    '<%= config.bin %> <%= command.id %> --output ./my-deployment',
    '',
    '# Generate with JSON output for automation',
    '<%= config.bin %> <%= command.id %> --json',
    '',
    '# Load private keys/passwords from an env file before deriving account addresses',
    '<%= config.bin %> <%= command.id %> --env-file custom.env',
    '',
    '# Dry run - validate and show what would be generated',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '',
    '# Generate Helm values files explicitly',
    '<%= config.bin %> <%= command.id %> --with-values',
    '<%= config.bin %> <%= command.id %> --values-only',
  ]

  static override flags = {
    bootstrap: Flags.boolean({default: false, description: 'Prepare pinned SDK templates and generated values as well as TOML; no cloud or chain operations.'}),
    'config-only': Flags.boolean({
      default: false,
      description: 'Only generate config.toml and .data/*.toml. This is the default.',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Validate spec and show what would be generated without writing files',
    }),
    'env-file': Flags.string({
      description: 'Private NAME=value file (default: ./deployment.env when present); process environment takes precedence.',
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
    'sdk-dir': Flags.string({description: 'Local SDK checkout for Helm values generation (default: ../scroll-sdk); uses committed HEAD unless templates.sdkRevision overrides it.'}),
    spec: Flags.string({
      char: 's',
      default: DEFAULT_SPEC,
      description: 'Path to DeploymentSpec YAML file',
    }),
    'values-only': Flags.boolean({
      default: false,
      description: 'Only generate values/*.yaml Helm files',
    }),
    'with-values': Flags.boolean({
      default: false,
      description: 'Also generate values/*.yaml Helm files',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(GenerateFromSpec)
    const jsonCtx = new JsonOutputContext('setup generate-from-spec', flags.json)
    if (flags.bootstrap && (flags['config-only'] || flags['values-only'])) throw new Error('--bootstrap cannot be combined with --config-only or --values-only')
    if (flags['sdk-dir'] && !(flags.bootstrap || flags['with-values'] || flags['values-only'])) throw new Error('--sdk-dir requires --bootstrap, --with-values or --values-only')

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

    if (flags['config-only'] && flags['with-values']) {
      jsonCtx.error(
        'E601_CONFLICTING_FLAGS',
        'Cannot use both --config-only and --with-values',
        'CONFIGURATION',
        true,
        { flags: ['--config-only', '--with-values'] }
      )
    }

    if (flags['values-only'] && flags['with-values']) {
      jsonCtx.error(
        'E601_CONFLICTING_FLAGS',
        'Cannot use both --values-only and --with-values',
        'CONFIGURATION',
        true,
        { flags: ['--values-only', '--with-values'] }
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

    const envFile = deploymentEnvFile(flags['env-file'])
    try {
      loadPreparationEnv(envFile)
      if (envFile) jsonCtx.info(`Loaded env file: ${envFile}`)
    } catch {
      jsonCtx.error('E601_FILE_NOT_FOUND', 'Cannot read or parse the deployment environment file', 'CONFIGURATION', true)
    }

    if (!envFile && envRefs.some(key => process.env[key] === undefined)) {
      jsonCtx.addWarning('No deployment.env found. Fill deployment.env or export the required variables, then rerun this command.')
    }

    // Load and validate the spec
    let spec
    try {
      spec = await resolvePreparationProofRelease(resolveCubesignerIdentity(loadDeploymentSpec(specPath)), path.resolve(flags.output))
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
    const generateValues = flags.bootstrap || flags['with-values'] || flags['values-only']
    const bootstrapFiles = flags.bootstrap ? planSpecBootstrap(spec, flags['sdk-dir'] ?? DEFAULT_SDK) : {}
    const templateFiles = flags.bootstrap ? bootstrapFiles : generateValues ? loadSdkTemplateFiles(flags['sdk-dir'] ?? DEFAULT_SDK, spec.templates?.sdkRevision).files : {}

    let configs: GeneratedConfigs | null = null
    let valuesFiles: GeneratedValuesFiles | null = null

    if (generateConfigs) {
      jsonCtx.info('Generating configuration files...')
      configs = generateAllConfigs(spec)
    }

    if (generateValues) {
      jsonCtx.info('Generating Helm values files...')
      // Use the same pinned defaults for bootstrap and direct generation. Preserve
      // local runtime policies on regeneration while refreshing spec-owned inputs.
      const existingValues = (file: string): string | undefined => {
        const target = path.join(valuesDir, file)
        return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined
      }

      const monitor = 'scroll-monitor-production.yaml'
      const monitorTemplate = mergeBootstrapValues(templateFiles[`values/${monitor}`], '{}', existingValues(monitor))
      valuesFiles = generateValuesFiles(spec, monitorTemplate)
      for (const [file, content] of Object.entries(valuesFiles)) {
        if (file === monitor) continue // Monitoring reconciles its own template above.
        const template = templateFiles[`values/${file}`]
        const explicitPolicies: string[] = []
        if (file === 'fee-oracle-production.yaml' && spec.feeOracle?.contractWriteMode !== undefined) explicitPolicies.push('configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE')
        if (file === 'dstack-controller-production.yaml' && spec.dstackController?.resources !== undefined) explicitPolicies.push('resources')
        valuesFiles[file] = mergeBootstrapValues(template, content, existingValues(file), explicitPolicies)
      }

      // Bootstrap also copies values with no spec projection (for example,
      // monitoring without Slack intent). Retain operator edits to those too.
      for (const [file, template] of Object.entries(bootstrapFiles)) {
        if (!file.startsWith('values/') || Object.hasOwn(valuesFiles, file.slice('values/'.length))) continue
        const existing = existingValues(file.slice('values/'.length))
        if (existing !== undefined) bootstrapFiles[file] = mergeBootstrapValues(template, '{}', existing)
      }
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
        jsonCtx.logKeyValue('  protocol_seed.toml', path.join(dataDir, 'protocol_seed.toml'))
      }

      if (valuesFiles) {
        jsonCtx.info('Helm values files:')
        for (const filename of Object.keys(valuesFiles)) {
          jsonCtx.logKeyValue(`  ${filename}`, path.join(valuesDir, filename))
        }
      }

      jsonCtx.success({
        bootstrapFiles: Object.keys(bootstrapFiles),
        configFiles: configs ? ['config.toml', 'doge-config.toml', 'setup_defaults.toml', 'protocol_seed.toml'] : [],
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
    for (const file of Object.keys(bootstrapFiles)) if (fs.existsSync(path.join(outputDir, file))) existingFiles.push(file)
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

        if (fs.existsSync(path.join(dataDir, 'protocol_seed.toml'))) {
          existingFiles.push('.data/protocol_seed.toml')
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
    for (const [file, content] of Object.entries(bootstrapFiles)) {
      const target = path.join(outputDir, file)
      fs.mkdirSync(path.dirname(target), {mode: 0o700, recursive: true})
      fs.writeFileSync(target, content, {mode: 0o600})
      writtenFiles.push(file)
    }

    if (configs) {
      writeGeneratedConfigs(configs, outputDir, dataDir)
      writtenFiles.push('config.toml', '.data/doge-config.toml', '.data/setup_defaults.toml', '.data/protocol_seed.toml')
      jsonCtx.logSuccess('Generated config.toml')
      jsonCtx.logSuccess('Generated .data/doge-config.toml')
      jsonCtx.logSuccess('Generated .data/setup_defaults.toml')
      jsonCtx.logSuccess('Generated .data/protocol_seed.toml')
    }

    if (valuesFiles) {
      for (const file of [...archiveRetiredGethValues(valuesDir), ...archiveRetiredServiceFiles(valuesDir)]) jsonCtx.info(`Archived retired values: ${file}`)
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
