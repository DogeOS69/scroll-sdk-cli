import type { Transaction as BitcoreTransactionType } from 'bitcore-lib-doge'

import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import { base58 } from '@scure/base';
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import { DogeConfig, DogeWallet } from '../../../types/doge-config.js'

const { Address, Networks, PrivateKey, Transaction } = bitcore
import { loadDogeConfigWithSelection } from '../../../utils/doge-config.js'

interface TransactionFlags {
  amount: string
  'chain-id'?: string
  config: string
  'dry-run'?: boolean
  'evm-address'?: string
  force?: boolean
  'hex-data'?: string
  'no-bridge'?: boolean
  path?: string
  'text-data'?: string
  to?: string
}

export default class WalletSend extends Command {
  static default = false

  static description = 'Send DOGE to an address or the bridge with cross-chain data (mainnet/testnet aware)'

  static examples = [
    '$ scrollsdk doge:wallet send --amount 1.0',
    '$ scrollsdk doge:wallet send --amount 1.0 --evm-address 0xabc... --config .data/doge-config-testnet.toml',
    '$ scrollsdk doge:wallet send --amount 1.0 --no-bridge --to અનન્ય_ADDRESS',
    '$ scrollsdk doge:wallet send --amount 1.0 --hex-data 6a0468656c6c6f --no-bridge',
    '$ scrollsdk doge:wallet send --amount 1.0 --force',
  ]

