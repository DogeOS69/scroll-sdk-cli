import { Command, Flags } from '@oclif/core'
import { Wallet, ethers } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import { confirm, password as input, input as textInput } from '@inquirer/prompts'
import * as toml from '@iarna/toml'
import chalk from 'chalk'
import { isAddress } from 'ethers'
import crypto from 'crypto'
import { writeConfigs } from '../../utils/config-writer.js'
import {
  createNonInteractiveContext,
  resolveConfirm,
  resolveEnvValue,
  type NonInteractiveContext,
} from '../../utils/non-interactive.js'
import { JsonOutputContext } from '../../utils/json-output.js'

interface KeyPair {
  privateKey: string
  address: string
}

interface SequencerData {
  address: string
  keystoreJson: string
  password: string
  nodekey: string
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
      description: 'Generate account key pairs',
      allowNo: true,
      default: true,
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      description: 'Run without prompts. Uses existing keys or generates new ones based on flags.',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
    'sequencer-count': Flags.integer({
      description: 'Number of sequencers (including primary). In non-interactive mode, generates if not enough exist.',
      default: 2,
    }),
    'bootnode-count': Flags.integer({
      description: 'Number of bootnodes. In non-interactive mode, generates if not enough exist.',
      default: 2,
    }),
    'regenerate-sequencers': Flags.boolean({
      description: 'Force regeneration of all sequencer keys (non-interactive mode)',
      default: false,
    }),
    'regenerate-bootnodes': Flags.boolean({
      description: 'Force regeneration of all bootnode keys (non-interactive mode)',
      default: false,
    }),
    'sequencer-password': Flags.string({
      description: 'Password for sequencer keystores (or use $ENV:VAR_NAME pattern in config). Required for new sequencers in non-interactive mode.',
    }),
  }

  private async getExistingConfig(): Promise<any> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error('config.toml not found in the current directory.')
      return {}
    }

    const configContent = fs.readFileSync(configPath, 'utf-8')
    return toml.parse(configContent) as any
  }

  private async generateSequencerKeystore(index: number, providedPassword?: string): Promise<SequencerData> {
    let password = providedPassword || ''
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
      password,
      nodekey: Wallet.createRandom().privateKey.slice(2), // Remove '0x' prefix
    }
  }

  private getEnodeUrl(nodekey: string, index: number): string {
    // Remove '0x' prefix if present
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey;

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey);

    // Get the public key
    const publicKey = wallet.signingKey.publicKey;

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4);

    return `enode://${publicKeyNoPrefix}@l2-sequencer-${index}:30303`
  }

  private getBootnodeEnodeUrl(nodekey: string, index: number): string {
    // Remove '0x' prefix if present
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey;

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey);

    // Get the public key
    const publicKey = wallet.signingKey.publicKey;

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4);

    return `enode://${publicKeyNoPrefix}@l2-bootnode-${index}:30303`
  }

  private generateKeyPair(): KeyPair {
    const wallet = Wallet.createRandom()
    return {
      privateKey: wallet.privateKey,
      address: wallet.address,
    }
  }

  private generateRandomHex(bytes: number): string {
    return crypto.randomBytes(bytes).toString('hex')
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
    const mainConfigPath = path.join(process.cwd(), 'config.toml')
    const publicConfigPath = path.join(process.cwd(), 'config.public.toml')
    const existingConfig = await this.getExistingConfig()

    // Create a new object to store the updated config in memory
    let updatedConfig: Record<string, any> = {}

    // Helper function to add or update a section
    const addOrUpdateSection = (key: string, value: any) => {
      if (key === 'sequencer') {
        updatedConfig[key] = value || {}
        const enodeUrls = sequencerData.map((data, index) => this.getEnodeUrl(data.nodekey, index))
        updatedConfig[key].L2_GETH_STATIC_PEERS = enodeUrls

        // If overwriting or no existing data, add the first sequencer data to the main sequencer section
        if (overwriteSequencers || !updatedConfig[key].L2GETH_SIGNER_ADDRESS) {
          if (sequencerData.length > 0) {
            const firstSequencer = sequencerData[0]
            updatedConfig[key].L2GETH_SIGNER_ADDRESS = firstSequencer.address
            updatedConfig[key].L2GETH_KEYSTORE = firstSequencer.keystoreJson
            updatedConfig[key].L2GETH_PASSWORD = firstSequencer.password
            updatedConfig[key].L2GETH_NODEKEY = firstSequencer.nodekey
          }
        }

        // If overwriting, remove all existing sequencer subsections
        if (overwriteSequencers) {
          Object.keys(updatedConfig[key]).forEach(subKey => {
            if (subKey.startsWith('sequencer-')) {
              delete updatedConfig[key][subKey]
            }
          })
        }

        // Add sequencer subsections starting from sequencer-1
        sequencerData.slice(1).forEach((data, index) => {
          const subKey = `sequencer-${index + 1}`
          updatedConfig[key][subKey] = {
            L2GETH_SIGNER_ADDRESS: data.address,
            L2GETH_KEYSTORE: data.keystoreJson,
            L2GETH_PASSWORD: data.password,
            L2GETH_NODEKEY: data.nodekey,
          }
        })
      } else if (key === 'bootnode') {
        updatedConfig[key] = value || {}
        
        const bootnodeEnodeUrls = bootnodeData.map((data, index) => this.getBootnodeEnodeUrl(data.nodekey, index))
        updatedConfig[key].L2_GETH_PUBLIC_PEERS = bootnodeEnodeUrls

        // If overwriting, remove all existing bootnode subsections
        if (overwriteBootnodes) {
          Object.keys(updatedConfig[key]).forEach(subKey => {
            if (subKey.startsWith('bootnode-')) {
              delete updatedConfig[key][subKey]
            }
          })
        }

        // Add bootnode subsections
        bootnodeData.forEach((data, index) => {
          const subKey = `bootnode-${index}`
          updatedConfig[key][subKey] = {
            L2GETH_NODEKEY: data.nodekey,
          }
        })
      } else if (key === 'accounts') {
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
      } else if (key === 'coordinator') {
        updatedConfig[key] = value || {}
        if (coordinatorJwtSecretKey) {
          updatedConfig[key].COORDINATOR_JWT_SECRET_KEY = coordinatorJwtSecretKey
        }
      } else {
        updatedConfig[key] = value
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

  private async getOwnerAddress(existingOwnerAddr: string | undefined): Promise<string | undefined> {
    const useManualAddress = await confirm({
      message: 'Do you want to manually provide an Owner wallet address?',
      default: !!existingOwnerAddr,
    })
    if (useManualAddress) {
      let ownerAddress: string | undefined
      while (!ownerAddress) {
        const input = await textInput({
          message: 'Enter the Owner wallet address:',
          default: existingOwnerAddr,
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

  private async generateBootnodeNodekey(): Promise<string> {
    return Wallet.createRandom().privateKey.slice(2) // Remove '0x' prefix
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenKeystore)
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json

    // Setup contexts for non-interactive/JSON mode
    const ctx = createNonInteractiveContext('setup gen-keystore', nonInteractive, jsonMode)
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
    const countExistingBootnodes = (): number => {
      return existingConfig.bootnode
        ? Object.keys(existingConfig.bootnode)
            .filter(key => key.startsWith('bootnode-'))
            .filter(key => {
              const section = existingConfig.bootnode[key]
              return section && section.L2GETH_NODEKEY !== ''
            })
            .length
        : 0
    }

    // Helper to collect existing sequencer data
    const collectExistingSequencerData = (): SequencerData[] => {
      const data: SequencerData[] = []
      if (existingConfig.sequencer?.L2GETH_SIGNER_ADDRESS) {
        data.push({
          address: existingConfig.sequencer.L2GETH_SIGNER_ADDRESS,
          keystoreJson: existingConfig.sequencer.L2GETH_KEYSTORE,
          password: existingConfig.sequencer.L2GETH_PASSWORD,
          nodekey: existingConfig.sequencer.L2GETH_NODEKEY,
        })
      }
      if (existingConfig.sequencer) {
        Object.keys(existingConfig.sequencer).forEach(key => {
          if (key.startsWith('sequencer-') && Object.values(existingConfig.sequencer[key]).some(value => value !== '')) {
            data.push({
              address: existingConfig.sequencer[key].L2GETH_SIGNER_ADDRESS,
              keystoreJson: existingConfig.sequencer[key].L2GETH_KEYSTORE,
              password: existingConfig.sequencer[key].L2GETH_PASSWORD,
              nodekey: existingConfig.sequencer[key].L2GETH_NODEKEY,
            })
          }
        })
      }
      return data
    }

    // Helper to collect existing bootnode data
    const collectExistingBootnodeData = (): BootnodeData[] => {
      const data: BootnodeData[] = []
      if (existingConfig.bootnode) {
        Object.keys(existingConfig.bootnode).forEach(key => {
          if (key.startsWith('bootnode-') && existingConfig.bootnode[key].L2GETH_NODEKEY) {
            data.push({
              nodekey: existingConfig.bootnode[key].L2GETH_NODEKEY,
            })
          }
        })
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
            { flag: '--sequencer-password', existing: existingSequencers, target: targetSequencerCount }
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
        message: 'Do you want to change your sequencer keys?',
        default: false,
      })

      if (changeSequencerKeys) {
        const existingSequencers = countExistingSequencers()

        const backupCount = await textInput({
          message: `How many backup sequencers do you want to run? (Current: ${Math.max(0, existingSequencers - 1)}, suggested: 1)`,
          default: '1',
        })
        const totalSequencers = parseInt(backupCount) + 1

        if (existingSequencers > 0) {
          const action = await textInput({
            message: 'Do you want to (a)dd additional keystores or (o)verwrite existing ones?',
            default: 'a',
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
        message: 'Do you want to change your bootnode keys?',
        default: false,
      })

      if (changeBootnodeKeys) {
        const existingBootnodes = countExistingBootnodes()

        const bootnodeCount = await textInput({
          message: `How many bootnodes do you want to run? (Current: ${existingBootnodes}, suggested: 2)`,
          default: '2',
        })
        const totalBootnodes = parseInt(bootnodeCount)

        if (existingBootnodes > 0) {
          const action = await textInput({
            message: 'Do you want to (a)dd additional bootnode keys or (o)verwrite existing ones?',
            default: 'a',
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
    let accounts: Record<string, KeyPair> = {}
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
          message: 'Do you want to generate account key pairs?',
          default: true,
        })
        const isTestnetActivityHelper = await confirm({
          message: 'Do you want to generate a private key for the Testnet Activity Helper?',
          default: true,
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
        if (!existingConfig.accounts?.[`${accountType}_PRIVATE_KEY`]) {
          accounts[accountType] = this.generateKeyPair()
        } else {
          accounts[accountType] = {
            privateKey: existingConfig.accounts[`${accountType}_PRIVATE_KEY`],
            address: existingConfig.accounts[`${accountType}_ADDR`],
          }
        }
      }

      // Handle OWNER address
      if (nonInteractive) {
        // Non-interactive: use existing OWNER_ADDR or generate new
        if (existingConfig.accounts?.OWNER_ADDR) {
          accounts.OWNER = { privateKey: '', address: existingConfig.accounts.OWNER_ADDR }
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
          accounts.OWNER = { privateKey: '', address: ownerAddress }
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
      if (!existingConfig.coordinator?.COORDINATOR_JWT_SECRET_KEY) {
        coordinatorJwtSecretKey = this.generateRandomHex(32)
        jsonCtx.info('Generated new COORDINATOR_JWT_SECRET_KEY')
      } else {
        jsonCtx.info('Keeping existing COORDINATOR_JWT_SECRET_KEY')
      }
    } else {
      // Interactive mode - original behavior
      const generateJwtSecret = await confirm({
        message: 'Do you want to generate a random COORDINATOR_JWT_SECRET_KEY?',
        default: !existingConfig.coordinator?.COORDINATOR_JWT_SECRET_KEY,
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
        sequencers: {
          count: sequencerData.length,
          regenerated: overwrite,
          addresses: sequencerData.map(s => s.address),
        },
        bootnodes: {
          count: bootnodeData.length,
          regenerated: overwriteBootnodes,
        },
        accounts: {
          generated: Object.keys(accounts),
          addresses: Object.fromEntries(
            Object.entries(accounts).map(([k, v]) => [k, v.address])
          ),
        },
        coordinatorJwtSecretGenerated: !!coordinatorJwtSecretKey,
        configUpdated: shouldUpdate,
      }

      // Include owner private key if newly generated (critical for user to save)
      if (ownerPrivateKey) {
        responseData.ownerPrivateKey = ownerPrivateKey
      }

      jsonCtx.success(responseData)
    }
  }
}