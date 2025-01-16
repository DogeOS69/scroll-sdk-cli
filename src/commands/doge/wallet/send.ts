import type {Transaction as TransactionType} from 'bitcore-lib-doge'

/**
 * Transaction Creation Implementation
 *
 * The command uses bitcore-lib-doge's helper methods for transaction creation:
 * - Transaction.UnspentOutput for input creation
 * - Transaction.from() to add inputs
 * - Transaction.to() for payment outputs
 * - Transaction.addData() for OP_RETURN outputs
 * - Transaction.change() for change address
 * - Transaction.feePerKb() for fee calculation
 * - Transaction.sign() for transaction signing
 *
 * Key features:
 * - Automatic fee calculation (minimum 0.0128 DOGE/KB)
 * - Support for OP_RETURN data in three formats
 * - Automatic UTXO selection and change handling
 * - Transaction preview with --dry-run
 */

import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

const {PrivateKey, Transaction} = bitcore

import {DogeConfig, DogeWallet} from '../../../types/doge-config.js'
import {loadDogeConfig} from '../../../utils/doge-config.js'

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

  static description = 'Send DOGE to the bridge with cross-chain data'

  static examples = [
    '$ scrollsdk doge:wallet send --amount 1.0',
    '$ scrollsdk doge:wallet send --amount 1.0 --chain-id 0x1234',
    '$ scrollsdk doge:wallet send --amount 1.0 --evm-address 0xabc...',
    '$ scrollsdk doge:wallet send --amount 1.0 --no-bridge',
    '$ scrollsdk doge:wallet send --amount 1.0 --hex-data 6a0468656c6c6f --no-bridge',
    '$ scrollsdk doge:wallet send --amount 1.0 --force # Skip wallet sync prompt',
  ]

  static flags = {
    amount: Flags.string({
      char: 'a',
      description: 'Amount to send in DOGE',
      required: true,
    }),
    'chain-id': Flags.string({
      description: 'Chain ID (6 bytes)',
      exclusive: ['hex-data', 'text-data', 'no-bridge'],
    }),
    config: Flags.string({
      char: 'c',
      default: '.data/doge-config.toml',
      description: 'Path to config file',
    }),
    'dry-run': Flags.boolean({
      char: 'd',
      default: false,
      description: 'Simulate the transaction without broadcasting',
    }),
    'evm-address': Flags.string({
      description: 'EVM address (20 bytes)',
      exclusive: ['hex-data', 'text-data', 'no-bridge'],
    }),
    force: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Skip wallet sync prompt',
    }),
    'hex-data': Flags.string({
      description: 'Custom hex data to include in OP_RETURN output (requires --no-bridge)',
      exclusive: ['chain-id', 'evm-address', 'text-data'],
    }),
    'no-bridge': Flags.boolean({
      default: false,
      description: 'Send without bridge data (allows custom OP_RETURN data)',
      exclusive: ['chain-id', 'evm-address'],
    }),
    path: Flags.string({
      char: 'p',
      description: 'Custom path for the wallet file (overrides config)',
    }),
    'text-data': Flags.string({
      description: 'Text data to include in OP_RETURN output (requires --no-bridge)',
      exclusive: ['chain-id', 'evm-address', 'hex-data'],
    }),
    to: Flags.string({
      char: 't',
      description: 'Recipient address (overrides config)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WalletSend)

    try {
      this.log(chalk.cyan('Loading configuration and wallet...'))

      // Load config
      const config = await loadDogeConfig(flags.config)

      // Validate inputs
      const recipientAddress = this.validateRecipient(flags.to, config)
      const amount = this.validateAmount(flags.amount)

      // Load wallet
      const walletPath = flags.path ? path.resolve(flags.path) : path.resolve(config.wallet.path)
      let walletData = this.loadWallet(walletPath)

      // Prompt for wallet sync if not in dry-run mode and not forced
      if (!flags['dry-run'] && !flags.force) {
        const shouldSync = await confirm({
          default: true,
          message: 'Would you like to sync your wallet before sending? (Recommended)',
        })

        if (shouldSync) {
          // Run the sync command with the same config and path
          const syncArgs = []
          if (flags.config) syncArgs.push('--config', flags.config)
          if (flags.path) syncArgs.push('--path', flags.path)

          await this.config.runCommand('doge:wallet:sync', syncArgs)

          // Reload wallet data after sync
          walletData = this.loadWallet(walletPath)
        }
      }

      // Create OP_RETURN data if specified
      const data = this.createOpReturnData(flags as TransactionFlags, config)

      // Create and sign transaction
      const tx = await this.createTransaction(walletData, amount, recipientAddress, data)

      if (flags['dry-run']) {
        this.log(chalk.yellow('\n🔍 Dry run - Transaction details:'))
        this.log(chalk.dim('Transaction hex:'))
        this.log(chalk.dim(tx.serialize()))
        this.log(chalk.dim('\nTransaction size:'), `${tx.serialize().length / 2} bytes`)

        const {outputs} = tx as unknown as {outputs: Array<{satoshis: number}>}

        this.log(chalk.dim('\nOutputs:'))
        for (const [index, output] of outputs.entries()) {
          if (index === 0) {
            this.log(chalk.dim(`- Payment: ${output.satoshis / 1e8} DOGE to ${recipientAddress}`))
          } else if (data && index === 1) {
            this.log(chalk.dim('- OP_RETURN data:', data.toString('hex')))
          } else {
            this.log(chalk.dim(`- Change: ${output.satoshis / 1e8} DOGE to ${walletData.address}`))
          }
        }

        this.log(chalk.yellow('\n✨ Dry run complete - No transaction broadcast'))
        return
      }

      // Broadcast transaction
      const result = await this.broadcastTransaction(tx, config.rpc?.apiKey || '')

      // Log success
      this.log(chalk.green('\n✓ Transaction sent successfully'))
      this.log(`Transaction ID: ${chalk.cyan(result.result)}`)
      this.log(`Explorer Link: ${chalk.cyan(`https://sochain.com/tx/DOGE/${result.result}`)}`)
      this.log(`Amount: ${chalk.yellow(amount)} DOGE`)

      // Calculate change from last output if it exists
      const {outputs} = tx as unknown as {outputs: Array<{satoshis: number}>}
      const change = outputs.length > 1 ? outputs.at(-1)?.satoshis || 0 : 0
      if (change > 0) {
        this.log(`Change: ${chalk.yellow(change / 1e8)} DOGE`)
      }
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message)
      }

      throw error
    }
  }

  private async broadcastTransaction(tx: TransactionType, apiKey: string) {
    this.log(chalk.cyan('\nBroadcasting transaction...'))
    const baseUrl = 'https://dogebook.nownodes.io/api/v2'
    const response = await fetch(`${baseUrl}/sendtx/${tx.serialize()}`, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(`Failed to broadcast transaction: ${response.status} ${response.statusText}`)
    }

    return response.json()
  }

  private createOpReturnData(flags: TransactionFlags, config: DogeConfig): Buffer | undefined {
    // Maximum size for OP_RETURN data (80 bytes)
    const MAX_OP_RETURN_SIZE = 80

    // If --no-bridge is not set, create bridge data
    if (!flags['no-bridge']) {
      // Get EVM address from flags or config
      const evmAddress = flags['evm-address'] || config.defaults?.evmAddress
      if (!evmAddress) {
        this.error('EVM address is required. Provide it via --evm-address flag or in config defaults.evmAddress')
      }

      // Validate EVM address format
      if (!/^0x[\dA-Fa-f]{40}$/.test(evmAddress)) {
        this.error('Invalid EVM address format. Must be 20 bytes (40 hex chars) with 0x prefix')
      }

      // Get chain ID from flags or config
      const chainId = flags['chain-id'] || config.defaults?.chainId
      if (!chainId) {
        this.error('Chain ID is required. Provide it via --chain-id flag or in config defaults.chainId')
      }

      // Convert decimal chain ID to hex
      const MAX_CHAIN_ID = BigInt('0xFFFFFFFFFFFF')

      // First validate and convert the chain ID
      let chainIdNum: bigint

      try {
        if (chainId.startsWith('0x')) {
          // Direct hex input validation
          if (!/^0x[\dA-Fa-f]{1,12}$/.test(chainId)) {
            this.error('Invalid hex chain ID format. Must start with 0x followed by 1-12 hex chars')
          }

          chainIdNum = BigInt(chainId)
        } else {
          // Decimal input validation
          chainIdNum = BigInt(chainId)
        }
      } catch {
        this.error('Invalid chain ID format. Must be a valid decimal number or hex string with 0x prefix')
      }

      // Then check the value range
      if (chainIdNum < 0) {
        this.error('Chain ID cannot be negative')
      }

      if (chainIdNum > MAX_CHAIN_ID) {
        this.error(
          `Chain ID value exceeds maximum allowed (6 bytes, max: ${
            chainId.startsWith('0x') ? '0xFFFFFFFFFFFF' : '281474976710655'
          })`,
        )
      }

      // Convert to hex format
      const chainIdHex = '0x' + chainIdNum.toString(16).padStart(12, '0')

      // Create structured data: version (1 byte) + chain ID (6 bytes) + EVM address (20 bytes)
      const data = Buffer.concat([
        Buffer.from([0x01]), // Version
        Buffer.from(chainIdHex.replace('0x', ''), 'hex'), // Chain ID (6 bytes)
        Buffer.from(evmAddress.replace('0x', ''), 'hex'), // EVM address (20 bytes)
      ])

      this.log(chalk.dim('Creating bridge payload:'))
      this.log(chalk.dim('- Version: 0x01'))
      this.log(chalk.dim(`- Chain ID: ${chainIdHex} (decimal: ${chainId})`))
      this.log(chalk.dim(`- EVM Address: ${evmAddress}`))
      this.log(chalk.dim(`- Hex: ${data.toString('hex')}`))

      return data
    }

    // Handle custom OP_RETURN data if specified
    if (flags['hex-data']) {
      const data = Buffer.from(flags['hex-data'], 'hex')
      if (data.length > MAX_OP_RETURN_SIZE) {
        this.error(
          `OP_RETURN data size (${data.length} bytes) exceeds maximum allowed size (${MAX_OP_RETURN_SIZE} bytes)`,
        )
      }

      this.log(chalk.dim('Using custom hex data:', flags['hex-data']))
      return data
    }

    if (flags['text-data']) {
      const data = Buffer.from(flags['text-data'], 'utf8')
      if (data.length > MAX_OP_RETURN_SIZE) {
        this.error(`Text data size (${data.length} bytes) exceeds maximum allowed size (${MAX_OP_RETURN_SIZE} bytes)`)
      }

      this.log(chalk.dim('Using text data:', flags['text-data']))
      this.log(chalk.dim('Hex representation:', data.toString('hex')))
      return data
    }

    return undefined
  }

  private async createTransaction(walletData: DogeWallet, amount: number, recipientAddress: string, data?: Buffer) {
    this.log(chalk.cyan('\nCreating transaction...'))
    const tx = new Transaction()
    const privateKey = PrivateKey.fromWIF(walletData.privateKey)

    // Set minimum fee rate (0.0128 DOGE/KB)
    tx.feePerKb(Math.max(Transaction.FEE_PER_KB, 1.28e6))

    // Add inputs
    let totalInput = 0
    const totalNeeded = Math.floor(amount * 1e8)
    this.log(chalk.dim('\nAdding inputs:'))

    for (const utxo of walletData.utxos) {
      const {satoshis, script, txid: prevTxId, vout: outputIndex} = utxo
      this.log(chalk.dim('Debug UTXO values:'))
      this.log(chalk.dim(`- satoshis: ${satoshis}`))
      this.log(chalk.dim(`- script: ${script}`))
      this.log(chalk.dim(`- txId: ${prevTxId}`))
      this.log(chalk.dim(`- vout: ${outputIndex}`))

      // Create input using UnspentOutput
      const input = new Transaction.UnspentOutput({
        address: walletData.address,
        outputIndex,
        satoshis,
        script,
        txId: prevTxId,
      })

      tx.from(input)
      totalInput += satoshis
      this.log(chalk.dim(`- Added input ${prevTxId}:${outputIndex} (${satoshis / 1e8} DOGE)`))
      if (totalInput >= totalNeeded) break
    }

    if (totalInput < totalNeeded) {
      this.error(`Insufficient funds. Need at least ${totalNeeded / 1e8} DOGE but only have ${totalInput / 1e8} DOGE`)
    }

    this.log(chalk.dim(`\nTotal input: ${totalInput / 1e8} DOGE`))

    // Add outputs
    this.log(chalk.dim('\nAdding outputs:'))

    // Add recipient output
    tx.to(recipientAddress, Math.floor(amount * 1e8))
    this.log(chalk.dim(`- To ${recipientAddress}: ${amount} DOGE`))

    // Add OP_RETURN output if specified
    if (data) {
      tx.addData(data)
      this.log(chalk.dim('- OP_RETURN data:', data.toString('hex')))
    }

    // Set change address
    tx.change(walletData.address)

    // Sign the transaction
    this.log(chalk.dim('\nSigning transaction...'))
    tx.sign(privateKey)

    return tx
  }

  private loadWallet(walletPath: string): DogeWallet {
    if (!fs.existsSync(walletPath)) {
      this.error(`Wallet file not found at ${walletPath}`)
    }

    return JSON.parse(fs.readFileSync(walletPath, 'utf8'))
  }

  private validateAmount(amountStr: string): number {
    const amount = Number.parseFloat(amountStr)
    if (Number.isNaN(amount) || amount <= 0) {
      this.error('Invalid amount')
    }

    return amount
  }

  private validateRecipient(address: string | undefined, config: DogeConfig): string {
    const recipientAddress = address || config.defaults?.recipient
    if (!recipientAddress) {
      this.error('Recipient address is required. Provide it via --to flag or in config defaults.recipient')
    }

    if (!/^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(recipientAddress)) {
      this.error('Invalid Dogecoin address format')
    }

    return recipientAddress
  }
}