  static flags = {
    amount: Flags.string({
      char: 'a',
      description: 'Amount to send in DOGE',
      required: true,
    }),
    config: Flags.string({
      char: 'c',
      description: 'Path to Dogecoin config file',
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      default: false,
      description: 'Simulate transaction without broadcasting',
    }),
    'evm-address': Flags.string({
      description: 'EVM address (20 bytes hex, 0x-prefixed) for bridge transactions',
      exclusive: ['hex-data', 'text-data'],
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip wallet sync prompt',
    }),
    'hex-data': Flags.string({
      description: 'Custom hex data for OP_RETURN (requires --no-bridge)',
      exclusive: ['evm-address', 'text-data'],
    }),
    'no-bridge': Flags.boolean({
      default: false,
      description: 'Send without bridge data (allows custom OP_RETURN data, or send to non-bridge address)',
      exclusive: ['evm-address'],
    }),
    path: Flags.string({
      char: 'p',
      description: 'Path to wallet file (overrides config)',
    }),
    'text-data': Flags.string({
      description: 'Text data for OP_RETURN (requires --no-bridge)',
      exclusive: ['evm-address', 'hex-data'],
    }),
    to: Flags.string({
      char: 't',
      description: 'Recipient Dogecoin address (required if --no-bridge and not using default recipient from config)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(WalletSend)

    try {
      this.log(chalk.cyan('Loading configuration and wallet...'))
      // const config = await loadDogeConfig(flags.config)

      const { config, configPath } = await loadDogeConfigWithSelection(
        flags['doge-config'],
        'scrollsdk doge:config'
      )

      this.log(chalk.blue(`Using network: ${config.network} (from ${flags.config})`))

      const currentBitcoreNetwork: typeof Networks.livenet = this.getBitcoreNetwork(config.network)

      const recipientAddress = this.validateRecipient(flags.to, currentBitcoreNetwork, configPath)
      const amountSatoshis = this.validateAmount(flags.amount)

      const walletPath = flags.path ? path.resolve(flags.path) : path.resolve(config.wallet.path)
      let walletData = this.loadWallet(walletPath)

      if (walletData.network && walletData.network !== config.network) {
        this.error(`Wallet at ${walletPath} is for ${walletData.network} but current config is for ${config.network}.`)
      }

      if (!flags['dry-run'] && !flags.force) {
        const shouldSync = await confirm({
          default: true,
          message: 'Sync wallet before sending? (Recommended)',
        })
        if (shouldSync) {
          await this.config.runCommand('doge:wallet:sync', [
            '--config',
            configPath,
            ...(flags.path ? ['--path', flags.path] : []),
          ])
          walletData = this.loadWallet(walletPath)
        }
      }

      const opReturnData = this.createOpReturnData(flags as TransactionFlags, config)
      const tx: BitcoreTransactionType = this.createTransaction(
        walletData,
        amountSatoshis,
        recipientAddress,
        opReturnData,
        currentBitcoreNetwork,
      )

      if (flags['dry-run']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.log(chalk.yellow(`\n🔍 Dry Run (Network: ${(currentBitcoreNetwork as any).name}):`))
        this.log(chalk.dim('Raw Tx Hex:'), tx.serialize())
        // @ts-expect-error d.ts for bitcore-lib-doge might be incomplete for tx.outputs

        const outputTotal = tx.outputs.reduce(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (sum: number, out: any /* bitcore.Transaction.Output */) => sum + out.satoshis,
          0,
        )
        // @ts-expect-error d.ts for bitcore-lib-doge might be incomplete for tx.inputAmount
        const estimatedFee = tx.inputAmount - outputTotal
        // @ts-expect-error d.ts for bitcore-lib-doge might be incomplete for tx.toBuffer
        this.log(chalk.dim('Size (bytes):'), tx.toBuffer().length)
        this.log(chalk.dim('Estimated Fee:'), `${estimatedFee / 1e8} DOGE`)
        // @ts-expect-error d.ts for bitcore-lib-doge might be incomplete for tx.outputs
        for (const [i, out] of tx.outputs.entries()) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const typedOut = out as any // bitcore.Transaction.Output - using any due to d.ts issues
          if (typedOut.script.isDataOut()) {
            this.log(chalk.dim(`Output ${i}: OP_RETURN Data: ${typedOut.script.getData().toString('hex')}`))
          } else {
            const addr = typedOut.script.toAddress(currentBitcoreNetwork)
            this.log(chalk.dim(`Output ${i}: ${typedOut.satoshis / 1e8} DOGE to ${addr.toString()}`))
          }
        }

        this.log(chalk.yellow('\n✨ Dry run complete.'))
        return
      }

      if (!config.rpc || !config.rpc.url) {
        this.error('RPC URL (config.rpc.url) must be set in configuration for broadcasting.')
      }

      const txid = await this.broadcastTransaction(tx.serialize(), config.rpc, config.rpc.url!)
      this.log(chalk.green(`\n✓ Tx sent on ${config.network}!`))
      this.log(`ID: ${chalk.cyan(txid)}`)
      this.log(
        `Explorer: ${chalk.cyan(
          (config.network === 'testnet' ? 'https://sochain.com/tx/DOGETEST/' : 'https://sochain.com/tx/DOGE/') + txid,
        )}`,
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.error(chalk.red(`Error: ${error.message}`), { exit: 1, suggestions: ['Check balance, sync, address.'] })
    }
  }

  private async broadcastTransaction(
    txHex: string,
    rpcConfig: DogeConfig['rpc'],
    primaryRpcUrl: string,
  ): Promise<string> {
    const urlToBroadcast = primaryRpcUrl
    this.log(chalk.cyan(`\nBroadcasting via ${urlToBroadcast}...`))

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (urlToBroadcast.includes('nownodes.io')) {
      const sendTxUrl = `${urlToBroadcast.replace(/\/$/, '')}/sendtx/${txHex}`
      if (rpcConfig?.apiKey) {
        headers['api-key'] = rpcConfig.apiKey
      }

      const response = await fetch(sendTxUrl, { headers, method: 'GET' })
      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(
          `Broadcast to NowNodes failed: ${response.status} ${response.statusText}. Response: ${errorBody}`,
        )
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await response.json()) as { error?: any; result?: string }
      if (result.error || !result.result) {
        throw new Error(`Broadcast error from NowNodes API: ${JSON.stringify(result.error || result)}`)
      }

      return result.result
    }

    if (rpcConfig?.username && rpcConfig?.password) {
      const credentials = Buffer.from(`${rpcConfig.username}:${rpcConfig.password}`).toString('base64')
      headers.Authorization = `Basic ${credentials}`
    }

    const body = JSON.stringify({
      id: 'broadcast',
      jsonrpc: '1.0',
      method: 'sendrawtransaction',
      params: [txHex],
    })

    const response = await fetch(urlToBroadcast, { body, headers, method: 'POST' })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Broadcast failed: ${response.status} ${response.statusText}. Response: ${errorBody}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await response.json()) as { error?: any; result?: string }
    if (result.error) {
      throw new Error(`RPC error: ${result.error.message || JSON.stringify(result.error)} (Code: ${result.error.code})`)
    }

    if (typeof result.result === 'string') {
      return result.result
    }

    throw new Error('Broadcast response did not contain a valid transaction ID string in result.')
  }

