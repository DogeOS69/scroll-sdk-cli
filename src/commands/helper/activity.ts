 
import {confirm} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import {SingleBar} from 'cli-progress'
import {ethers} from 'ethers'
import {randomBytes} from 'node:crypto'
import path from 'node:path'

import {parseTomlConfig} from '../../utils/config-parser.js'
// import { BlockExplorerParams } from '../../utils/onchain/constructBlockExplorerUrl.js';
// import { txLink } from '../../utils/onchain/txLink.js'

enum Layer {
  L1 = 'l1',
  L2 = 'l2',
  RPC = 'rpc',
}

export default class HelperActivity extends Command {
  static description = 'Generate transactions on the specified network(s) to produce more blocks'
  static flags = {
    config: Flags.string({
      char: 'c',
      default: './config.toml',
      description: 'Path to config.toml file',
    }),
    debug: Flags.boolean({
      char: 'd',
      default: false,
      description: 'Enable debug mode for more detailed logging',
    }),
    interval: Flags.integer({
      char: 'i',
      default: 3,
      description: 'Interval between transactions in seconds',
    }),
    layer1: Flags.boolean({
      char: 'o',
      default: false,
      description: 'Generate activity on Layer 1',
    }),
    layer2: Flags.boolean({
      allowNo: true,
      char: 't',
      default: true,
      description: 'Generate activity on Layer 2',
    }),
    pod: Flags.boolean({
      char: 'p',
      default: false,
      description: 'Run inside Kubernetes pod',
    }),
    privateKey: Flags.string({
      char: 'k',
      description: 'Private key (overrides config)',
    }),
    recipient: Flags.string({
      char: 'x',
      description: 'Recipient address (overrides config)',
    }),
    rpc: Flags.string({
      char: 'r',
      description: 'RPC URL (overrides config for both layers)',
    }),
    spam: Flags.boolean({
      char: 's',
      default: false,
      description: 'with 110KB input while sending transaction',
    }),
  }

  private flags: any
  private nonceTrackers: Record<Layer, number> = {} as Record<Layer, number>

  private providers: Record<Layer, ethers.JsonRpcProvider> = {} as Record<Layer, ethers.JsonRpcProvider>

  private rpcUrls: Record<Layer, string> = {} as Record<Layer, string>

