import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DogeConfig, Network } from '../../types/doge-config.js'

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
    const { flags } = await this.parse(DogeConfigCommand)

    const networkSelection = (await select({
      choices: [
        { name: 'mainnet', value: 'mainnet' as const },
        { name: 'testnet', value: 'testnet' as const },
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
            `Warning: Failed to parse existing config at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
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
        rpcPassword: 'password',
        rpcUser: 'user',
      },
      testnet: {
        blockbookAPIUrl: 'https://dogebook-testnet.nownodes.io/api/v2',
        recipient: 'nZVA3ysLh4LsmDog9hg1kkXMhzAT8DbnTT',
        rpcUrl: 'https://doge-testnet.nownodes.io',
        walletPath: '.data/doge-wallet-testnet.json',
        rpcPassword: 'password',
        rpcUser: 'user'
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

    const rpcUser = await input({
      default: existingConfig.rpc?.username || currentDefaults.rpcUser,
      message: `Enter the dogecoin RPC user (for ${networkSelection} network):`,
    });

    const rpcPassword = await input({
      default: existingConfig.rpc?.password || currentDefaults.rpcPassword,
      message: `Enter the dogecoin RPC password of user "${rpcUser}" (for ${networkSelection} network):`,
    });

    const newConfig: DogeConfig = {
      ...(existingConfig as DogeConfig),
      defaults: {
        ...existingConfig.defaults,
        chainId,
        evmAddress,
        recipient,
      },
      frontend: existingConfig.frontend ? { ...existingConfig.frontend } : undefined,
      network: networkSelection,
      rpc: {
        ...existingConfig.rpc,
        apiKey,
        blockbookAPIUrl: currentDefaults.blockbookAPIUrl,
        url: currentDefaults.rpcUrl,
        password: rpcPassword,
        username: rpcUser,
      },
      test: existingConfig.test ? { ...existingConfig.test } : undefined,
      wallet: {
        ...existingConfig.wallet,
        path: walletPathInput,
      },
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
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

    await this.generateSetupDefaultsToml(newConfig)
    await this.runGenerateTestKeys('latest')
  }


  async generateSetupDefaultsToml(newDogeConfig: DogeConfig): Promise<void> {
    // Create setup_defaults.toml in user's current working directory
    const setupDefaultsPath = path.resolve(process.cwd(), 'crates/test_utils/config/setup_defaults.toml');

    if (!fs.existsSync(setupDefaultsPath)) {
      // Ensure the target directory exists
      const targetDir = path.dirname(setupDefaultsPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const templatePath = path.resolve(currentDir, '../../../src/config/setup_defaults.toml');
      this.log(chalk.blue(`Copying template file from ${templatePath} to ${setupDefaultsPath}`));
      fs.copyFileSync(templatePath, setupDefaultsPath);
    }
    //read existing config file from user's working directory
    const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf-8');
    let newConfig = toml.parse(existingConfigStr);

    newConfig.network = newDogeConfig.network;

    const seedString = await input({
      message: 'Enter seed string for key derivation:',
      default: String(newConfig.seed_string || ''),
      validate: (value) => value.length > 0 ? true : 'Seed string cannot be empty'
    });
    newConfig.seed_string = seedString;

    // const rpcUrl = await input({
    //   message: 'Enter Dogecoin RPC URL:',
    //   default: String(newConfig.dogecoin_rpc_url || (network === 'testnet' ? 'https://testnet.doge.xyz' : 'https://doge.xyz')),
    //   validate: (value) => value.startsWith('http') ? true : 'URL must start with http or https'
    // });
    //newConfig.dogecoin_rpc_url = newDogeConfig.rpc?.url || '';

    // const rpcUser = await input({
    //   message: 'Enter Dogecoin RPC username:',
    //   default: String(newConfig.dogecoin_rpc_user || 'user')
    // });
    //newConfig.dogecoin_rpc_user = newDogeConfig.rpc?.username || '';

    // const rpcPass = await input({
    //   message: 'Enter Dogecoin RPC password:',
    //   default: String(newConfig.dogecoin_rpc_pass || 'password_test')
    // });
    //newConfig.dogecoin_rpc_pass = newDogeConfig.rpc?.password || '';

    // const blockbookUrl = await input({
    //   message: 'Enter Blockbook API URL (optional):',
    //   default: String(newConfig.dogecoin_blockbook_url || (network === 'testnet' ? 'https://dogebook-testnet.nownodes.io' : 'https://dogebook.nownodes.io'))
    // });
    const blockbookUrl = newDogeConfig.rpc?.blockbookAPIUrl?.replace('/api/v2', '') || '';
    newConfig.dogecoin_blockbook_url = blockbookUrl;

    // const apiKey = await input({
    //   message: 'Enter Blockbook API key (if required):',
    //   default: String(newConfig.dogecoin_blockbook_api_key || '')
    // });
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';

    // const ethAddress = await input({
    //   message: 'Enter Ethereum recipient address (20 bytes hex):',
    //   default: String(newConfig.deposit_eth_recipient_address_hex || "null"),
    //   validate: (value) => /^0x[a-fA-F0-9]{40}$/.test(value) ? true : 'Must be a valid 20-byte hex address starting with 0x'
    // });
    newConfig.deposit_eth_recipient_address_hex = newDogeConfig.defaults?.evmAddress || '';

    //write to crates/test_utils/config/setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }

  async runGenerateTestKeys(imageTag: string): Promise<void> {
    const docker = new Docker();
    const image = `ghcr.io/dogeos69/dogeos-core/generate-test-keys:${imageTag}`;
    try {
      this.log(chalk.cyan('Pulling Docker Image...'))
      // Pull the image if it doesn't exist locally
      const pullStream = await docker.pull(image)
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(pullStream, (err, res) => {
          if (err) {
            reject(err)
          } else {
            this.log(chalk.green('Image pulled successfully'))
            resolve(res)
          }
        })
      })

      this.log(chalk.cyan('Creating Docker Container...'))
      // Create and run the container
      const container = await docker.createContainer({
        Cmd: [], // Add any command if needed
        HostConfig: {
          Binds: [`${process.cwd()}:/contracts/volume`],
        },
        Image: image,
      })

      this.log(chalk.cyan('Starting Container'))
      await container.start()

      // Wait for the container to finish and get the logs
      const stream = await container.logs({
        follow: true,
        stderr: true,
        stdout: true,
      })

      // Print the logs
      stream.pipe(process.stdout)

      // Wait for the container to finish
      await new Promise((resolve) => {
        container.wait((err, data) => {
          if (err) {
            this.error(`Container exited with error: ${err}`)
          } else if (data.StatusCode !== 0) {
            this.error(`Container exited with status code: ${data.StatusCode}`)
          }

          resolve(null)
        })
      })

      // Remove the container
      await container.remove()
    } catch (error) {
      this.error(`Failed to run Docker command: ${error}`)
    }

  }
}

export default DogeConfigCommand
