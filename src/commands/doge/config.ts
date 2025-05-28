import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DogeConfig, Network } from '../../types/doge-config.js'
import { loadDogeConfig } from '../../utils/doge-config.js'

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
    let resolvedPath = "";

    if (!flags.config) {
      if (!fs.existsSync('.data')) {
        fs.mkdirSync('.data', { recursive: true });
      }
      const files = fs.readdirSync('.data')
      const configFiles = files.filter(file => file.endsWith('.toml'))
      const configFileChoices = configFiles.map(file => ({ name: file, value: file }))

      const fileSelection = await select({
        choices: [
          ...configFileChoices,
          { name: 'Create New Config', value: 'new' as const },
        ],
        message: 'Select config file to configure:',
      })

      if (fileSelection === 'new') {
        const newConfigName = await input({
          default: "doge-config.toml",
          message: 'Enter the name of the new config file:',
        })
        resolvedPath = path.resolve('.data/' + newConfigName);
      } else {
        const configPath = path.join('.data', fileSelection)
        resolvedPath = path.resolve(configPath)
      }

    } else {
      resolvedPath = path.resolve(flags.config);
      if (!fs.existsSync(resolvedPath)) {
        this.error(`Config file ${resolvedPath} does not exist`);
        return;
      }
    }

    const existingConfig = await loadDogeConfig(resolvedPath)
    let newConfig = await loadDogeConfig(resolvedPath);

    newConfig.rpc!.apiKey = await input({
      default: existingConfig.rpc?.apiKey,
      message: 'Enter your NowNodes API key (get one at nownodes.io):',
      validate: (value) => (value ? true : 'API key is required'),
    })

    newConfig.defaults!.chainId = await input({
      default: existingConfig.defaults?.chainId,
      message: 'Enter the Chain ID (hex with 0x prefix or decimal):',
      validate: (value) =>
        /^(0x[\dA-Fa-f]+|\d+)$/.test(value) ? true : 'Chain ID must be decimal or hex with 0x prefix',
    })

    newConfig.defaults!.evmAddress = await input({
      default: existingConfig.defaults?.evmAddress || '0x151a64570e4997739458455ba4ab5A535FD2E306',
      message: 'Enter the EVM Address (20 bytes):',
      validate: (value) =>
        /^0x[\dA-Fa-f]{40}$/.test(value) ? true : 'EVM Address must be 20 bytes (40 hex chars) with 0x prefix',
    })

    newConfig.defaults!.recipient = await input({
      default: existingConfig.defaults?.recipient || 'nmNf4f5kyvCFrfyUBoQU3TKN3Dyc5kcMoH',
      message: `Enter the Doge recipient Address:`,
      validate: (value) =>
        /^(D[1-9A-HJ-NP-Za-km-z]{33}|[mn][1-9A-HJ-NP-Za-km-z]{33})$/.test(value)
          ? true
          : 'Invalid Dogecoin address format',
    })

    newConfig.wallet!.path = await input({
      default: existingConfig.wallet?.path,
      message: `Enter the wallet file path:`,
    })

    newConfig.rpc!.username = await input({
      default: existingConfig.rpc?.username,
      message: `Enter the dogecoin RPC user:`,
    });

    newConfig.rpc!.password = await input({
      default: existingConfig.rpc?.password,
      message: `Enter the dogecoin RPC password of user (for ${existingConfig.network} network):`,
    });

    newConfig.da!.rpcUrl = await input({
      default: existingConfig.da?.rpcUrl,
      message: `Enter the Celestia RPC URL:`,
    });
    newConfig.da!.tendermintRpcUrl = await input({
      default: existingConfig.da?.tendermintRpcUrl,
      message: `Enter the Celestia Tendermint RPC URL:`,
    });
    newConfig.da!.daNamespace = await input({
      default: existingConfig.da?.daNamespace,
      message: `Enter the Celestia DA Namespace:`,
    });
    newConfig.da!.signerAddress = await input({
      default: existingConfig.da?.signerAddress,
      message: `Enter the Celestia Signer Address:`,
    });
    newConfig.da!.genesisBlobCommitment = await input({
      default: existingConfig.da?.genesisBlobCommitment,
      message: `Enter the Celestia Genesis Blob Commitment:`,
    });

    newConfig.da!.celestiaIndexerStartBlock = Number(await input({
      default: String(existingConfig.da?.celestiaIndexerStartBlock || 0),
      message: `Enter the Celestia Indexer Start Block:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

    newConfig.defaults!.dogecoinIndexerStartHeight = Number(await input({
      default: String(existingConfig.defaults?.dogecoinIndexerStartHeight || 4000000),
      message: `Enter the Dogecoin Indexer Start Height:`,
      validate: (value) => !isNaN(Number(value)) ? true : 'Must be a valid number',
    }));

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
    await this.runGenerateTestKeys()
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

    newConfig.dogecoin_rpc_url = 'https://testnet.doge.xyz'; //TODO: change to newDogeConfig.rpc?.url
    newConfig.dogecoin_rpc_user = 'user';                   //TODO newDogeConfig.rpc?.username || '';
    newConfig.dogecoin_rpc_pass = 'password_test';          //TODO newDogeConfig.rpc?.password || '';
    const blockbookUrl = newDogeConfig.rpc?.blockbookAPIUrl?.replace('/api/v2', '') || '';
    newConfig.dogecoin_blockbook_url = blockbookUrl;
    newConfig.dogecoin_blockbook_api_key = newDogeConfig.rpc?.apiKey || '';
    newConfig.deposit_eth_recipient_address_hex = newDogeConfig.defaults?.evmAddress || '';

    //write to crates/test_utils/config/setup_defaults.toml
    fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));
  }

  async runGenerateTestKeys(): Promise<void> {
    const docker = new Docker();
    const image = `docker.io/dogeos69/generate-test-keys:v0.1.1-test`;
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
          Binds: [`${process.cwd()}:/app`],
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
