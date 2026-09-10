/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML account configuration. */
import * as toml from '@iarna/toml'
import {confirm, input as textInput} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {Wallet, isAddress} from 'ethers'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {writeConfigs} from '../../utils/config-writer.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {resolveEnvValue} from '../../utils/non-interactive.js'

export default class SetupGenKeystore extends Command {
  static override description = 'Generate deployment and activity account keypairs; configure Reth node identities with setup l2-sequencer-reth and setup l2-bootnode-reth'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --non-interactive --json',
  ]

  static override flags = {
    accounts: Flags.boolean({allowNo: true, default: true, description: 'Generate or reuse deployment and activity account keypairs'}),
    json: Flags.boolean({default: false, description: 'Output in JSON format'}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Use existing accounts or generate missing keys without prompts'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(SetupGenKeystore)
    const jsonCtx = new JsonOutputContext('setup gen-keystore', flags.json)
    const configPath = path.resolve('config.toml')
    if (!fs.existsSync(configPath)) this.error('config.toml not found in the current directory.')
    const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as any
    const addresses: Record<string, string> = {}
    let configUpdated = false

    if (flags.accounts) {
      config.accounts ||= {}
      const owner = await this.resolveOwnerAddress(config.accounts.OWNER_ADDR, flags['non-interactive'], jsonCtx)
      for (const name of ['DEPLOYER', 'L2_TESTNET_ACTIVITY_HELPER']) {
        const selected = flags['non-interactive'] || await confirm({
          default: !config.accounts[`${name}_PRIVATE_KEY`],
          message: `Do you want to generate/update ${name}_PRIVATE_KEY?`,
        })
        if (!selected) continue

        // Preserve an existing private key even if its address projection is missing.
        const configuredKey = config.accounts[`${name}_PRIVATE_KEY`]
        const existingKey = resolveEnvValue(configuredKey)
        if (configuredKey && !existingKey) this.error(`${name}_PRIVATE_KEY references an unavailable environment variable.`)
        const wallet = existingKey ? new Wallet(existingKey) : Wallet.createRandom()
        const existingAddress = resolveEnvValue(config.accounts[`${name}_ADDR`])
        if (existingAddress && String(existingAddress).toLowerCase() !== wallet.address.toLowerCase()) {
          this.error(`${name}_ADDR does not match its private key; correct the configuration before continuing.`)
        }

        config.accounts[`${name}_PRIVATE_KEY`] = configuredKey || wallet.privateKey
        config.accounts[`${name}_ADDR`] = wallet.address
        addresses[name] = wallet.address
      }

      if (owner) {
        config.accounts.OWNER_ADDR = owner
        addresses.OWNER = owner
      }

      const shouldUpdate = flags['non-interactive'] || await confirm({message: 'Do you want to update these accounts in config.toml?'})
      if (shouldUpdate) {
        if (!writeConfigs(config, undefined, configPath, flags.json)) this.error('Failed to write account configuration.')
        configUpdated = true
      }
    }

    jsonCtx.info('Reth node keys are managed by setup l2-sequencer-reth and setup l2-bootnode-reth.')
    if (flags.json) {
      jsonCtx.success({accounts: {addresses}, configUpdated})
    } else {
      for (const [name, address] of Object.entries(addresses)) jsonCtx.info(`${name}_ADDR: ${address}`)
    }
  }

  private async resolveOwnerAddress(
    existingOwnerAddr: string | undefined,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<string | undefined> {
    const resolvedExisting = resolveEnvValue(existingOwnerAddr)
    if (resolvedExisting) {
      if (!isAddress(resolvedExisting)) {
        jsonCtx.error(
          'E603_INVALID_OWNER_ADDR',
          `OWNER_ADDR is not a valid Ethereum address: ${resolvedExisting}`,
          'CONFIGURATION',
          true,
          { ownerAddr: existingOwnerAddr }
        )
      }

      return resolvedExisting
    }

    if (nonInteractive) {
      jsonCtx.error(
        'E604_OWNER_ADDR_REQUIRED',
        'OWNER_ADDR is required. Provide accounts.OWNER_ADDR in config.toml or set the referenced environment variable before running setup gen-keystore.',
        'CONFIGURATION',
        true
      )
    }

    let ownerAddress: string | undefined
    while (!ownerAddress) {
      const value = await textInput({
        message: 'Enter the Owner wallet address:',
        required: true,
      })
      if (isAddress(value)) {
        ownerAddress = value
      } else {
        this.log(chalk.red('Invalid Ethereum address format. Please try again.'))
      }
    }

    return ownerAddress
  }

}
