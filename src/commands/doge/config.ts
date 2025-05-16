import * as toml from '@iarna/toml'
import {input, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type {DogeConfig, Network} from '../../types/doge-config.js'

export class DogeConfigCommand extends Command {
  static description = 'Configure Dogecoin settings for mainnet or testnet'

  static examples = [
    '$ scrollsdk doge:config',
    '$ scrollsdk doge:config --config .data/doge-config-mainnet.toml',
    '$ scrollsdk doge:config --config .data/doge-config-testnet.toml',
  ]

  static flags = {
    config: Flags.string({
      char: 'c',
      description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DogeConfigCommand)

    const networkSelection = (await select({
      choices: [
        {name: 'mainnet', value: 'mainnet' as const},
        {name: 'testnet', value: 'testnet' as const},
      ],
      default: 'mainnet',
      message: 'Select network type to configure:',
    })) as Network

    const defaultConfigFilename = networkSelection === 'mainnet' ? 'doge-config.toml' : 'doge-config-testnet.toml'
    const configPath = flags.config || path.join('.data', defaultConfigFilename)
    const resolvedPath = path.resolve(configPath)

    this.log(chalk.blue(`Configuring for ${networkSelection} network. Target config file: ${resolvedPath}`))

    let existingConfig: Partial<DogeConfig> = {}
    if (fs.existsSync(resolvedPath)) {
      try {
        const configContent = fs.readFileSync(resolvedPath, 'utf8')
        existingConfig = toml.parse(configContent) as unknown as Partial<DogeConfig>
        if (existingConfig.network && existingConfig.network !== networkSelection) {
          this.log(
            chalk.yellow(
              `Warning: Selected network (${networkSelection}) differs from existing config's network (${existingConfig.network}) in ${resolvedPath}. Proceeding will overwrite with ${networkSelection} settings.`,
            ),
          )
        }
      } catch (error) {
        this.log(
          chalk.yellow(
            `Warning: Failed to parse existing config at ${resolvedPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
      }
    }

    const networkDefaults = {
      mainnet: {
        blockbookAPIUrl: 'https://dogebook.nownodes.io/api/v2',
        recipient: 'DARn34TPXXQZgcVo5nZ7iqvJJRsm2PkjSC',
        rpcUrl: 'https://doge.nownodes.io',
        walletPath: '.data/doge-wallet-mainnet.json',
      },
      testnet: {
        blockbookAPIUrl: 'https://dogebook-testnet.nownodes.io/api/v2',
        recipient: 'nZVA3ysLh4LsmDog9hg1kkXMhzAT8DbnTT',
        rpcUrl: 'https://doge-testnet.nownodes.io',
        walletPath: '.data/doge-wallet-testnet.json',
      },
    }
    const currentDefaults = networkDefaults[networkSelection]

    const apiKey = await input({
      default: existingConfig.rpc?.apiKey,
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate: (value) => (value ? true : 'API key is required'),
    })

    const chainId = await input({
      default: existingConfig.defaults?.chainId || '0x221122',
      message: 'Enter the Chain ID (hex with 0x prefix or decimal):',
      validate: (value) =>
        /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    })

    const evmAddress = await input({
      default: existingConfig.defaults?.evmAddress || '0x151a64570e4997739458455ba4ab5A535FD2E306',
      message: 'Enter the EVM Address (20 bytes):',
      validate: (value) =>
        /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    })

    const recipient = await input({
      default: existingConfig.defaults?.recipient || currentDefaults.recipient,
      message: `Enter the Doge Bridge Address (for ${networkSelection} network):`,
      validate: (value) =>
        /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value)
          ? true
          : 'Invalid Dogecoin address format',
    })

    const walletPathInput = await input({
      default: existingConfig.wallet?.path || currentDefaults.walletPath,
      message: `Enter the wallet file path (for ${networkSelection} network):`,
    })

    const newConfig: DogeConfig = {
      ...(existingConfig as DogeConfig),
      defaults: {
        ...existingConfig.defaults,
        chainId,
        evmAddress,
        recipient,
      },
      frontend: existingConfig.frontend ? {...existingConfig.frontend} : undefined,
      network: networkSelection,
      rpc: {
        ...existingConfig.rpc,
        apiKey,
        blockbookAPIUrl: currentDefaults.blockbookAPIUrl,
        url: currentDefaults.rpcUrl,
      },
      test: existingConfig.test ? {...existingConfig.test} : undefined,
      wallet: {
        ...existingConfig.wallet,
        path: walletPathInput,
      },
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, {recursive: true})
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(newConfig as any))

    this.log(chalk.green(`\nConfiguration for ${newConfig.network} network saved to ${resolvedPath}`))
    this.log(chalk.blue('\nConfiguration Summary:'))
    this.log(chalk.blue(`Network: ${newConfig.network}`))
    this.log(chalk.blue(`RPC URL: ${newConfig.rpc!.url}`))
    this.log(chalk.blue(`Blockbook API URL: ${newConfig.rpc!.blockbookAPIUrl}`))
    this.log(chalk.blue(`Wallet Path: ${newConfig.wallet.path}`))
    this.log(chalk.blue(`Chain ID: ${newConfig.defaults!.chainId}`))
    this.log(chalk.blue(`EVM Address: ${newConfig.defaults!.evmAddress}`))
    this.log(chalk.blue(`Doge Bridge Address: ${newConfig.defaults!.recipient}`))
  }
}

export default DogeConfigCommand
