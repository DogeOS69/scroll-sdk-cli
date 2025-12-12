import * as toml from '@iarna/toml'
import { select } from '@inquirer/prompts'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { DogeConfig } from '../types/doge-config.js'

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
  const configFiles = files.filter(file => file.startsWith('doge') && file.endsWith('.toml'))
  
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

async function loadDogeConfig(configPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

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

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk doge:config' to regenerate it.`,
    )
  }
}
