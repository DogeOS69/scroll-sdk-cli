import { confirm, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import cliProgress from 'cli-progress'
import { ethers } from 'ethers'
import path from 'node:path'

import { parseTomlConfig } from '../../utils/config-parser.js'

export default class HelperClearAccounts extends Command {
  static description = 'Clear pending transactions and optionally transfer remaining funds on Layer 2'

  static flags = {
    accounts: Flags.integer({ char: 'a', default: 10, description: 'Number of accounts to generate from mnemonic' }),
    config: Flags.string({ char: 'c', default: './config.toml', description: 'Path to config.toml file' }),
    debug: Flags.boolean({ char: 'd', default: false, description: 'Run in debug mode' }),
    mnemonic: Flags.string({ char: 'm', description: 'Mnemonic to generate wallets' }),
    pod: Flags.boolean({ char: 'p', default: false, description: 'Run in pod mode' }),
    privateKey: Flags.string({ char: 'k', description: 'Private key to clear pending transactions' }),
    recipient: Flags.string({ char: 'x', description: 'Recipient address for remaining funds' }),
    rpc: Flags.string({ char: 'r', description: 'Layer 2 RPC URL' }),
  }

  private debugMode: boolean = false;
  private provider!: ethers.JsonRpcProvider;

  public async run(): Promise<void> {
    const { flags } = await this.parse(HelperClearAccounts)
    this.debugMode = flags.debug;

    let rpcUrl: string;
    if (flags.rpc) {
      rpcUrl = flags.rpc;
    } else {
      const configPath = path.resolve(flags.config)
      const config = parseTomlConfig(configPath)

      rpcUrl = flags.pod ? config.general.L2_RPC_ENDPOINT : config.frontend.EXTERNAL_RPC_URI_L2;
    }

    if (!rpcUrl) {
      this.error('Missing RPC URL. Please provide --rpc flag or ensure it\'s in the config file.')
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    if (flags.privateKey) {
      await this.clearAccount(flags.privateKey, flags.recipient);
    } else if (flags.mnemonic) {
      await this.clearMnemonicAccounts(flags.mnemonic, flags.accounts, flags.recipient);
    } else {
      this.error('Either --privateKey or --mnemonic must be provided');
    }
  }

  private async clearAccount(privateKey: string, recipient?: string, autoReplace?: boolean): Promise<void> {
    const wallet = new ethers.Wallet(privateKey, this.provider);
    const {address} = wallet;

    this.log(chalk.cyan(`Clearing account: ${address}`));

    const currentNonce = await this.provider.getTransactionCount(address, 'latest');
    const pendingNonce = await this.provider.getTransactionCount(address, 'pending');
    const pendingTxCount = pendingNonce - currentNonce;

    if (pendingTxCount > 0) {
      this.log(chalk.yellow(`${pendingTxCount} pending transactions detected.`));

      let replacePending = autoReplace;
      if (autoReplace === undefined) {
        replacePending = await confirm({
          message: `Do you want to replace the ${pendingTxCount} pending transactions with higher gas prices?`,
        });
      }

      if (replacePending) {
        await this.replaceTransactions(wallet, currentNonce, pendingNonce);
      } else {
        this.log(chalk.yellow('Skipping pending transactions.'));
      }
    } else {
      this.log(chalk.green('No pending transactions detected.'));
    }

    if (recipient) {
      await this.transferRemainingFunds(wallet, recipient);
    }
  }

  private async clearMnemonicAccounts(phrase: string, accountCount: number, recipient?: string): Promise<void> {
    const mnemonic = ethers.Mnemonic.fromPhrase(phrase)
    const rootWallet = ethers.HDNodeWallet.fromMnemonic(mnemonic).address

    const replaceOption = await select({
      choices: [
        { name: 'Ask for each account', value: 'ask' },
        { name: 'Yes to all', value: 'all' },
        { name: 'Skip all', value: 'skip' }
      ],
      message: 'How would you like to handle pending transactions?'
    });

    for (let i = 0; i < accountCount; i++) {
      const path = `m/44'/60'/0'/0/${i}`;
      const wallet = ethers.HDNodeWallet.fromMnemonic(mnemonic, path);

      this.log(chalk.cyan(`Processing Layer 2 account ${i + 1}/${accountCount}: ${wallet.address}`));

      if (replaceOption === 'all') {
        await this.clearAccount(wallet.privateKey, recipient || rootWallet, true);
      } else if (replaceOption === 'skip') {
        await this.clearAccount(wallet.privateKey, recipient || rootWallet, false);
      } else {
        await this.clearAccount(wallet.privateKey, recipient || rootWallet);
      }
    }
  }

  private async replaceTransactions(wallet: ethers.Wallet, startNonce: number, endNonce: number): Promise<void> {
    const batchSize = 100;
    const currentGasPrice = await this.provider.getFeeData();

    if (this.debugMode) {
      this.log(chalk.cyan(`Initial gas price: ${currentGasPrice.maxFeePerGas?.toString() || 'N/A'}`));
      this.log(chalk.cyan(`Replacing transactions from nonce ${startNonce} to ${endNonce - 1}`));
    }

    const progressBar = new cliProgress.SingleBar({
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      format: 'Replacing transactions |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Transactions',
      hideCursor: true
    });

    if (!this.debugMode) {
      progressBar.start(endNonce - startNonce, 0);
    }

    for (let i = startNonce; i < endNonce; i += batchSize) {
      const promises = [];
      for (let j = i; j < Math.min(i + batchSize, endNonce); j++) {
        const newTx = {
          gasLimit: 21_000,
          maxFeePerGas: currentGasPrice.maxFeePerGas ? currentGasPrice.maxFeePerGas * 3n : undefined,
          maxPriorityFeePerGas: currentGasPrice.maxPriorityFeePerGas ? currentGasPrice.maxPriorityFeePerGas * 3n : undefined,
          nonce: j,
          to: wallet.address,
          value: 0,
        };

        promises.push(this.sendReplacementTransaction(wallet, newTx, currentGasPrice));
      }

      const results = await Promise.allSettled(promises);
      const successCount = results.filter(r => r.status === 'fulfilled').length;

      if (this.debugMode) {
        this.log(chalk.yellow(`Batch completed: ${successCount}/${promises.length} transactions successful`));
      } else {
        progressBar.increment(successCount);
      }
    }

    if (!this.debugMode) {
      progressBar.stop();
    }

    this.log(chalk.green(`Replacement of transactions completed.`));
  }

  private async sendReplacementTransaction(
    wallet: ethers.Wallet,
    tx: ethers.TransactionRequest,
    originalGasPrice: ethers.FeeData,
    retryCount: number = 0
  ): Promise<boolean> {
    try {
      const sentTx = await wallet.sendTransaction(tx);
      if (this.debugMode) {
        this.log(chalk.yellow(`Transaction sent: ${sentTx.hash} (Nonce: ${tx.nonce})`));
      }

      const receipt = await sentTx.wait();
      if (this.debugMode) {
        this.log(chalk.green(`Transaction ${sentTx.hash} confirmed in block ${receipt?.blockNumber}`));
      }

      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('replacement fee too low') && retryCount < 3) {
        // Increase the fee by 10x for each retry
        const multiplier = 10n ** BigInt(retryCount + 1);
        const newTx = {
          ...tx,
          maxFeePerGas: originalGasPrice.maxFeePerGas ? originalGasPrice.maxFeePerGas * multiplier : undefined,
          maxPriorityFeePerGas: originalGasPrice.maxPriorityFeePerGas ? originalGasPrice.maxPriorityFeePerGas * multiplier : undefined,
        };

        if (this.debugMode) {
          this.log(chalk.yellow(`Retrying transaction (Nonce: ${tx.nonce}) with higher fee. Attempt: ${retryCount + 1}`));
        }

        return this.sendReplacementTransaction(wallet, newTx, originalGasPrice, retryCount + 1);
      }

      if (this.debugMode) {
        this.log(chalk.red(`Failed to send transaction (Nonce: ${tx.nonce}): ${error instanceof Error ? error.message : 'Unknown error'}`));
      }

      return false;
    }
  }

  private async transferRemainingFunds(wallet: ethers.Wallet, recipient: string): Promise<void> {
    const balance = await this.provider.getBalance(wallet.address);
    if (balance === 0n) {
      this.log(chalk.yellow('No remaining balance to transfer.'));
      return;
    }

    const gasPrice = await this.provider.getFeeData();
    const gasLimit = 21_000n;
    const gasCost = gasLimit * (gasPrice.maxFeePerGas || 0n);
    const amountToSend = balance - gasCost;

    if (amountToSend <= 0n) {
      this.log(chalk.yellow('Remaining balance too low to cover gas costs for transfer.'));
      return;
    }

    try {
      const tx = await wallet.sendTransaction({
        gasLimit,
        to: recipient,
        value: amountToSend,
      });

      const receipt = await tx.wait();
      this.log(chalk.green(`Transferred ${ethers.formatEther(amountToSend)} ETH to ${recipient}`));
      this.log(chalk.green(`Transaction hash: ${receipt?.hash}`));
    } catch (error) {
      this.log(chalk.red(`Failed to transfer remaining funds: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }
  }
}
