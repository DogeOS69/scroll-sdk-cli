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

function getDogecoinSection(config: unknown): Record<string, unknown> | undefined {
  const section = (config as { dogecoin?: unknown })?.dogecoin
  if (section === undefined) return undefined
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error('[dogecoin] must be a TOML table.')
  }

  return section as Record<string, unknown>
}

export function getOptionalDogeNetworkFromConfig(config: unknown, sourceDescription = 'config.toml'): Network | undefined {
  const dogecoinSection = getDogecoinSection(config)
  if (!dogecoinSection || dogecoinSection.network === undefined) return undefined

  const network = normalizeDogeNetwork(dogecoinSection.network)
  if (!network) {
    throw new Error(
      `${sourceDescription} has an invalid [dogecoin].network value: ${String(dogecoinSection.network)}. ` +
      `Must be 'mainnet', 'testnet', or 'regtest'.`
    )
  }

  return network
}

export function getDogeNetworkFromConfig(config: unknown, sourceDescription = 'config.toml'): Network {
  const network = getOptionalDogeNetworkFromConfig(config, sourceDescription)
  if (!network) {
    throw new Error(
      `${sourceDescription} must define [dogecoin].network as 'mainnet', 'testnet', or 'regtest'.`
    )
  }

  return network
}

export function loadDogeNetworkFromMainConfig(
  mainConfigPath: string = path.resolve('config.toml')
): Network {
  const resolvedPath = path.resolve(mainConfigPath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Main config file ${resolvedPath} not found. ` +
      `Create config.toml and set [dogecoin].network before using Dogecoin commands.`
    )
  }

  const configContent = fs.readFileSync(resolvedPath, 'utf8')
  const config = toml.parse(configContent)
  return getDogeNetworkFromConfig(config, resolvedPath)
}

export function setDogeNetworkInConfig(config: toml.JsonMap, network: Network): void {
  const configMap = config as Record<string, unknown>
  if (!configMap.dogecoin || typeof configMap.dogecoin !== 'object' || Array.isArray(configMap.dogecoin)) {
    configMap.dogecoin = {}
  }

  ;(configMap.dogecoin as Record<string, unknown>).network = network
}

export function stripDogeConfigFileOnlyFields(config: DogeConfig): Record<string, unknown> {
  const fileConfig = { ...config } as Record<string, unknown>
  delete fileConfig.network

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
  mainConfigPath: string = path.resolve('config.toml')
): Promise<{ config: DogeConfig; configPath: string }> {
  const configPath = await selectDogeConfigFile(providedConfigPath, suggestedCommand)
  const config = await loadDogeConfig(configPath, mainConfigPath)
  return { config, configPath }
}

async function loadDogeConfig(configPath: string, mainConfigPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

  try {
    const mainConfigNetwork = loadDogeNetworkFromMainConfig(mainConfigPath)
    const configContent = fs.readFileSync(resolvedPath, 'utf8')
    const parsedConfig = toml.parse(configContent) as unknown as DogeConfig

    if (parsedConfig.network !== undefined) {
      throw new Error(
        `Config file ${resolvedPath} contains 'network', but Dogecoin network must only be defined in ` +
        `config.toml [dogecoin].network. Remove the field from ${resolvedPath}.`
      )
    }

    const { localSigners } = parsedConfig as Record<string, unknown>
    if (localSigners && typeof localSigners === 'object' && !Array.isArray(localSigners) && 'network' in localSigners) {
      throw new Error(
        `Config file ${resolvedPath} contains 'localSigners.network', but Dogecoin network must only be defined in ` +
        `config.toml [dogecoin].network. Remove the field from ${resolvedPath}.`
      )
    }

    delete (parsedConfig as Record<string, unknown>).network
    parsedConfig.network = mainConfigNetwork

    if (!parsedConfig.wallet || !parsedConfig.wallet.path) {
      throw new Error(
        `Config file ${resolvedPath} is missing 'wallet.path'.`
      )
    }

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    if (error instanceof Error && (
      error.message.startsWith('Main config file') ||
      error.message.includes('[dogecoin].network') ||
      error.message === '[dogecoin] must be a TOML table.'
    )) {
      throw error
    }

    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk setup doge-config' to regenerate it.`,
    )
  }
}