  public async run(): Promise<void> {
    const {flags} = await this.parse(HelperActivity)
    this.flags = flags // Assign parsed flags to the instance property

    const configPath = path.resolve(flags.config)
    const config = parseTomlConfig(configPath)

    const privateKey = flags.privateKey ?? config.accounts.DEPLOYER_PRIVATE_KEY

    if (!privateKey) {
      this.error('Missing required configuration. Please check your config file or provide flags.')
    }

    const publicKey = new ethers.Wallet(privateKey).address
    const recipientAddr = flags.recipient ?? publicKey

    const layers: Layer[] = []
    if (flags.rpc) {
      layers.push(Layer.RPC)
    } else {
      if (flags.layer1) layers.push(Layer.L1)
      if (flags.layer2) layers.push(Layer.L2)
    }

    if (layers.length === 0) {
      this.error('At least one layer must be selected. Use --layer1 --layer2 or --rpc flags.')
    }

    const wallets: Record<Layer, ethers.Wallet> = {} as Record<Layer, ethers.Wallet>

    for (const layer of layers) {
      let rpcUrl: string
      if (layer === Layer.RPC && flags.rpc) {
        rpcUrl = flags.rpc
      } else if (flags.pod) {
        rpcUrl = layer === Layer.L1 ? config.general.L1_RPC_ENDPOINT : config.general.L2_RPC_ENDPOINT
      } else {
        rpcUrl = layer === Layer.L1 ? config.frontend.EXTERNAL_RPC_URI_L1 : config.frontend.EXTERNAL_RPC_URI_L2
      }

      if (!rpcUrl) {
        this.error(`Missing RPC URL for ${layer.toUpperCase()}. Please check your config file or provide --rpc flag.`)
      }

      this.providers[layer] = new ethers.JsonRpcProvider(rpcUrl)
      this.rpcUrls[layer] = rpcUrl
      wallets[layer] = new ethers.Wallet(privateKey, this.providers[layer])

      this.log(rpcUrl)

      const currentNonce = await this.providers[layer].getTransactionCount(publicKey, 'latest')
      const pendingNonce = await this.providers[layer].getTransactionCount(publicKey, 'pending')
      const pendingTxCount = pendingNonce - currentNonce

      if (pendingTxCount > 0) {
        this.log(
          chalk.red(`${pendingTxCount} pending transactions detected for ${publicKey} on ${layer.toUpperCase()}.`),
        )

        const countdownSeconds = 5
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        let countdownHandle: ReturnType<typeof setInterval> | undefined
        const timeoutPromise = new Promise<boolean>((resolve) => {
          let secondsLeft = countdownSeconds
          const logCountdown = () => {
            this.log(chalk.yellow(`Auto-confirming in ${secondsLeft}s...`))
          }

          logCountdown()
          countdownHandle = setInterval(() => {
            secondsLeft -= 1
            if (secondsLeft > 0) {
              logCountdown()
            } else if (countdownHandle) clearInterval(countdownHandle)
          }, 1000)

          timeoutHandle = setTimeout(() => {
            if (countdownHandle) clearInterval(countdownHandle)
            this.log(chalk.yellow('No response in 5s, defaulting to "Yes".'))
            resolve(true)
          }, countdownSeconds * 1000)
        })

        const replacePending = await Promise.race([
          confirm({
            default: true,
            message: `Do you want to replace the ${pendingTxCount} pending transactions with higher gas prices?`,
          }),
          timeoutPromise,
        ])

        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (countdownHandle) clearInterval(countdownHandle)

        if (replacePending) {
          this.log('Replacing pending txs...')
          await this.replaceTransactions(wallets[layer], currentNonce, pendingNonce, layer)
          return
        }

        this.log('Wait for pending tx to clear.')
        return
      }

      this.log(
        chalk.cyan(
          `Starting activity generation on ${layers.map((l) => l.toUpperCase()).join(' and ')}. Press Ctrl+C to stop.`,
        ),
      )
      this.log(chalk.magenta(`Sender: ${publicKey} | Recipient: ${recipientAddr}`))
    }

    await this.initializeNonceTrackers(wallets)

    layers.map(async (layer) => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await this.sendTransaction(wallets[layer], recipientAddr, layer, flags.spam)
        await new Promise((resolve) => setTimeout(resolve, flags.interval * 1000))
      }
    })
  }

  private debugLog(message: string): void {
    if (this.flags && this.flags.debug) {
      this.log(chalk.gray(`[DEBUG] ${message}`))
    }
  }

  private async initializeNonceTrackers(wallets: Record<Layer, ethers.Wallet>) {
    for (const [layer, wallet] of Object.entries(wallets)) {
      const nonce = await wallet.getNonce()
      this.nonceTrackers[layer as Layer] = nonce
      this.debugLog(`Initialized nonce for ${layer}: ${nonce}`)
    }
  }

  private async replaceTransactions(wallet: ethers.Wallet, startNonce: number, endNonce: number, layer: Layer) {
    const batchSize = 100
    const currentGasPrice = await this.providers[layer].getFeeData()

    const progressBar = new SingleBar({
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      format: 'Replacing transactions |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Transactions',
      hideCursor: true,
    })

    progressBar.start(endNonce - startNonce, 0)

    for (let i = startNonce; i < endNonce; i += batchSize) {
      const promises = []
      for (let j = i; j < Math.min(i + batchSize, endNonce); j++) {
        const newTx = {
          gasLimit: 21_000, // standard gas limit for simple transfers
          maxFeePerGas: currentGasPrice.maxFeePerGas ? currentGasPrice.maxFeePerGas * 3n : undefined,
          maxPriorityFeePerGas: currentGasPrice.maxPriorityFeePerGas
            ? currentGasPrice.maxPriorityFeePerGas * 3n
            : undefined,
          nonce: j,
          to: wallet.address, // sending to self
          value: 0, // 0 ETH
        }

        promises.push(this.sendReplacementTransaction(wallet, newTx))
        // promises.push(this.sendReplacementTransaction(wallet, newTx, layer))
      }

      const results = await Promise.allSettled(promises)
      const successCount = results.filter((r) => r.status === 'fulfilled').length
      progressBar.increment(successCount)
    }

    progressBar.stop()
    this.log(chalk.green(`Replacement of transactions completed.`))
  }

  private async sendReplacementTransaction(
    wallet: ethers.Wallet,
    tx: ethers.TransactionRequest,
    // layer: Layer,
  ): Promise<boolean> {
    try {
      const sentTx = await wallet.sendTransaction(tx)
      await sentTx.wait()
      return true
    } catch {
      // Silently fail, we'll handle the overall progress in the replaceTransactions method
      return false
    }
  }

  private async sendTransaction(wallet: ethers.Wallet, recipient: string, layer: Layer, spam: boolean = false) {
    try {
      this.debugLog(`Preparing transaction for ${layer.toUpperCase()}`)
      this.debugLog(`Sender: ${wallet.address}, Recipient: ${recipient}`)

      const currentNonce = this.nonceTrackers[layer]
      this.debugLog(`Current nonce for ${layer}: ${currentNonce}`)

      const tx = await wallet.sendTransaction({
        data: spam ? `0x${randomBytes(110 * 1024).toString('hex')}` : null,
        nonce: currentNonce,
        to: recipient,
        value: ethers.parseUnits('0.1', 'gwei'),
      })

      // this.debugLog(`Transaction created: ${JSON.stringify(tx, null, 2)}`)

      // Increment the nonce tracker immediately after sending the transaction
      this.nonceTrackers[layer]++
      this.debugLog(`Updated nonce for ${layer}: ${this.nonceTrackers[layer]}`)

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Transaction taking longer than expected')), 5000),
      )

      try {
        const receipt = (await Promise.race([tx.wait(), timeoutPromise])) as ethers.TransactionReceipt | null
        if (receipt) {
          this.log(chalk.green(`${layer.toUpperCase()} Transaction sent: ${tx.hash} (Block: ${receipt.blockNumber})`))
          this.debugLog(`Full receipt: ${JSON.stringify(receipt, null, 2)}`)
        } else {
          this.log(chalk.yellow(`${layer.toUpperCase()} Transaction sent: ${tx.hash} (Receipt not available)`))
        }
      } catch (timeoutError) {
        this.log(chalk.yellow(`${layer.toUpperCase()} Transaction sent, but taking longer than expected: ${tx.hash}`))
        this.debugLog(`Timeout error: ${timeoutError}`)
      }
    } catch (error) {
      this.log(
        chalk.red(
          `Failed to send ${layer.toUpperCase()} transaction: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        ),
      )
      if (error instanceof Error) {
        this.debugLog(`Error stack: ${error.stack}`)
        if ('code' in error) {
          this.debugLog(`Error code: ${(error as any).code}`)
          if ((error as any).code === 'NONCE_EXPIRED') {
            this.nonceTrackers[layer] = await wallet.getNonce()
            this.log(chalk.blue(`Nonce expired. Trying use the latest nonce. ${this.nonceTrackers[layer]}`))
            return
          }
        }
      }

      this.debugLog(`Full error object: ${JSON.stringify(error, null, 2)}`)
    }
  }
}
