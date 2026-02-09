/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command } from '@oclif/core'
import chalk from 'chalk'
import { ethers } from 'ethers'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { writeConfigs } from '../../utils/config-writer.js'

export default class SetupGasToken extends Command {
  static override description = 'Set up gas token configurations'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  public async run(): Promise<void> {
    this.log(chalk.blue('Setting up gas token configurations...'))

    const existingConfig = await this.getExistingConfig()
    const existingGasToken = existingConfig['gas-token'] || {}

    const useAlternativeToken = await confirm({
      default: existingGasToken.ALTERNATIVE_GAS_TOKEN_ENABLED || false,
      message: chalk.cyan('Do you want to use an alternative gas token?')
    })

    const gasConfig: Record<string, boolean | number | string> = {
      ALTERNATIVE_GAS_TOKEN_ENABLED: useAlternativeToken,
    }

    if (useAlternativeToken) {
      const deploymentChoice = await select({
        choices: [
          { name: 'Use an existing L1 ERC20 token', value: 'existing' },
          { name: 'Auto-deploy a new ERC20 token', value: 'autodeploy' },
        ],
        default: existingGasToken.L1_GAS_TOKEN ? 'existing' : 'autodeploy',
        message: chalk.cyan('How do you want to set up the gas token?')
      })

      if (deploymentChoice === 'existing') {
        let tokenAddress: string
        let isValidAddress = false
        let continueAnyway = false

        do {
          tokenAddress = await input({
            default: existingGasToken.L1_GAS_TOKEN || '',
            message: chalk.cyan('Enter the L1 ERC20 token address:'),
            validate: (value) => ethers.isAddress(value) || 'Please enter a valid Ethereum address',
          })

          isValidAddress = await this.checkL1TokenExists(tokenAddress)
          if (!isValidAddress) {
            this.log(chalk.yellow('The provided address does not contain a contract.'))
            continueAnyway = await confirm({
              default: false,
              message: chalk.cyan('Do you want to continue anyway?')
            })
          }
        } while (!isValidAddress && !continueAnyway)

        gasConfig.L1_GAS_TOKEN = tokenAddress
      } else {
        const tokenDecimals = await input({
          default: existingGasToken.EXAMPLE_GAS_TOKEN_DECIMAL?.toString() || '18',
          message: chalk.cyan('Enter the number of decimals for the example gas token:'),
          validate(value) {
            const num = Number.parseInt(value, 10)
            return (!Number.isNaN(num) && num >= 0 && num <= 256) || 'Please enter a valid number between 0 and 256'
          },
        })

        gasConfig.EXAMPLE_GAS_TOKEN_DECIMAL = Number.parseInt(tokenDecimals, 10)
      }
    }

    await this.displayChanges(gasConfig)

    const confirmChanges = await confirm({
      default: true,
      message: chalk.cyan('Do you want to apply these changes?')
    })

    if (confirmChanges) {
      await this.updateConfigFile(gasConfig)
      this.log(chalk.green('Gas token configuration completed successfully.'))
    } else {
      this.log(chalk.yellow('Gas token configuration cancelled.'))
    }
  }

  private async checkL1TokenExists(tokenAddress: string): Promise<boolean> {
    const config = await this.getExistingConfig()

    const l1RpcEndpoint = config.frontend?.EXTERNAL_RPC_URI_L1
    if (!l1RpcEndpoint) {
      this.error('EXTERNAL_RPC_URI_L1 not found in config.toml')
      return false
    }

    try {
      if (!ethers.isAddress(tokenAddress)) {
        this.log(chalk.red('Invalid Ethereum address format.'))
        return false
      }

      const provider = new ethers.JsonRpcProvider(l1RpcEndpoint)
      const code = await provider.getCode(tokenAddress)
      return code !== '0x'
    } catch (error) {
      this.error(`Failed to check token existence: ${error}`)
      return false
    }
  }

  private async displayChanges(gasConfig: Record<string, boolean | number | string>): Promise<void> {
    this.log(chalk.cyan('\nThe following changes will be made to the [gas-token] section in config.toml:'))

    for (const [key, value] of Object.entries(gasConfig)) {
      if (typeof value === 'boolean') {
        this.log(`${key} = ${chalk.green(value.toString())}`)
      } else if (typeof value === 'number') {
        this.log(`${key} = ${chalk.green(value.toString())}`)
      } else {
        this.log(`${key} = ${chalk.green(`"${value}"`)}`)
      }
    }
  }

  private async getExistingConfig(): Promise<any> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error('config.toml not found in the current directory.')
      return {}
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    return toml.parse(configContent) as any
  }

  private async updateConfigFile(gasConfig: Record<string, boolean | number | string>): Promise<void> {
    const existingConfig = await this.getExistingConfig()

    if (!existingConfig['gas-token']) {
      existingConfig['gas-token'] = {}
    }

    // Update gas-token configurations
    for (const [key, value] of Object.entries(gasConfig)) {
      existingConfig['gas-token'][key] = value
    }

    // const updatedContent = toml.stringify(existingConfig)
    // fs.writeFileSync(configPath, updatedContent)
    writeConfigs(existingConfig);

    this.log(chalk.green('config.toml has been updated with the new gas token configurations.'))
  }
}
