/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { confirm, password as input, input as textInput } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { Wallet, ethers , isAddress } from 'ethers'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { writeConfigs } from '../../utils/config-writer.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  createNonInteractiveContext,
  resolveEnvValue,
} from '../../utils/non-interactive.js'

interface KeyPair {
  address: string
  privateKey: string
}

interface SequencerData {
  address: string
  keystoreJson: string
  nodekey: string
  password: string
}

interface BootnodeData {
  nodekey: string
}

export default class SetupGenKeystore extends Command {
  static override description = 'Generate keystore and account keys for L2 Geth'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-accounts',
    '<%= config.bin %> <%= command.id %> --non-interactive',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --sequencer-count 2 --bootnode-count 2',
  ]

  static override flags = {
    accounts: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Generate account key pairs',
    }),
    'bootnode-count': Flags.integer({
      default: 2,
      description: 'Number of bootnodes. In non-interactive mode, generates if not enough exist.',
    }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Uses existing keys or generates new ones based on flags.',
    }),
    'regenerate-bootnodes': Flags.boolean({
      default: false,
      description: 'Force regeneration of all bootnode keys (non-interactive mode)',
    }),
    'regenerate-sequencers': Flags.boolean({
      default: false,
      description: 'Force regeneration of all sequencer keys (non-interactive mode)',
    }),
    'sequencer-count': Flags.integer({
      default: 2,
      description: 'Number of sequencers (including primary). In non-interactive mode, generates if not enough exist.',
    }),
    'sequencer-password': Flags.string({
      description: 'Password for sequencer keystores (or use $ENV:VAR_NAME pattern in config). Required for new sequencers in non-interactive mode.',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenKeystore)
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json

    // Setup contexts for non-interactive/JSON mode
    createNonInteractiveContext('setup gen-keystore', nonInteractive, jsonMode)
    const jsonCtx = new JsonOutputContext('setup gen-keystore', jsonMode)

    const existingConfig = await this.getExistingConfig()

    jsonCtx.info('Setting up Sequencer keystores, bootnode nodekeys, L2 account keypairs, and coordinator JWT secret key...')

    // Helper to count existing sequencers
    const countExistingSequencers = (): number => {
      const mainSequencer = existingConfig.sequencer?.L2GETH_SIGNER_ADDRESS ? 1 : 0
      const subSequencers = existingConfig.sequencer
        ? Object.keys(existingConfig.sequencer)
            .filter(key => key.startsWith('sequencer-'))
            .filter(key => {
              const section = existingConfig.sequencer[key]
              return section && Object.values(section).some(value => value !== '')
            })
            .length
        : 0
      return mainSequencer + subSequencers
    }

    // Helper to count existing bootnodes
    const countExistingBootnodes = (): number => existingConfig.bootnode
        ? Object.keys(existingConfig.bootnode)
            .filter(key => key.startsWith('bootnode-'))
            .filter(key => {
              const section = existingConfig.bootnode[key]
              return section && section.L2GETH_NODEKEY !== ''
            })
            .length
        : 0

    // Helper to collect existing sequencer data
    const collectExistingSequencerData = (): SequencerData[] => {
      const data: SequencerData[] = []
      if (existingConfig.sequencer?.L2GETH_SIGNER_ADDRESS) {
        data.push({
          address: existingConfig.sequencer.L2GETH_SIGNER_ADDRESS,
          keystoreJson: existingConfig.sequencer.L2GETH_KEYSTORE,
          nodekey: existingConfig.sequencer.L2GETH_NODEKEY,
          password: existingConfig.sequencer.L2GETH_PASSWORD,
        })
      }

      if (existingConfig.sequencer) {
        for (const key of Object.keys(existingConfig.sequencer)) {
          if (key.startsWith('sequencer-') && Object.values(existingConfig.sequencer[key]).some(value => value !== '')) {
            data.push({
              address: existingConfig.sequencer[key].L2GETH_SIGNER_ADDRESS,
              keystoreJson: existingConfig.sequencer[key].L2GETH_KEYSTORE,
              nodekey: existingConfig.sequencer[key].L2GETH_NODEKEY,
              password: existingConfig.sequencer[key].L2GETH_PASSWORD,
            })
          }
        }
      }

      return data
    }

    // Helper to collect existing bootnode data
    const collectExistingBootnodeData = (): BootnodeData[] => {
      const data: BootnodeData[] = []
      if (existingConfig.bootnode) {
        for (const key of Object.keys(existingConfig.bootnode)) {
          if (key.startsWith('bootnode-') && existingConfig.bootnode[key].L2GETH_NODEKEY) {
            data.push({
              nodekey: existingConfig.bootnode[key].L2GETH_NODEKEY,
            })
          }
        }
      }

      return data
    }

    let sequencerData: SequencerData[] = []
    let overwrite = false
    let bootnodeData: BootnodeData[] = []
    let overwriteBootnodes = false

    // ============ SEQUENCER HANDLING ============
    if (nonInteractive) {
      // Non-interactive mode: use flags to determine behavior
      const existingSequencers = countExistingSequencers()
      const targetSequencerCount = flags['sequencer-count']
      overwrite = flags['regenerate-sequencers']

      if (overwrite) {
        // Regenerate all sequencers
        const password = resolveEnvValue(flags['sequencer-password'])
        if (!password) {
          jsonCtx.error(
            'E601_MISSING_FIELD',
            'Sequencer password required when regenerating sequencers in non-interactive mode. Use --sequencer-password or $ENV:VAR_NAME.',
            'CONFIGURATION',
            true,
            { flag: '--sequencer-password' }
          )
        }

        jsonCtx.info(`Regenerating ${targetSequencerCount} sequencer(s)...`)
        for (let i = 0; i < targetSequencerCount; i++) {
          sequencerData.push(await this.generateSequencerKeystore(i, password))
        }
      } else if (existingSequencers < targetSequencerCount) {
        // Keep existing, generate additional
        sequencerData = collectExistingSequencerData()
        const password = resolveEnvValue(flags['sequencer-password'])
        if (!password) {
          jsonCtx.error(
            'E601_MISSING_FIELD',
            'Sequencer password required when generating new sequencers in non-interactive mode. Use --sequencer-password or $ENV:VAR_NAME.',
            'CONFIGURATION',
            true,
            { existing: existingSequencers, flag: '--sequencer-password', target: targetSequencerCount }
          )
        }

        jsonCtx.info(`Adding ${targetSequencerCount - existingSequencers} new sequencer(s) to existing ${existingSequencers}...`)
        for (let i = existingSequencers; i < targetSequencerCount; i++) {
          sequencerData.push(await this.generateSequencerKeystore(i, password))
        }
      } else {
        // Keep existing sequencers as-is
        sequencerData = collectExistingSequencerData()
        jsonCtx.info(`Keeping ${sequencerData.length} existing sequencer(s)`)
      }
    } else {
      // Interactive mode - original behavior
      const changeSequencerKeys = await confirm({
        default: false,
        message: 'Do you want to change your sequencer keys?',
      })

      if (changeSequencerKeys) {
        const existingSequencers = countExistingSequencers()

        const backupCount = await textInput({
          default: '1',
          message: `How many backup sequencers do you want to run? (Current: ${Math.max(0, existingSequencers - 1)}, suggested: 1)`,
        })
        const totalSequencers = Number.parseInt(backupCount, 10) + 1

        if (existingSequencers > 0) {
          const action = await textInput({
            default: 'a',
            message: 'Do you want to (a)dd additional keystores or (o)verwrite existing ones?',
          })

          if (action.toLowerCase() === 'a') {
            sequencerData = collectExistingSequencerData()
            if (totalSequencers > existingSequencers) {
              for (let i = existingSequencers; i < totalSequencers; i++) {
                sequencerData.push(await this.generateSequencerKeystore(i))
              }
            } else {
              this.log(chalk.yellow(`You already have ${existingSequencers} sequencer(s). No new sequencers will be added.`))
            }
          } else if (action.toLowerCase() === 'o') {
            overwrite = true
            for (let i = 0; i < totalSequencers; i++) {
              sequencerData.push(await this.generateSequencerKeystore(i))
            }
          } else {
            this.error(chalk.red('Invalid option. Please run the command again and choose either (a)dd or (o)verwrite.'))
          }
        } else {
          for (let i = 0; i < totalSequencers; i++) {
            sequencerData.push(await this.generateSequencerKeystore(i))
          }
        }
      } else {
        sequencerData = collectExistingSequencerData()
      }
    }

    // ============ BOOTNODE HANDLING ============
    if (nonInteractive) {
      // Non-interactive mode: use flags to determine behavior
      const existingBootnodes = countExistingBootnodes()
      const targetBootnodeCount = flags['bootnode-count']
      overwriteBootnodes = flags['regenerate-bootnodes']

      if (overwriteBootnodes) {
        // Regenerate all bootnodes
        jsonCtx.info(`Regenerating ${targetBootnodeCount} bootnode(s)...`)
        for (let i = 0; i < targetBootnodeCount; i++) {
          bootnodeData.push({ nodekey: await this.generateBootnodeNodekey() })
        }
      } else if (existingBootnodes < targetBootnodeCount) {
        // Keep existing, generate additional
        bootnodeData = collectExistingBootnodeData()
        jsonCtx.info(`Adding ${targetBootnodeCount - existingBootnodes} new bootnode(s) to existing ${existingBootnodes}...`)
        for (let i = existingBootnodes; i < targetBootnodeCount; i++) {
          bootnodeData.push({ nodekey: await this.generateBootnodeNodekey() })
        }
      } else {
        // Keep existing bootnodes as-is
        bootnodeData = collectExistingBootnodeData()
        jsonCtx.info(`Keeping ${bootnodeData.length} existing bootnode(s)`)
      }
    } else {
      // Interactive mode - original behavior
      const changeBootnodeKeys = await confirm({
        default: false,
        message: 'Do you want to change your bootnode keys?',
      })

      if (changeBootnodeKeys) {
        const existingBootnodes = countExistingBootnodes()

        const bootnodeCount = await textInput({
          default: '2',
          message: `How many bootnodes do you want to run? (Current: ${existingBootnodes}, suggested: 2)`,
        })
        const totalBootnodes = Number.parseInt(bootnodeCount, 10)

        if (existingBootnodes > 0) {
          const action = await textInput({
            default: 'a',
            message: 'Do you want to (a)dd additional bootnode keys or (o)verwrite existing ones?',
          })

          if (action.toLowerCase() === 'a') {
            bootnodeData = collectExistingBootnodeData()
            if (totalBootnodes > existingBootnodes) {
              for (let i = existingBootnodes; i < totalBootnodes; i++) {
                bootnodeData.push({ nodekey: await this.generateBootnodeNodekey() })
              }
            } else {
              this.log(chalk.yellow(`You already have ${existingBootnodes} bootnode(s). No new bootnodes will be added.`))
            }
          } else if (action.toLowerCase() === 'o') {
            overwriteBootnodes = true
            for (let i = 0; i < totalBootnodes; i++) {
              bootnodeData.push({ nodekey: await this.generateBootnodeNodekey() })
            }
          } else {
            this.error(chalk.red('Invalid option. Please run the command again and choose either (a)dd or (o)verwrite.'))
          }
        } else {
          for (let i = 0; i < totalBootnodes; i++) {
            bootnodeData.push({ nodekey: await this.generateBootnodeNodekey() })
          }
        }
      } else {
        bootnodeData = collectExistingBootnodeData()
      }
    }

    // ============ ACCOUNT HANDLING ============
    const accounts: Record<string, KeyPair> = {}
    let ownerPrivateKey: string | undefined

    if (flags.accounts) {
      const accountTypes: string[] = []

      if (nonInteractive) {
        // Non-interactive mode: generate all account types by default
        accountTypes.push('L2_TESTNET_ACTIVITY_HELPER', 'DEPLOYER', 'L1_COMMIT_SENDER', 'L1_FINALIZE_SENDER', 'L1_GAS_ORACLE_SENDER', 'L2_GAS_ORACLE_SENDER')
        jsonCtx.info('Generating/collecting account key pairs...')
      } else {
        // Interactive mode - original behavior
        const generateAccounts = await confirm({
          default: true,
          message: 'Do you want to generate account key pairs?',
        })
        const isTestnetActivityHelper = await confirm({
          default: true,
          message: 'Do you want to generate a private key for the Testnet Activity Helper?',
        })

        if (isTestnetActivityHelper) {
          accountTypes.push('L2_TESTNET_ACTIVITY_HELPER')
        }

        if (generateAccounts) {
          this.log(chalk.blue('Generating account key pairs...'))
          accountTypes.push('DEPLOYER', 'L1_COMMIT_SENDER', 'L1_FINALIZE_SENDER', 'L1_GAS_ORACLE_SENDER', 'L2_GAS_ORACLE_SENDER')
        } else {
          this.log(chalk.yellow('Skipping account key pair generation...'))
        }
      }

      for (const accountType of accountTypes) {
        accounts[accountType] = existingConfig.accounts?.[`${accountType}_PRIVATE_KEY`] ? {
            address: existingConfig.accounts[`${accountType}_ADDR`],
            privateKey: existingConfig.accounts[`${accountType}_PRIVATE_KEY`],
          } : this.generateKeyPair();
      }

      // Handle OWNER address
      if (nonInteractive) {
        // Non-interactive: use existing OWNER_ADDR or generate new
        if (existingConfig.accounts?.OWNER_ADDR) {
          accounts.OWNER = { address: existingConfig.accounts.OWNER_ADDR, privateKey: '' }
          jsonCtx.info(`Using existing OWNER_ADDR: ${existingConfig.accounts.OWNER_ADDR}`)
        } else {
          accounts.OWNER = this.generateKeyPair()
          ownerPrivateKey = accounts.OWNER.privateKey
          jsonCtx.addWarning('Generated new OWNER wallet. Private key included in JSON output but NOT stored in config.toml. Save it securely!')
        }
      } else {
        // Interactive mode - original behavior
        const ownerAddress = await this.getOwnerAddress(existingConfig.accounts?.OWNER_ADDR)
        if (ownerAddress) {
          accounts.OWNER = { address: ownerAddress, privateKey: '' }
        } else {
          accounts.OWNER = this.generateKeyPair()
          ownerPrivateKey = accounts.OWNER.privateKey
          this.log(chalk.yellow('\n⚠️  IMPORTANT: Randomly generated Owner wallet'))
          this.log(chalk.yellow('Owner private key will not be stored in config.toml'))
          this.log(chalk.yellow('Please store this private key in a secure place:'))
          this.log(chalk.red(`OWNER_PRIVATE_KEY: ${accounts.OWNER.privateKey}`))
          this.log(chalk.yellow('You will need this key for future operations!\n'))
        }
      }

      // Display public addresses (only in interactive mode)
      if (!jsonMode) {
        this.log(chalk.cyan('\nGenerated public addresses:'))
        for (const [key, value] of Object.entries(accounts)) {
          this.log(chalk.cyan(`${key}_ADDR: ${value.address}`))
        }
      }
    }

    // ============ COORDINATOR JWT SECRET ============
    let coordinatorJwtSecretKey: string | undefined

    if (nonInteractive) {
      // Non-interactive: generate if not exists
      if (existingConfig.coordinator?.COORDINATOR_JWT_SECRET_KEY) {
        jsonCtx.info('Keeping existing COORDINATOR_JWT_SECRET_KEY')
      } else {
        coordinatorJwtSecretKey = this.generateRandomHex(32)
        jsonCtx.info('Generated new COORDINATOR_JWT_SECRET_KEY')
      }
    } else {
      // Interactive mode - original behavior
      const generateJwtSecret = await confirm({
        default: !existingConfig.coordinator?.COORDINATOR_JWT_SECRET_KEY,
        message: 'Do you want to generate a random COORDINATOR_JWT_SECRET_KEY?',
      })
      if (generateJwtSecret) {
        coordinatorJwtSecretKey = this.generateRandomHex(32)
        this.log(chalk.green(`Generated COORDINATOR_JWT_SECRET_KEY: ${coordinatorJwtSecretKey}`))
      }
    }

    // ============ UPDATE CONFIG ============
    let shouldUpdate = true
    if (!nonInteractive) {
      shouldUpdate = await confirm({ message: 'Do you want to update these values in config.toml?' })
    }

    if (shouldUpdate) {
      await this.updateConfigToml(
        sequencerData,
        bootnodeData,
        accounts,
        coordinatorJwtSecretKey,
        overwrite,
        overwriteBootnodes,
        jsonMode
      )
    }

    // ============ JSON OUTPUT ============
    if (jsonMode) {
      // Build response data
      const responseData: Record<string, unknown> = {
        accounts: {
          addresses: Object.fromEntries(
            Object.entries(accounts).map(([k, v]) => [k, v.address])
          ),
          generated: Object.keys(accounts),
        },
        bootnodes: {
          count: bootnodeData.length,
          regenerated: overwriteBootnodes,
        },
        configUpdated: shouldUpdate,
        coordinatorJwtSecretGenerated: Boolean(coordinatorJwtSecretKey),
        sequencers: {
          addresses: sequencerData.map(s => s.address),
          count: sequencerData.length,
          regenerated: overwrite,
        },
      }

      // Include owner private key if newly generated (critical for user to save)
      if (ownerPrivateKey) {
        responseData.ownerPrivateKey = ownerPrivateKey
      }

      jsonCtx.success(responseData)
    }
  }

  private async generateBootnodeNodekey(): Promise<string> {
    return Wallet.createRandom().privateKey.slice(2) // Remove '0x' prefix
  }

  private generateKeyPair(): KeyPair {
    const wallet = Wallet.createRandom()
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
    }
  }

  private generateRandomHex(bytes: number): string {
    return crypto.randomBytes(bytes).toString('hex')
  }

  private async generateSequencerKeystore(index: number, providedPassword: string = ''): Promise<SequencerData> {
    let password = providedPassword
    if (!password) {
       
      while (!password) {
        password = await input({ message: `Enter a password for sequencer-${index} keystore:` })
        if (!password) {
          console.log('Password cannot be empty. Please try again.')
        }
      }
    }

    const wallet = Wallet.createRandom()
    const encryptedJson = await wallet.encrypt(password)
    return {
      address: wallet.address,
      keystoreJson: encryptedJson,
      nodekey: Wallet.createRandom().privateKey.slice(2), // Remove '0x' prefix
      password,
    }
  }

  private getBootnodeEnodeUrl(nodekey: string, index: number): string {
    // Remove '0x' prefix if present
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey;

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey);

    // Get the public key
    const {publicKey} = wallet.signingKey;

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4);

    return `enode://${publicKeyNoPrefix}@l2-bootnode-${index}:30303`
  }

  private getEnodeUrl(nodekey: string, index: number): string {
    // Remove '0x' prefix if present
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey;

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey);

    // Get the public key
    const {publicKey} = wallet.signingKey;

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4);

    return `enode://${publicKeyNoPrefix}@l2-sequencer-${index}:30303`
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

  private async getOwnerAddress(existingOwnerAddr: string | undefined): Promise<string | undefined> {
    const useManualAddress = await confirm({
      default: Boolean(existingOwnerAddr),
      message: 'Do you want to manually provide an Owner wallet address?',
    })
    if (useManualAddress) {
      let ownerAddress: string | undefined
      while (!ownerAddress) {
        const input = await textInput({
          default: existingOwnerAddr,
          message: 'Enter the Owner wallet address:',
        })
        if (isAddress(input)) {
          ownerAddress = input
        } else {
          this.log(chalk.red('Invalid Ethereum address format. Please try again.'))
        }
      }

      return ownerAddress
    }

    return undefined
  }

  private async updateConfigToml(
    sequencerData: SequencerData[],
    bootnodeData: BootnodeData[],
    accounts: Record<string, KeyPair>,
    coordinatorJwtSecretKey?: string,
    overwriteSequencers: boolean = false,
    overwriteBootnodes: boolean = false,
    jsonMode: boolean = false
  ): Promise<void> {
    const existingConfig = await this.getExistingConfig()

    // Create a new object to store the updated config in memory
    const updatedConfig: Record<string, any> = {}

    // Helper function to add or update a section
    const addOrUpdateSection = (key: string, value: any) => {
      switch (key) {
      case 'sequencer': {
        updatedConfig[key] = value || {}
        const enodeUrls = sequencerData.map((data, index) => this.getEnodeUrl(data.nodekey, index))
        updatedConfig[key].L2_GETH_STATIC_PEERS = enodeUrls

        // If overwriting or no existing data, add the first sequencer data to the main sequencer section
        if ((overwriteSequencers || !updatedConfig[key].L2GETH_SIGNER_ADDRESS) && sequencerData.length > 0) {
            const firstSequencer = sequencerData[0]
            updatedConfig[key].L2GETH_SIGNER_ADDRESS = firstSequencer.address
            updatedConfig[key].L2GETH_KEYSTORE = firstSequencer.keystoreJson
            updatedConfig[key].L2GETH_PASSWORD = firstSequencer.password
            updatedConfig[key].L2GETH_NODEKEY = firstSequencer.nodekey
          }

        // If overwriting, remove all existing sequencer subsections
        if (overwriteSequencers) {
          for (const subKey of Object.keys(updatedConfig[key])) {
            if (subKey.startsWith('sequencer-')) {
              delete updatedConfig[key][subKey]
            }
          }
        }

        // Add sequencer subsections starting from sequencer-1
        for (const [index, data] of sequencerData.slice(1).entries()) {
          const subKey = `sequencer-${index + 1}`
          updatedConfig[key][subKey] = {
            L2GETH_KEYSTORE: data.keystoreJson,
            L2GETH_NODEKEY: data.nodekey,
            L2GETH_PASSWORD: data.password,
            L2GETH_SIGNER_ADDRESS: data.address,
          }
        }
      
      break;
      }

      case 'bootnode': {
        updatedConfig[key] = value || {}
        
        const bootnodeEnodeUrls = bootnodeData.map((data, index) => this.getBootnodeEnodeUrl(data.nodekey, index))
        updatedConfig[key].L2_GETH_PUBLIC_PEERS = bootnodeEnodeUrls

        // If overwriting, remove all existing bootnode subsections
        if (overwriteBootnodes) {
          for (const subKey of Object.keys(updatedConfig[key])) {
            if (subKey.startsWith('bootnode-')) {
              delete updatedConfig[key][subKey]
            }
          }
        }

        // Add bootnode subsections
        for (const [index, data] of bootnodeData.entries()) {
          const subKey = `bootnode-${index}`
          updatedConfig[key][subKey] = {
            L2GETH_NODEKEY: data.nodekey,
          }
        }
      
      break;
      }

      case 'accounts': {
        updatedConfig[key] = value || {}
        for (const [accountKey, accountValue] of Object.entries(accounts)) {
          if (accountKey === 'OWNER') {
            updatedConfig[key].OWNER_ADDR = accountValue.address
            delete updatedConfig[key].OWNER_PRIVATE_KEY
          } else {
            updatedConfig[key][`${accountKey}_PRIVATE_KEY`] = accountValue.privateKey
            updatedConfig[key][`${accountKey}_ADDR`] = accountValue.address
          }
        }
      
      break;
      }

      case 'coordinator': {
        updatedConfig[key] = value || {}
        if (coordinatorJwtSecretKey) {
          updatedConfig[key].COORDINATOR_JWT_SECRET_KEY = coordinatorJwtSecretKey
        }
      
      break;
      }

      default: {
        updatedConfig[key] = value
      }
      }
    }

    // Iterate through existing config to maintain order
    for (const [key, value] of Object.entries(existingConfig)) {
      addOrUpdateSection(key, value)
    }

    // Add new sections if they didn't exist in the original config
    if (!updatedConfig.sequencer) addOrUpdateSection('sequencer', null)
    if (!updatedConfig.bootnode) addOrUpdateSection('bootnode', null)
    if (!updatedConfig.accounts) addOrUpdateSection('accounts', null)
    if (coordinatorJwtSecretKey && !updatedConfig.coordinator) addOrUpdateSection('coordinator', null)

    // Use the atomic sync function to write both files
    const success = writeConfigs(updatedConfig, undefined, undefined, jsonMode);

    if (success) {
      if (!jsonMode) {
        this.log(chalk.green('config.toml and config.public.toml updated successfully.'))
      }
    } else {
      this.error(chalk.red('Configuration update failed. Check logs for details.'));
    }
  }
}