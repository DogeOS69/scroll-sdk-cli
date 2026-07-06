/* eslint-disable @typescript-eslint/no-explicit-any, perfectionist/sort-classes -- Dynamic TOML config operations and lifecycle-oriented command helpers */
import * as toml from '@iarna/toml'
import { confirm, password as input, select, input as textInput } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { Wallet, ethers, isAddress } from 'ethers'
import * as yaml from 'js-yaml'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { writeConfigs } from '../../utils/config-writer.js'
import { loadDeploymentSpec } from '../../utils/deployment-spec-generator.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  type BlobArchivePlan,
  type KmsProvisionIdentity,
  normalizeEksClusterName,
  sanitizeName,
  truncateIamRoleName,
} from '../../utils/kms-signer-provisioner.js'
import {
  createNonInteractiveContext,
  resolveEnvValue,
} from '../../utils/non-interactive.js'
import {
  LEGACY_ACCOUNT_KEYS,
  MANAGED_SIGNER_KEYS,
  MANAGED_SIGNER_ROLES,
  type ManagedSignerBackend,
  type ManagedSignerConfig,
  type ManagedSignerKey,
  type ManagedSignerRole,
} from '../../utils/signer-roles.js'

const DEPLOYMENT_STATE_PATH = path.join('.data', 'deployment-state.yaml')

