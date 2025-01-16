import * as toml from '@iarna/toml'
import {confirm, input} from '@inquirer/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {DogeConfig} from '../types/doge-config.js'

export async function loadDogeConfig(configPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

  if (!fs.existsSync(resolvedPath)) {
    const shouldCreate = await confirm({
      default: true,
      message: `Config file not found at ${resolvedPath}. Would you like to create one?`,
    })

    if (!shouldCreate) {
      throw new Error(`Config file not found at ${resolvedPath}`)
    }

    // Get NowNodes API key
    const apiKey = await input({
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate(value) {
        if (!value) return 'API key is required'
        return true
      },
    })

    // Create default config
    const config: DogeConfig = {
      defaults: {
        chainId: '0x221122',
        evmAddress: '0x151a64570e4997739458455ba4ab5A535FD2E306',
      },
      network: 'doge',
      rpc: {
        apiKey,
        url: 'https://doge.nownodes.io',
      },
      wallet: {
        path: '.data/doge-wallet.json',
      },
    }

    // Create directory if it doesn't exist
    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, {recursive: true})
    }

    // Write config file
    fs.writeFileSync(resolvedPath, toml.stringify(config as unknown as toml.JsonMap))
    console.log(`Created config file at ${resolvedPath}`)
  }

  try {
    const configContent = fs.readFileSync(resolvedPath, 'utf8')
    const parsedConfig = toml.parse(configContent)
    return parsedConfig as unknown as DogeConfig
  } catch (error) {
    throw new Error(`Failed to load Dogecoin config: ${error instanceof Error ? error.message : String(error)}`)
  }
}
