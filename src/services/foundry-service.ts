import chalk from 'chalk'
import { ContractFactory, Interface, InterfaceAbi, Wallet } from 'ethers'
import { ExecFileException, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface HelperVerificationConfig {
  apiKey?: string
  chainId?: string
  enabled: boolean
}

export interface HelperContractConfig {
  file?: string
  name?: string
  redeploy?: boolean
  root?: string
  verification: HelperVerificationConfig
}

export class FoundryService {
  constructor(private log: (msg: string) => void, private warn: (msg: string) => void) { }

  public async buildHelperDeploymentArtifacts(
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
    const {data} = deployTx
    if (!data) {
      throw new Error('Failed to encode helper deployment data.')
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

  public async compileHelperContract(
    contractFile: string,
    contractName: string,
    foundryRoot?: string,
  ): Promise<{
    abi: InterfaceAbi
    bytecode: string
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

  public findFoundryProjectRoot(startDir: string): string | undefined {
    let currentDir = path.resolve(startDir)
    // eslint-disable-next-line no-constant-condition
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

  public normalizeForFoundryPath(filePath: string): string {
    if (!filePath) {
      return ''
    }

    const normalized = filePath.split(path.sep).join(path.posix.sep)
    return normalized.startsWith('./') ? normalized.slice(2) : normalized
  }

  public async runForgeInspect(
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
      const execError = error as { stderr?: string } & ExecFileException
      const stderr = execError?.stderr ? execError.stderr.toString().trim() : ''
      throw new Error(`forge inspect ${field} failed for ${contractSpecifier}${stderr ? `: ${stderr}` : ''}`)
    }
  }

  public async verifyHelperContract(
    address: string | undefined,
    helperConfig: HelperContractConfig,
    encodedConstructorArgs?: string,
    l2VerifierType?: string,
    l2ExplorerApiUrl?: string,
  ): Promise<void> {
    const {verification} = helperConfig
    if (!verification.enabled) return

    if (!address) {
      this.warn('Verification requested but no contract address was produced.')
      return
    }

    if (!helperConfig.file || !helperConfig.name) {
      this.warn('Verification requested but helper contract source file or name is missing.')
      return
    }

    const {chainId} = verification
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

    if (l2VerifierType) {
      args.push('--verifier', l2VerifierType)
    }

    if (l2ExplorerApiUrl) {
      args.push('--verifier-url', l2ExplorerApiUrl)
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
      const execError = error as { stderr?: string } & ExecFileException
      const stderr = execError?.stderr?.toString().trim()
      this.warn(
        `Helper contract verification failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
      )
    }
  }
}
