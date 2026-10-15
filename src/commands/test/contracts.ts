import {Command, Flags} from '@oclif/core'
import chalk from 'chalk'
import * as cliProgress from 'cli-progress'
import {ethers} from 'ethers'
import path from 'node:path'

import {DeployedContract, contracts} from '../../data/contracts.js'
import {preinstalledContracts} from '../../data/preinstalled-contracts.js'
import {parseTomlConfig} from '../../utils/config-parser.js'
import {addressLink} from '../../utils/onchain/index.js'

type ContractResult = {
  contract: DeployedContract
  deployed: boolean
  problems: string[]
}

export default class TestContracts extends Command {
  static description = 'Test L2 contracts and preinstalls by checking deployment, initialization and ownership'

  static flags = {
    config: Flags.string({
      char: 'c',
      default: './config.toml',
      description: 'Path to config.toml file',
    }),
    contracts: Flags.string({
      char: 'n',
      default: './config-contracts.toml',
      description: 'Path to config-contracts.toml file',
    }),
    pod: Flags.boolean({
      char: 'p',
      default: false,
      description: 'Run inside Kubernetes pod',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(TestContracts)
    const configPath = path.resolve(flags.config)
    const contractsPath = path.resolve(flags.contracts)
    const config = parseTomlConfig(configPath)
    const contractAddresses: Record<string, string> = parseTomlConfig(contractsPath)
    const rpcUrl: string = flags.pod ? config?.general?.L2_RPC_ENDPOINT : config?.frontend?.EXTERNAL_RPC_URI_L2
    const owner: string = config?.accounts?.OWNER_ADDR
    const explorer: string | undefined = config?.frontend?.EXTERNAL_EXPLORER_URI_L2

    if (!rpcUrl) {
      this.error(`Missing L2 RPC URL in ${configPath}. Please ensure L2_RPC_ENDPOINT (for pod mode) or EXTERNAL_RPC_URI_L2 (for non-pod mode) is defined.`, {exit: 1})
    }

    if (!owner || !ethers.isAddress(owner)) {
      this.error(`Missing or invalid OWNER_ADDR in ${configPath}. Please ensure it is defined in the accounts section.`, {exit: 1})
    }

    // Legacy L1 and retired gateway entries in config-contracts.toml are ignored.
    // Canonical preinstall addresses are fixed and cannot be overridden by config.
    const groups = [
      {contracts: contracts.map(contract => ({...contract, address: contractAddresses[contract.name]})), name: 'scroll-contracts'},
      {contracts: preinstalledContracts, name: 'dogeos-preinstalls'},
    ]
    const totals = {failures: 0, optionalAbsent: 0, passed: 0}
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const progress = new cliProgress.SingleBar({
      clearOnComplete: true,
      format: ' {bar} | {percentage}% | {value}/{total} | {name}',
      hideCursor: true,
    }, cliProgress.Presets.shades_classic)

    try {
      for (const group of groups) {
        this.log(chalk.bold(`\n=== ${group.name} (${group.contracts.length} contracts) ===`))
        const results: ContractResult[] = group.contracts.map(contract => ({contract, deployed: false, problems: []}))
        progress.start(results.length, 0, {name: `Checking ${group.name}...`})
        for (const result of results) {
          const {contract} = result
          progress.update({name: `${group.name}: ${contract.name}`})
          if (!contract.address || !ethers.isAddress(contract.address) || contract.address === ethers.ZeroAddress) {
            result.problems.push('Missing or invalid contract address')
          } else {
            result.deployed = await provider.getCode(contract.address) !== '0x'
            if (result.deployed) {
              await this.checkConfiguration(provider, contract, contractAddresses, owner, result.problems)
            }
          }

          progress.increment()
        }

        progress.stop()
        const summary = await this.reportResults(results, explorer)
        totals.passed += summary.passed
        totals.failures += summary.failures
        totals.optionalAbsent += summary.optionalAbsent
      }
    } finally {
      progress.stop()
      provider.destroy()
    }

    this.log(`\nOverall: ${totals.passed} passed, ${totals.failures} failed, ${totals.optionalAbsent} optional absent.`)
    if (totals.failures > 0) this.error('L2 contract checks failed.', {exit: 1})
    this.log(chalk.green('All required L2 contract and preinstall checks passed.'))
  }

  private async checkConfiguration(
    provider: ethers.Provider,
    contract: DeployedContract,
    addresses: Record<string, string>,
    expectedOwner: string,
    problems: string[],
  ): Promise<void> {
    const {initialization} = contract
    if (initialization) {
      try {
        if ('byteOffset' in initialization) {
          // Initializable uses one byte in slot 0. Moat packs it after its
          // 20-byte owner; Messenger and SystemConfig use the low byte.
          const slot = BigInt(await provider.getStorage(contract.address!, 0))
          // eslint-disable-next-line no-bitwise
          const initialized = (slot >> BigInt(initialization.byteOffset * 8)) & 0xffn
          if (initialized === 0n) problems.push('Contract not initialized')
        } else {
          const expected = addresses[initialization.expectedAddress]
          const instance = new ethers.Contract(contract.address!, [`function ${initialization.getter}() view returns (address)`], provider)
          const actual: string = await instance[initialization.getter]()
          if (!expected || !ethers.isAddress(expected) || actual === ethers.ZeroAddress || actual.toLowerCase() !== expected.toLowerCase()) {
            problems.push(`${initialization.getter}() does not match ${initialization.expectedAddress}`)
          }
        }
      } catch {
        problems.push('Unable to check initialization')
      }
    }

    if (contract.owned) {
      try {
        const instance = new ethers.Contract(contract.address!, ['function owner() view returns (address)'], provider)
        const actual: string = await instance.owner()
        if (actual.toLowerCase() !== expectedOwner.toLowerCase()) problems.push('Incorrect owner')
      } catch {
        problems.push('Unable to check ownership')
      }
    }
  }

  private async reportResults(results: ContractResult[], explorer?: string): Promise<{failures: number; optionalAbsent: number; passed: number}> {
    let failures = 0
    let passed = 0
    let optionalAbsent = 0
    for (const result of results) {
      const {contract, deployed, problems} = result
      const required = !contract.optional || results.some(other => other.contract.name === contract.requiredWhen && other.deployed)
      if (!deployed && problems.length === 0) {
        if (required) {
          problems.push('Contract not deployed')
        } else {
          optionalAbsent++
          this.log(chalk.yellow(`[optional absent] ${contract.name} (${contract.address})`))
          continue
        }
      }

      const link = contract.address && ethers.isAddress(contract.address) && explorer
        ? await addressLink(contract.address, {blockExplorerURI: explorer})
        : contract.address || '(no address)'
      if (problems.length > 0) {
        failures++
        this.log(chalk.red(`[failed] ${contract.name} (${link}): ${problems.join('; ')}`))
      } else {
        passed++
        const checks = ['Deployed']
        if (contract.initialization) checks.push('Initialized')
        if (contract.owned) checks.push('Correctly Owned')
        this.log(chalk.green(`[ok] ${contract.name} (${link}): ${checks.join(', ')}`))
      }
    }

    this.log(`\n${passed} passed, ${failures} failed, ${optionalAbsent} optional absent.`)
    return {failures, optionalAbsent, passed}
  }

}
