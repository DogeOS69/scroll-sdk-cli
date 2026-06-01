import * as toml from '@iarna/toml'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { DogeConfig, Network } from '../types/doge-config.js'

export const DOGE_NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'regtest']

export function normalizeDogeNetwork(network: unknown): Network | undefined {
  return typeof network === 'string' && DOGE_NETWORKS.includes(network as Network)
    ? network as Network
    : undefined
}

function getDogeConfigNetwork(config: unknown): Network | undefined {
  const network = (config as { network?: unknown })?.network
  if (network === undefined) return undefined

  const normalizedNetwork = normalizeDogeNetwork(network)
  if (!normalizedNetwork) {
    throw new Error(
      `doge-config.toml has an invalid network value: ${String(network)}. ` +
      `Must be 'mainnet', 'testnet', or 'regtest'.`
    )
  }

  return normalizedNetwork
}

export function loadDogeNetworkFromDogeConfig(
  dogeConfigPath: string = path.resolve('.data/doge-config.toml')
): Network {
  const resolvedPath = path.resolve(dogeConfigPath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Dogecoin config file ${resolvedPath} not found. ` +
      `Run 'scrollsdk setup doge-config' to create it.`
    )
  }

  const configContent = fs.readFileSync(resolvedPath, 'utf8')
  const config = toml.parse(configContent)
  const network = getDogeConfigNetwork(config)
  if (!network) {
    throw new Error(
      `${resolvedPath} must define network as 'mainnet', 'testnet', or 'regtest'. ` +
      `Run 'scrollsdk setup doge-config' to update it.`
    )
  }

  return network
}

export function stripDogeConfigFileOnlyFields(config: DogeConfig): Record<string, unknown> {
  const fileConfig = { ...config } as Record<string, unknown>

  if (fileConfig.localSigners && typeof fileConfig.localSigners === 'object' && !Array.isArray(fileConfig.localSigners)) {
    const localSigners = { ...(fileConfig.localSigners as Record<string, unknown>) }
    delete localSigners.network
    fileConfig.localSigners = localSigners
  }

  return fileConfig
}

export function dogeConfigToToml(config: DogeConfig): string {
  return toml.stringify(stripDogeConfigFileOnlyFields(config) as toml.JsonMap)
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
  suggestedCommand: string = 'scrollsdk setup doge-config',
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

    const network = getDogeConfigNetwork(parsedConfig)
    if (!network) {
      throw new Error(
        `Config file ${resolvedPath} is missing 'network'. Run 'scrollsdk setup doge-config' to update it.`
      )
    }

    const { localSigners } = parsedConfig as Record<string, unknown>
    if (localSigners && typeof localSigners === 'object' && !Array.isArray(localSigners) && 'network' in localSigners) {
      throw new Error(
        `Config file ${resolvedPath} contains 'localSigners.network'. Move the Dogecoin network to top-level ` +
        `'network' in ${resolvedPath}.`
      )
    }

    parsedConfig.network = network

    if (!parsedConfig.wallet || !parsedConfig.wallet.path) {
      throw new Error(
        `Config file ${resolvedPath} is missing 'wallet.path'.`
      )
    }

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    if (error instanceof Error && error.message.includes('doge-config.toml has an invalid network value')) {
      throw error
    }

    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk setup doge-config' to regenerate it.`,
    )
  }
}
