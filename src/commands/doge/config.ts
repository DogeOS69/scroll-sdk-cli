import * as toml from '@iarna/toml'
import {input} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig} from '../../types/doge-config.js'

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings'

  static examples = ['$ scrollsdk doge:config', '$ scrollsdk doge:config --config .data/doge-config.toml']

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file',
      default: '.data/doge-config.toml',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DogeConfigCommand)

    // Resolve config path
    const resolvedPath = path.resolve(flags.config)

    // Load existing config if it exists
    let existingConfig: Partial<DogeConfig> = {}
    if (fs.existsSync(resolvedPath)) {
      try {
        const configContent = fs.readFileSync(resolvedPath, 'utf8')
        existingConfig = toml.parse(configContent) as unknown as DogeConfig
      } catch (error) {
        this.log(
          chalk.yellow(
            `Warning: Failed to parse existing config: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }

    // Get NowNodes API key
    const apiKey = await input({
      default: existingConfig.rpc?.apiKey,
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate(value) {
        if (!value) return 'API key is required'
        return true
      },
    })

    // Get Chain ID
    const chainId = await input({
      default: existingConfig.defaults?.chainId || '0x221122',
      message: 'Enter the Chain ID (hex with 0x prefix or decimal):',
      validate(value) {
        if (!/^(0x[\dA-Fa-f]+|\d+)$/.test(value)) {
          return 'Chain ID must be decimal or hex with 0x prefix'
        }
        return true
      },
    })

    // Get EVM Address
    const evmAddress = await input({
      default: existingConfig.defaults?.evmAddress || '0x151a64570e4997739458455ba4ab5A535FD2E306',
      message: 'Enter the EVM Address (20 bytes):',
      validate(value) {
        if (!/^0x[\dA-Fa-f]{40}$/.test(value)) {
          return 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix'
        }
        return true
      },
    })

    // Get Doge Bridge Address
    const recipient = await input({
      default: existingConfig.defaults?.recipient || 'DARn34TPXXQZgcVo5nZ7iqvJJRsm2PkjSC',
      message: 'Enter the Doge Bridge Address:',
      validate(value) {
        if (!/^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
          return 'Invalid Dogecoin address format'
        }
        return true
      },
    })

    // Create config object with required fields
    const config = {
      defaults: {
        chainId,
        evmAddress,
        recipient,
      },
      network: 'doge' as const,
      rpc: {
        apiKey,
        url: 'https://doge.nownodes.io',
      },
      wallet: {
        path: '.data/doge-wallet.json',
      },
    } satisfies DogeConfig

    // Create directory if it doesn't exist
    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, {recursive: true})
    }

    // Write config file
    fs.writeFileSync(resolvedPath, toml.stringify(config as unknown as toml.JsonMap))

    this.log(chalk.green(`\nConfiguration saved to ${resolvedPath}`))
    this.log(chalk.blue('\nConfiguration Summary:'))
    this.log(chalk.blue(`Network: ${config.network}`))
    this.log(chalk.blue(`RPC URL: ${config.rpc.url}`))
    this.log(chalk.blue(`Chain ID: ${config.defaults.chainId}`))
    this.log(chalk.blue(`EVM Address: ${config.defaults.evmAddress}`))
    this.log(chalk.blue(`Doge Bridge Address: ${config.defaults.recipient}`))
  }
}

export default DogeConfigCommand
