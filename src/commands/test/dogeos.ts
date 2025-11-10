import { Args, Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import { dogecoinMainnet, dogecoinTestnet, reverseHex } from '../../types/dogecoin.js'
import { parseTomlConfig } from '../../utils/config-parser.js'

import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory, ECPairAPI, ECPairInterface } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { randomBytes } from 'node:crypto'
import { execFile, ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'
import { Contract, ContractFactory, FunctionFragment, Interface, InterfaceAbi, JsonRpcProvider, Wallet } from 'ethers'

const execFileAsync = promisify(execFile)

const DEFAULT_HELPER_ABI: InterfaceAbi = [
  {
    type: 'constructor',
    inputs: [{ name: '_moat', type: 'address', internalType: 'address payable' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'receive',
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'moat',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address payable' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'mutiWithdrawal',
    inputs: [
      { name: 'count', type: 'uint256', internalType: 'uint256' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'target', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'setMoat',
    inputs: [{ name: '_moat', type: 'address', internalType: 'address payable' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
]

export interface Utxo {
  txid: string
  vout: number
  value: string // Value in dogetoshis as a string
  confirmations: number
}

export interface Tx {
  hex: string
  confirmations?: number
}

type ConfigToml = {
  frontend?: Record<string, unknown>
  general?: Record<string, unknown>
  contracts?: {
    verification?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Fetches UTXOs for a given address from a blockbook API.
 * @param address The Dogecoin address.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to an array of UTXOs.
 */
export async function getUtxos(address: string, blockbookUrl: string): Promise<Utxo[]> {
  const response = await fetch(`${blockbookUrl}/api/v2/utxo/${address}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch UTXOs: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Fetches the raw transaction hex for a given transaction ID.
 * @param txid The transaction ID.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the transaction object containing the hex.
 */
export async function getTx(txid: string, blockbookUrl: string): Promise<Tx> {
  const response = await fetch(`${blockbookUrl}/api/v2/tx/${txid}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch transaction: ${response.statusText}`)
  }
  return response.json()
}

/**
 * Broadcasts a raw transaction to the network via a blockbook API.
 * @param txHex The raw transaction hex string.
 * @param blockbookUrl The base URL of the blockbook API.
 * @returns A promise that resolves to the broadcast result, typically containing the txid.
 */
export async function broadcastTx(txHex: string, blockbookUrl: string): Promise<{ result: string }> {
  const response = await fetch(`${blockbookUrl}/api/v2/sendtx/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: txHex,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Failed to broadcast transaction: ${response.statusText} - ${errorBody}`)
  }

  return response.json()
}

interface BlockbookUtxo {
  confirmations?: number
  height?: number
  scriptPubKey?: string
  txid: string
  value: string
  vout: number
}

const ECPair: ECPairAPI = ECPairFactory(tinysecp)
type PsbtOutputParam = Parameters<bitcoin.Psbt['addOutput']>[0]
const DUST_LIMIT = 1n // 0.01 DOGE

interface HelperVerificationConfig {
  enabled: boolean
  apiKey?: string
  chainId?: string
}

interface HelperContractConfig {
  file?: string
  name?: string
  root?: string
  redeploy?: boolean
  verification: HelperVerificationConfig
}

export default class Case extends Command {
  static override description = 'describe the command here'

  static override examples = [
    '<%= config.bin %> <%= command.id %> multiple-opreturn',
    '<%= config.bin %> <%= command.id %> multiple-output --bridge=n...',
  ]

  moatAddress: string = '' //
  bridgeAddress: string = ''
  l2RPC: string = ''
  l2ExplorerUrl: string = ''
  l2ExplorerApiUrl: string = ''
  l2VerifierType: string = ''
  l2ChainId: string = ''
  // l1RPC: string = ''
  blockbookURL: string = ''
  masterWif: string = ''
  masterAddress: string = ''
  networkName: string = ''
  network: bitcoin.Network = dogecoinTestnet
  l2AddressPrivateKey = ''
  l2Address = ''

  static override flags = {
    masterwif: Flags.string({
      char: 'm',
      description: 'master wif key, provide test dogecoin',
      default: 'cftTTdqFUYi3Njx4VLZGATAFCuX8wetJddD71FGmC91wKJ2XidVY',
    }),
    blockbookurl: Flags.string({
      char: 'b',
      description: 'blockbook url',
      default: 'https://blockbook.qiaoxiaorui.org', // Sets a default URL
    }),
    outputcount: Flags.integer({
      char: 'c',
      description: 'Number of P2PKH outputs when running the multiple-output scenario',
      default: 24,
    }),
    outputvalue: Flags.string({
      char: 'v',
      description: 'Value per P2PKH output (in dogetoshis) when running the multiple-output scenario',
      default: '1000000',
    }),
    l2PrivateKey: Flags.string({
      description: '',
      default: '0x713137ab6bfaf197200b4f1e033bb3abadaf76564f6b2ca4f00aaa90c3c8efe5',
    }),
    verbose: Flags.boolean({
      description: 'Enable detailed verbose logging',
      default: false,
    }),
  }

  static override args = {
    caseName: Args.string({
      description: 'The name of the case to run',
      required: true,
      default: 'all',
    }),
  }

  public async loadConfig() {
    const { flags } = await this.parse(Case)
    const toString = (value: unknown): string => {
      if (typeof value === 'string') {
        return value.trim()
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toString()
      }
      return ''
    }
    const loadToml = (filePath: string, label: string): Record<string, unknown> | undefined => {
      if (!fs.existsSync(filePath)) {
        this.warn(`${label} not found at ${filePath}`)
        return undefined
      }

      try {
        return parseTomlConfig(filePath)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.warn(`Failed to parse ${label}: ${reason}`)
        return undefined
      }
    }

    const ensureHexKey = (value: string) => {
      if (!value) return value
      return value.startsWith('0x') ? value : `0x${value}`
    }

    const deriveAddressFromKey = (privateKey: string, fallbackAddress: string): string => {
      if (privateKey) {
        try {
          return new Wallet(privateKey).address
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.warn(`Failed to derive L2 sender address from private key: ${reason}`)
        }
      }
      return fallbackAddress
    }

    const loadJson = (filePath: string, label: string): Record<string, unknown> | undefined => {
      if (!fs.existsSync(filePath)) {
        this.warn(`${label} not found at ${filePath}`)
        return undefined
      }

      try {
        const contents = fs.readFileSync(filePath, 'utf8')
        return JSON.parse(contents)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.warn(`Failed to parse ${label}: ${reason}`)
        return undefined
      }
    }

    const maskSensitive = (value: string) => {
      if (!value) return ''
      if (value.length <= 12) return value
      return `${value.slice(0, 6)}...${value.slice(-4)}`
    }

    const configPath = path.resolve('config.toml')
    const contractsPath = path.resolve('config-contracts.toml')
    const testDataPath = path.resolve('.data', 'output-test-data.json')

    const config = loadToml(configPath, 'config.toml') as ConfigToml | undefined
    const contractsConfig = loadToml(contractsPath, 'config-contracts.toml')
    const outputTestData = loadJson(testDataPath, '.data/output-test-data.json')
    const frontendSection = config?.frontend
    const generalSection = config?.general
    const verificationSection = config?.contracts?.verification as Record<string, unknown> | undefined

    this.moatAddress = toString(contractsConfig?.L2_MOAT_PROXY_ADDR)
    this.bridgeAddress = toString(outputTestData?.bridge_address)
    this.l2RPC = toString(frontendSection?.EXTERNAL_RPC_URI_L2)
    this.l2ExplorerUrl = toString(verificationSection?.EXPLORER_URI_L2)
    this.l2ExplorerApiUrl = this.deriveExplorerApiUrl(this.l2ExplorerUrl)
    this.l2VerifierType = toString(verificationSection?.VERIFIER_TYPE_L2).toLowerCase()
    this.l2ChainId = toString(generalSection?.CHAIN_ID_L2)

    this.l2AddressPrivateKey = ensureHexKey(flags.l2PrivateKey || randomBytes(32).toString('hex'))
    this.l2Address = deriveAddressFromKey(this.l2AddressPrivateKey, '')

    this.blockbookURL = flags.blockbookurl
    this.masterWif = flags.masterwif

    const valuesPath = path.resolve('values', 'l1-interface-production.yaml')
    let networkFromValues = ''
    if (fs.existsSync(valuesPath)) {
      try {
        const valuesContents = fs.readFileSync(valuesPath, 'utf8')
        const parsedValues = yaml.load(valuesContents) as {
          configMaps?: { env?: { data?: Record<string, unknown> } }
        }
        const envData = parsedValues?.configMaps?.env?.data
        networkFromValues =
          typeof envData?.DOGEOS_L1_INTERFACE_NETWORK_STR === 'string'
            ? envData.DOGEOS_L1_INTERFACE_NETWORK_STR.trim()
            : ''
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.warn(`Failed to parse ${valuesPath}: ${reason}`)
      }
    } else {
      this.warn(`${valuesPath} not found; defaulting network to testnet`)
    }

    this.networkName = networkFromValues || 'testnet'
    const networkSource = networkFromValues ? 'values/l1-interface-production.yaml' : 'default'
    this.network = this.networkName === 'mainnet' ? dogecoinMainnet : dogecoinTestnet
    const mKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
    this.masterAddress = bitcoin.payments.p2pkh({ pubkey: mKeyPair.publicKey, network: this.network }).address || ''

    this.log(chalk.cyan('\nLoaded DogeOS test configuration:'))
    this.log(`  Network (${networkSource}): ${this.networkName}`)
    this.log(`  Blockbook URL: ${this.blockbookURL || 'N/A'}`)
    this.log(`  L2 RPC: ${this.l2RPC || 'N/A'}`)
    this.log(`  L2 Explorer: ${this.l2ExplorerUrl || 'N/A'}`)
    this.log(`  L2 Chain ID: ${this.l2ChainId || 'N/A'}`)
    this.log(`  L2 Verifier: ${this.l2VerifierType || 'default'}`)
    this.log(`  Bridge address: ${this.bridgeAddress || 'N/A'}`)
    this.log(`  Moat contract: ${this.moatAddress || 'N/A'}`)
    this.log(`  Master WIF: ${maskSensitive(this.masterWif) || 'N/A'}`)
    this.log(`  Master address:${this.masterAddress}`)
    this.log(`  l2Address: ${this.l2Address || 'N/A'}`)
    this.log(`  l2AddressPrivateKey: ${this.l2AddressPrivateKey || 'N/A'}`)
  }

  public async run(): Promise<void> {
    const { args } = await this.parse(Case)
    await this.loadConfig()
    this.log(chalk.bold.cyan(`\n🚀 Running test case: ${args.caseName}`))

    try {
      switch (args.caseName) {
        case 'multiple-opreturn': {
          await this.caseMultipleOpReturn()
          break
        }
        case 'multiple-output': {
          await this.caseMultipleOutput()
          break
        }
        case '3': {
          await this.caseBridgeUtxoAttack()
          break
        }
        case '4': {
          await this.caseMutipleWithdrawalPerTx()
          break
        }
        case 'all': {
          await this.caseMultipleOpReturn()
          await this.caseMultipleOutput()
          await this.caseBridgeUtxoAttack()
          await this.caseMutipleWithdrawalPerTx()
          break
        }
        default: {
          this.error(`Unknown case: ${args.caseName}`)
        }
      }
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ A critical error occurred during test execution.'))
      this.log(chalk.red(`   Error: ${error.message}`))
      const { flags } = await this.parse(Case)
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
    }
  }

  private readDeploymentCache(): Record<string, string> {
    const cachePath = path.resolve('.deployment-cache.json')
    if (!fs.existsSync(cachePath)) {
      return {}
    }
    try {
      const contents = fs.readFileSync(cachePath, 'utf8')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return JSON.parse(contents)
    } catch (error) {
      this.warn('Could not read or parse deployment cache file.')
      return {}
    }
  }

  private writeDeploymentCache(cache: Record<string, string>): void {
    const cachePath = path.resolve('.deployment-cache.json')
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2))
    } catch (error) {
      this.warn('Could not write to deployment cache file.')
    }
  }

  private async caseMutipleWithdrawalPerTx() {
    this.log(chalk.bold.cyan('\n✨ Starting: Multiple Withdrawal Per Tx Case'))
    const { flags } = await this.parse(Case)
    try {
      const helperConfig = this.getHelperContractConfig()
      const verificationConfig = helperConfig.verification

      let helperAbi: InterfaceAbi = DEFAULT_HELPER_ABI
      let deploymentBytecode = ''
      let helperConstructorArgs: unknown[] = [this.moatAddress]

      if (helperConfig.file) {
        if (!helperConfig.name) {
          this.error('DOGEOS_HELPER_CONTRACT_NAME is required when DOGEOS_HELPER_CONTRACT_FILE is provided.')
        }
        try {
          this.log(chalk.gray('-> Compiling helper contract with Forge...'))
          const artifacts = await this.compileHelperContract(helperConfig.file, helperConfig.name, helperConfig.root)
          helperAbi = artifacts.abi
          deploymentBytecode = artifacts.bytecode
          helperConstructorArgs = [this.moatAddress]
          this.log(chalk.green(`✅ Using Forge-compiled helper contract ${helperConfig.name}`))
        } catch (error) {
          throw new Error(`Failed to compile helper contract via Foundry: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (!this.l2RPC) this.error('L2 RPC endpoint is not configured.')
      if (!this.l2AddressPrivateKey) this.error('L2 sender private key is not configured.')

      const provider = new JsonRpcProvider(this.l2RPC)
      const wallet = new Wallet(this.l2AddressPrivateKey, provider)

      const { deploymentData, encodedConstructorArgs } = await this.buildHelperDeploymentArtifacts(
        helperAbi,
        deploymentBytecode,
        helperConstructorArgs,
        wallet,
      )

      const txRequest = { data: deploymentData }

      const cache = this.readDeploymentCache()
      const helperDiscriminator = helperConfig.file
        ? `${path.resolve(helperConfig.file)}:${helperConfig.name ?? 'unknown'}:${encodedConstructorArgs ?? 'noargs'}`
        : `builtin:${encodedConstructorArgs ?? 'noargs'}`
      const cacheKey = `mutiWithdrawal-${this.networkName || 'unknown'}-${helperDiscriminator}`
      let contractAddress = cache[cacheKey]?.trim() ?? ''
      let deployedThisRun = false

      if (helperConfig.redeploy) {
        this.log(chalk.yellow('⚠️ Helper redeploy requested; ignoring cached helper contract.'))
        contractAddress = ''
      }

      if (contractAddress) {
        this.log(chalk.green(`✅ Using cached multi-withdrawal helper contract at ${contractAddress}`))
      } else {
        this.log(chalk.gray('-> Deploying multi-withdrawal helper contract...'))
        const gasEstimate = await wallet.estimateGas(txRequest)
        const bufferedGas = (gasEstimate * 12n) / 10n // add 20% buffer
        const tx = await wallet.sendTransaction({ ...txRequest, gasLimit: bufferedGas })

        this.log(chalk.green(`✅ Deployment transaction submitted!`))
        this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(tx.hash)}
`)

        const receipt = await tx.wait()
        if (receipt?.contractAddress) {
          contractAddress = receipt.contractAddress
          cache[cacheKey] = contractAddress
          this.writeDeploymentCache(cache)
          this.log(chalk.green(`✅ Contract deployed at ${contractAddress}`))
          deployedThisRun = true
        } else {
          this.log(chalk.yellow('⚠️ Deployment transaction mined, but contract address is missing in the receipt.'))
        }
      }

      if (deployedThisRun && verificationConfig.enabled) {
        this.log(chalk.gray('-> Waiting 30 seconds for block explorer to index contract...'))
        await new Promise((resolve) => setTimeout(resolve, 30000))
        await this.verifyHelperContract(contractAddress, helperConfig, encodedConstructorArgs)
      } else if (verificationConfig.enabled && !deployedThisRun) {
        this.log(chalk.yellow('ℹ️ Helper verification skipped because cached deployment was reused.'))
      }

      const targetContract = contractAddress?.trim()
      if (!targetContract) this.error('Unable to determine helper contract address.')

      const amount = BigInt('1100000000000000000')

      let withdrawalTargetAddress = ''
      if (!this.masterAddress) this.error('masterAddress is not set; cannot derive targetAddress.')
      try {
        const decoded = bitcoin.address.fromBase58Check(this.masterAddress)
        withdrawalTargetAddress = `0x${Buffer.from(decoded.hash).toString('hex')}`
      } catch (error) {
        throw new Error(`Failed to decode masterAddress: ${error instanceof Error ? error.message : String(error)}`)
      }

      const mutiContract = new Contract(targetContract, helperAbi, wallet)

      if (flags.verbose) {
        this.log(chalk.dim(`   Withdrawal Target: ${withdrawalTargetAddress}`))
        this.log(chalk.dim(`   Moat Address: ${this.moatAddress}`))
      }

      const count = 2
      const { args: mutiArgs, txValue } = await this.prepareMutiWithdrawalCall(
        mutiContract,
        count,
        amount,
        this.moatAddress,
        withdrawalTargetAddress,
      )

      this.log(chalk.gray('-> Invoking mutiWithdrawal...'))
      const tx = await mutiContract.mutiWithdrawal(...mutiArgs, { value: txValue })
      this.log(chalk.green(`✅ mutiWithdrawal tx sent!`))
      this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(tx.hash)}
`)
      await tx.wait()
      this.log(chalk.green('✅ mutiWithdrawal transaction confirmed.'))
      this.log(chalk.green.bold('\n✨ Case Finished Successfully.'));
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ Case Failed: Multiple Withdrawal Per Tx'))
      this.log(chalk.red(`   Error: ${error.message}`))
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
      throw error // Re-throw to be caught by the main handler
    }
  }

  private async compileHelperContract(
    contractFile: string,
    contractName: string,
    foundryRoot?: string,
  ): Promise<{
    bytecode: string
    abi: InterfaceAbi
  }> {
    const resolvedFile = path.resolve(contractFile)
    const rootCandidate =
      (foundryRoot && path.resolve(foundryRoot)) ||
      this.findFoundryProjectRoot(path.dirname(resolvedFile)) ||
      path.dirname(resolvedFile)

    const relativeContractPathRaw = path.relative(rootCandidate, resolvedFile) || path.basename(resolvedFile)
    const relativeContractPath = this.normalizeForFoundryPath(relativeContractPathRaw)
    const contractSpecifier = `${relativeContractPath}:${contractName}`

    const bytecodeStdout = await this.runForgeInspect(contractSpecifier, 'bytecode', rootCandidate)
    const abiStdout = await this.runForgeInspect(contractSpecifier, 'abi', rootCandidate, true)

    let abi: InterfaceAbi
    try {
      abi = JSON.parse(abiStdout) as InterfaceAbi
    } catch {
      throw new Error(`Unable to parse ABI JSON emitted by forge for ${contractSpecifier}`)
    }

    const normalizedBytecode = bytecodeStdout.startsWith('0x') ? bytecodeStdout : `0x${bytecodeStdout}`
    if (normalizedBytecode.length <= 2) {
      throw new Error(`Forge produced empty bytecode for ${contractSpecifier}`)
    }

    return { abi, bytecode: normalizedBytecode }
  }

  private async runForgeInspect(
    contractSpecifier: string,
    field: 'abi' | 'bytecode',
    cwd: string,
    jsonOutput = false,
  ): Promise<string> {
    try {
      const args = ['inspect', contractSpecifier, field]
      if (jsonOutput) {
        args.unshift('--json')
      }
      const { stdout } = await execFileAsync('forge', args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
      return stdout.toString().trim()
    } catch (error) {
      const execError = error as ExecFileException & { stderr?: string }
      const stderr = execError?.stderr ? execError.stderr.toString().trim() : ''
      throw new Error(`forge inspect ${field} failed for ${contractSpecifier}${stderr ? `: ${stderr}` : ''}`)
    }
  }

  private findFoundryProjectRoot(startDir: string): string | undefined {
    let currentDir = path.resolve(startDir)
    while (true) {
      if (fs.existsSync(path.join(currentDir, 'foundry.toml'))) {
        return currentDir
      }
      const parent = path.dirname(currentDir)
      if (parent === currentDir) {
        return undefined
      }
      currentDir = parent
    }
  }

  private normalizeForFoundryPath(filePath: string): string {
    if (!filePath) {
      return ''
    }
    const normalized = filePath.split(path.sep).join(path.posix.sep)
    return normalized.startsWith('./') ? normalized.slice(2) : normalized
  }

  private getHelperContractConfig(): HelperContractConfig {
    const chainId = this.l2ChainId
    const verification: HelperVerificationConfig = {
      enabled: Boolean(chainId),
      apiKey: undefined,
      chainId,
    }

    const searchRoots = new Set<string>()
    searchRoots.add(process.cwd())
    if (this.config?.root) {
      searchRoots.add(path.resolve(this.config.root))
    }
    if (this.config?.configDir) {
      searchRoots.add(path.resolve(this.config.configDir, '..'))
    }
    if (this.config?.cacheDir) {
      searchRoots.add(path.resolve(this.config.cacheDir, '..'))
    }

    const relativeCandidates = [
      { segments: ['contracts', 'MultiWithdrawalHelper.sol'], name: 'MultiWithdrawalHelper' },
    ]

    for (const rootDir of Array.from(searchRoots)) {
      for (const candidate of relativeCandidates) {
        const absolutePath = path.resolve(rootDir, ...candidate.segments)
        if (fs.existsSync(absolutePath)) {
          return {
            file: absolutePath,
            name: candidate.name,
            root: this.findFoundryProjectRoot(path.dirname(absolutePath)) ?? path.dirname(absolutePath),
            redeploy: false,
            verification,
          }
        }
      }
    }

    return { redeploy: false, verification }
  }

  private async buildHelperDeploymentArtifacts(
    abi: InterfaceAbi,
    bytecode: string,
    constructorArgs: unknown[],
    wallet: Wallet,
  ): Promise<{ deploymentData: string; encodedConstructorArgs?: string }> {
    const normalizedBytecode = bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`

    if (constructorArgs.length === 0) {
      return { deploymentData: normalizedBytecode }
    }

    const factory = new ContractFactory(abi, normalizedBytecode, wallet)
    const deployTx = await factory.getDeployTransaction(...constructorArgs)
    const data = deployTx.data
    if (!data) {
      this.error('Failed to encode helper deployment data.')
    }

    let encodedConstructorArgs: string | undefined
    try {
      const iface = new Interface(abi)
      encodedConstructorArgs = iface.encodeDeploy(constructorArgs)
    } catch {
      encodedConstructorArgs = undefined
    }

    return {
      deploymentData: data,
      encodedConstructorArgs,
    }
  }

  private async prepareMutiWithdrawalCall(
    contract: Contract,
    count: number,
    amount: bigint,
    moatAddress: string,
    targetAddress: string,
  ): Promise<{ args: unknown[]; txValue: bigint }> {
    const totalValue = amount * BigInt(count)
    let fragment: FunctionFragment | null = null
    try {
      fragment = contract.interface.getFunction('mutiWithdrawal')
    } catch {
      this.error('Helper contract does not expose mutiWithdrawal()')
    }
    if (!fragment) {
      this.error('Helper contract does not expose mutiWithdrawal()')
    }

    const inputLength = fragment.inputs.length
    if (inputLength === 4) {
      return { args: [count, amount, moatAddress, targetAddress], txValue: totalValue }
    }

    if (inputLength === 3) {
      await this.ensureHelperMoatConfigured(contract, moatAddress)
      return { args: [count, amount, targetAddress], txValue: totalValue }
    }

    this.error(`Unsupported mutiWithdrawal signature with ${inputLength} parameters.`)
  }

  private async ensureHelperMoatConfigured(contract: Contract, moatAddress: string): Promise<void> {
    if (!moatAddress) {
      this.error('Moat address is required but missing; cannot configure helper contract.')
    }

    const normalize = (value: string) => value.toLowerCase()
    let currentMoat = ''
    const contractWithMoat = contract as Contract & { moat?: () => Promise<string> }
    if (typeof contractWithMoat.moat === 'function') {
      try {
        currentMoat = (await contractWithMoat.moat())?.trim() ?? ''
      } catch {
        // ignore read failures
      }
    }
    if (currentMoat && normalize(currentMoat) === normalize(moatAddress)) {
      return
    }

    try {
      contract.interface.getFunction('setMoat')
    } catch {
      this.error('Helper contract lacks setMoat() but requires moat configuration.')
    }

    this.log(chalk.gray(`-> Configuring helper contract moat address to ${moatAddress}...`))
    try {
      const contractWithSetter = contract as Contract & {
        setMoat?: (addr: string) => Promise<{ hash?: string; wait: () => Promise<unknown> }>
      }
      if (typeof contractWithSetter.setMoat !== 'function') {
        this.error('Helper contract exposes setMoat in ABI but function is not callable.')
      }
      const tx = await contractWithSetter.setMoat(moatAddress)
      this.log(chalk.green(`✅ setMoat transaction sent!`))
      this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(tx.hash)}
`)
      await tx.wait()
      this.log(chalk.green('✅ Moat address configured on helper contract.'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.error(`Failed to set moat address on helper contract: ${reason}`)
    }
  }

  private deriveExplorerApiUrl(baseUrl: string): string {
    const trimmed = (baseUrl || '').trim()
    if (!trimmed) return ''
    const sanitized = trimmed.replace(/\/+$/, '')
    return `${sanitized}/api`;
  }

  private async verifyHelperContract(
    address: string | undefined,
    helperConfig: HelperContractConfig,
    encodedConstructorArgs?: string,
  ): Promise<void> {
    const verification = helperConfig.verification
    if (!verification.enabled) return

    if (!address) {
      this.warn('Verification requested but no contract address was produced.')
      return
    }

    if (!helperConfig.file || !helperConfig.name) {
      this.warn('Verification requested but helper contract source file or name is missing.')
      return
    }

    const chainId = verification.chainId
    if (!chainId) {
      this.warn('Verification requested but could not determine chain ID; skipping.')
      return
    }

    const projectRoot =
      helperConfig.root ||
      this.findFoundryProjectRoot(path.dirname(helperConfig.file)) ||
      path.dirname(helperConfig.file)

    const relativeContractPathRaw = path.relative(projectRoot, helperConfig.file) || path.basename(helperConfig.file)
    const contractSpecifier = `${this.normalizeForFoundryPath(relativeContractPathRaw)}:${helperConfig.name}`

    const args = ['verify-contract', '--chain', chainId, address, contractSpecifier]
    if (verification.apiKey) {
      args.push('--etherscan-api-key', verification.apiKey)
    }
    if (encodedConstructorArgs) {
      args.push('--constructor-args', encodedConstructorArgs)
    }
    if (this.l2VerifierType) {
      args.push('--verifier', this.l2VerifierType)
    }
    if (this.l2ExplorerApiUrl) {
      args.push('--verifier-url', this.l2ExplorerApiUrl)
    }
    this.log(chalk.gray(`-> Submitting helper contract verification (${contractSpecifier}) on chain ${chainId}...`))
    this.log(chalk.dim(`   Running command: forge ${args.join(' ')}`))
    try {
      const { stdout } = await execFileAsync('forge', args, {
        cwd: projectRoot,
        maxBuffer: 10 * 1024 * 1024,
      })
      if (stdout?.toString().trim()) {
        this.log(stdout.toString().trim())
      }
      this.log(chalk.green('✅ Helper contract verification submitted to explorer.'))
    } catch (error) {
      const execError = error as ExecFileException & { stderr?: string }
      const stderr = execError?.stderr?.toString().trim()
      this.warn(
        `Helper contract verification failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
      )
    }
  }

  private async caseMultipleOpReturn() {
    this.log(chalk.bold.cyan('\n✨ Starting: Multiple OP_RETURN Case'))
    const { flags } = await this.parse(Case)
    try {
      const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)

      const opReturnData1 = new Uint8Array(Buffer.from('00d98f41da0f5b229729ed7bf469ea55d98d11f467', 'hex'))
      const opReturnData2 = new Uint8Array(Buffer.from('002eaf5e9022f7c99937ecba7925f1baa9d1bf75b2', 'hex'))
      const opReturnOutput1 = bitcoin.payments.embed({ data: [opReturnData1] })
      const opReturnOutput2 = bitcoin.payments.embed({ data: [opReturnData2] })

      const outputs: PsbtOutputParam[] = [
        { address: this.bridgeAddress, value: 2n * 100_000_000n },
        { script: opReturnOutput1.output!, value: 0n },
        { script: opReturnOutput2.output!, value: 0n },
      ]

      const txid = await this.buildAndBroadcastTx(masterKeyPair, outputs, flags.verbose)
      await this.waitForConfirmations(txid, this.blockbookURL)
      this.log(chalk.green.bold('\n✨ Case Finished Successfully.'));
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ Case Failed: Multiple OP_RETURN'))
      this.log(chalk.red(`   Error: ${error.message}`))
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
      throw error // Re-throw to be caught by the main handler
    }
  }

  private async caseMultipleOutput() {
    this.log(chalk.bold.cyan('\n✨ Starting: Multiple Output Case'))
    const { flags } = await this.parse(Case)
    try {
      const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
      const opReturnData1 = new Uint8Array(Buffer.from(this.l2Address.toLowerCase().replace('0x', '00'), 'hex'))
      const opReturnOutput1 = bitcoin.payments.embed({ data: [opReturnData1] })

      const outputCount = 24
      if (!Number.isSafeInteger(outputCount) || outputCount <= 0) {
        this.error('outputcount must be a positive safe integer.')
      }

      const outputValueRaw = flags.outputvalue ?? ''
      const sanitizedOutputValue = outputValueRaw.replace(/_/g, '')
      if (!/^\d+$/.test(sanitizedOutputValue)) {
        this.error('outputvalue must be a numeric string representing dogetoshis.')
      }
      const outputValue = BigInt(sanitizedOutputValue)
      if (outputValue < DUST_LIMIT) {
        this.error(`outputvalue must be at least ${DUST_LIMIT.toString()} dogetoshis.`) 
      }

      const outputs: PsbtOutputParam[] = [
        { script: opReturnOutput1.output!, value: 0n },
        { address: this.bridgeAddress, value: BigInt(1e8) },
      ]
      for (let i = 0; i < outputCount; i++) {
        outputs.push({ address: this.bridgeAddress, value: outputValue })
      }

      const txid = await this.buildAndBroadcastTx(masterKeyPair, outputs, flags.verbose)
      await this.waitForConfirmations(txid, this.blockbookURL)
      this.log(chalk.green.bold('\n✨ Case Finished Successfully.'));
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ Case Failed: Multiple Output'))
      this.log(chalk.red(`   Error: ${error.message}`))
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
      throw error
    }
  }

  private async caseBridgeUtxoAttack() {
    this.log(chalk.bold.cyan('\n✨ Starting: Bridge UTXO Attack Case'))
    const { flags } = await this.parse(Case)
    try {
      const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
      const agentKeyPair: ECPairInterface = ECPair.fromPrivateKey(new Uint8Array(randomBytes(32)))

      const outputs: PsbtOutputParam[] = []
      const outputValue = BigInt(1_000_000)
      const attackCount = 10
      const feeForDogeOs = 100_000_000n
      const feeForMiner = 1_000_000n

      const agentAddress = bitcoin.payments.p2pkh({ pubkey: agentKeyPair.publicKey, network: this.network }).address
      if (!agentAddress) this.error(`Agent address generation failed.`)

      for (let i = 0; i < attackCount; i++) {
        outputs.push({
          address: agentAddress,
          value: outputValue * 24n + feeForDogeOs + feeForMiner,
        })
      }

      this.log(chalk.gray('-> Phase 1: Broadcasting master transaction to fund agent...'))
      const txid = await this.buildAndBroadcastTx(masterKeyPair, outputs, flags.verbose)
      if (!txid) this.error(`Build and broadcast master->agent transaction failed.`)

      this.log(chalk.green('✅ Master transaction sent!'))
      this.log(`   ${chalk.blue('SoChain Link:')} https://sochain.com/tx/DOGETEST/${txid}`)

      const masterConfirmed = await this.waitForConfirmations(txid, this.blockbookURL)
      if (!masterConfirmed) {
        this.error(`Master transaction ${txid} did not confirm within the expected time.`) 
      }

      this.log(chalk.gray('-> Phase 2: Broadcasting agent attack transactions...'))
      const opReturnData = new Uint8Array(Buffer.from(this.l2Address.toLowerCase().replace('0x', '00'), 'hex'))
      const opReturnOutput = bitcoin.payments.embed({ data: [opReturnData] })
      const outputCount = flags.outputcount
      if (!Number.isSafeInteger(outputCount) || outputCount <= 0) {
        this.error('outputcount must be a positive safe integer.')
      }

      const txHex = (await getTx(txid, this.blockbookURL)).hex
      for (let i = 0; i < attackCount; i++) {
        const psbt = new bitcoin.Psbt({ network: this.network })
        psbt.addInput({
          hash: txid,
          index: i,
          nonWitnessUtxo: new Uint8Array(Buffer.from(txHex, 'hex')),
        })

        psbt.addOutput({ address: this.bridgeAddress, value: feeForDogeOs })
        psbt.addOutput({ script: opReturnOutput.output!, value: 0n })
        for (let j = 0; j < 24; j++) {
          psbt.addOutput({ address: this.bridgeAddress, value: outputValue })
        }

        psbt.signAllInputs(agentKeyPair)
        psbt.finalizeAllInputs()

        const finalTxHex = psbt.extractTransaction().toHex()
        const { result: txid2 } = await broadcastTx(finalTxHex, flags.blockbookurl)
        this.log(chalk.green(`✅ Agent tx ${i + 1}/${attackCount} sent!`))
        this.log(`   ${chalk.blue('SoChain Link:')} https://sochain.com/tx/DOGETEST/${txid2}`)
      }
      this.log(chalk.green.bold('\n✨ Case Finished Successfully.'));
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ Case Failed: Bridge UTXO Attack'))
      this.log(chalk.red(`   Error: ${error.message}`))
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
      throw error
    }
  }

  private async waitForConfirmations(
    txid: string,
    blockbookUrl: string,
    minConfirmations = 2,
    pollIntervalMs = 30_000,
    timeoutMs = 10 * 60_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    this.log(chalk.gray(`-> Waiting for ${minConfirmations} confirmations for tx ${txid}...`))

    while (Date.now() <= deadline) {
      try {
        const tx = await getTx(txid, blockbookUrl)
        const confirmations = tx.confirmations ?? 0
        if (confirmations >= minConfirmations) {
          this.log(chalk.green(`✅ Transaction ${txid} confirmed.`))
          return true
        }
        this.log(chalk.gray(`   Current: ${confirmations}/${minConfirmations}...`))
      } catch (error) {
        this.warn(`   ${chalk.yellow('⚠️ Failed to fetch confirmation status:')} ${(error as Error).message}`)
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollIntervalMs)
      })
    }
    this.log(chalk.red(`   Timeout reached waiting for confirmations for ${txid}.`))
    return false
  }

  private async buildAndBroadcastTx(keyPair: ECPairInterface, outputs: PsbtOutputParam[], verbose = false) {
    const FEE_RATE = 1000 // dogetoshis per vB
    const { address: senderAddress } = bitcoin.payments.p2pkh({
      pubkey: keyPair.publicKey,
      network: this.network,
    })
    if (!senderAddress) throw new Error('Could not derive sender address.')

    this.log(chalk.gray('-> Building and broadcasting transaction...'))
    if (verbose) this.log(chalk.dim(`   Sender address: ${senderAddress}`))

    this.log(chalk.gray('-> Fetching UTXOs...'))
    let utxos = await getUtxos(senderAddress, this.blockbookURL)
    if (utxos.length === 0) this.error(`No UTXOs found for address: ${senderAddress}`)

    utxos = utxos.filter((utxo) => utxo.confirmations > 1)
    if (utxos.length === 0) this.error('No UTXOs with more than 1 confirmation found.')
    this.log(chalk.green(`✅ Found ${utxos.length} spendable UTXOs.`))

    const totalOutputValue = outputs.reduce((sum, output) => sum + output.value, 0n)
    if (verbose) this.log(chalk.dim(`   Total output value: ${Number(totalOutputValue) / 1e8} DOGE`))

    const psbt = new bitcoin.Psbt({ network: this.network })
    const targetValue = totalOutputValue + DUST_LIMIT
    let totalInput = 0n
    for (const utxo of utxos) {
      if (totalInput >= targetValue) break
      totalInput += BigInt(utxo.value)
      const txHex = (await getTx(utxo.txid, this.blockbookURL)).hex
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: new Uint8Array(Buffer.from(txHex, 'hex')),
      })
    }
    if (verbose) this.log(chalk.dim(`   Total input value: ${Number(totalInput) / 1e8} DOGE`))

    for (const output of outputs) {
      psbt.addOutput(output)
    }

    const estimatedVSize = 10 + psbt.txInputs.length * 148 + (psbt.txOutputs.length + 1) * 34
    let fee = BigInt(estimatedVSize * FEE_RATE)

    let change = totalInput - totalOutputValue - fee
    if (change >= DUST_LIMIT) {
      psbt.addOutput({ address: senderAddress, value: change })
      const tempPsbt = psbt.clone()
      tempPsbt.signAllInputs(keyPair)
      tempPsbt.finalizeAllInputs()
      const finalVSize = tempPsbt.extractTransaction().virtualSize()
      fee = BigInt(finalVSize * FEE_RATE)
    }

    const totalNeeded = totalOutputValue + fee
    if (totalInput < totalNeeded) {
      this.error(
        `Insufficient funds. Found ${Number(totalInput) / 1e8} DOGE, but need at least ${Number(totalNeeded) / 1e8} DOGE.`,
      )
    }

    if (verbose) {
      this.log(chalk.dim(`   Calculated Fee: ${Number(fee) / 1e8} DOGE`))
      this.log(chalk.dim(`   Total Needed: ${Number(totalNeeded) / 1e8} DOGE`))
    }

    change = totalInput - totalNeeded
    if (change >= DUST_LIMIT) {
      const changeOutputIndex = psbt.txOutputs.findIndex((o) => o.address === senderAddress)
      if (changeOutputIndex !== -1) {
        psbt.txOutputs[changeOutputIndex].value = change
      } else {
        psbt.addOutput({ address: senderAddress, value: change })
      }
    }

    psbt.signAllInputs(keyPair)
    psbt.finalizeAllInputs()

    const finalTxHex = psbt.extractTransaction().toHex()
    this.log(chalk.gray('-> Broadcasting transaction...'))
    try {
      const { result: txid } = await broadcastTx(finalTxHex, this.blockbookURL)
      this.log(chalk.green(`✅ Transaction broadcasted successfully!`))
      this.log(`   ${chalk.blue('SoChain Link:')} https://sochain.com/tx/DOGETEST/${txid}`)
      return txid
    } catch (error) {
      this.error(error as Error)
    }
  }
}