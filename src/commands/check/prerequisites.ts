import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { JsonOutputContext, ERROR_CODES } from '../../utils/json-output.js'

interface PrerequisiteCheck {
  name: string
  description: string
  required: boolean
  check: () => Promise<CheckResult>
}

interface CheckResult {
  passed: boolean
  version?: string
  message?: string
  error?: string
}

interface PrerequisiteResult {
  name: string
  description: string
  required: boolean
  passed: boolean
  version?: string
  message?: string
  error?: string
}

export default class CheckPrerequisites extends Command {
  static override description = 'Check that all required prerequisites are installed and configured'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --verbose',
  ]

  static override flags = {
    json: Flags.boolean({
      description: 'Output in JSON format (stdout for data, stderr for logs)',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output for each check',
      default: false,
    }),
  }

  private async checkCommand(command: string, versionFlag: string = '--version'): Promise<CheckResult> {
    try {
      const output = execSync(`${command} ${versionFlag}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).trim()

      // Extract version from output (first line, first version-like match)
      const versionMatch = output.match(/v?(\d+\.\d+\.?\d*)/i)
      const version = versionMatch ? versionMatch[1] : output.split('\n')[0].trim()

      return { passed: true, version }
    } catch (error) {
      return {
        passed: false,
        error: `Command '${command}' not found or failed`,
      }
    }
  }

  private async checkDockerRunning(): Promise<CheckResult> {
    try {
      execSync('docker info', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      })
      return { passed: true, message: 'Docker daemon is running' }
    } catch {
      return {
        passed: false,
        error: 'Docker daemon is not running. Start Docker and try again.',
      }
    }
  }

  private async checkKubectlConnected(): Promise<CheckResult> {
    try {
      const output = execSync('kubectl cluster-info', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      })
      const clusterMatch = output.match(/Kubernetes.*is running at\s+(https?:\/\/[^\s]+)/i)
      return {
        passed: true,
        message: clusterMatch ? `Connected to ${clusterMatch[1]}` : 'Connected to cluster',
      }
    } catch {
      return {
        passed: false,
        error: 'kubectl is not connected to a cluster. Configure your kubeconfig.',
      }
    }
  }

  private async checkHelmRepos(): Promise<CheckResult> {
    try {
      const output = execSync('helm repo list', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      })

      // Check for expected repos
      const hasScrollSdk = output.includes('scroll-sdk')
      const hasBitnami = output.includes('bitnami')

      if (!hasScrollSdk && !hasBitnami) {
        return {
          passed: false,
          error: 'No Helm repositories configured. Run `helm repo add` to add required repos.',
        }
      }

      const repos: string[] = []
      if (hasScrollSdk) repos.push('scroll-sdk')
      if (hasBitnami) repos.push('bitnami')

      return {
        passed: true,
        message: `Repos configured: ${repos.join(', ')}`,
      }
    } catch {
      return {
        passed: false,
        error: 'No Helm repositories configured',
      }
    }
  }

  private async checkConfigFile(): Promise<CheckResult> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (fs.existsSync(configPath)) {
      const stats = fs.statSync(configPath)
      return {
        passed: true,
        message: `Found (${Math.round(stats.size / 1024)}KB)`,
      }
    }
    return {
      passed: false,
      error: 'config.toml not found in current directory',
    }
  }

  private async checkDataDir(): Promise<CheckResult> {
    const dataDir = path.join(process.cwd(), '.data')
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir)
      return {
        passed: true,
        message: `Found with ${files.length} files`,
      }
    }
    return {
      passed: false,
      error: '.data directory not found. Run scrollsdk commands to create it.',
    }
  }

  private async checkDogeConfig(): Promise<CheckResult> {
    const dataDir = path.join(process.cwd(), '.data')
    if (!fs.existsSync(dataDir)) {
      return { passed: false, error: '.data directory not found' }
    }

    const files = fs.readdirSync(dataDir)
    const dogeConfigs = files.filter(f => f.startsWith('doge') && f.endsWith('.toml'))

    if (dogeConfigs.length > 0) {
      return {
        passed: true,
        message: `Found: ${dogeConfigs.join(', ')}`,
      }
    }
    return {
      passed: false,
      error: 'No doge config files found. Run `scrollsdk doge:config` first.',
    }
  }

  private async checkNodeModules(): Promise<CheckResult> {
    const nodeModulesPath = path.join(process.cwd(), 'node_modules')
    if (fs.existsSync(nodeModulesPath)) {
      return { passed: true, message: 'node_modules present' }
    }
    return {
      passed: false,
      error: 'node_modules not found. Run `npm install` first.',
    }
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(CheckPrerequisites)
    const jsonCtx = new JsonOutputContext('check prerequisites', flags.json)

    const log = (msg: string) => jsonCtx.log(msg)
    const logSuccess = (msg: string) => jsonCtx.logSuccess(msg)

    const prerequisites: PrerequisiteCheck[] = [
      // Required CLI tools
      {
        name: 'docker',
        description: 'Docker CLI',
        required: true,
        check: () => this.checkCommand('docker'),
      },
      {
        name: 'docker-daemon',
        description: 'Docker daemon running',
        required: true,
        check: () => this.checkDockerRunning(),
      },
      {
        name: 'kubectl',
        description: 'Kubernetes CLI',
        required: true,
        check: () => this.checkCommand('kubectl'),
      },
      {
        name: 'kubectl-connected',
        description: 'kubectl cluster connection',
        required: false,
        check: () => this.checkKubectlConnected(),
      },
      {
        name: 'helm',
        description: 'Helm package manager',
        required: true,
        check: () => this.checkCommand('helm'),
      },
      {
        name: 'helm-repos',
        description: 'Helm repositories',
        required: false,
        check: () => this.checkHelmRepos(),
      },
      {
        name: 'node',
        description: 'Node.js runtime',
        required: true,
        check: () => this.checkCommand('node'),
      },
      {
        name: 'npm',
        description: 'NPM package manager',
        required: true,
        check: () => this.checkCommand('npm'),
      },
      {
        name: 'git',
        description: 'Git version control',
        required: true,
        check: () => this.checkCommand('git'),
      },
      // Optional but useful
      {
        name: 'jq',
        description: 'JSON processor',
        required: false,
        check: () => this.checkCommand('jq'),
      },
      {
        name: 'aws',
        description: 'AWS CLI',
        required: false,
        check: () => this.checkCommand('aws'),
      },
      // Configuration checks
      {
        name: 'config.toml',
        description: 'Main configuration file',
        required: true,
        check: () => this.checkConfigFile(),
      },
      {
        name: '.data',
        description: 'Data directory',
        required: false,
        check: () => this.checkDataDir(),
      },
      {
        name: 'doge-config',
        description: 'Doge configuration',
        required: false,
        check: () => this.checkDogeConfig(),
      },
    ]

    log(chalk.bold.underline('\nChecking Prerequisites\n'))

    const results: PrerequisiteResult[] = []
    let allRequiredPassed = true
    let totalPassed = 0
    let totalFailed = 0

    for (const prereq of prerequisites) {
      const result = await prereq.check()
      const resultObj: PrerequisiteResult = {
        name: prereq.name,
        description: prereq.description,
        required: prereq.required,
        ...result,
      }
      results.push(resultObj)

      const requiredTag = prereq.required ? chalk.red('[REQUIRED]') : chalk.gray('[optional]')
      const status = result.passed
        ? chalk.green('✓')
        : prereq.required
          ? chalk.red('✗')
          : chalk.yellow('○')

      const versionInfo = result.version ? chalk.gray(` (${result.version})`) : ''
      const messageInfo = result.message ? chalk.gray(` - ${result.message}`) : ''
      const errorInfo = result.error && !result.passed ? chalk.red(` - ${result.error}`) : ''

      if (flags.verbose || !result.passed) {
        log(`${status} ${prereq.description} ${requiredTag}${versionInfo}${messageInfo}${errorInfo}`)
      } else {
        log(`${status} ${prereq.description}${versionInfo}`)
      }

      if (result.passed) {
        totalPassed++
      } else {
        totalFailed++
        if (prereq.required) {
          allRequiredPassed = false
        }
      }
    }

    log('')

    if (allRequiredPassed) {
      logSuccess(chalk.green(`\n✓ All required prerequisites satisfied (${totalPassed}/${results.length} checks passed)`))
    } else {
      log(chalk.red(`\n✗ Some required prerequisites are missing (${totalPassed}/${results.length} checks passed)`))
      log(chalk.yellow('\nPlease install the missing required tools before continuing.'))
    }

    // Output JSON response and exit appropriately
    if (flags.json) {
      if (allRequiredPassed) {
        jsonCtx.success({
          allRequiredPassed,
          totalChecks: results.length,
          passed: totalPassed,
          failed: totalFailed,
          results,
        })
      } else {
        // Use error() which outputs JSON and exits with code 1
        const failedRequired = results.filter(r => r.required && !r.passed)
        jsonCtx.error(
          'E100_PREREQUISITES_MISSING',
          `${failedRequired.length} required prerequisite(s) not satisfied`,
          'PREREQUISITE',
          true,
          {
            allRequiredPassed,
            totalChecks: results.length,
            passed: totalPassed,
            failed: totalFailed,
            failedRequired: failedRequired.map(r => ({
              name: r.name,
              description: r.description,
              error: r.error,
            })),
            results,
          }
        )
      }
    }

    // Exit with error code if required checks failed (non-JSON mode)
    if (!allRequiredPassed) {
      this.exit(1)
    }
  }
}
