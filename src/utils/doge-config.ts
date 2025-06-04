import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'

import { DogeConfig, Network } from '../types/doge-config.js'

/**
 * Select and return the path to a doge config file
 * @param providedConfigPath - Optional config path provided by user
 * @param suggestedCommand - Command to suggest if no config files are found
 * @returns Resolved path to the config file
 */
export async function selectDogeConfigFile(
  providedConfigPath?: string,
  suggestedCommand: string = 'scrollsdk doge:config'
): Promise<string> {
  // If user provided a specific config path, use it directly
  if (providedConfigPath) {
    return path.resolve(providedConfigPath)
  }

  // Check if .data directory exists
  if (!fs.existsSync('.data')) {
    throw new Error(
      chalk.red(`No .data directory found. Please run "${suggestedCommand}" first to create the configuration.`)
    )
  }

  // Look for .toml config files in .data directory
  const files = fs.readdirSync('.data')
  const configFiles = files.filter(file => file.endsWith('.toml'))
  
  if (configFiles.length === 0) {
    throw new Error(
      chalk.red(`No .toml config files found in .data directory. Please run "${suggestedCommand}" first to create the configuration.`)
    )
  }
  
  // If only one config file, use it automatically
  if (configFiles.length === 1) {
    const selectedFile = path.resolve('.data/' + configFiles[0])
    console.log(chalk.blue(`Using config file: ${selectedFile}`))
    return selectedFile
  }
  
  // Multiple config files found, let user choose
  const configFileChoices = configFiles.map(file => ({ name: file, value: file }))
  const fileSelection = await select({
    choices: configFileChoices,
    message: 'Select config file to use:',
  })
  
  return path.resolve('.data/' + fileSelection)
}

/**
 * Load doge config with automatic file selection
 * @param providedConfigPath - Optional config path provided by user
 * @param suggestedCommand - Command to suggest if no config files are found
 * @returns Loaded DogeConfig and the path used
 */
export async function loadDogeConfigWithSelection(
  providedConfigPath?: string,
  suggestedCommand: string = 'scrollsdk doge:config'
): Promise<{ config: DogeConfig; configPath: string }> {
  const configPath = await selectDogeConfigFile(providedConfigPath, suggestedCommand)
  const config = await loadDogeConfig(configPath)
  return { config, configPath }
}

export async function loadDogeConfig(configPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

  if (!fs.existsSync(resolvedPath)) {
    const shouldCreate = await confirm({
      default: true,
      message: `Config file not found at ${resolvedPath}. Would you like to create a default one now?`,
    })

    if (!shouldCreate) {
      throw new Error(`Config file not found at ${resolvedPath}, and not created.`)
    }

    console.log('Creating a new default Dogecoin configuration file...')

    const network = (await select({
      choices: [
        { name: 'mainnet', value: 'mainnet' as const },
        { name: 'testnet', value: 'testnet' as const },
      ],
      default: 'mainnet',
      message: 'Select network for the new default config:',
    })) as Network

    const apiKey = await input({
      message: 'Enter your NowNodes API key (get one at nownodes.io - required for network operations):',
      validate: (value) => (value ? true : 'API key is required'),
    })


    const defaultConfig: DogeConfig = {
      defaults: {
        dogecoinIndexerStartHeight: '4000000',
      },
      frontend: {},
      network,
      rpc: {
        username: '',
        password: '',
        apiKey,
        blockbookAPIUrl:
          network === 'mainnet' ? 'https://dogebook.nownodes.io/api/v2' : 'https://dogebook-testnet.nownodes.io/api/v2',
        url: network === 'mainnet' ? '' : 'https://testnet.doge.xyz/',
      },
      dogecoinClusterRpc: {
        username: "",
        password: "",
      },
      test: {},
      wallet: {
        path: network === 'mainnet' ? '.data/doge-wallet-mainnet.json' : '.data/doge-wallet-testnet.json',
      },
      da: {
        celestiaIndexerStartBlock: network === 'mainnet' ? '0' : '6175746',
        //rpcUrl: network === 'mainnet' ? 'http://celestia-mainnet:26658' : 'http://celestia-testnet-mocha:26658',
        tendermintRpcUrl: '',
        daNamespace: network === 'mainnet' ? '' : 'D06305735700',
        signerAddress: network === 'mainnet' ? '' : 'celestia1y2yeln5dt4chaezx59fyjm477gw5x4vl6du6u7',
        genesisBlobCommitment: network === 'mainnet' ? '' : 'VTYXiL6DKEhFBGB7kXORCC8uNu/UOR20mUyzMICmnkk=',
        celestiaMnemonic: '',
      }
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(defaultConfig as any))
    console.log(
      `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk doge:config'.`,
    )
    return defaultConfig
  }

  try {
    const configContent = fs.readFileSync(resolvedPath, 'utf8')
    const parsedConfig = toml.parse(configContent) as unknown as DogeConfig

    if (!parsedConfig.network || (parsedConfig.network !== 'mainnet' && parsedConfig.network !== 'testnet')) {
      throw new Error(
        `Config file ${resolvedPath} has an invalid 'network' value: ${parsedConfig.network}. Must be 'mainnet' or 'testnet'.`,
      )
    }

    if (!parsedConfig.wallet || !parsedConfig.wallet.path) {
      throw new Error(`Config file ${resolvedPath} is missing 'wallet.path'.`)
    }

    if (!parsedConfig.rpc || !parsedConfig.rpc.blockbookAPIUrl) {
      throw new Error(`Config file ${resolvedPath} is missing 'rpc.blockbookAPIUrl'. Run 'doge:config' to set it.`)
    }

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk doge:config' to regenerate it.`,
    )
  }
}
