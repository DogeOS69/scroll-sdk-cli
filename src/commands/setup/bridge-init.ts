/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import Docker from 'dockerode'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { CliExitError, JsonOutputContext } from '../../utils/json-output.js'

type BridgeInitStep = '1-prepare' | '2-setup' | '3-generate' | '4-fund' | 'all'

interface BridgeInitPaths {
  dataDir: string
  generateBridgeInfoPath: string
  genesisJsonPath: string
  protocolContextPath: string
  protocolContextYamlPath: string
  protocolSeedPath: string
  secretsDir: string
  setupDefaultsPath: string
  valuesDir: string
  withdrawalProcessorSecretPath: string
  withdrawalProcessorTomlPath: string
}

interface BridgeInitPostprocessResult {
  confirmedBlockHash?: string
  confirmedBlockHeight?: number
  outputFiles: string[]
}

function isValidSecp256k1PublicKey(publicKey: string): boolean {
  const normalized = publicKey.replace(/^0x/, '')
  return /^[\dA-Fa-f]{66}$/.test(normalized) || /^04[\dA-Fa-f]{128}$/.test(normalized)
}

export class BridgeInitCommand extends Command {
  static description = 'Initialize DogeOS bridge after L2 artifacts and CubeSigner keys are ready'

  static examples = [
    '$ scrollsdk setup bridge-init',
    '$ scrollsdk setup bridge-init --step 1-prepare',
    '$ scrollsdk setup bridge-init --step 2-setup',
    '$ scrollsdk setup bridge-init --step 3-generate',
    '$ scrollsdk setup bridge-init --step 4-fund',
    '$ scrollsdk setup bridge-init --step 2',
    '$ scrollsdk setup bridge-init -s 123456',
    '$ scrollsdk setup bridge-init --seed 123456',
    '$ scrollsdk setup bridge-init --image-tag 0.2.0-debug',
    '$ scrollsdk setup bridge-init --non-interactive --seed 123456 --image-tag 0.2.0-rc.3',
    '$ scrollsdk setup bridge-init --non-interactive --json --seed 123456',
  ]

