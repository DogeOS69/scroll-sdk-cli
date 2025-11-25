import { Args, Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'
import { dogecoinMainnet, dogecoinTestnet } from '../../types/dogecoin.js'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory, ECPairAPI, ECPairInterface } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { randomBytes, randomInt } from 'node:crypto'
import { Contract, FunctionFragment, InterfaceAbi, JsonRpcProvider, Wallet } from 'ethers'
import {
  broadcastTx,
  deriveAddressFromKey,
  ensureHexKey,
  getTx,
  getUtxos,
  loadJson,
  loadToml,
  maskSensitive,
  toString,
  waitForConfirmations,
} from '../../utils/dogeos-utils.js'
import { FoundryService, HelperContractConfig, HelperVerificationConfig } from '../../services/foundry-service.js'
import { select } from '@inquirer/prompts'

const TEST_CASES = [
  {
    id: '1',
    name: 'Multiple OP_RETURN',
    description: 'Send a transaction with multiple OP_RETURN outputs',
  },
  {
    id: '2',
    name: 'Multiple Output',
    description: 'Send a transaction with many P2PKH outputs',
  },
  {
    id: '3',
    name: 'Bridge UTXO Attack',
    description: 'Simulate a UTXO fan-out attack on the bridge',
  },
  {
    id: '4',
    name: 'Multiple Withdrawal Per Tx',
    description: 'Test multiple withdrawals in a single L2 transaction',
  },
  {
    id: '5',
    name: 'Large PSBT',
    description: 'Construct and broadcast a large transaction with many inputs',
  },
  {
    id: '6',
    name: 'Fee Wallet 2000 Inputs',
    description: 'Send M+1 to the fee wallet using 2000 inputs via an agent',
  },
  {
    id: '0',
    name: 'Run All Cases',
    description: 'Execute all test cases sequentially',
  },
]

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

