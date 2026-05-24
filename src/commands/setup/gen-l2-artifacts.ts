import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import { ethers } from 'ethers'
import * as yaml from 'js-yaml'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_REPOSITORY, DOCKER_TAGS_URL } from '../../constants/docker.js'
import { writeConfigs } from '../../utils/config-writer.js'
import { hasEnvRef, resolveInlineEnvRefs } from '../../utils/deployment-spec-generator.js'
import { CliExitError, JsonOutputContext } from '../../utils/json-output.js'
import {
  resolveEnvValue,
} from '../../utils/non-interactive.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- TOML configs have dynamic structure */

export default class SetupGenL2Artifacts extends Command {
  static override description = 'Generate L2 deployment artifacts, including genesis, public config, contract config, and Helm config values'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --image-tag gen-configs-v0.2.0-debug',
    '<%= config.bin %> <%= command.id %> --configs-dir ./configs-override',
  ]

  static override flags: any = {
    'base-fee-per-gas': Flags.string({
      description: 'Base fee per gas (non-interactive mode). Uses existing config value if not provided.',
    }),
    'configs-dir': Flags.string({
      default: 'values',
      description: 'Directory name to copy configs to',
      required: false,
    }),
    'deployment-salt': Flags.string({
      description: 'Deployment salt value (non-interactive mode). If not provided, keeps existing or auto-increments.',
    }),
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use',
      required: false,
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'l1-fee-vault-addr': Flags.string({
      description: 'L1 fee vault address (non-interactive mode). Defaults to OWNER_ADDR.',
    }),
    'l1-plonk-verifier-addr': Flags.string({
      description: 'L1 plonk verifier address (non-interactive mode). If not provided, one will be deployed.',
    }),
    'l2-bridge-fee-recipient-addr': Flags.string({
      description: 'L2 bridge fee recipient address (non-interactive mode). Defaults to zero address.',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses config values or sensible defaults.',
    }),
    'skip-deployment-salt-update': Flags.boolean({
      default: false,
      description: 'Skip deployment salt update (non-interactive mode)',
    }),
    'skip-l1-fee-vault-update': Flags.boolean({
      default: false,
      description: 'Skip L1 fee vault address update (non-interactive mode)',
    }),
    'skip-l1-plonk-verifier-update': Flags.boolean({
      default: true,
      description: 'Skip L1 plonk verifier address update (non-interactive mode)',
    }),
  }

  protected jsonCtx!: JsonOutputContext
  protected jsonMode: boolean = false
  protected nonInteractive: boolean = false

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenL2Artifacts) as any

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup gen-l2-artifacts', this.jsonMode)

    const imageTag = await this.getDockerImageTag(flags['image-tag'])
    this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)

    const configsDir = flags['configs-dir']
    this.jsonCtx.info(`Using configuration directory: ${configsDir}`)

    // Skip L1_CONTRACT_DEPLOYMENT_BLOCK for DogeOS network
    // this.jsonCtx.info('Checking L1_CONTRACT_DEPLOYMENT_BLOCK...')
    // await this.updateL1ContractDeploymentBlock()
    this.jsonCtx.info('Checking deployment salt...')
    await this.updateDeploymentSalt(flags)

    this.jsonCtx.info('Checking L1_FEE_VAULT_ADDR...')
    await this.updateL1FeeVaultAddr(flags)

    this.jsonCtx.info('Checking L2_BRIDGE_FEE_RECIPIENT_ADDR...')
    await this.updateL2BridgeFeeRecipientAddr(flags)

    this.jsonCtx.info('Checking L1_PLONK_VERIFIER_ADDR...')
    await this.updateL1PlonkVerifierAddr(flags)

    await this.updateBaseFeePerGas(flags)

    this.resolveConfigEnvRefsInPlace()
    this.validateConfigForArtifactGeneration()

    this.jsonCtx.info('Running docker command to generate L2 artifacts...')
    await this.runDockerCommand(imageTag)

    const publicConfigPath = path.join(process.cwd(), 'config.public.toml')
    if (fs.existsSync(publicConfigPath)) {
      try {
        const publicConfigContent = fs.readFileSync(publicConfigPath, 'utf8')
        toml.parse(publicConfigContent)
        this.jsonCtx.logSuccess('Successfully parsed config.public.toml')
      } catch (error) {
        this.jsonCtx.error(
          'E602_INVALID_CONFIG_FORMAT',
          `Failed to parse config.public.toml: ${error instanceof Error ? error.message : String(error)}`,
          'CONFIGURATION',
          false
        )
      }
    } else {
      this.jsonCtx.addWarning('config.public.toml not found after docker command.')
    }

    this.jsonCtx.info('Processing generated YAML files...')
    await this.processYamlFiles(configsDir)

    this.jsonCtx.logSuccess('L2 artifact generation completed.')

    // JSON output
    if (this.jsonMode) {
      this.jsonCtx.success({
        configsDir,
        genesisPath: path.join(path.resolve(configsDir), 'genesis.yaml'),
        imageTag,
        yamlFilesProcessed: true,
      })
    }

  }

  private canAccessFile(filePath: string): boolean {
    try {
      // eslint-disable-next-line no-bitwise
      fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }



  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        `${DOCKER_TAGS_URL}?page_size=100`,
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: { name: string }) => tag.name).filter((tag: string) => tag.startsWith('gen-configs-'))
    } catch (error) {
      this.jsonCtx.error(
        'E400_DOCKER_IMAGE_PULL_FAILED',
        `Failed to fetch Docker tags: ${error}`,
        'DOCKER',
        true,
        { error: String(error) }
      )
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = `gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (providedTag.startsWith('gen-configs-') && tags.includes(providedTag)) {
      return providedTag
    }

    if (providedTag.startsWith('v') && tags.includes(`gen-configs-${providedTag}`)) {
      return `gen-configs-${providedTag}`
    }

    if (/^\d+\.\d+\.\d+$/.test(providedTag) && tags.includes(`gen-configs-v${providedTag}`)) {
      return `gen-configs-v${providedTag}`
    }

    // In non-interactive mode, use default tag if provided tag is invalid
    if (this.nonInteractive) {
      this.jsonCtx.addWarning(`Provided tag "${providedTag}" not found, using default: ${defaultTag}`)
      return defaultTag
    }

    const selectedTag = await select({
      choices: tags.map((tag) => ({ name: tag, value: tag })),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }

  private async processYamlFiles(configsDir: string): Promise<void> {
    const sourceDir = process.cwd()
    const targetDir = path.join(sourceDir, configsDir)

    // Ensure the target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    // Check permissions and potentially change ownership before processing
    const yamlFiles = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.yaml'))
    if (yamlFiles.some((file) => !this.canAccessFile(path.join(sourceDir, file)))) {
      let changeOwnership = true
      if (this.nonInteractive) {
        this.jsonCtx.info('Non-interactive mode: Attempting to change ownership of YAML files with permission issues...')
      } else {
        changeOwnership = await confirm({
          message:
            'Some YAML files have permission issues. Would you like to change their ownership to the current user?',
        })
      }

      if (changeOwnership) {
        try {
          childProcess.execFileSync('sudo', ['find', sourceDir, '-name', '*.yaml', '-user', 'root', '-exec', 'sudo', 'chown', '-R', `${process.env.USER || 'root'}:`, '{}', ';'], { stdio: 'inherit' })
          this.jsonCtx.logSuccess('File ownership changed successfully.')
        } catch (error) {
          this.jsonCtx.error(
            'E900_UNEXPECTED_ERROR',
            `Failed to change file ownership: ${error}`,
            'INTERNAL',
            false,
            { error: String(error) }
          )
          return // Exit the method if we can't change permissions
        }
      } else {
        this.jsonCtx.addWarning('File ownership not changed. Some files may not be accessible.')
        return // Exit the method if user chooses not to change permissions
      }
    }

    const fileMappings = [
      { source: 'admin-system-backend-config.yaml', target: 'admin-system-backend-config.yaml' },
      { source: 'admin-system-backend-config.yaml', target: 'admin-system-cron-config.yaml' },
      { source: 'balance-checker-config.yaml', target: 'balance-checker-config.yaml' },
      { source: 'bridge-history-config.yaml', target: 'bridge-history-api-config.yaml' },
      { source: 'bridge-history-config.yaml', target: 'bridge-history-fetcher-config.yaml' },
      { source: 'chain-monitor-config.yaml', target: 'chain-monitor-config.yaml' },
      { source: 'coordinator-api-config.yaml', target: 'coordinator-api-config.yaml' },
      { source: 'coordinator-cron-config.yaml', target: 'coordinator-cron-config.yaml' },
      { source: 'frontend-config.yaml', target: 'frontends-config.yaml' },
      { source: 'genesis.yaml', target: 'genesis.yaml' },
      { source: 'gas-oracle-config.yaml', target: 'gas-oracle-config.yaml' },
      { source: 'rollup-config.yaml', target: 'rollup-relayer-config.yaml' },
      { source: 'rollup-explorer-backend-config.yaml', target: 'rollup-explorer-backend-config.yaml' },
    ]

    // Process all mappings
    for (const mapping of fileMappings) {
      const sourcePath = path.join(sourceDir, mapping.source)
      const targetPath = path.join(targetDir, mapping.target)

      if (fs.existsSync(sourcePath)) {
        try {
          if (mapping.source === "gas-oracle-config.yaml") {
            // gas-oracle-config.yaml no longer used.
            continue;
          }

          fs.copyFileSync(sourcePath, targetPath)
          this.jsonCtx.log(chalk.green(`Processed file: ${mapping.source} -> ${mapping.target}`))

          if (
            mapping.target === 'coordinator-api-config.yaml' ||
            mapping.target === 'coordinator-cron-config.yaml'
          ) {
            // remove auth.secret
            try {
              const yamlFileContent = fs.readFileSync(targetPath, 'utf8')
              const parsedYaml = yaml.load(yamlFileContent) as any | null

              if (!parsedYaml || parsedYaml.scrollConfig === undefined) {
                this.jsonCtx.log(chalk.yellow(`scrollConfig not found in ${mapping.target}`))
                continue
              }

              let scrollConfigObject: any
              const originalScrollConfig = parsedYaml.scrollConfig

              if (typeof originalScrollConfig === 'string') {
                scrollConfigObject = JSON.parse(originalScrollConfig)
              } else if (typeof originalScrollConfig === 'object' && originalScrollConfig !== null) {
                scrollConfigObject = originalScrollConfig
              } else {
                this.jsonCtx.log(chalk.yellow(`Unsupported scrollConfig format in ${mapping.target}`))
                continue
              }

              if (!scrollConfigObject || typeof scrollConfigObject !== 'object') {
                this.jsonCtx.log(chalk.yellow(`scrollConfig is not an object in ${mapping.target}`))
                continue
              }

              if (!scrollConfigObject.auth || typeof scrollConfigObject.auth !== 'object') {
                scrollConfigObject.auth = {}
                this.jsonCtx.log(chalk.yellow(`auth field missing; created auth object in ${mapping.target}`))
              }

              const hadSecretKey = Object.hasOwn(scrollConfigObject.auth, 'secret')
              scrollConfigObject.auth.secret = null
              if (hadSecretKey) {
                this.jsonCtx.log(chalk.green(`Sanitized auth.secret in ${mapping.target}`))
              } else {
                this.jsonCtx.log(chalk.yellow(`auth.secret key missing; initialized to null in ${mapping.target}`))
              }

              parsedYaml.scrollConfig =
                typeof originalScrollConfig === 'string'
                  ? JSON.stringify(scrollConfigObject, null, 2)
                  : scrollConfigObject

              const updatedYaml = yaml.dump(parsedYaml, { indent: 2 })
              fs.writeFileSync(targetPath, updatedYaml)
            } catch (error) {
              if (error instanceof Error) {
                this.jsonCtx.log(chalk.red(`Failed to remove auth.secret in ${mapping.target}: ${error.message}`))
              } else {
                this.jsonCtx.log(chalk.red(`Unknown error updating ${mapping.target}`))
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.jsonCtx.log(chalk.red(`Error processing file ${mapping.source}: ${error.message}`))
          } else {
            this.jsonCtx.log(chalk.red(`Unknown error processing file ${mapping.source}`))
          }
        }
      } else {
        this.jsonCtx.log(chalk.yellow(`Source file not found: ${mapping.source}`))
      }
    }

    /*
        try {
          this.jsonCtx.log(chalk.blue(`generating balance-checker alert rules file...`))
          const scrollMonitorProductionFilePath = path.join(targetDir, 'scroll-monitor-production.yaml')
          const balanceCheckerConfigFilePath = path.join(targetDir, 'balance-checker-config.yaml')
          const addedAlertRules = this.generateAlertRules(balanceCheckerConfigFilePath)
          const existingContent = fs.readFileSync(scrollMonitorProductionFilePath, 'utf8')
          const existingYaml = yaml.load(existingContent) as any
          existingYaml['kube-prometheus-stack'].additionalPrometheusRules = addedAlertRules
          fs.writeFileSync(scrollMonitorProductionFilePath, yaml.dump(existingYaml, { indent: 2 }))
        } catch {
          this.error(`generating balance-checker alert rules file failed`)
        }
    */
    // Remove source files after all processing is complete
    for (const mapping of fileMappings) {
      const sourcePath = path.join(sourceDir, mapping.source)
      if (fs.existsSync(sourcePath)) {
        try {
          fs.unlinkSync(sourcePath)
          this.jsonCtx.log(chalk.green(`Removed source file: ${mapping.source}`))
        } catch (error: unknown) {
          if (error instanceof Error) {
            this.jsonCtx.log(chalk.red(`Error removing file ${mapping.source}: ${error.message}`))
          } else {
            this.jsonCtx.log(chalk.red(`Unknown error removing file ${mapping.source}`))
          }
        }
      }
    }

    // Process config.toml and config-contracts.toml
    const configFiles = [
      { key: 'scrollConfig', source: 'config.public.toml', target: 'scroll-common-config.yaml' },
      { key: 'scrollConfigContracts', source: 'config-contracts.toml', target: 'scroll-common-config-contracts.yaml' },
    ]

    for (const file of configFiles) {
      const sourcePath = path.join(sourceDir, file.source)
      const targetPath = path.join(targetDir, file.target)

      if (fs.existsSync(sourcePath)) {
        const content = fs.readFileSync(sourcePath, 'utf8')
        const yamlContent = {
          [file.key]: content,
        }
        const yamlString = yaml.dump(yamlContent, { indent: 2 })
        fs.writeFileSync(targetPath, yamlString)
        this.jsonCtx.log(chalk.green(`Processed file: ${file.target}`))
      } else {
        this.jsonCtx.log(chalk.yellow(`Source file not found: ${file.source}`))
      }
    }
  }

  private resolveConfigEnvRefsInPlace(): void {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping $ENV expansion.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    if (!hasEnvRef(configContent)) return

    try {
      const parsed = toml.parse(configContent)
      const resolved = this.resolveEnvRefs(parsed) as toml.JsonMap
      writeConfigs(resolved, path.join(process.cwd(), 'config.public.toml'), configPath, this.jsonMode)
      this.jsonCtx.info('Resolved $ENV references in config.toml.')
    } catch (error) {
      this.jsonCtx.error(
        'E602_INVALID_CONFIG_FORMAT',
        `Failed to resolve $ENV references in config.toml: ${error instanceof Error ? error.message : String(error)}`,
        'CONFIGURATION',
        true
      )
    }
  }

  private resolveEnvRefs(value: unknown): unknown {
    if (typeof value === 'string') {
      return hasEnvRef(value) ? resolveInlineEnvRefs(value) : value
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolveEnvRefs(item))
    }

    if (value && typeof value === 'object') {
      const resolved: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        resolved[key] = this.resolveEnvRefs(item)
      }

      return resolved
    }

    return value
  }

  private async runDockerCommand(imageTag: string): Promise<void> {
    const docker = new Docker()
    // const image = `dogeos69/scroll-stack-contracts:${imageTag}`
    const image = `${DOCKER_REPOSITORY}:${imageTag}`

    try {
      this.jsonCtx.info(`Pulling Docker Image: ${image}`)
      // Pull the image if it doesn't exist locally
      const pullStream = await docker.pull(image)
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(pullStream, (err, res) => {
          if (err) {
            reject(err)
          } else {
            this.jsonCtx.logSuccess('Image pulled successfully')
            resolve(res)
          }
        })
      })

      this.jsonCtx.info('Creating Docker Container...')
      // Create and run the container
      // Note: Container must run as root because forge is installed in /root/.foundry/
      // We fix file ownership after the container exits
      const container = await docker.createContainer({
        Cmd: [], // Add any command if needed
        HostConfig: {
          Binds: [`${process.cwd()}:/contracts/volume`],
        },
        Image: image,
      })

      this.jsonCtx.info('Starting Container')
      await container.start()

      // Wait for the container to finish and get the logs
      const stream = await container.logs({
        follow: true,
        stderr: true,
        stdout: true,
      })

      // Print the logs (stderr in JSON mode to keep stdout clean for JSON response)
      const logTarget = this.jsonMode ? process.stderr : process.stdout
      stream.pipe(logTarget)

      try {
        // Wait for the container to finish
        const { StatusCode } = await new Promise<{ StatusCode: number }>((resolve, reject) => {
          container.wait((err: Error | null, data: { StatusCode: number }) => {
            if (err) reject(err)
            else resolve(data)
          })
        })

        if (StatusCode !== 0) {
          this.jsonCtx.error(
            'E401_DOCKER_CONTAINER_FAILED',
            `Container exited with status code: ${StatusCode}`,
            'DOCKER',
            false,
            { statusCode: StatusCode }
          )
        }
      } finally {
        // Clean up the log stream to prevent hanging
        stream.unpipe(logTarget)
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy()
        }

        // Remove container (ignore errors if already removed)
        try { await container.remove() } catch { /* container may already be removed */ }
      }

      // Fix file ownership on POSIX systems (Docker runs as root, creates root-owned files)
      // Use a lightweight container to chown files since non-root can't chown root-owned files
      if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
        const uid = process.getuid()
        const gid = process.getgid()
        if (uid !== 0) {
          this.jsonCtx.info('Fixing file ownership...')
          try {
            // Ensure alpine:latest is available. Inspect first; only pull if missing.
            // The pull stream MUST be fully consumed via followProgress, otherwise
            // an unfinished keep-alive connection lingers on dockerode's HTTP agent
            // and prevents the Node event loop from draining (process hangs at exit).
            try {
              await docker.getImage('alpine:latest').inspect()
            } catch {
              try {
                const alpinePullStream = await docker.pull('alpine:latest')
                await new Promise((resolve, reject) => {
                  docker.modem.followProgress(alpinePullStream, (err, res) => {
                    if (err) reject(err)
                    else resolve(res)
                  })
                })
              } catch (pullError) {
                this.jsonCtx.addWarning(`Could not pull alpine:latest and image not found locally: ${pullError}`)
                throw pullError
              }
            }

            const chownContainer = await docker.createContainer({
              Cmd: ['chown', '-R', `${uid}:${gid}`, '/volume'],
              HostConfig: {
                AutoRemove: true,
                Binds: [`${process.cwd()}:/volume`],
              },
              Image: 'alpine:latest',
            })
            await chownContainer.start()
            await chownContainer.wait()
          } catch (chownError) {
            this.jsonCtx.addWarning(`Could not fix file ownership: ${chownError}`)
            this.jsonCtx.addWarning('Files may be owned by root. Run: sudo chown -R $(id -u):$(id -g) .')
          }
        }
      }
    } catch (error) {
      if (error instanceof CliExitError) throw error
      this.jsonCtx.error(
        'E401_DOCKER_CONTAINER_FAILED',
        `Failed to run Docker command: ${error}`,
        'DOCKER',
        false,
        { error: String(error) }
      )
    } finally {
      // Close Docker HTTP agent to release event loop
      const { agent } = docker.modem as { agent?: { destroy?: () => void } }
      agent?.destroy?.()
    }
  }

  private async updateBaseFeePerGas(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping BASE_FEE_PER_GAS update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)
    const currentBaseFee = String((config.genesis as any)?.BASE_FEE_PER_GAS || '')

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or keep existing
      const newBaseFeePerGas = resolveEnvValue(flags['base-fee-per-gas']) || currentBaseFee

      if (!newBaseFeePerGas) {
        this.jsonCtx.addWarning('BASE_FEE_PER_GAS not provided and not in config. Skipping.')
        return
      }

      if (!config.genesis) {
        config.genesis = {}
      }

      ; (config.genesis as any).BASE_FEE_PER_GAS = newBaseFeePerGas

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`BASE_FEE_PER_GAS updated in config.toml to "${newBaseFeePerGas}"`)
      }
    } else {
      const newBaseFeePerGas = await input({
        default: currentBaseFee,
        message: "Enter baseFeePerGas"
      })

      if (!config.genesis) {
        config.genesis = {}
      }

      ; (config.genesis as any).BASE_FEE_PER_GAS = newBaseFeePerGas

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.log(chalk.green(`BASE_FEE_PER_GAS updated in config.toml to "${newBaseFeePerGas}"`))
      }
    }
  }

  private async updateDeploymentSalt(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping deployment salt update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)
    const currentSalt = String((config.contracts as any)?.DEPLOYMENT_SALT || '')
    let defaultNewSalt = currentSalt

    if (/\d+$/.test(currentSalt)) {
      // If the current salt ends with a number, increment it
      const match = currentSalt.match(/\d+$/)
      const number = Number.parseInt(match![0], 10)
      defaultNewSalt = currentSalt.replace(/\d+$/, (number + 1).toString())
    } else {
      // Generate a new random 6 char string and append it to the base
      const baseSalt = currentSalt.split('-')[0] || 'devnetSalt'
      const randomString = Math.random().toString(36).slice(2, 8)
      defaultNewSalt = `${baseSalt}-${randomString}`
    }

    this.jsonCtx.info(`Current deployment salt: ${currentSalt}`)

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or skip if --skip-deployment-salt-update
      if (flags['skip-deployment-salt-update']) {
        this.jsonCtx.info('Skipping deployment salt update (--skip-deployment-salt-update)')
        return
      }

      const newSalt = resolveEnvValue(flags['deployment-salt'] as string | undefined) || defaultNewSalt

      if (!config.contracts) {
        config.contracts = {}
      }

      ; (config.contracts as any).DEPLOYMENT_SALT = newSalt

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`Deployment salt updated in config.toml from "${currentSalt}" to "${newSalt}"`)
      }
    } else {
      const updateSalt = await confirm({
        message: 'Would you like to update the deployment salt in config.toml?',
      })

      if (updateSalt) {
        const newSalt = await input({
          default: defaultNewSalt,
          message: 'Enter new deployment salt:',
        })

        if (!config.contracts) {
          config.contracts = {}
        }

        ; (config.contracts as any).DEPLOYMENT_SALT = newSalt

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`Deployment salt updated in config.toml from "${currentSalt}" to "${newSalt}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('Deployment salt not updated'))
      }
    }
  }

  private async updateL1ContractDeploymentBlock(): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.log(chalk.yellow('config.toml not found. Skipping L1_CONTRACT_DEPLOYMENT_BLOCK update.'))
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)
    const currentBlock = String((config.general as any)?.L1_CONTRACT_DEPLOYMENT_BLOCK || '')
    let defaultNewBlock = currentBlock

    const updateBlock = await confirm({
      message: 'Would you like to update the L1_CONTRACT_DEPLOYMENT_BLOCK in config.toml?',
    })

    if (updateBlock) {
      try {
        const l1RpcUri = (config.frontend as any)?.EXTERNAL_RPC_URI_L1 as string | undefined
        const isDevnet = (config.general as any)?.L1_RPC_ENDPOINT === 'http://l1-devnet:8545'

        if (isDevnet) {
          defaultNewBlock = '0'
        } else if (l1RpcUri) {
          const provider = new ethers.JsonRpcProvider(l1RpcUri)
          const latestBlock = await provider.getBlockNumber()
          defaultNewBlock = latestBlock.toString()
          this.jsonCtx.log(chalk.green(`Retrieved current L1 block height: ${defaultNewBlock}`))
        } else {
          this.jsonCtx.log(chalk.yellow('EXTERNAL_RPC_URI_L1 not found in config.toml. Using current value as default.'))
        }
      } catch (error) {
        this.jsonCtx.log(chalk.yellow(`Failed to retrieve current L1 block height: ${error}`))
      }

      if (!defaultNewBlock || Number.isNaN(Number(defaultNewBlock))) {
        defaultNewBlock = '0'
      }

      const newBlock = await input({
        default: defaultNewBlock,
        message: 'Enter new L1_CONTRACT_DEPLOYMENT_BLOCK:',
      })

      if (!config.general) {
        config.general = {}
      }

      ; (config.general as any).L1_CONTRACT_DEPLOYMENT_BLOCK = newBlock
      if (writeConfigs(config)) {
        this.jsonCtx.logSuccess(`L1_CONTRACT_DEPLOYMENT_BLOCK updated in config.toml from "${currentBlock}" to "${newBlock}"`)
      }

    } else {
      this.jsonCtx.log(chalk.yellow('L1_CONTRACT_DEPLOYMENT_BLOCK not updated'))
    }
  }

  private async updateL1FeeVaultAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L1_FEE_VAULT_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)
    const defaultAddr = String((config.accounts as any)?.OWNER_ADDR || '')

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value, existing config value, or OWNER_ADDR
      if (flags['skip-l1-fee-vault-update']) {
        this.jsonCtx.info('Skipping L1_FEE_VAULT_ADDR update (--skip-l1-fee-vault-update)')
        return
      }

      const newAddr = resolveEnvValue(flags['l1-fee-vault-addr']) ||
        String((config.contracts as any)?.L1_FEE_VAULT_ADDR || '') ||
        defaultAddr

      if (!ethers.isAddress(newAddr)) {
        this.jsonCtx.error(
          'E600_INVALID_ADDRESS',
          `Invalid L1_FEE_VAULT_ADDR: ${newAddr}`,
          'VALIDATION',
          true,
          { address: newAddr }
        )
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ; (config.contracts as any).L1_FEE_VAULT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`L1_FEE_VAULT_ADDR updated in config.toml to "${newAddr}"`)
      }
    } else {
      const updateFeeVault = await confirm({
        message: 'Would you like to set a value for L1_FEE_VAULT_ADDR?',
      })

      if (updateFeeVault) {
        this.jsonCtx.log(chalk.yellow('It is recommended to use a Safe for the L1_FEE_VAULT_ADDR.'))
        this.jsonCtx.log(chalk.cyan(`The Owner address (${defaultAddr}) is the default value.`))

        let isValidAddress = false
        let newAddr = ''

        while (!isValidAddress) {
          newAddr = await input({
            default: defaultAddr,
            message: 'Enter the L1_FEE_VAULT_ADDR:',
          })

          if (ethers.isAddress(newAddr)) {
            isValidAddress = true
          } else {
            this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
          }
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ; (config.contracts as any).L1_FEE_VAULT_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`L1_FEE_VAULT_ADDR updated in config.toml to "${newAddr}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('L1_FEE_VAULT_ADDR not updated'))
      }
    }
  }

  private async updateL1PlonkVerifierAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L1_PLONK_VERIFIER_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const currentAddr = (config.contracts as any)?.L1_PLONK_VERIFIER_ADDR || ''

    if (this.nonInteractive) {
      // Non-interactive mode: skip by default (--skip-l1-plonk-verifier-update is true by default)
      // Only update if explicitly provided via flag
      if (flags['skip-l1-plonk-verifier-update'] && !flags['l1-plonk-verifier-addr']) {
        this.jsonCtx.info('Skipping L1_PLONK_VERIFIER_ADDR update (will be auto-deployed)')
        return
      }

      const newAddr = resolveEnvValue(flags['l1-plonk-verifier-addr'])
      if (newAddr) {
        if (!ethers.isAddress(newAddr)) {
          this.jsonCtx.error(
            'E600_INVALID_ADDRESS',
            `Invalid L1_PLONK_VERIFIER_ADDR: ${newAddr}`,
            'VALIDATION',
            true,
            { address: newAddr }
          )
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ; (config.contracts as any).L1_PLONK_VERIFIER_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.logSuccess(`L1_PLONK_VERIFIER_ADDR updated in config.toml to "${newAddr}"`)
        }
      } else {
        this.jsonCtx.info('L1_PLONK_VERIFIER_ADDR not provided, will be auto-deployed')
      }
    } else {
      this.jsonCtx.log(chalk.yellow('Note: If you do not set L1_PLONK_VERIFIER_ADDR, one will be automatically deployed.'))

      const updatePlonkVerifier = await confirm({
        default: false,
        message: 'Would you like to set a value for L1_PLONK_VERIFIER_ADDR?',
      })

      if (updatePlonkVerifier) {
        this.jsonCtx.log(chalk.cyan(`The current L1_PLONK_VERIFIER_ADDR is: ${currentAddr}`))

        let isValidAddress = false
        let newAddr = ''

        while (!isValidAddress) {
          newAddr = await input({
            default: currentAddr,
            message: 'Enter the L1_PLONK_VERIFIER_ADDR:',
          })

          if (ethers.isAddress(newAddr)) {
            isValidAddress = true
          } else {
            this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
          }
        }

        if (!config.contracts) {
          config.contracts = {}
        }

        ; (config.contracts as any).L1_PLONK_VERIFIER_ADDR = newAddr

        if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
          this.jsonCtx.log(chalk.green(`L1_PLONK_VERIFIER_ADDR updated in config.toml to "${newAddr}"`))
        }
      } else {
        this.jsonCtx.log(chalk.yellow('L1_PLONK_VERIFIER_ADDR not updated'))
      }
    }
  }

  private async updateL2BridgeFeeRecipientAddr(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.addWarning('config.toml not found. Skipping L2_BRIDGE_FEE_RECIPIENT_ADDR update.')
      return
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    const config = toml.parse(configContent)

    const defaultAddr = (config.contracts as any)?.L2_BRIDGE_FEE_RECIPIENT_ADDR || "0x0000000000000000000000000000000000000000"

    if (this.nonInteractive) {
      // Non-interactive mode: use flag value or existing config value or zero address
      const newAddr = resolveEnvValue(flags['l2-bridge-fee-recipient-addr']) || defaultAddr

      if (!ethers.isAddress(newAddr)) {
        this.jsonCtx.error(
          'E600_INVALID_ADDRESS',
          `Invalid L2_BRIDGE_FEE_RECIPIENT_ADDR: ${newAddr}`,
          'VALIDATION',
          true,
          { address: newAddr }
        )
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ; (config.contracts as any).L2_BRIDGE_FEE_RECIPIENT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.logSuccess(`L2_BRIDGE_FEE_RECIPIENT_ADDR updated in config.toml to "${newAddr}"`)
      }
    } else {
      let isValidAddress = false
      let newAddr = ''

      while (!isValidAddress) {
        newAddr = await input({
          default: defaultAddr,
          message: 'Please enter the L2_BRIDGE_FEE_RECIPIENT_ADDR:',
        })

        if (ethers.isAddress(newAddr)) {
          isValidAddress = true
        } else {
          this.jsonCtx.log(chalk.red('Invalid Ethereum address. Please try again.'))
        }
      }

      if (!config.contracts) {
        config.contracts = {}
      }

      ; (config.contracts as any).L2_BRIDGE_FEE_RECIPIENT_ADDR = newAddr

      if (writeConfigs(config, undefined, undefined, this.jsonMode)) {
        this.jsonCtx.log(chalk.green(`L2_BRIDGE_FEE_RECIPIENT_ADDR updated in config.toml to "${newAddr}"`))
      }
    }
  }

  private validateConfigForArtifactGeneration(): void {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.error(
        'E602_CONFIG_NOT_FOUND',
        'config.toml not found. Run setup generate-from-spec first.',
        'CONFIGURATION',
        true,
        { path: configPath }
      )
    }

    const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
    const signerAddress = config.sequencer?.L2GETH_SIGNER_ADDRESS
    if (typeof signerAddress !== 'string' || !ethers.isAddress(signerAddress)) {
      this.jsonCtx.error(
        'E002_MISSING_REQUIRED_FIELD',
        'sequencer.L2GETH_SIGNER_ADDRESS is required before generating L2 artifacts. Run setup gen-keystore --from-spec deployment-spec.yaml --non-interactive --sequencer-password "$ENV:SEQUENCER_KEYSTORE_PASSWORD", or set infrastructure.sequencers[0].signerAddress in the spec and regenerate config.toml.',
        'VALIDATION',
        true,
        { path: 'sequencer.L2GETH_SIGNER_ADDRESS' }
      )
    }
  }
}