  private createOpReturnData(flags: TransactionFlags, _config: DogeConfig): Buffer | undefined {
    const MAX_OP_RETURN_SIZE = 80 // Max size for OP_RETURN data

    // If --no-bridge is not set, create the new simplified bridge data
    if (!flags['no-bridge']) {
      const evmAddress = flags['evm-address']
      if (!evmAddress || !/^0x[\dA-Fa-f]{40}$/.test(evmAddress)) {
        this.error(
          'Valid EVM address (20 bytes hex, 0x-prefixed) required for bridge. Provide via --evm-address or in config defaults.evmAddress',
        )
      }

      // New simplified bridge data: version (1 byte) + EVM address (20 bytes)
      const bridgeDataPayload = Buffer.concat([
        Buffer.from([0x00]), // New Version byte: 0x00
        Buffer.from(evmAddress.slice(2), 'hex'), // EVM address (20 bytes, remove 0x prefix)
      ])

      if (bridgeDataPayload.length > MAX_OP_RETURN_SIZE) {
        // This should not happen with 1 + 20 = 21 bytes, but check is good practice
        this.error(
          `Constructed bridge data (${bridgeDataPayload.length} bytes) exceeds OP_RETURN limit of ${MAX_OP_RETURN_SIZE} bytes.`,
        )
      }

      this.log(chalk.dim(`Bridge Payload (v0): EVM ${evmAddress}, Hex: ${bridgeDataPayload.toString('hex')}`))
      return bridgeDataPayload
    }

    // Handle custom OP_RETURN data if --no-bridge is set (this part remains the same)
    if (flags['hex-data']) {
      const hexData = Buffer.from(flags['hex-data'], 'hex')
      if (hexData.length > MAX_OP_RETURN_SIZE) {
        this.error(`Hex data (${hexData.length} bytes) exceeds OP_RETURN limit (${MAX_OP_RETURN_SIZE} bytes).`)
      }

      this.log(chalk.dim(`Using custom hex data for OP_RETURN: ${flags['hex-data']}`))
      return hexData
    }

    if (flags['text-data']) {
      const textData = Buffer.from(flags['text-data'], 'utf8')
      if (textData.length > MAX_OP_RETURN_SIZE) {
        this.error(`Text data (${textData.length} bytes) exceeds OP_RETURN limit (${MAX_OP_RETURN_SIZE} bytes).`)
      }

      this.log(chalk.dim(`Using custom text data for OP_RETURN: "${flags['text-data']}"`))
      this.log(chalk.dim(`Hex representation: ${textData.toString('hex')}`))
      return textData
    }

    return undefined // No OP_RETURN data if no flags are set
  }