type ConfigToml = {
  frontend?: Record<string, unknown>
  general?: Record<string, unknown>
  contracts?: {
    verification?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

const ECPair: ECPairAPI = ECPairFactory(tinysecp)
type PsbtOutputParam = Parameters<bitcoin.Psbt['addOutput']>[0]
const DUST_LIMIT = 1000000n // 0.01 DOGE
const RBF_SEQUENCE = 0xfffffffd

export default class Case extends Command {
  static override description = `Run DogeOS integration tests.
  
Available Test Cases:
${TEST_CASES.map((c) => `  - ${c.id}: ${c.name} - ${c.description}`).join('\n')}`

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> multiple-opreturn',
    '<%= config.bin %> <%= command.id %> multiple-output --bridge=n...',
  ]

  moatAddress: string = ''
  bridgeAddress: string = ''
  l2RPC: string = ''
  l2ExplorerUrl: string = ''
  l2ExplorerApiUrl: string = ''
  l2VerifierType: string = ''
  l2ChainId: string = ''
  blockbookURL: string = ''
  masterWif: string = ''
  masterAddress: string = ''
  networkName: string = ''
  network: bitcoin.Network = dogecoinTestnet
  l2AddressPrivateKey = ''
  l2Address = ''
  feeWalletAddress = ''

  // Services
  foundryService: FoundryService

  constructor(argv: string[], config: any) {
    super(argv, config)
    this.foundryService = new FoundryService(
      (msg) => this.log(msg),
      (msg) => this.warn(msg)
    )
  }

  static override flags = {
    masterwif: Flags.string({
      char: 'm',
      description: 'master wif key, provide test dogecoin',
      default: 'cftTTdqFUYi3Njx4VLZGATAFCuX8wetJddD71FGmC91wKJ2XidVY',
    }),
    blockbookurl: Flags.string({
      char: 'b',
      description: 'blockbook url',
      default: 'https://blockbook.qiaoxiaorui.org',
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
      required: false,
    }),
  }

  public async loadConfig() {
    const { flags } = await this.parse(Case)
    const warn = (msg: string) => this.warn(msg)

    const configPath = path.resolve('config.toml')
    const contractsPath = path.resolve('config-contracts.toml')
    const testDataPath = path.resolve('.data', 'output-test-data.json')

    const config = loadToml(configPath, 'config.toml', warn) as ConfigToml | undefined
    const contractsConfig = loadToml(contractsPath, 'config-contracts.toml', warn)
    const outputTestData = loadJson(testDataPath, '.data/output-test-data.json', warn)
    const frontendSection = config?.frontend
    const generalSection = config?.general
    const verificationSection = config?.contracts?.verification as Record<string, unknown> | undefined

    this.moatAddress = toString(contractsConfig?.L2_MOAT_PROXY_ADDR)
    this.bridgeAddress = toString(outputTestData?.bridge_address)
    this.feeWalletAddress = toString(outputTestData?.fee_wallet_address)
    this.l2RPC = toString(frontendSection?.EXTERNAL_RPC_URI_L2)
    this.l2ExplorerUrl = toString(verificationSection?.EXPLORER_URI_L2)
    this.l2ExplorerApiUrl = this.deriveExplorerApiUrl(this.l2ExplorerUrl)
    this.l2VerifierType = toString(verificationSection?.VERIFIER_TYPE_L2).toLowerCase()
    this.l2ChainId = toString(generalSection?.CHAIN_ID_L2)

    this.l2AddressPrivateKey = ensureHexKey(flags.l2PrivateKey || randomBytes(32).toString('hex'))
    this.l2Address = deriveAddressFromKey(this.l2AddressPrivateKey, '', warn)

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

    let selectedCase = args.caseName

    if (!selectedCase) {
      selectedCase = await select({
        message: 'Select a test case to run:',
        choices: TEST_CASES.map((c) => ({
          name: `${c.id}: ${c.name}`,
          value: c.id,
          description: c.description,
        })),
      })
    }

    this.log(chalk.bold.cyan(`\n🚀 Running test case: ${selectedCase}`))

    try {
      switch (selectedCase) {
        case '1': {
          await this.caseMultipleOpReturn()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '2': {
          await this.caseMultipleOutput()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '3': {
          await this.caseBridgeUtxoAttack()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '4': {
          await this.caseMutipleWithdrawalPerTx()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '5': {
          await this.caseLargePsbt()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '6': {
          await this.caseFeeWalletAgentConsolidation()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        case '0': {
          await this.caseMultipleOpReturn()
          await this.sendL2SelfTxWithRandomData()
          await this.caseMultipleOutput()
          await this.sendL2SelfTxWithRandomData()
          await this.caseBridgeUtxoAttack()
          await this.sendL2SelfTxWithRandomData()
          await this.caseMutipleWithdrawalPerTx()
          await this.sendL2SelfTxWithRandomData()
          await this.caseLargePsbt()
          await this.sendL2SelfTxWithRandomData()
          await this.caseFeeWalletAgentConsolidation()
          await this.sendL2SelfTxWithRandomData()
          break
        }
        default: {
          this.error(`Unknown case: ${selectedCase}`)
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
          const artifacts = await this.foundryService.compileHelperContract(helperConfig.file, helperConfig.name, helperConfig.root)
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

      const { deploymentData, encodedConstructorArgs } = await this.foundryService.buildHelperDeploymentArtifacts(
        helperAbi,
        deploymentBytecode,
        helperConstructorArgs,
        wallet,
      )


      const txRequest = { data: deploymentData }

      this.log(chalk.gray('-> Deploying multi-withdrawal helper contract...'))
      const gasEstimate = await wallet.estimateGas(txRequest)
      const bufferedGas = (gasEstimate * 12n) / 10n // add 20% buffer
      const tx = await wallet.sendTransaction({ ...txRequest, gasLimit: bufferedGas })

      this.log(chalk.green(`✅ Deployment transaction submitted!`))
      this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(tx.hash)}\n`)

      let contractAddress = ''
      const receipt = await tx.wait()
      if (receipt?.contractAddress) {
        contractAddress = receipt.contractAddress
        this.log(chalk.green(`✅ Contract deployed at ${contractAddress}`))
      } else {
        this.log(chalk.yellow('⚠️ Deployment transaction mined, but contract address is missing in the receipt.'))
      }

      if (contractAddress && verificationConfig.enabled) {
        this.log(chalk.gray('-> Waiting 30 seconds for block explorer to index contract...'))
        await new Promise((resolve) => setTimeout(resolve, 10000))
        await this.foundryService.verifyHelperContract(
          contractAddress,
          helperConfig,
          encodedConstructorArgs,
          this.l2VerifierType,
          this.l2ExplorerApiUrl
        )
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

      const balance = await wallet.provider!.getBalance(wallet.address)
      if (balance < txValue) {
        await this.rechargeL2Wallet(txValue, balance)
      }

      this.log(chalk.gray('-> Invoking mutiWithdrawal...'))
      const withdrawalTx = await mutiContract.mutiWithdrawal(...mutiArgs, { value: txValue })
      this.log(chalk.green(`✅ mutiWithdrawal tx sent!`))
      this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(withdrawalTx.hash)}
`)
      await withdrawalTx.wait()
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

  private getHelperContractConfig(): HelperContractConfig {
    const chainId = this.l2ChainId
    const verification: HelperVerificationConfig = {
      enabled: Boolean(chainId),
      apiKey: undefined,
      chainId,
    }

    const searchRoots = new Set<string>()
    searchRoots.add(process.cwd())
    // @ts-ignore
    if (this.config?.root) {
      // @ts-ignore
      searchRoots.add(path.resolve(this.config.root))
    }
    // @ts-ignore
    if (this.config?.configDir) {
      // @ts-ignore
      searchRoots.add(path.resolve(this.config.configDir, '..'))
    }
    // @ts-ignore
    if (this.config?.cacheDir) {
      // @ts-ignore
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
            root: this.foundryService.findFoundryProjectRoot(path.dirname(absolutePath)) ?? path.dirname(absolutePath),
            redeploy: false,
            verification,
          }
        }
      }
    }

    return { redeploy: false, verification }
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
      await waitForConfirmations(txid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
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
      await waitForConfirmations(txid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
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

      const masterConfirmed = await waitForConfirmations(txid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
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
          sequence: RBF_SEQUENCE,
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

  private async caseFeeWalletAgentConsolidation() {
    this.log(chalk.bold.cyan('\n✨ Starting: Fee Wallet 2000 Inputs Case'))
    const { flags } = await this.parse(Case)
    try {
      if (!this.feeWalletAddress) this.error('feeWalletAddress is not configured.')
      this.log(chalk.gray(`-> Fetching UTXOs for fee wallet ${this.feeWalletAddress}...`))
      const feeWalletUtxos = await getUtxos(this.feeWalletAddress, this.blockbookURL)
      const confirmedUtxos = feeWalletUtxos.filter((utxo) => utxo.confirmations > 0)
      if (confirmedUtxos.length === 0) this.error('No confirmed UTXOs found for the fee wallet.')

      let largestValue = 0n
      for (const utxo of confirmedUtxos) {
        const value = BigInt(utxo.value)
        if (value > largestValue) largestValue = value
      }
      if (largestValue <= 0n) this.error('Unable to determine the largest UTXO value for the fee wallet.')
      const targetValue = largestValue + 1n
      this.log(chalk.green(`✅ Largest UTXO: ${largestValue.toString()} dogetoshis. Target send value: ${targetValue.toString()} dogetoshis.`))

      const agentKeyPair: ECPairInterface = ECPair.fromPrivateKey(new Uint8Array(randomBytes(32)), { network: this.network })
      const agentAddress = bitcoin.payments.p2pkh({ pubkey: agentKeyPair.publicKey, network: this.network }).address
      if (!agentAddress) this.error('Agent address generation failed.')

      const inputCount = 2000
      const FEE_RATE = 1000n // dogetoshis per vB
      const estimatedVSize = 10n + BigInt(inputCount) * 148n + 2n * 34n
      const estimatedFee = estimatedVSize * FEE_RATE
      const totalNeeded = targetValue + estimatedFee + DUST_LIMIT
      let perOutputValue = totalNeeded / BigInt(inputCount)
      if (totalNeeded % BigInt(inputCount) !== 0n) perOutputValue += 1n
      if (perOutputValue < DUST_LIMIT) perOutputValue = DUST_LIMIT
      const totalFunding = perOutputValue * BigInt(inputCount)

      if (flags.verbose) {
        this.log(chalk.dim(`   Funding per UTXO: ${perOutputValue.toString()} dogetoshis`))
        this.log(chalk.dim(`   Total funding to agent: ${totalFunding.toString()} dogetoshis`))
      }

      const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
      const fundingOutputs: PsbtOutputParam[] = Array.from({ length: inputCount }, () => ({
        address: agentAddress,
        value: perOutputValue,
      }))

      this.log(chalk.gray(`-> Funding agent with ${inputCount} outputs...`))
      const fundingTxid = await this.buildAndBroadcastTx(masterKeyPair, fundingOutputs, flags.verbose)
      if (!fundingTxid) this.error('Funding transaction failed to broadcast.')

      this.log(chalk.gray('-> Waiting for funding confirmation...'))
      const fundingConfirmed = await waitForConfirmations(fundingTxid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
      if (!fundingConfirmed) this.error(`Funding transaction ${fundingTxid} did not confirm within the expected time.`)

      const fundingTxHex = (await getTx(fundingTxid, this.blockbookURL)).hex
      const fundingTxBuffer = new Uint8Array(Buffer.from(fundingTxHex, 'hex'))

      this.log(chalk.gray('-> Building 2000-input agent transaction...'))
      const psbt = new bitcoin.Psbt({ network: this.network })
      const logEvery = 200
      for (let i = 0; i < inputCount; i++) {
        psbt.addInput({
          hash: fundingTxid,
          index: i,
          sequence: RBF_SEQUENCE,
          nonWitnessUtxo: fundingTxBuffer,
        })
        if ((i + 1) % logEvery === 0) {
          this.log(chalk.dim(`   Added inputs: ${i + 1}/${inputCount}`))
        }
      }
      this.log(chalk.dim('   Finished adding all inputs.'))
      psbt.addOutput({ address: this.feeWalletAddress, value: targetValue })
      this.log(chalk.dim('   Added primary output to fee wallet.'))

      const totalInput = totalFunding
      const estimatedVSizeWithChange = 10n + BigInt(psbt.txInputs.length) * 148n + (BigInt(psbt.txOutputs.length) + 1n) * 34n
      let fee = estimatedVSizeWithChange * FEE_RATE
      let change = totalInput - targetValue - fee
      this.log(
        chalk.dim(
          `   Fee estimation -> estVSizeWithChange: ${estimatedVSizeWithChange} vbytes, estFee: ${fee.toString()}, initial change: ${change.toString()}`,
        ),
      )
      if (change < 0n) {
        this.error('Insufficient funding to cover target amount and fees for the agent transaction.')
      }

      let includeChange = false
      if (change >= DUST_LIMIT) {
        includeChange = true
        psbt.addOutput({ address: agentAddress, value: change })
        // Avoid re-signing 2000 inputs for fee estimation; use rough vsize with change output.
        const estVSizeWithChange = 10n + BigInt(psbt.txInputs.length) * 148n + BigInt(psbt.txOutputs.length) * 34n
        fee = estVSizeWithChange * FEE_RATE
        change = totalInput - targetValue - fee
        if (change >= DUST_LIMIT) {
          psbt.txOutputs[psbt.txOutputs.length - 1].value = change
        } else {
          includeChange = false
          psbt.txOutputs.pop()
          fee = totalInput - targetValue
          change = 0n
        }
      } else {
        fee = totalInput - targetValue
      }

      this.log(chalk.gray('-> Signing inputs...'))
      for (let i = 0; i < inputCount; i++) {
        psbt.signInput(i, agentKeyPair)
        if ((i + 1) % logEvery === 0) {
          this.log(chalk.dim(`   Signed inputs: ${i + 1}/${inputCount}`))
        }
      }
      this.log(chalk.dim('   Finished signing all inputs. Finalizing...'))
      psbt.finalizeAllInputs()
      const finalTx = psbt.extractTransaction()
      this.log(chalk.dim(`   Final tx virtual size: ${finalTx.virtualSize()} vbytes`))
      const outputsTotal = finalTx.outs.reduce((sum, out) => sum + BigInt(out.value), 0n)
      const finalFee = totalInput - outputsTotal

      if (flags.verbose) {
        this.log(chalk.dim(`   Final fee: ${finalFee.toString()} dogetoshis`))
        this.log(chalk.dim(`   Change to agent: ${includeChange ? change.toString() : '0'}`))
      }

      const finalTxHex = finalTx.toHex()
      this.log(chalk.gray('-> Broadcasting agent consolidation transaction...'))
      const { result: txid } = await broadcastTx(finalTxHex, this.blockbookURL)
      this.log(chalk.green(`✅ Agent consolidation transaction broadcasted!`))
      this.log(`   ${chalk.blue('SoChain Link:')} https://sochain.com/tx/DOGETEST/${txid}`)
      await waitForConfirmations(txid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
      this.log(chalk.green.bold('\n✨ Case Finished Successfully.'));
    } catch (error: any) {
      this.log(chalk.red.bold('\n❌ Case Failed: Fee Wallet 2000 Inputs'))
      this.log(chalk.red(`   Error: ${error.message}`))
      if (flags.verbose) {
        this.log(chalk.dim(error.stack))
      }
      throw error
    }
  }

  private async sendL2SelfTxWithRandomData(sizeBytes = 110 * 1024) {
    if (!this.l2RPC || !this.l2AddressPrivateKey) {
      this.warn('L2 RPC or L2 private key is missing; skipping L2 self-transfer.')
      return
    }

    const provider = new JsonRpcProvider(this.l2RPC)
    const wallet = new Wallet(this.l2AddressPrivateKey, provider)

    const payload = randomBytes(sizeBytes)
    const dataHex = `0x${payload.toString('hex')}`

    this.log(chalk.gray(`-> Sending L2 self-transfer with ${sizeBytes} bytes of data...`))
    const txRequest = { to: wallet.address, value: 0, data: dataHex }
    const gasEstimate = await wallet.estimateGas(txRequest)
    const gasLimit = (gasEstimate * 12n) / 10n
    const tx = await wallet.sendTransaction({ ...txRequest, gasLimit })

    this.log(chalk.green(`✅ L2 self-transfer submitted: ${tx.hash}`))
    await tx.wait()
    this.log(chalk.green('✅ L2 self-transfer confirmed.'))
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
        sequence: RBF_SEQUENCE,
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

  private async rechargeL2Wallet(requiredWei: bigint, currentWei: bigint) {
    this.log(chalk.yellow('⚠️ Insufficient L2 balance. Initiating auto-recharge...'))
    const deficitWei = requiredWei - currentWei
    // Convert Wei to Dogetoshis. 1 Doge (10^8 sat) = 1 ETH (10^18 wei)
    // 1 sat = 10^10 wei
    // dogetoshis = ceil(wei / 10^10)
    const conversionRate = 10_000_000_000n
    let deficitDogetoshis = deficitWei / conversionRate
    if (deficitWei % conversionRate > 0n) deficitDogetoshis += 1n

    // Add buffer and fee. User mentioned 1 coin fee.
    // Let's add 50 Doge buffer to be safe + 1 Doge fee.
    const bufferDoges = 50n
    const feeDoges = 1n
    const amountDogetoshis = (deficitDogetoshis + (bufferDoges + feeDoges) * 100_000_000n)

    this.log(chalk.gray(`-> Calculated recharge amount: ${Number(amountDogetoshis) / 1e8} DOGE`))

    const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
    const opReturnData = new Uint8Array(Buffer.from(this.l2Address.toLowerCase().replace('0x', '00'), 'hex'))
    const opReturnOutput = bitcoin.payments.embed({ data: [opReturnData] })

    const outputs: PsbtOutputParam[] = [
      { address: this.bridgeAddress, value: amountDogetoshis },
      { script: opReturnOutput.output!, value: 0n },
    ]

    const txid = await this.buildAndBroadcastTx(masterKeyPair, outputs, true)
    if (!txid) throw new Error('Recharge transaction failed to broadcast.')

    this.log(chalk.gray('-> Waiting for recharge confirmation...'))
    await waitForConfirmations(txid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
    this.log(chalk.green('✅ Recharge confirmed. Waiting for L2 balance update...'))

    // Wait for L2 balance to reflect (bridge delay)
    const provider = new JsonRpcProvider(this.l2RPC)
    const wallet = new Wallet(this.l2AddressPrivateKey, provider)

    let retries = 0
    const maxRetries = 60 // 5 minutes
    while (retries < maxRetries) {
      const newBalance = await wallet.provider!.getBalance(wallet.address)
      if (newBalance >= requiredWei) {
        this.log(chalk.green(`\n✅ L2 Balance updated: ${newBalance.toString()}`))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5000))
      retries++
      process.stdout.write('.')
    }
    throw new Error('Recharge timed out waiting for L2 balance update.')
  }

  private async caseLargePsbt() {
    this.log(chalk.bold.cyan('\n✨ Starting: Large PSBT Case'))
    const { flags } = await this.parse(Case)

    const inputCount = 3000
    //0.01~2.01
    const fundingAmount = BigInt(Math.round(Math.random() * 1_000_000));
    const feePerInput = 1000_000n // Generous fee for consolidation
    const totalFundingNeeded = BigInt(inputCount) * (fundingAmount + feePerInput)

    this.log(chalk.gray(`-> Generating ${inputCount} random keypairs...`))
    const keyPairs: ECPairInterface[] = []
    const addresses: string[] = []
    for (let i = 0; i < inputCount; i++) {
      const keyPair = ECPair.fromPrivateKey(new Uint8Array(randomBytes(32)), { network: this.network })
      keyPairs.push(keyPair)
      const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: this.network })
      if (!address) throw new Error('Failed to generate address')
      addresses.push(address)
    }

    // Phase 1: Fund the addresses
    this.log(chalk.gray('-> Phase 1: Funding random addresses...'))
    const masterKeyPair: ECPairInterface = ECPair.fromWIF(this.masterWif, this.network)
    const fundingOutputs: PsbtOutputParam[] = addresses.map(addr => ({
      address: addr,
      value: fundingAmount + feePerInput
    }))

    const fundingTxid = await this.buildAndBroadcastTx(masterKeyPair, fundingOutputs, flags.verbose)
    if (!fundingTxid) throw new Error('Funding transaction failed')

    this.log(chalk.gray('-> Waiting for funding confirmation...'))
    await waitForConfirmations(fundingTxid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))
    this.log(chalk.green('✅ Funding confirmed.'))

    // Phase 2: Construct Large PSBT
    this.log(chalk.gray('-> Phase 2: Constructing Large PSBT...'))
    const psbt = new bitcoin.Psbt({ network: this.network })

    // Add inputs
    const fundingTxHex = (await getTx(fundingTxid, this.blockbookURL)).hex
    for (let i = 0; i < inputCount; i++) {
      psbt.addInput({
        hash: fundingTxid,
        index: i,
        sequence: RBF_SEQUENCE,
        nonWitnessUtxo: new Uint8Array(Buffer.from(fundingTxHex, 'hex')),
      })
    }

    // Add outputs: Bridge + OP_RETURN
    const opReturnData = new Uint8Array(Buffer.from(this.l2Address.toLowerCase().replace('0x', '00'), 'hex'))
    const opReturnOutput = bitcoin.payments.embed({ data: [opReturnData] })

    const totalInput = BigInt(inputCount) * (fundingAmount + feePerInput)
    // Calculate fee roughly: 100 inputs * ~148 bytes + 2 outputs * ~34 bytes + overhead ~10 bytes
    // ~14800 + 68 + 10 = ~14878 vBytes. @ 1000 sats/vB = ~14,878,000 sats.
    // We allocated 500,000 * 100 = 50,000,000 sats for fees, so plenty.

    const estimatedVSize = 10 + psbt.txInputs.length * 148 + 2 * 34
    const fee = BigInt(estimatedVSize * 1000)
    const bridgeValue = totalInput - fee

    psbt.addOutput({ address: this.bridgeAddress, value: bridgeValue })
    psbt.addOutput({ script: opReturnOutput.output!, value: 0n })

    // Sign all inputs
    this.log(chalk.gray('-> Signing inputs...'))
    for (let i = 0; i < inputCount; i++) {
      psbt.signInput(i, keyPairs[i])
      if (i % 100 == 0) {
        this.log(`sign input ${i} ...`)
      }
    }
    psbt.finalizeAllInputs()

    const finalTxHex = psbt.extractTransaction().toHex()
    this.log(chalk.gray(`-> Broadcasting large transaction (${finalTxHex.length / 2} bytes)...`))

    const { result: largeTxid } = await broadcastTx(finalTxHex, this.blockbookURL)
    this.log(chalk.green(`✅ Large transaction broadcasted successfully!`))
    this.log(`   ${chalk.blue('SoChain Link:')} https://sochain.com/tx/DOGETEST/${largeTxid}`)

    await waitForConfirmations(largeTxid, this.blockbookURL, (msg) => this.log(msg), (msg) => this.warn(msg))

    this.log(chalk.gray('-> Waiting for L2 balance update...'))
    const provider = new JsonRpcProvider(this.l2RPC)
    const wallet = new Wallet(this.l2AddressPrivateKey, provider)

    // Convert bridgeValue (sats) to Wei (1 sat = 10^10 wei)
    const bridgeValueWei = bridgeValue * 10_000_000_000n
    const withdrawAmount = bridgeValueWei - 100_000_000_000_000_000n // -0.1 ETH (10^17 wei)

    if (withdrawAmount <= 0n) {
      this.warn('Calculated withdrawal amount is too low. Skipping withdrawal.')
    } else {
      let retries = 0
      const maxRetries = 60 // 5 minutes
      while (retries < maxRetries) {
        const balance = await wallet.provider!.getBalance(wallet.address)
        if (balance >= withdrawAmount) { // Wait for the full bridge amount to arrive
          this.log(chalk.green(`✅ L2 Balance updated: ${balance.toString()}`))
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
        retries++
        process.stdout.write('.')
        this.log(`   Current: ${retries}/${maxRetries}. balance: ${balance.toString()} withdrawAmount: ${withdrawAmount.toString()}`)
      }

      if (retries >= maxRetries) {
        this.warn('Timed out waiting for L2 balance update. Proceeding with available balance check...')
      }

      const currentBalance = await wallet.provider!.getBalance(wallet.address)
      if (currentBalance < withdrawAmount) {
        this.error(`Insufficient L2 balance for withdrawal. Have ${currentBalance}, need ${withdrawAmount}`)
      }

      this.log(chalk.gray(`-> Withdrawing ${Number(withdrawAmount) / 1e18} ETH to L1...`))

      if (!this.moatAddress) {
        this.error('Moat address (L2 Messenger) is not configured.')
      }

      const moat = new Contract(
        this.moatAddress,
        ['function withdrawToL1(address _target) external payable'],
        wallet
      )

      // Withdraw to masterAddress on L1
      // target: L1 address (but sendMessage expects an L1 address format? standard address string works)
      // value: amount to transfer on L1
      // message: empty for ETH transfer
      // gasLimit: 0 for default
      // The function is payable, so we send the ETH value with the call.
      // Wait, sendMessage(target, value, message, gasLimit)
      // The 'value' param in sendMessage is the amount to be deposited/transferred on L1?
      // Usually for ETH withdrawal: msg.value is the amount burned/locked on L2.
      // The '_value' arg is often the value passed to the L1 call.
      // For simple ETH withdrawal, msg.value = amount, _value = amount.

      // withdrawToL1 的输入参数是 eth 地址。但是这个地址应该是 dogecoin 地址解码后的 20 字节公钥 hash
      const decoded = bitcoin.address.fromBase58Check(this.masterAddress)
      const targetPkh = '0x' + Buffer.from(decoded.hash).toString('hex')

      const tx = await moat.withdrawToL1(
        targetPkh,
        { value: withdrawAmount }
      )

      this.log(chalk.green(`✅ Withdrawal transaction sent!`))
      this.log(`   ${chalk.blue('Transaction Hash:')} ${chalk.bold(tx.hash)}`)
      await tx.wait()
      this.log(chalk.green('✅ Withdrawal confirmed.'))
    }

    this.log(chalk.green.bold('\n✨ Case Finished Successfully.'))
  }
}
