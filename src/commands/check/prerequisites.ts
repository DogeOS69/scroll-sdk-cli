import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'

interface PrerequisiteCheck {
  check: () => Promise<CheckResult>
  description: string
  name: string
  required: boolean
}

interface CheckResult {
  error?: string
  message?: string
  passed: boolean
  version?: string
}

interface PrerequisiteResult {
  description: string
  error?: string
  message?: string
  name: string
  passed: boolean
  required: boolean
  version?: string
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
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    verbose: Flags.boolean({
      char: 'v',
      default: false,
      description: 'Show detailed output for each check',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(CheckPrerequisites)
    const jsonCtx = new JsonOutputContext('check prerequisites', flags.json)

    const log = (msg: string) => jsonCtx.log(msg)
    const logSuccess = (msg: string) => jsonCtx.logSuccess(msg)

    const prerequisites: PrerequisiteCheck[] = [
      // Required CLI tools
      {
        check: () => this.checkCommand('docker'),
        description: 'Docker CLI',
        name: 'docker',
        required: true,
      },
      {
        check: () => this.checkDockerRunning(),
        description: 'Docker daemon running',
        name: 'docker-daemon',
        required: true,
      },
      {
        check: () => this.checkCommand('kubectl'),
        description: 'Kubernetes CLI',
        name: 'kubectl',
        required: true,
      },
      {
        check: () => this.checkKubectlConnected(),
        description: 'kubectl cluster connection',
        name: 'kubectl-connected',
        required: false,
      },
      {
        check: () => this.checkCommand('helm'),
        description: 'Helm package manager',
        name: 'helm',
        required: true,
      },
      {
        check: () => this.checkHelmRepos(),
        description: 'Helm repositories',
        name: 'helm-repos',
        required: false,
      },
      {
        check: () => this.checkCommand('node'),
        description: 'Node.js runtime',
        name: 'node',
        required: true,
      },
      {
        check: () => this.checkCommand('npm'),
        description: 'NPM package manager',
        name: 'npm',
        required: true,
      },
      {
        check: () => this.checkCommand('git'),
        description: 'Git version control',
        name: 'git',
        required: true,
      },
      // Optional but useful
      {
        check: () => this.checkCommand('jq'),
        description: 'JSON processor',
        name: 'jq',
        required: false,
      },
      {
        check: () => this.checkCommand('aws'),
        description: 'AWS CLI',
        name: 'aws',
        required: false,
      },
      // Configuration checks
      {
        check: () => this.checkConfigFile(),
        description: 'Main configuration file',
        name: 'config.toml',
        required: true,
      },
      {
        check: () => this.checkDataDir(),
        description: 'Data directory',
        name: '.data',
        required: false,
      },
      {
        check: () => this.checkDogeConfig(),
        description: 'Doge configuration',
        name: 'doge-config',
        required: false,
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
        description: prereq.description,
        name: prereq.name,
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
          failed: totalFailed,
          passed: totalPassed,
          results,
          totalChecks: results.length,
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
            failed: totalFailed,
            failedRequired: failedRequired.map(r => ({
              description: r.description,
              error: r.error,
              name: r.name,
            })),
            passed: totalPassed,
            results,
            totalChecks: results.length,
          }
        )
      }
    }

    // Exit with error code if required checks failed (non-JSON mode)
    if (!allRequiredPassed) {
      this.exit(1)
    }
  }

  private async checkCommand(command: string, versionFlag: string = '--version'): Promise<CheckResult> {
    try {
      const output = execSync(`${command} ${versionFlag}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      }).trim()

      // Extract version from output (first line, first version-like match)
      const versionMatch = output.match(/v?(\d+\.\d+\.?\d*)/i)
      const version = versionMatch ? versionMatch[1] : output.split('\n')[0].trim()

      return { passed: true, version }
    } catch {
      return {
        error: `Command '${command}' not found or failed`,
        passed: false,
      }
    }
  }

  private async checkConfigFile(): Promise<CheckResult> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (fs.existsSync(configPath)) {
      const stats = fs.statSync(configPath)
      return {
        message: `Found (${Math.round(stats.size / 1024)}KB)`,
        passed: true,
      }
    }

    return {
      error: 'config.toml not found in current directory',
      passed: false,
    }
  }

  private async checkDataDir(): Promise<CheckResult> {
    const dataDir = path.join(process.cwd(), '.data')
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir)
      return {
        message: `Found with ${files.length} files`,
        passed: true,
      }
    }

    return {
      error: '.data directory not found. Run scrollsdk commands to create it.',
      passed: false,
    }
  }

  private async checkDockerRunning(): Promise<CheckResult> {
    try {
      execSync('docker info', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      return { message: 'Docker daemon is running', passed: true }
    } catch {
      return {
        error: 'Docker daemon is not running. Start Docker and try again.',
        passed: false,
      }
    }
  }

  private async checkDogeConfig(): Promise<CheckResult> {
    const dataDir = path.join(process.cwd(), '.data')
    if (!fs.existsSync(dataDir)) {
      return { error: '.data directory not found', passed: false }
    }

    const files = fs.readdirSync(dataDir)
    const dogeConfigs = files.filter(f => f.startsWith('doge') && f.endsWith('.toml'))

    if (dogeConfigs.length > 0) {
      return {
        message: `Found: ${dogeConfigs.join(', ')}`,
        passed: true,
      }
    }

    return {
      error: 'No doge config files found. Run `scrollsdk setup doge-config` first.',
      passed: false,
    }
  }

  private async checkHelmRepos(): Promise<CheckResult> {
    try {
      const output = execSync('helm repo list', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })

      // Check for expected repos
      const hasScrollSdk = output.includes('scroll-sdk')
      const hasBitnami = output.includes('bitnami')

      if (!hasScrollSdk && !hasBitnami) {
        return {
          error: 'No Helm repositories configured. Run `helm repo add` to add required repos.',
          passed: false,
        }
      }

      const repos: string[] = []
      if (hasScrollSdk) repos.push('scroll-sdk')
      if (hasBitnami) repos.push('bitnami')

      return {
        message: `Repos configured: ${repos.join(', ')}`,
        passed: true,
      }
    } catch {
      return {
        error: 'No Helm repositories configured',
        passed: false,
      }
    }
  }

  private async checkKubectlConnected(): Promise<CheckResult> {
    try {
      const output = execSync('kubectl cluster-info', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15_000,
      })
      const clusterMatch = output.match(/kubernetes.*is running at\s+(https?:\/\/\S+)/i)
      return {
        message: clusterMatch ? `Connected to ${clusterMatch[1]}` : 'Connected to cluster',
        passed: true,
      }
    } catch {
      return {
        error: 'kubectl is not connected to a cluster. Configure your kubeconfig.',
        passed: false,
      }
    }
  }

}