interface KeyPair {
  address: string
  privateKey?: string
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

interface PublicSequencerState {
  enodeUrl: string
  index: number
  signerAddress: string
}

interface PublicBootnodeState {
  enodeUrl: string
  index: number
}

interface DeploymentState {
  generatedAt: string
  l2: {
    bootnodes: PublicBootnodeState[]
    sequencers: PublicSequencerState[]
  }
}

interface KmsIdentityPromptDefaults {
  awsRegion?: string
  eksCluster?: string
  namespace?: string
  networkAlias?: string
}

interface ResolvedKmsSignerInput {
  kmsKeyId?: string
  roleArn?: string
  serviceAccount: string
}

export default class SetupGenKeystore extends Command {
  static override description = 'Generate L2 node keys and deployment account keypairs'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-accounts',
    '<%= config.bin %> <%= command.id %> --non-interactive',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --sequencer-count 2 --bootnode-count 2',
    '<%= config.bin %> <%= command.id %> --non-interactive --sequencer-count 2 --bootnode-count 2',
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
    'from-spec': Flags.string({
      description: 'Path to DeploymentSpec YAML. Uses infrastructure.sequencerCount and bootnodeCount as count defaults.',
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
      description: 'Password for sequencer keystores (or use $ENV:VAR_NAME pattern). Defaults to a generated random password for new sequencers in non-interactive mode.',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenKeystore) as any
    const nonInteractive = flags['non-interactive']
    const jsonMode = flags.json

    // Setup contexts for non-interactive/JSON mode
    createNonInteractiveContext('setup gen-keystore', nonInteractive, jsonMode)
    const jsonCtx = new JsonOutputContext('setup gen-keystore', jsonMode)

    const existingConfig = await this.getExistingConfig()
    jsonCtx.info('Setting up Sequencer keystores, bootnode nodekeys, and L2 account keypairs...')

    const fromSpecPath = flags['from-spec'] ? path.resolve(flags['from-spec']) : undefined
    let fromSpec: ReturnType<typeof loadDeploymentSpec> | undefined
    if (fromSpecPath) {
      try {
        fromSpec = loadDeploymentSpec(fromSpecPath)
      } catch (error) {
        jsonCtx.error(
          'E602_INVALID_SPEC',
          `Failed to load DeploymentSpec: ${error instanceof Error ? error.message : String(error)}`,
          'CONFIGURATION',
          true,
          { error: String(error), path: fromSpecPath }
        )
      }
    }

    if (fromSpecPath) {
      jsonCtx.info(`Using DeploymentSpec counts from ${fromSpecPath}`)
    }

    const targetSequencerCount = this.validateTargetCount(
      'sequencer',
      this.hasFlag('sequencer-count') ? flags['sequencer-count'] : fromSpec?.infrastructure?.sequencerCount ?? flags['sequencer-count'],
      1,
      jsonCtx
    )
    const targetBootnodeCount = this.validateTargetCount(
      'bootnode',
      this.hasFlag('bootnode-count') ? flags['bootnode-count'] : fromSpec?.infrastructure?.bootnodeCount ?? flags['bootnode-count'],
      0,
      jsonCtx
    )

    // Helper to count existing bootnodes
    const countExistingBootnodes = (): number => collectExistingBootnodeData().length

    // Helper to collect existing sequencer data
    const collectExistingSequencerData = (): SequencerData[] => {
      const data: SequencerData[] = []
      if (this.isCompleteSequencerConfig(existingConfig.sequencer)) {
        data.push({
          address: existingConfig.sequencer.L2GETH_SIGNER_ADDRESS,
          keystoreJson: existingConfig.sequencer.L2GETH_KEYSTORE,
          nodekey: existingConfig.sequencer.L2GETH_NODEKEY,
          password: existingConfig.sequencer.L2GETH_PASSWORD,
        })
      }

      if (existingConfig.sequencer) {
        for (const key of Object.keys(existingConfig.sequencer)) {
          if (key.startsWith('sequencer-') && this.isCompleteSequencerConfig(existingConfig.sequencer[key])) {
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

    // Helper to count existing sequencers
    const countExistingSequencers = (): number => collectExistingSequencerData().length

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

    const getSequencerPassword = (index: number): string => {
      const providedPassword = resolveEnvValue(flags['sequencer-password'])
      if (providedPassword) return providedPassword

      jsonCtx.info(`Generated random sequencer-${index} keystore password`)
      return crypto.randomBytes(24).toString('base64url')
    }

    // ============ SEQUENCER HANDLING ============
    if (nonInteractive) {
      // Non-interactive mode: use flags to determine behavior
      const existingSequencers = countExistingSequencers()
      overwrite = flags['regenerate-sequencers']

      if (overwrite) {
        // Regenerate all sequencers
        jsonCtx.info(`Regenerating ${targetSequencerCount} sequencer(s)...`)
        for (let i = 0; i < targetSequencerCount; i++) {
          const password = getSequencerPassword(i)
          sequencerData.push(await this.generateSequencerKeystore(i, password))
        }
      } else if (existingSequencers < targetSequencerCount) {
        // Keep existing, generate additional
        sequencerData = collectExistingSequencerData()

        jsonCtx.info(`Adding ${targetSequencerCount - existingSequencers} new sequencer(s) to existing ${existingSequencers}...`)
        for (let i = existingSequencers; i < targetSequencerCount; i++) {
          const password = getSequencerPassword(i)
          sequencerData.push(await this.generateSequencerKeystore(i, password))
        }
      } else {
        // Keep existing sequencers as-is
        sequencerData = collectExistingSequencerData()
        if (existingSequencers > targetSequencerCount) {
          jsonCtx.addWarning(`Found ${existingSequencers} existing sequencer(s), which is greater than target ${targetSequencerCount}; keeping existing keys. Use --regenerate-sequencers to rebuild exactly ${targetSequencerCount}.`)
        }

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
          default: String(Math.max(0, targetSequencerCount - 1)),
          message: `How many backup sequencers do you want to run? (Current: ${Math.max(0, existingSequencers - 1)}, suggested: ${Math.max(0, targetSequencerCount - 1)})`,
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
        if (existingBootnodes > targetBootnodeCount) {
          jsonCtx.addWarning(`Found ${existingBootnodes} existing bootnode(s), which is greater than target ${targetBootnodeCount}; keeping existing keys. Use --regenerate-bootnodes to rebuild exactly ${targetBootnodeCount}.`)
        }

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
          default: String(targetBootnodeCount),
          message: `How many bootnodes do you want to run? (Current: ${existingBootnodes}, suggested: ${targetBootnodeCount})`,
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
    const signerConfigs: Partial<Record<ManagedSignerKey, ManagedSignerConfig>> = {}

    if (flags.accounts) {
      jsonCtx.info('Generating/collecting deployment account key pairs and signer identities...')

      const generateDeployerAccount = nonInteractive || await confirm({
        default: !existingConfig.accounts?.DEPLOYER_PRIVATE_KEY,
        message: 'Do you want to generate/update DEPLOYER_PRIVATE_KEY?',
      })
      const generateTestnetActivityHelper = nonInteractive || await confirm({
        default: !existingConfig.accounts?.L2_TESTNET_ACTIVITY_HELPER_PRIVATE_KEY,
        message: 'Do you want to generate/update L2_TESTNET_ACTIVITY_HELPER_PRIVATE_KEY?',
      })
      if (generateTestnetActivityHelper) {
        accounts.L2_TESTNET_ACTIVITY_HELPER = this.getOrGenerateLocalAccount(existingConfig, 'L2_TESTNET_ACTIVITY_HELPER')
      }

      if (generateDeployerAccount) {
        accounts.DEPLOYER = this.getOrGenerateLocalAccount(existingConfig, 'DEPLOYER')
      }

      // Handle OWNER address
      const ownerAddress = await this.resolveOwnerAddress(existingConfig.accounts?.OWNER_ADDR, nonInteractive, jsonCtx)
      if (ownerAddress) {
        accounts.OWNER = { address: ownerAddress }
        jsonCtx.info(`Using OWNER_ADDR: ${ownerAddress}`)
      } else {
        this.log(chalk.yellow('Skipping OWNER_ADDR update.'))
      }

      // Display public addresses (only in interactive mode)
      if (!jsonMode) {
        this.logAccountAddresses(accounts, signerConfigs)
      }
    }

    // ============ UPDATE CONFIG ============
    let shouldUpdate = true
    let deploymentStateWritten = false
    if (!nonInteractive) {
      shouldUpdate = await confirm({ message: 'Do you want to update these values in config.toml?' })
    }

    if (shouldUpdate) {
      await this.updateConfigToml(
        sequencerData,
        bootnodeData,
        accounts,
        signerConfigs,
        overwrite,
        overwriteBootnodes,
        jsonMode
      )

      if (sequencerData.length > 0 || bootnodeData.length > 0) {
        this.writeDeploymentState(sequencerData, bootnodeData, jsonMode)
        deploymentStateWritten = true
      }
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
          enodeUrls: bootnodeData.map((data, index) => this.getBootnodeEnodeUrl(data.nodekey, index)),
          instances: this.getPublicBootnodeState(bootnodeData),
          regenerated: overwriteBootnodes,
        },
        configUpdated: shouldUpdate,
        deploymentStatePath: deploymentStateWritten ? DEPLOYMENT_STATE_PATH : undefined,
        fromSpec: fromSpecPath,
        sequencers: {
          addresses: sequencerData.map(s => s.address),
          count: sequencerData.length,
          enodeUrls: sequencerData.map((data, index) => this.getEnodeUrl(data.nodekey, index)),
          instances: this.getPublicSequencerState(sequencerData),
          regenerated: overwrite,
        },
        signers: signerConfigs,
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
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey)

    // Get the public key
    const { publicKey } = wallet.signingKey

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4)

    return `enode://${publicKeyNoPrefix}@l2-bootnode-${index}:30303`
  }

  private getEnodeUrl(nodekey: string, index: number): string {
    // Remove '0x' prefix if present
    nodekey = nodekey.startsWith('0x') ? nodekey.slice(2) : nodekey

    // Create a Wallet instance from the private key
    const wallet = new ethers.Wallet(nodekey)

    // Get the public key
    const { publicKey } = wallet.signingKey

    // Remove '0x04' prefix from public key
    const publicKeyNoPrefix = publicKey.slice(4)

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

  private getOptionalDogeConfig(jsonCtx: JsonOutputContext): DogeConfig | undefined {
    const configPath = path.resolve('.data/doge-config.toml')
    if (!fs.existsSync(configPath)) return undefined

    try {
      return toml.parse(fs.readFileSync(configPath, 'utf8')) as unknown as DogeConfig
    } catch (error) {
      jsonCtx.addWarning(`Could not parse ${configPath}. S3 archive IAM permissions will only use explicit --archive-bucket flags. ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private getOrGenerateLocalAccount(existingConfig: any, accountType: string): KeyPair {
    const privateKeyKey = `${accountType}_PRIVATE_KEY`
    const addressKey = `${accountType}_ADDR`
    const privateKey = existingConfig.accounts?.[privateKeyKey]
    const address = existingConfig.accounts?.[addressKey]
    if (privateKey && address) {
      return { address, privateKey }
    }

    return this.generateKeyPair()
  }

  private hasCompleteManagedSignerConfig(existingConfig: any): boolean {
    return MANAGED_SIGNER_KEYS.every((signerKey) => {
      const signer = existingConfig.signers?.[signerKey] as ManagedSignerConfig | undefined
      if (!signer?.backend) return false
      if (signer.backend === 'local') return true
      return Boolean(signer.expectedAddress && signer.kmsKeyId && signer.kmsRegion)
    })
  }

  private getDefaultKmsAlias(role: ManagedSignerRole, identity: KmsProvisionIdentity): string {
    return `alias/dogeos/${sanitizeName(identity.networkAlias)}/${sanitizeName(identity.eksCluster)}/${role.aliasSuffix}`
  }

  private getDefaultKmsRoleName(role: ManagedSignerRole, identity: KmsProvisionIdentity): string {
    return truncateIamRoleName(`dogeos-${sanitizeName(identity.networkAlias)}-${sanitizeName(identity.eksCluster)}-${role.roleSuffix}`)
  }

  private getKmsIdentityPromptDefaults(
    signerKeys: ManagedSignerKey[],
    existingKmsSigners: Partial<Record<ManagedSignerKey, ManagedSignerConfig>>
  ): KmsIdentityPromptDefaults {
    const defaults: KmsIdentityPromptDefaults = {}
    for (const signerKey of signerKeys) {
      const signer = existingKmsSigners[signerKey]
      if (!signer) continue

      defaults.awsRegion ||= signer.kmsRegion
      defaults.namespace ||= signer.namespace
      defaults.eksCluster ||= signer.eksCluster
      defaults.networkAlias ||= signer.networkAlias

      const role = MANAGED_SIGNER_ROLES[signerKey]
      const parsedAlias = this.parseDogeosKmsAlias(signer.kmsKeyId, role)
      defaults.eksCluster ||= parsedAlias?.eksCluster
      defaults.networkAlias ||= parsedAlias?.networkAlias
    }

    return defaults
  }

  private getSignerPurpose(role: ManagedSignerRole): string {
    return role.configKey === 'l1CommitSender'
      ? 'submits Ethereum DA transactions to L1'
      : 'updates the L2 fee oracle contract'
  }

  private isCompleteSequencerConfig(section: any): boolean {
    return Boolean(
      section?.L2GETH_SIGNER_ADDRESS &&
      section?.L2GETH_KEYSTORE &&
      section?.L2GETH_NODEKEY &&
      section?.L2GETH_PASSWORD
    )
  }

  private logAccountAddresses(
    accounts: Record<string, KeyPair>,
    signerConfigs: Partial<Record<ManagedSignerKey, ManagedSignerConfig>>
  ): void {
    if (Object.keys(accounts).length === 0) return

    this.log(chalk.cyan('\nSigner/account addresses to write:'))
    for (const [key, value] of Object.entries(accounts)) {
      this.log(chalk.cyan(`${key}_ADDR: ${value.address}${this.describeAccountAddress(key, signerConfigs)}`))
    }
  }

  private describeAccountAddress(
    accountKey: string,
    signerConfigs: Partial<Record<ManagedSignerKey, ManagedSignerConfig>>
  ): string {
    if (accountKey === 'OWNER') return ' (external owner)'
    if (accountKey === 'DEPLOYER') return ' (local private key, deploys L2 contracts)'
    if (accountKey === 'L2_TESTNET_ACTIVITY_HELPER') return ' (local private key, activity helper)'

    for (const signerKey of MANAGED_SIGNER_KEYS) {
      const role = MANAGED_SIGNER_ROLES[signerKey]
      if (accountKey !== role.role) continue

      const signerConfig = signerConfigs[signerKey]
      const backend = signerConfig?.backend === 'aws_kms' ? 'AWS KMS' : 'local private key'
      return ` (${backend}, ${role.service})`
    }

    return ''
  }

  private parseDogeosKmsAlias(kmsKeyId: string | undefined, role: ManagedSignerRole): KmsIdentityPromptDefaults | undefined {
    if (!kmsKeyId) return undefined

    const match = kmsKeyId.match(/^alias\/dogeos\/([^/]+)\/([^/]+)\/([^/]+)$/)
    if (!match || match[3] !== role.aliasSuffix) return undefined

    return {
      eksCluster: match[2],
      networkAlias: match[1],
    }
  }

  private logKmsProvisionPlan(
    signerKeys: ManagedSignerKey[],
    identity: KmsProvisionIdentity,
    inputs: Partial<Record<ManagedSignerKey, ResolvedKmsSignerInput>>,
    jsonCtx: JsonOutputContext
  ): void {
    jsonCtx.info('AWS KMS signer context:')
    jsonCtx.info(`  AWS region: ${identity.awsRegion}`)
    jsonCtx.info(`  EKS cluster: ${identity.eksCluster}`)
    jsonCtx.info(`  Kubernetes namespace: ${identity.namespace}`)
    jsonCtx.info(`  Resource alias: ${identity.networkAlias}`)

    jsonCtx.info('KMS signer setup plan:')
    for (const signerKey of signerKeys) {
      const role = MANAGED_SIGNER_ROLES[signerKey]
      const input = inputs[signerKey]
      const kmsKeyId = input?.kmsKeyId || this.getDefaultKmsAlias(role, identity)
      const roleArn = input?.roleArn
      const serviceAccount = input?.serviceAccount || role.defaultServiceAccount
      jsonCtx.info(`  ${role.service} (${role.role}):`)
      jsonCtx.info(`    purpose: ${this.getSignerPurpose(role)}`)
      jsonCtx.info(`    KMS key: ${kmsKeyId}`)
      jsonCtx.info(`    service account: ${identity.namespace}/${serviceAccount}`)
      jsonCtx.info(roleArn
        ? `    IAM role ARN: ${roleArn}`
        : `    IAM role name: ${this.getDefaultKmsRoleName(role, identity)}`)
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

  private async resolveSignerBackend(
    flags: any,
    existingConfig: any,
    signerKey: ManagedSignerKey,
    nonInteractive: boolean
  ): Promise<ManagedSignerBackend> {
    const flagName = signerKey === 'l1CommitSender'
      ? 'l1-commit-signer-backend'
      : 'l2-gas-oracle-signer-backend'
    const rawBackend = flags[flagName] || existingConfig.signers?.[signerKey]?.backend || 'local'
    const normalized = this.normalizeSignerBackend(rawBackend)

    if (nonInteractive) return normalized

    const role = MANAGED_SIGNER_ROLES[signerKey]
    return select({
      choices: [
        { name: 'Local private key (development)', value: 'local' },
        { name: 'AWS KMS (recommended production)', value: 'aws_kms' },
      ],
      default: normalized,
      message: `${role.role} / ${role.service} signer backend (${this.getSignerPurpose(role)}):`,
    })
  }

  private normalizeSignerBackend(value: string): ManagedSignerBackend {
    if (value === 'aws-kms' || value === 'aws_kms') return 'aws_kms'
    if (value === 'local') return 'local'

    throw new Error(`Unsupported signer backend: ${value}`)
  }

  private getCompleteExistingKmsSigner(existingConfig: any, signerKey: ManagedSignerKey): ManagedSignerConfig | undefined {
    const signer = existingConfig.signers?.[signerKey] as ManagedSignerConfig | undefined
    if (
      signer?.backend === 'aws_kms' &&
      signer.expectedAddress &&
      signer.kmsKeyId &&
      signer.kmsRegion
    ) {
      return signer
    }

    return undefined
  }

  private hasKmsProvisioningInput(flags: any, signerKey: ManagedSignerKey): boolean {
    return Boolean(
      flags['aws-region'] ||
      flags['eks-cluster'] ||
      flags['network-alias'] ||
      this.hasFlag('namespace') ||
      this.targetKmsKeyId(flags, signerKey) ||
      this.targetRoleArn(flags, signerKey) ||
      this.targetServiceAccountFlag(flags, signerKey) ||
      (
        signerKey === 'l1CommitSender' &&
        (
          flags['archive-bucket'] ||
          flags['archive-region'] ||
          flags['archive-key-prefix'] ||
          flags['disable-archive'] ||
          this.hasFlag('create-archive-bucket') ||
          this.hasFlag('no-create-archive-bucket')
        )
      )
    )
  }

  private shouldConfigureKmsSigner(
    flags: any,
    signerKey: ManagedSignerKey,
    existingSigner: ManagedSignerConfig | undefined,
    nonInteractive: boolean
  ): boolean {
    if (this.hasKmsProvisioningInput(flags, signerKey) || !existingSigner) return true
    return !nonInteractive
  }

  private async resolveKmsIdentity(
    flags: any,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext,
    defaults: KmsIdentityPromptDefaults = {}
  ): Promise<KmsProvisionIdentity> {
    const awsRegion = await this.resolveRequiredTextFlag(flags['aws-region'], defaults.awsRegion, 'AWS region for the EKS cluster and KMS keys:', '--aws-region', nonInteractive, jsonCtx)
    const eksCluster = await this.resolveRequiredTextFlag(flags['eks-cluster'], defaults.eksCluster, 'EKS cluster name or ARN for IRSA trust:', '--eks-cluster', nonInteractive, jsonCtx)
    const networkAlias = await this.resolveRequiredTextFlag(flags['network-alias'], defaults.networkAlias, 'Resource alias used in KMS aliases and IAM role names (for example devnet, testnet, staging):', '--network-alias', nonInteractive, jsonCtx)
    const namespace = await this.resolveNamespace(this.hasFlag('namespace') ? flags.namespace : undefined, defaults.namespace, nonInteractive)

    return {
      awsRegion,
      eksCluster: normalizeEksClusterName(eksCluster),
      namespace,
      networkAlias,
    }
  }

  private async resolveNamespace(value: string | undefined, defaultValue: string | undefined, nonInteractive: boolean): Promise<string> {
    const resolved = resolveEnvValue(value) || defaultValue || 'default'
    if (nonInteractive) return resolved.trim()

    return (await textInput({
      default: resolved.trim(),
      message: 'Kubernetes namespace for signer service accounts:',
      required: true,
    })).trim()
  }

  private async resolveRequiredTextFlag(
    value: string | undefined,
    defaultValue: string | undefined,
    message: string,
    flagName: string,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<string> {
    const resolved = resolveEnvValue(value)
    if (resolved) return resolved.trim()
    if (nonInteractive && defaultValue) return defaultValue.trim()

    if (nonInteractive) {
      jsonCtx.error(
        'E601_MISSING_FIELD',
        `${flagName} is required for AWS KMS signer provisioning.`,
        'CONFIGURATION',
        true,
        { flag: flagName }
      )
    }

    return (await textInput({ default: defaultValue, message, required: true })).trim()
  }

  private resolveKmsSignerInput(
    flags: any,
    signerKey: ManagedSignerKey,
    role: ManagedSignerRole,
    existingSigner: ManagedSignerConfig | undefined
  ): ResolvedKmsSignerInput {
    return {
      kmsKeyId: this.targetKmsKeyId(flags, signerKey) || existingSigner?.kmsKeyId,
      roleArn: this.targetRoleArn(flags, signerKey) || existingSigner?.serviceAccountRoleArn,
      serviceAccount: this.targetServiceAccountFlag(flags, signerKey) || existingSigner?.serviceAccountName || role.defaultServiceAccount,
    }
  }

  private async resolveBlobArchive(
    flags: any,
    awsRegion: string,
    dogeConfig: DogeConfig | undefined,
    nonInteractive: boolean,
    jsonCtx: JsonOutputContext
  ): Promise<BlobArchivePlan> {
    if (flags['disable-archive']) {
      return { created: false, enabled: false }
    }

    const flagBucket = resolveEnvValue(flags['archive-bucket'])
    const flagRegion = resolveEnvValue(flags['archive-region'])
    const flagKeyPrefix = resolveEnvValue(flags['archive-key-prefix'])
    const configuredArchive = this.getConfiguredBlobArchive(dogeConfig)

    const defaultBucket = flagBucket || configuredArchive?.bucket
    const defaultRegion = flagRegion || configuredArchive?.region || awsRegion
    const defaultKeyPrefix = flagKeyPrefix || configuredArchive?.keyPrefix || ''

    if (nonInteractive) {
      if (!defaultBucket) {
        if (flagRegion || flagKeyPrefix) {
          jsonCtx.addWarning('--archive-region and --archive-key-prefix were ignored because --archive-bucket was not provided and doge-config has no enabled S3 archive bucket.')
        }

        return { created: false, enabled: false }
      }

      return {
        bucket: defaultBucket,
        created: false,
        enabled: true,
        keyPrefix: defaultKeyPrefix || undefined,
        region: defaultRegion,
      }
    }

    const enabled = await confirm({
      default: Boolean(defaultBucket),
      message: 'Grant eth-da-submitter IAM role access to an S3 blob archive bucket?',
    })
    if (!enabled) return { created: false, enabled: false }

    const bucket = (await textInput({
      default: defaultBucket || '',
      message: 'S3 archive bucket name:',
      required: true,
    })).trim()
    const region = (await textInput({
      default: defaultRegion,
      message: 'S3 archive bucket region:',
      required: true,
    })).trim()
    const keyPrefix = (await textInput({
      default: defaultKeyPrefix,
      message: 'S3 object key prefix (optional):',
    })).trim()

    if (
      configuredArchive?.bucket &&
      (
        bucket !== configuredArchive.bucket ||
        region !== (configuredArchive.region || awsRegion) ||
        keyPrefix !== (configuredArchive.keyPrefix || '')
      )
    ) {
      jsonCtx.addWarning('S3 archive IAM target differs from .data/doge-config.toml. Update doge-config/chart values too if the runtime archive target should change.')
    }

    return {
      bucket,
      created: false,
      enabled: true,
      keyPrefix: keyPrefix || undefined,
      region,
    }
  }

  private getConfiguredBlobArchive(dogeConfig: DogeConfig | undefined): BlobArchivePlan | undefined {
    const s3 = dogeConfig?.ethereumDa?.blobArchive?.s3
    if (!s3 || !this.isConfigTruthy(s3.enabled) || !s3.bucket) return undefined

    return {
      bucket: String(s3.bucket),
      created: false,
      enabled: true,
      keyPrefix: this.optionalConfigString(s3.keyPrefix),
      region: this.optionalConfigString(s3.region),
    }
  }

  private isConfigTruthy(value: boolean | string | undefined): boolean {
    return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
  }

  private optionalConfigString(value: number | string | undefined): string | undefined {
    if (value === undefined || value === null || value === '') return undefined
    return String(value)
  }

  private targetKmsKeyId(flags: any, signerKey: ManagedSignerKey): string | undefined {
    return signerKey === 'l1CommitSender'
      ? resolveEnvValue(flags['eth-da-kms-key-id'])
      : resolveEnvValue(flags['fee-oracle-kms-key-id'])
  }

  private targetRoleArn(flags: any, signerKey: ManagedSignerKey): string | undefined {
    return signerKey === 'l1CommitSender'
      ? resolveEnvValue(flags['eth-da-role-arn'])
      : resolveEnvValue(flags['fee-oracle-role-arn'])
  }

  private targetServiceAccountFlag(flags: any, signerKey: ManagedSignerKey): string | undefined {
    if (signerKey === 'l1CommitSender') {
      return this.hasFlag('eth-da-service-account')
        ? resolveEnvValue(flags['eth-da-service-account'])
        : undefined
    }

    return this.hasFlag('fee-oracle-service-account')
      ? resolveEnvValue(flags['fee-oracle-service-account'])
      : undefined
  }

  private getPublicBootnodeState(bootnodeData: BootnodeData[]): PublicBootnodeState[] {
    return bootnodeData.map((data, index) => ({
      enodeUrl: this.getBootnodeEnodeUrl(data.nodekey, index),
      index,
    }))
  }

  private getPublicSequencerState(sequencerData: SequencerData[]): PublicSequencerState[] {
    return sequencerData.map((data, index) => ({
      enodeUrl: this.getEnodeUrl(data.nodekey, index),
      index,
      signerAddress: data.address,
    }))
  }

  private hasFlag(name: string): boolean {
    return this.argv.some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`))
  }

  private async updateConfigToml(
    sequencerData: SequencerData[],
    bootnodeData: BootnodeData[],
    accounts: Record<string, KeyPair>,
    signerConfigs: Partial<Record<ManagedSignerKey, ManagedSignerConfig>>,
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
        const shouldRewriteSequencers = overwriteSequencers || sequencerData.length > 0
        if (!shouldRewriteSequencers) break

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
        const shouldRewriteBootnodes = overwriteBootnodes || bootnodeData.length > 0
        if (!shouldRewriteBootnodes) break
        
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
        for (const legacyKey of LEGACY_ACCOUNT_KEYS) {
          delete updatedConfig[key][legacyKey]
        }

        for (const [accountKey, accountValue] of Object.entries(accounts)) {
          if (accountKey === 'OWNER') {
            updatedConfig[key].OWNER_ADDR = accountValue.address
            delete updatedConfig[key].OWNER_PRIVATE_KEY
          } else {
            if (accountValue.privateKey) {
              updatedConfig[key][`${accountKey}_PRIVATE_KEY`] = accountValue.privateKey
            }

            updatedConfig[key][`${accountKey}_ADDR`] = accountValue.address
          }
        }
      
      break;
      }

      case 'signers': {
        updatedConfig[key] = value || {}
        for (const [signerKey, signerConfig] of Object.entries(signerConfigs)) {
          if (signerConfig) {
            updatedConfig[key][signerKey] = signerConfig
          }
        }

      break;
      }

      case 'coordinator': {
        updatedConfig[key] = value || {}
        delete updatedConfig[key].COORDINATOR_JWT_SECRET_KEY
      
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
    if (Object.keys(signerConfigs).length > 0 && !updatedConfig.signers) addOrUpdateSection('signers', null)

    // Use the atomic sync function to write both files
    const success = writeConfigs(updatedConfig, undefined, undefined, jsonMode)

    if (success) {
      if (!jsonMode) {
        this.log(chalk.green('config.toml and config.public.toml updated successfully.'))
      }
    } else {
      this.error(chalk.red('Configuration update failed. Check logs for details.'))
    }
  }

  private validateTargetCount(
    name: 'bootnode' | 'sequencer',
    value: number,
    minimum: number,
    jsonCtx: JsonOutputContext
  ): number {
    if (!Number.isInteger(value) || value < minimum) {
      jsonCtx.error(
        'E602_INVALID_COUNT',
        `${name} count must be an integer greater than or equal to ${minimum}.`,
        'CONFIGURATION',
        true,
        { count: value }
      )
    }

    return value
  }

  private writeDeploymentState(
    sequencerData: SequencerData[],
    bootnodeData: BootnodeData[],
    jsonMode: boolean
  ): void {
    const state: DeploymentState = {
      generatedAt: new Date().toISOString(),
      l2: {
        bootnodes: this.getPublicBootnodeState(bootnodeData),
        sequencers: this.getPublicSequencerState(sequencerData),
      },
    }

    const dataDir = path.join(process.cwd(), '.data')
    fs.mkdirSync(dataDir, { recursive: true })
    const statePath = path.join(process.cwd(), DEPLOYMENT_STATE_PATH)
    fs.writeFileSync(statePath, yaml.dump(state, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
    }), 'utf8')

    if (!jsonMode) {
      this.log(chalk.green(`${DEPLOYMENT_STATE_PATH} updated with public L2 node metadata.`))
    }
  }
}
