import * as toml from '@iarna/toml'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { DogeConfig, Network } from '../types/doge-config.js'

const NETWORK_ALIASES: Record<string, Network> = {
  doge: 'mainnet',
  dogeRegtest: 'regtest',
  dogeTestnet: 'testnet',
  dogecoin: 'mainnet',
  mainnet: 'mainnet',
  regtest: 'regtest',
  testnet: 'testnet',
}

export function normalizeDogeNetwork(network: unknown): Network | undefined {
  return typeof network === 'string' ? NETWORK_ALIASES[network] : undefined
}

/**
 * Select and return the path to a doge config file
 * @param providedConfigPath - Optional config path provided by user
 * @param suggestedCommand - Command to suggest if no config files are found
 * @returns Resolved path to the config file
 */
export async function selectDogeConfigFile(
  providedConfigPath?: string,
  suggestedCommand: string = 'scrollsdk setup doge-config'
): Promise<string> {
  // If user provided a specific config path, use it directly
  if (providedConfigPath) {
    return path.resolve(providedConfigPath)
  }

  const defaultConfigPath = path.resolve('.data/doge-config.toml')

  if (fs.existsSync(defaultConfigPath)) {
    return defaultConfigPath
  }

  if (!fs.existsSync('.data')) {
    throw new Error(
      chalk.red(`No .data directory found. Please run "${suggestedCommand}" first to create the configuration.`)
    )
  }

  throw new Error(
    chalk.red(
      `Dogecoin config not found at ${defaultConfigPath}. ` +
      `Please run "${suggestedCommand}" first, or pass --doge-config/--config to use a custom path.`
    )
  )
}

/**
 * Load doge config with automatic file selection
 * @param providedConfigPath - Optional config path provided by user
 * @param suggestedCommand - Command to suggest if no config files are found
 * @returns Loaded DogeConfig and the path used
 */
export async function loadDogeConfigWithSelection(
  providedConfigPath?: string,
  suggestedCommand: string = 'scrollsdk setup doge-config'
): Promise<{ config: DogeConfig; configPath: string }> {
  const configPath = await selectDogeConfigFile(providedConfigPath, suggestedCommand)
  const config = await loadDogeConfig(configPath)
  return { config, configPath }
}

async function loadDogeConfig(configPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

  try {
    const configContent = fs.readFileSync(resolvedPath, 'utf8')
    const parsedConfig = toml.parse(configContent) as unknown as DogeConfig

    const normalizedNetwork = normalizeDogeNetwork(parsedConfig.network)
    if (!normalizedNetwork) {
      throw new Error(
        `Config file ${resolvedPath} has an invalid 'network' value: ${parsedConfig.network}. Must be 'mainnet', 'testnet', or 'regtest'.`,
      )
    }

    parsedConfig.network = normalizedNetwork

    if (!parsedConfig.wallet || !parsedConfig.wallet.path) {
      throw new Error(`Config file ${resolvedPath} is missing 'wallet.path'.`)
    }

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk setup doge-config' to regenerate it.`,
    )
  }
}