  // eslint-disable-next-line max-params
  private createTransaction(
    wallet: DogeWallet,
    amountSatoshis: number,
    recipientAddrStr: string,
    opReturnData: Buffer | undefined,
    network: typeof Networks.livenet,
  ): BitcoreTransactionType {
    this.log(chalk.cyan('\nCreating transaction...'))
    const privateKey = PrivateKey.fromWIF(wallet.privateKey)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkNetwork = (privateKey as any).network // Get the network object from the private key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentBitcoreNetworkName = (network as any).name // Get name from the passed bitcore network object

    if (pkNetwork && typeof pkNetwork.name === 'string' && pkNetwork.name !== currentBitcoreNetworkName) {
      this.error(
        `Wallet key is for network '${pkNetwork.name}' but current operation is for network '${currentBitcoreNetworkName}'. Mismatch.`,
      )
    }

    if (!wallet.utxos || wallet.utxos.length === 0) {
      this.error('No UTXOs in wallet. Sync first.')
    }

    const validUtxos = wallet.utxos.filter((utxo) => {
      if (typeof utxo.script === 'string' && utxo.script.length > 0) return true
      this.warn(chalk.yellow(`Skipping UTXO ${utxo.txid}:${utxo.vout} due to missing script.`))
      return false
    })

    if (validUtxos.length === 0) {
      this.error('No valid UTXOs with scriptPubKey found in wallet to fund the transaction.')
    }

    const SATOSHIS_PER_KB = 101_000
    let currentInputSum = 0
    const selectedUtxoObjects: InstanceType<typeof Transaction.UnspentOutput>[] = []
    const sortedValidUtxos = [...validUtxos].sort((a, b) => b.satoshis - a.satoshis)

    for (const utxo of sortedValidUtxos) {
      selectedUtxoObjects.push(
        new Transaction.UnspentOutput({
          address: wallet.address,
          outputIndex: utxo.vout,
          satoshis: utxo.satoshis,
          script: utxo.script,
          txId: utxo.txid,
        }),
      )
      currentInputSum += utxo.satoshis

      // Construct tempTx step-by-step for fee estimation
      const tempTx = new Transaction()
      for (const selected of selectedUtxoObjects) {
        tempTx.from(selected)
      }

      tempTx.to(recipientAddrStr, amountSatoshis)
      if (opReturnData) tempTx.addData(opReturnData)
      tempTx.change(wallet.address)
      tempTx.feePerKb(SATOSHIS_PER_KB)

      // @ts-expect-error _estimateFee is internal, d.ts might not expose it.
      const estimatedFee = tempTx._estimateFee()

      if (currentInputSum >= amountSatoshis + estimatedFee) {
        break
      }
    }

    if (selectedUtxoObjects.length === 0) {
      this.error('Coin selection failed: No UTXOs were selected. This should not happen if validUtxos was not empty.')
    }

    // Build the final transaction with exactly the selected UTXOs
    const finalTx = new Transaction()
    for (const selected of selectedUtxoObjects) {
      finalTx.from(selected)
    }

    finalTx.to(recipientAddrStr, amountSatoshis)
    if (opReturnData) finalTx.addData(opReturnData)
    finalTx.change(wallet.address)
    finalTx.feePerKb(SATOSHIS_PER_KB) // Ensure fee rate is set on the final transaction too

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalInputValueFromSelected = selectedUtxoObjects.reduce((sum: number, utxo: any) => sum + utxo.satoshis, 0)
    // @ts-expect-error _estimateFee is internal, d.ts might not expose it.
    const finalEstimatedFee = finalTx._estimateFee()

    if (totalInputValueFromSelected < amountSatoshis + finalEstimatedFee) {
      this.error(
        `Insufficient funds after coin selection. Needed: ${Number(amountSatoshis + finalEstimatedFee) / 1e8
        } DOGE (incl. fee), Have: ${totalInputValueFromSelected / 1e8} DOGE from ${selectedUtxoObjects.length} UTXOs.`,
      )
    }

    finalTx.sign(privateKey)
    this.log(
      chalk.dim(
        `Transaction built with ${selectedUtxoObjects.length} inputs. Estimated fee: ${Number(finalEstimatedFee) / 1e8
        } DOGE.`,
      ),
    )
    return finalTx
  }

  private getBitcoreNetwork(configNetwork: string): typeof Networks.livenet {
    return configNetwork === 'testnet' ? Networks.testnet : Networks.livenet
  }

  private loadWallet(walletPath: string): DogeWallet {
    if (!fs.existsSync(walletPath)) {
      this.error(`Wallet file not found at ${walletPath}. Try 'doge:wallet:new' or check path.`)
    }

    try {
      return JSON.parse(fs.readFileSync(walletPath, 'utf8'))
    } catch (error) {
      this.error(`Failed to parse wallet file at ${walletPath}. Ensure it is valid JSON.`)
      throw error
    }
  }

  private validateAmount(amountStr: string): number {
    const amount = Number.parseFloat(amountStr)
    if (Number.isNaN(amount) || amount <= 0) {
      this.error('Invalid amount: Must be a positive number.')
    }

    return Math.floor(amount * 1e8)
  }

  private validateRecipient(
    address: string | undefined,
    network: typeof Networks.livenet,
    configFilePath: string,
  ): string {
    const recipient = address;
    if (!recipient) this.error(`Recipient address required via --to or config.defaults.recipient in ${configFilePath}`)
    let isValid = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const networkName = (network as any).name as string

    const decodedAddress = base58.decode(address);
    if (decodedAddress.length !== 25) {
      this.error(`Invalid Dogecoin address format for ${networkName} network: ${recipient}.`)
    }

    const versionByte = decodedAddress[0];

    if (networkName === 'livenet') {
      // isValid = mainnetPattern.test(recipient)
      if (versionByte === 0x1E) {
        isValid = true
      }
      else if (versionByte === 0x16) {
        isValid = true
      }
    } else if (networkName === 'testnet') {
      if (versionByte === 0xC4 || versionByte === 0x71) {
        isValid = true
      }
    } else {
      this.warn(`Unknown network name: ${networkName} for address validation. Attempting generic validation.`)
      try {
        // eslint-disable-next-line no-new
        new Address(recipient) // Intentionally creating new Address to trigger validation error if invalid
        isValid = true
      } catch {
        isValid = false
      }
    }

    if (!isValid) {
      this.error(`Invalid Dogecoin address format for ${networkName} network: ${recipient}.`)
    }

    return recipient
  }
}