  static flags = {
    'image-tag': Flags.string({
      description: 'Specify the Docker image tag to use (defaults to 0.2.0-rc.3)',
      required: false,
    }),
    'json': Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Requires --seed for --step all or --step 1-prepare.',
    }),
    seed: Flags.string({
      char: 's',
      description: 'seed which will regenerate the sequencer and fee wallet',
    }),
    step: Flags.string({
      default: 'all',
      description: [
        'Bridge init step to run.',
        'all runs 1-prepare, 2-setup, 3-generate, and 4-fund.',
        '1-prepare requires values/genesis.yaml, extracts .data/genesis.json, and prepares protocol_seed.toml.',
        '2-setup is NOT idempotent: generate test keys and broadcast the setup transaction.',
        '3-generate is idempotent: generate namespace, bridge.json, and protocol_context.json.',
        '4-fund is NOT idempotent: broadcast 10 initial bridge funding transactions.',
        'Numeric aliases 1, 2, 3, and 4 are accepted.',
      ].join(' '),
    }),
  }

  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false

  async run(): Promise<void> {
    const { flags } = await this.parse(BridgeInitCommand)

    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup bridge-init', this.jsonMode)

    let { seed } = flags
    let imageTag = flags['image-tag']
    const step = this.normalizeStep(flags.step)
    const needsPrepare = step === 'all' || step === '1-prepare'
    const dataDir = path.join(process.cwd(), '.data')
    const secretsDir = path.join(process.cwd(), 'secrets')
    const valuesDir = path.join(process.cwd(), 'values')
    const paths: BridgeInitPaths = {
      dataDir,
      generateBridgeInfoPath: path.join(dataDir, 'GenerateBridgeInfo.toml'),
      genesisJsonPath: path.join(dataDir, 'genesis.json'),
      protocolContextPath: path.join(dataDir, 'protocol_context.json'),
      protocolContextYamlPath: path.join(valuesDir, 'protocol_context.yaml'),
      protocolSeedPath: path.join(dataDir, 'protocol_seed.toml'),
      secretsDir,
      setupDefaultsPath: getSetupDefaultsPath(),
      valuesDir,
      withdrawalProcessorSecretPath: path.join(secretsDir, 'withdrawal-processor-secret.env'),
      withdrawalProcessorTomlPath: path.join(dataDir, 'output-withdrawal-processor.toml'),
    }

    // In non-interactive mode, require seed only for steps that prepare setup_defaults.toml.
    if (this.nonInteractive && needsPrepare && !seed) {
      this.jsonCtx.error(
        'E601_MISSING_FIELD',
        '--seed flag is required in non-interactive mode for --step all or --step 1-prepare',
        'CONFIGURATION',
        true,
        { flag: '--seed', step }
      )
    }

    imageTag = await this.getDockerImageTag(imageTag)
    this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)

    if (needsPrepare) {
      seed = await this.prepareBridgeInit(seed, paths)
    }

    let postprocessResult: BridgeInitPostprocessResult = { outputFiles: [] }

    switch (step) {
      case 'all': {
        await this.runPrepareStep(imageTag, paths)
        await this.runSetupStep(imageTag, paths)
        postprocessResult = this.postprocessBridgeInit(paths)
        await this.runGenerateStep(imageTag, paths)
        await this.runFundStep(imageTag, paths)
        postprocessResult = this.postprocessBridgeInit(paths)
        break
      }

      case '1-prepare': {
        await this.runPrepareStep(imageTag, paths)
        break
      }

      case '2-setup': {
        await this.runSetupStep(imageTag, paths)
        postprocessResult = this.postprocessBridgeInit(paths)
        break
      }

      case '3-generate': {
        await this.runGenerateStep(imageTag, paths)
        break
      }

      case '4-fund': {
        await this.runFundStep(imageTag, paths)
        postprocessResult = this.postprocessBridgeInit(paths)
        break
      }
    }

    // JSON success output
    this.jsonCtx.success({
      confirmedBlockHash: postprocessResult.confirmedBlockHash,
      confirmedBlockHeight: postprocessResult.confirmedBlockHeight,
      genesisJsonPath: paths.genesisJsonPath,
      imageTag,
      outputFiles: postprocessResult.outputFiles,
      protocolContextPath: paths.protocolContextPath,
      protocolContextYamlPath: paths.protocolContextYamlPath,
      protocolSeedPath: paths.protocolSeedPath,
      seed,
      setupDefaultsPath: paths.setupDefaultsPath,
      step,
      withdrawalProcessorSecretPath: paths.withdrawalProcessorSecretPath,
    })
  }

  async runDockerCommand(imageTag: string, command: string[]): Promise<void> {
    const docker = new Docker();
    const image = `docker.io/dogeos69/generate-test-keys:${imageTag}`;
    try {
      try {
        await docker.getImage(image).inspect()
        this.jsonCtx.info(`Docker image found locally, skipping pull: ${image}`)
      } catch (inspectError: any) {
        const statusCode = inspectError?.statusCode
        if (statusCode && statusCode !== 404) {
          throw inspectError
        }

        this.jsonCtx.info(`Docker image not found locally. Pulling Docker Image: ${image}`)
        const pullStream = await docker.pull(image)
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(pullStream, (err, res) => {
            if (err) {
              reject(err)
            } else {
              this.jsonCtx.info('Image pulled successfully')
              resolve(res)
            }
          })
        })
      }

      this.jsonCtx.info('Creating Docker Container...')
      // Create and run the container
      const container = await docker.createContainer({
        Cmd: command,
        HostConfig: {
          Binds: [`${process.cwd()}:/app`],
        },
        Image: image,
        WorkingDir: '/app',
      })

      this.jsonCtx.info('Starting Container')
      await container.start()

      // Wait for the container to finish and get the logs
      const stream = await container.logs({
        follow: true,
        stderr: true,
        stdout: true,
      })

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
        // Clean up stream to prevent process hang
        stream.unpipe(logTarget)
        if ('destroy' in stream && typeof stream.destroy === 'function') {
          stream.destroy()
        }

        // Remove container (suppress 404/409 if already removed or in use)
        try {
          await container.remove()
        } catch (removeError: any) {
          const statusCode = removeError?.statusCode
          if (statusCode !== 404 && statusCode !== 409) {
            this.jsonCtx.addWarning(`Failed to remove container: ${removeError}`)
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
      const { agent } = docker.modem as any
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy()
      }
    }
  }

  private assertAttestationPubkeysReady(setupDefaultsPath: string): void {
    this.assertFileExists(
      setupDefaultsPath,
      'E103_DOGE_CONFIG_MISSING',
      'Run `scrollsdk setup doge-config`, then `scrollsdk setup cubesigner-init` first.'
    )

    const setupDefaults = toml.parse(fs.readFileSync(setupDefaultsPath, 'utf8')) as any
    const attestationPubkeys = setupDefaults.attestation_pubkeys
    const attestationKeyCount = Number(setupDefaults.attestation_key_count)
    const attestationThreshold = Number(setupDefaults.attestation_threshold)

    if (!Array.isArray(attestationPubkeys) || attestationPubkeys.length === 0) {
      this.jsonCtx.error(
        'E103_CUBESIGNER_PUBKEYS_MISSING',
        'CubeSigner attestation public keys are missing from .data/setup_defaults.toml. Run `scrollsdk setup cubesigner-init` before `scrollsdk setup bridge-init`.',
        'CONFIGURATION',
        true,
        { path: setupDefaultsPath }
      )
    }

    const invalidPubkey = attestationPubkeys.find((pubkey: unknown) =>
      typeof pubkey !== 'string' || !isValidSecp256k1PublicKey(pubkey)
    )
    if (invalidPubkey) {
      this.jsonCtx.error(
        'E602_INVALID_CUBESIGNER_PUBKEY',
        'attestation_pubkeys must contain secp256k1 public keys encoded as compressed 33-byte hex or uncompressed 65-byte hex.',
        'CONFIGURATION',
        true,
        { invalidPubkey, path: setupDefaultsPath }
      )
    }

    if (!Number.isInteger(attestationKeyCount) || attestationKeyCount !== attestationPubkeys.length) {
      this.jsonCtx.error(
        'E602_INVALID_CUBESIGNER_PUBKEYS',
        `attestation_key_count (${setupDefaults.attestation_key_count}) must match attestation_pubkeys length (${attestationPubkeys.length}). Run \`scrollsdk setup cubesigner-init\` again.`,
        'CONFIGURATION',
        true,
        {
          attestationKeyCount: setupDefaults.attestation_key_count,
          pubkeyCount: attestationPubkeys.length,
        }
      )
    }

    if (
      !Number.isInteger(attestationThreshold) ||
      attestationThreshold < 1 ||
      attestationThreshold > attestationPubkeys.length
    ) {
      this.jsonCtx.error(
        'E602_INVALID_CUBESIGNER_THRESHOLD',
        `attestation_threshold must be between 1 and ${attestationPubkeys.length}. Run \`scrollsdk setup cubesigner-init\` again.`,
        'CONFIGURATION',
        true,
        {
          attestationThreshold: setupDefaults.attestation_threshold,
          pubkeyCount: attestationPubkeys.length,
        }
      )
    }
  }

  private assertFileExists(filePath: string, code: string, hint: string): void {
    if (fs.existsSync(filePath)) {
      return
    }

    this.jsonCtx.error(
      code,
      `Required file does not exist: ${filePath}. ${hint}`,
      'CONFIGURATION',
      true,
      { path: filePath }
    )
  }

  private copyGenesisYamlToData(dataDir: string): string {
    const genesisYamlPath = path.join(process.cwd(), 'values', 'genesis.yaml')
    const genesisJsonPath = path.join(dataDir, 'genesis.json')

    if (!fs.existsSync(genesisYamlPath)) {
      this.jsonCtx.error(
        'E103_GENESIS_CONFIG_MISSING',
        `genesis.yaml not found at: ${genesisYamlPath}. Run \`scrollsdk setup gen-l2-artifacts\` before \`scrollsdk setup bridge-init\`.`,
        'CONFIGURATION',
        true,
        { path: genesisYamlPath }
      )
    }

    try {
      const genesisYamlContent = fs.readFileSync(genesisYamlPath, 'utf8')
      const parsedGenesisYaml = yaml.load(genesisYamlContent) as any

      if (!parsedGenesisYaml || parsedGenesisYaml.scrollConfig === undefined) {
        this.jsonCtx.error(
          'E602_INVALID_GENESIS_CONFIG',
          'values/genesis.yaml must contain scrollConfig',
          'CONFIGURATION',
          true,
          { path: genesisYamlPath }
        )
      }

      let genesisJson: any
      if (typeof parsedGenesisYaml.scrollConfig === 'string') {
        genesisJson = JSON.parse(parsedGenesisYaml.scrollConfig)
      } else if (typeof parsedGenesisYaml.scrollConfig === 'object' && parsedGenesisYaml.scrollConfig !== null) {
        genesisJson = parsedGenesisYaml.scrollConfig
      } else {
        this.jsonCtx.error(
          'E602_INVALID_GENESIS_CONFIG',
          'values/genesis.yaml scrollConfig must be a JSON string or object',
          'CONFIGURATION',
          true,
          { path: genesisYamlPath, type: typeof parsedGenesisYaml.scrollConfig }
        )
      }

      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(genesisJsonPath, JSON.stringify(genesisJson, null, 2))
      this.jsonCtx.info(`Extracted values/genesis.yaml scrollConfig to ${genesisJsonPath}`)
      return genesisJsonPath
    } catch (error) {
      if (error instanceof CliExitError) throw error

      this.jsonCtx.error(
        'E602_INVALID_GENESIS_CONFIG',
        `Failed to extract genesis.json from values/genesis.yaml: ${error}`,
        'CONFIGURATION',
        true,
        { error: String(error), path: genesisYamlPath }
      )
    }
  }

  private escapeEnvValue(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  }

  private async fetchDockerTags(): Promise<string[]> {
    try {
      const response = await fetch(
        'https://registry.hub.docker.com/v2/repositories/dogeos69/generate-test-keys/tags?page_size=100',
      )
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      return data.results.map((tag: any) => tag.name)
    } catch (error) {
      this.jsonCtx.error(
        'E400_DOCKER_TAG_FETCH_FAILED',
        `Failed to fetch Docker tags: ${error}`,
        'DOCKER',
        true,
        { error: String(error) }
      )
    }
  }

  private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
    const defaultTag = 'latest'

    if (!providedTag) {
      return defaultTag
    }

    const tags = await this.fetchDockerTags()

    if (tags.includes(providedTag)) {
      return providedTag
    }

    if (providedTag.startsWith('v') && tags.includes(providedTag)) {
      return providedTag
    }

    if (/^\d+\.\d+\.\d+(-test)?$/.test(providedTag) && tags.includes(`v${providedTag}`)) {
      return `v${providedTag}`
    }

    // In non-interactive mode, fail if provided tag isn't valid
    if (this.nonInteractive) {
      this.jsonCtx.error(
        'E400_INVALID_DOCKER_TAG',
        `Docker image tag "${providedTag}" not found. Available tags include: ${tags.slice(0, 5).join(', ')}...`,
        'DOCKER',
        true,
        { availableTags: tags, providedTag }
      )
    }

    const selectedTag = await select({
      choices: tags.map((tag) => ({ name: tag, value: tag })),
      message: 'Select a Docker image tag:',
    })

    return selectedTag
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
  }

  private getRequiredContractAddress(contractsConfig: any, contractName: string, contractsPath: string): string {
    const value = contractsConfig[contractName]

    if (typeof value !== 'string' || value.trim() === '') {
      this.jsonCtx.error(
        'E602_INVALID_CONTRACTS_CONFIG',
        `${contractName} is missing or empty in ${contractsPath}`,
        'CONFIGURATION',
        true,
        { contractName, path: contractsPath }
      )
    }

    if (!/^0x[\dA-Fa-f]{40}$/.test(value)) {
      this.jsonCtx.error(
        'E602_INVALID_CONTRACTS_CONFIG',
        `${contractName} must be a 20-byte EVM address in ${contractsPath}`,
        'CONFIGURATION',
        true,
        { contractName, path: contractsPath, value }
      )
    }

    return value
  }

  private getRequiredDogeConfig(dataDir: string, network: string): { config: any; path: string } {
    const configPaths = [
      path.join(dataDir, `doge-config-${network}.toml`),
      path.join(dataDir, 'doge-config.toml'),
    ]

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        return {
          config: toml.parse(fs.readFileSync(configPath, 'utf8')),
          path: configPath,
        }
      }
    }

    this.jsonCtx.error(
      'E101_CONFIG_NOT_FOUND',
      `Doge config not found. Expected one of: ${configPaths.join(', ')}`,
      'CONFIGURATION',
      true,
      { paths: configPaths }
    )
  }

  private getRequiredNumberValue(source: any, key: string, sourcePath: string): number {
    const value = source?.[key]

    if (typeof value === 'number' && Number.isInteger(value)) {
      return value
    }

    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return Number(value)
    }

    this.jsonCtx.error(
      'E602_INVALID_CONFIG_VALUE',
      `${key} must be an integer in ${sourcePath}`,
      'CONFIGURATION',
      true,
      { key, path: sourcePath, value }
    )
  }

  private getRequiredStringValue(source: any, key: string, sourcePath: string): string {
    const value = source[key]

    if (typeof value !== 'string' || value.trim() === '') {
      this.jsonCtx.error(
        'E602_INVALID_WITHDRAWAL_PROCESSOR_OUTPUT',
        `${key} is missing or empty in ${sourcePath}`,
        'CONFIGURATION',
        true,
        { key, path: sourcePath }
      )
    }

    return value
  }

  private getRequiredTomlConfig(configPath: string): any {
    if (!fs.existsSync(configPath)) {
      this.jsonCtx.error(
        'E101_CONFIG_NOT_FOUND',
        `config.toml not found at: ${configPath}`,
        'CONFIGURATION',
        true,
        { path: configPath }
      )
    }

    return toml.parse(fs.readFileSync(configPath, 'utf8'))
  }

  private materializeProtocolContextYaml(paths: BridgeInitPaths): void {
    this.assertFileExists(
      paths.protocolContextPath,
      'E103_PROTOCOL_CONTEXT_MISSING',
        'Run `scrollsdk setup bridge-init --step 3-generate` first.'
    )

    const protocolContextJson = fs.readFileSync(paths.protocolContextPath, 'utf8').trimEnd()
    const indentedProtocolContext = protocolContextJson
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')

    fs.mkdirSync(paths.valuesDir, { recursive: true })
    fs.writeFileSync(
      paths.protocolContextYamlPath,
      `protocolContext: |\n${indentedProtocolContext}\n`
    )
    this.jsonCtx.info(`Wrote ${paths.protocolContextYamlPath} from ${paths.protocolContextPath}`)
  }

  private materializeWithdrawalProcessorSecrets(paths: BridgeInitPaths): void {
    this.assertFileExists(
      paths.withdrawalProcessorTomlPath,
      'E103_WITHDRAWAL_PROCESSOR_OUTPUT_MISSING',
        'Run `scrollsdk setup bridge-init --step 2-setup` first.'
    )

    const withdrawalProcessorToml = toml.parse(fs.readFileSync(paths.withdrawalProcessorTomlPath, 'utf8')) as any
    const feeSignerKey = this.getRequiredStringValue(
      withdrawalProcessorToml,
      'fee_signer_key',
      paths.withdrawalProcessorTomlPath
    )
    const sequencerSignerKey = this.getRequiredStringValue(
      withdrawalProcessorToml,
      'sequencer_signer_key',
      paths.withdrawalProcessorTomlPath
    )

    fs.mkdirSync(path.dirname(paths.withdrawalProcessorSecretPath), { recursive: true })
    const existingContent = fs.existsSync(paths.withdrawalProcessorSecretPath)
      ? fs.readFileSync(paths.withdrawalProcessorSecretPath, 'utf8')
      : ''
    const nextContent = this.upsertEnvValues(existingContent, {
      DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY: feeSignerKey,
      DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY: sequencerSignerKey,
    })
    fs.writeFileSync(paths.withdrawalProcessorSecretPath, nextContent)
    this.jsonCtx.info(`Updated withdrawal processor signer keys in ${paths.withdrawalProcessorSecretPath}`)
  }

  private moveLegacyOutputFiles(dataDir: string): string[] {
    const outputFiles = [
      'output-withdrawal-processor.toml',
      'output-dummy-signer-keys.json',
      'output-test-data.json',
    ]

    fs.mkdirSync(dataDir, { recursive: true })

    const outputPaths: string[] = []
    for (const fileName of outputFiles) {
      const sourceFile = path.join(process.cwd(), fileName)
      const targetFile = path.join(dataDir, fileName)

      if (fs.existsSync(sourceFile)) {
        fs.renameSync(sourceFile, targetFile)
        this.jsonCtx.info(`Moved ${fileName} to .data directory`)
      }

      if (fs.existsSync(targetFile)) {
        outputPaths.push(targetFile)
      }
    }

    return outputPaths
  }

  private normalizeCelestiaNamespace(namespace: string, sourcePath: string): string {
    const cleanNamespace = namespace.replace(/^0x/i, '').replaceAll(/\s+/g, '').toLowerCase()

    if (!/^[\da-f]+$/.test(cleanNamespace) || cleanNamespace.length % 2 !== 0) {
      this.jsonCtx.error(
        'E602_INVALID_CONFIG_VALUE',
        `daNamespace must be an even-length hex string in ${sourcePath}`,
        'CONFIGURATION',
        true,
        { namespace, path: sourcePath }
      )
    }

    const byteLength = cleanNamespace.length / 2
    if (byteLength < 2 || byteLength > 28) {
      this.jsonCtx.error(
        'E602_INVALID_CONFIG_VALUE',
        `daNamespace must be between 2 and 28 bytes in ${sourcePath}`,
        'CONFIGURATION',
        true,
        { namespace, path: sourcePath }
      )
    }

    return `0x${cleanNamespace.padStart(56, '0')}`
  }

  private normalizeStep(step: string | undefined): BridgeInitStep {
    switch (step) {
      case undefined:
      case '':
      case 'all': {
        return 'all'
      }

      case '1':
      case '1-prepare': {
        return '1-prepare'
      }

      case '2':
      case '2-setup': {
        return '2-setup'
      }

      case '3':
      case '3-generate': {
        return '3-generate'
      }

      case '4':
      case '4-fund': {
        return '4-fund'
      }

      default: {
        this.jsonCtx.error(
          'E602_INVALID_BRIDGE_INIT_STEP',
          `Invalid --step "${step}". Expected all, 1-prepare, 2-setup, 3-generate, 4-fund, or numeric aliases 1, 2, 3, 4.`,
          'VALIDATION',
          true,
          { step }
        )
      }
    }
  }

  private postprocessBridgeInit(paths: BridgeInitPaths): BridgeInitPostprocessResult {
    const outputFiles = this.moveLegacyOutputFiles(paths.dataDir)
    let confirmedBlockHeight: number | undefined
    let confirmedBlockHash: string | undefined
    const testDataPath = path.join(paths.dataDir, 'output-test-data.json')

    if (fs.existsSync(testDataPath)) {
      let testData: any
      try {
        testData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'))
      } catch (parseError) {
        this.jsonCtx.addWarning(`Failed to parse output-test-data.json: ${parseError}. dogecoinIndexerStartHeight was NOT updated.`)
        testData = null
      }

      if (testData) {
        confirmedBlockHeight = testData.confirmed_block_height
        confirmedBlockHash = testData.confirmed_block_hash

        if (confirmedBlockHeight && confirmedBlockHeight > 0) {
          this.jsonCtx.info(`Bridge transactions confirmed at block height: ${confirmedBlockHeight}`)
          this.updateDogeConfigBlockHeight(paths.setupDefaultsPath, paths.dataDir, confirmedBlockHeight)
        }
      }
    }

    return {
      confirmedBlockHash,
      confirmedBlockHeight,
      outputFiles,
    }
  }

  private async prepareBridgeInit(seed: string | undefined, paths: BridgeInitPaths): Promise<string> {
    // Read existing seed from setup_defaults.toml
    if (!fs.existsSync(paths.setupDefaultsPath)) {
      this.jsonCtx.error(
        'E103_DOGE_CONFIG_MISSING',
        'setup_defaults.toml not found, please run `scrollsdk setup doge-config` first',
        'CONFIGURATION',
        true,
        { path: paths.setupDefaultsPath }
      )
    }

    const existingConfigStr = fs.readFileSync(paths.setupDefaultsPath, 'utf8')
    const existingConfig = toml.parse(existingConfigStr) as any
    const existingSeed = existingConfig.seed_string || ''
    const network = existingConfig.network || 'testnet'

    if (!seed) {
      seed = await input({
        default: existingSeed,
        message: 'Enter the seed string',
      })
    }

    const configPath = path.join(process.cwd(), 'config.toml')
    let configData: any
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8')
      configData = toml.parse(configContent)
    } else {
      this.jsonCtx.addWarning('config.toml not found. Some values may not be populated correctly.')
    }

    const newConfig = toml.parse(existingConfigStr) as any
    newConfig.seed_string = seed
    newConfig.deposit_eth_recipient_address_hex = this.getNestedValue(configData, 'accounts.DEPLOYER_ADDR')
    fs.writeFileSync(paths.setupDefaultsPath, toml.stringify(newConfig))

    this.jsonCtx.info(`Updating protocol seed for Dogecoin network ${network}`)
    this.updateProtocolSeed(paths.dataDir, network, configPath)
    this.updateGenerateBridgeInfoNetwork(paths.generateBridgeInfoPath, network, false)

    // copy ./values/genesis.yaml to .data/genesis.json, cause bridge init need genesis.json now
    this.copyGenesisYamlToData(paths.dataDir)
    this.assertAttestationPubkeysReady(paths.setupDefaultsPath)

    return seed
  }

  private resolveDogecoinChainId(network: string): number {
    switch (network) {
      case 'doge':
      case 'dogecoin':
      case 'mainnet': {
        return 1
      }

      case 'dogeTestnet':
      case 'testnet': {
        return 111_111
      }

      case 'dogeRegtest':
      case 'regtest': {
        return 5_555_555
      }

      default: {
        this.jsonCtx.error(
          'E602_INVALID_DOGE_NETWORK',
          `Unsupported Dogecoin network "${network}". Expected mainnet/dogecoin/doge, testnet/dogeTestnet, or regtest/dogeRegtest.`,
          'CONFIGURATION',
          true,
          { network }
        )
      }
    }
  }

  private async runFundStep(imageTag: string, paths: BridgeInitPaths): Promise<void> {
    this.assertFileExists(
      paths.setupDefaultsPath,
      'E103_DOGE_CONFIG_MISSING',
      'Run `scrollsdk setup bridge-init --step 1-prepare` first.'
    )
    this.assertFileExists(
      path.join(paths.dataDir, 'bridge.json'),
      'E103_BRIDGE_JSON_MISSING',
      'Run `scrollsdk setup bridge-init --step 3-generate` first.'
    )

    this.warnNonIdempotentStep(
      '4-fund',
      'This step is NOT idempotent. It consumes funding UTXOs and broadcasts 10 bridge funding transactions.'
    )

    this.jsonCtx.info('Running step 4-fund: broadcast 10 initial bridge funding transactions')
    await this.runDockerCommand(imageTag, [
      'generate_test_keys',
      'fund-bridge',
      '--config',
      '.data/setup_defaults.toml',
      '--output-dir',
      '.data',
      '--bridge-json',
      '.data/bridge.json',
    ])
    this.moveLegacyOutputFiles(paths.dataDir)
  }

  private async runGenerateStep(imageTag: string, paths: BridgeInitPaths): Promise<void> {
    this.assertFileExists(
      path.join(paths.dataDir, 'output-withdrawal-processor.toml'),
      'E103_BRIDGE_SETUP_OUTPUT_MISSING',
      'Run `scrollsdk setup bridge-init --step 2-setup` first.'
    )
    this.assertFileExists(
      path.join(paths.dataDir, 'output-test-data.json'),
      'E103_BRIDGE_SETUP_OUTPUT_MISSING',
      'Run `scrollsdk setup bridge-init --step 2-setup` first.'
    )
    this.assertFileExists(
      path.join(paths.dataDir, 'GenerateBridgeInfo.toml'),
      'E103_BRIDGE_SETUP_OUTPUT_MISSING',
      'Run `scrollsdk setup bridge-init --step 2-setup` first.'
    )
    this.assertFileExists(
      paths.protocolSeedPath,
      'E103_PROTOCOL_SEED_MISSING',
      'Run `scrollsdk setup bridge-init --step 1-prepare` first.'
    )
    this.assertFileExists(
      paths.setupDefaultsPath,
      'E103_DOGE_CONFIG_MISSING',
      'Run `scrollsdk setup bridge-init --step 1-prepare` first.'
    )

    const setupDefaults = toml.parse(fs.readFileSync(paths.setupDefaultsPath, 'utf8')) as any
    this.updateProtocolSeed(paths.dataDir, setupDefaults.network || 'testnet', path.join(process.cwd(), 'config.toml'))

    this.jsonCtx.info('Running step 3-generate: generate namespace, bridge.json, and protocol_context.json')

    await this.runDockerCommand(imageTag, [
      'compute-bridge-namespace-cli',
      '--withdrawal-processor-toml',
      '.data/output-withdrawal-processor.toml',
      '--write-back',
      '.data/GenerateBridgeInfo.toml',
      '--format',
      'hex',
    ])
    await this.runDockerCommand(imageTag, [
      'generate-bridge-info-cli',
      '--config-file',
      '.data/GenerateBridgeInfo.toml',
      '--output-file',
      '.data/bridge.json',
    ])
    await this.runDockerCommand(imageTag, [
      'generate_protocol_context',
      '--bridge-info',
      '.data/output-withdrawal-processor.toml',
      '--test-data',
      '.data/output-test-data.json',
      '--protocol-seed',
      '.data/protocol_seed.toml',
      '--bridge-json',
      '.data/bridge.json',
      '--output',
      '.data/protocol_context.json',
    ])
    this.materializeProtocolContextYaml(paths)
  }

  private async runPrepareStep(imageTag: string, paths: BridgeInitPaths): Promise<void> {
    this.assertFileExists(
      paths.genesisJsonPath,
      'E103_GENESIS_CONFIG_MISSING',
      'Run `scrollsdk setup gen-l2-artifacts`, then `scrollsdk setup bridge-init --step 1-prepare`.'
    )
    this.assertFileExists(
      paths.protocolSeedPath,
      'E103_PROTOCOL_SEED_MISSING',
      'Run `scrollsdk setup bridge-init --step 1-prepare` to create .data/protocol_seed.toml.'
    )

    this.jsonCtx.info('Running step 1-prepare: genesis.json -> protocol_seed.toml')
    await this.runDockerCommand(imageTag, [
      'update_protocol_seed_from_genesis',
      '--genesis-json',
      '.data/genesis.json',
      '--protocol-seed',
      '.data/protocol_seed.toml',
    ])

    const setupDefaults = toml.parse(fs.readFileSync(paths.setupDefaultsPath, 'utf8')) as any
    this.updateProtocolSeed(paths.dataDir, setupDefaults.network || 'testnet', path.join(process.cwd(), 'config.toml'))
  }

  private async runSetupStep(imageTag: string, paths: BridgeInitPaths): Promise<void> {
    this.assertFileExists(
      paths.setupDefaultsPath,
      'E103_DOGE_CONFIG_MISSING',
      'Run `scrollsdk setup bridge-init --step 1-prepare` first.'
    )

    this.warnNonIdempotentStep(
      '2-setup',
      'This step is NOT idempotent. It consumes funding UTXOs and broadcasts the setup transaction.'
    )

    this.jsonCtx.info('Running step 2-setup: generate test keys and broadcast setup transaction')
    await this.runDockerCommand(imageTag, [
      'generate_test_keys',
      'setup',
      '--config',
      '.data/setup_defaults.toml',
      '--output-dir',
      '.data',
    ])
    this.moveLegacyOutputFiles(paths.dataDir)
    const setupDefaults = toml.parse(fs.readFileSync(paths.setupDefaultsPath, 'utf8')) as any
    this.updateGenerateBridgeInfoNetwork(paths.generateBridgeInfoPath, setupDefaults.network || 'testnet', true)
    this.materializeWithdrawalProcessorSecrets(paths)
  }

  /**
   * Update dogecoinIndexerStartHeight in the appropriate doge-config file.
   * Tries network-specific config first, then falls back to generic config.
   */
  private updateDogeConfigBlockHeight(
    setupDefaultsPath: string,
    dataDir: string,
    blockHeight: number
  ): void {
    try {
      const setupDefaults = toml.parse(fs.readFileSync(setupDefaultsPath, 'utf8'))
      const network = (setupDefaults as any).network || 'testnet'

      const configPaths = [
        path.join(dataDir, `doge-config-${network}.toml`),
        path.join(dataDir, 'doge-config.toml'),
      ]

      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          let content = fs.readFileSync(configPath, 'utf8')
          content = content.replace(
            /dogecoinIndexerStartHeight\s*=\s*["']?\d*["']?/,
            `dogecoinIndexerStartHeight = "${blockHeight}"`
          )
          fs.writeFileSync(configPath, content)
          this.jsonCtx.info(`Updated ${configPath} with dogecoinIndexerStartHeight = ${blockHeight}`)
          return
        }
      }
    } catch (configError) {
      this.jsonCtx.addWarning(`Failed to update doge-config with block height: ${configError}`)
    }
  }

  private updateGenerateBridgeInfoNetwork(generateBridgeInfoPath: string, network: string, required: boolean): void {
    if (!fs.existsSync(generateBridgeInfoPath)) {
      if (required) {
        this.jsonCtx.error(
          'E103_GENERATE_BRIDGE_INFO_MISSING',
          `GenerateBridgeInfo.toml not found at: ${generateBridgeInfoPath}`,
          'CONFIGURATION',
          true,
          { path: generateBridgeInfoPath }
        )
      }

      return
    }

    const bridgeInfoConfig = toml.parse(fs.readFileSync(generateBridgeInfoPath, 'utf8')) as any
    if (bridgeInfoConfig.default && typeof bridgeInfoConfig.default === 'object') {
      bridgeInfoConfig.default.network = network
    } else {
      bridgeInfoConfig.network = network
    }

    fs.writeFileSync(generateBridgeInfoPath, toml.stringify(bridgeInfoConfig))
    this.jsonCtx.info(`Updated ${generateBridgeInfoPath} with network = ${network}`)
  }

  private updateProtocolSeed(dataDir: string, network: string, configPath: string): string {
    const configToml = this.getRequiredTomlConfig(configPath)
    const { config: dogeConfig, path: dogeConfigPath } = this.getRequiredDogeConfig(dataDir, network)
    const contractsPath = path.join(process.cwd(), 'config-contracts.toml')
    const contractsConfig = this.getRequiredTomlConfig(contractsPath)

    fs.mkdirSync(dataDir, { recursive: true })
    const protocolSeedPath = path.join(dataDir, 'protocol_seed.toml')

    let protocolSeedConfig: any = {}
    if (fs.existsSync(protocolSeedPath)) {
      protocolSeedConfig = toml.parse(fs.readFileSync(protocolSeedPath, 'utf8'))
    }

    const dogecoinChainId = this.resolveDogecoinChainId(network)
    const l2ChainId = this.getRequiredNumberValue(configToml?.general, 'CHAIN_ID_L2', configPath)
    const celestiaNamespace = this.normalizeCelestiaNamespace(
      this.getRequiredStringValue(dogeConfig?.da, 'daNamespace', dogeConfigPath),
      dogeConfigPath
    )
    protocolSeedConfig.protocol ??= {}
    protocolSeedConfig.protocol.dogecoin_chain_id = dogecoinChainId
    protocolSeedConfig.protocol.l2_chain_id = l2ChainId
    protocolSeedConfig.protocol.celestia_namespace = celestiaNamespace
    protocolSeedConfig.protocol_config_seed ??= {}
    protocolSeedConfig.protocol_config_seed.protocol_config ??= {}
    const protocolConfig = protocolSeedConfig.protocol_config_seed.protocol_config
    protocolConfig.l2_chain_id = l2ChainId
    protocolConfig.celestia_namespace = celestiaNamespace
    protocolConfig.deposit_queue_transform ??= {}
    protocolConfig.deposit_queue_transform.l1_scroll_messenger_address = this.getRequiredContractAddress(
      contractsConfig,
      'L1_SCROLL_MESSENGER_PROXY_ADDR',
      contractsPath
    ).toLowerCase()
    protocolConfig.deposit_queue_transform.l2_messenger_address = this.getRequiredContractAddress(
      contractsConfig,
      'L2_DOGEOS_MESSENGER_PROXY_ADDR',
      contractsPath
    ).toLowerCase()
    protocolConfig.deposit_queue_transform.moat_address = this.getRequiredContractAddress(
      contractsConfig,
      'L2_MOAT_PROXY_ADDR',
      contractsPath
    ).toLowerCase()
    protocolConfig.deposit_queue_transform.message_queue_gas_limit = this.getRequiredNumberValue(
      configToml?.rollup,
      'MAX_L1_MESSAGE_GAS_LIMIT',
      configPath
    )

    fs.writeFileSync(protocolSeedPath, toml.stringify(protocolSeedConfig))
    this.jsonCtx.info(`Updated ${protocolSeedPath} for Dogecoin network ${network}`)
    return protocolSeedPath
  }

  private upsertEnvValues(existingContent: string, values: Record<string, string>): string {
    const pending = new Map(Object.entries(values))
    const lines = existingContent.split(/\r?\n/)
    const updatedLines: string[] = []

    for (const line of lines) {
      if (line === '' && updatedLines.length === lines.length - 1) {
        continue
      }

      const match = /^([A-Z_a-z]\w*)=/.exec(line)
      if (match && pending.has(match[1])) {
        updatedLines.push(`${match[1]}="${this.escapeEnvValue(pending.get(match[1]) || '')}"`)
        pending.delete(match[1])
      } else {
        updatedLines.push(line)
      }
    }

    for (const [key, value] of pending) {
      updatedLines.push(`${key}="${this.escapeEnvValue(value)}"`)
    }

    return `${updatedLines.join('\n').replace(/\n*$/, '')}\n`
  }

  private warnNonIdempotentStep(step: BridgeInitStep, message: string): void {
    this.jsonCtx.addWarning(`${step}: ${message}`)
  }
}
export default BridgeInitCommand
