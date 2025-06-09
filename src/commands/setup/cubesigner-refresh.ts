import { Command, Flags } from '@oclif/core'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { input, select } from '@inquirer/prompts'
import chalk from 'chalk'
import * as fs from 'fs'
import type { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import * as path from 'path'
const execAsync = promisify(exec)

export default class SetupCubesignerRefresh extends Command {
    static override description = 'Refresh cubesigner session secrets'

    static override examples = [
        '<%= config.bin %> <%= command.id %>',
    ]

    static override flags = {
        'doge-config': Flags.string({
            description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
            required: false,
        }),
    }

    private dogeConfig: DogeConfig = {} as DogeConfig
    private dogeConfigFile: string = ''

    public async run(): Promise<void> {
        const { flags } = await this.parse(SetupCubesignerRefresh)

        // Use the new common function to load config
        const { config, configPath } = await loadDogeConfigWithSelection(
            flags['doge-config'],
            'scrollsdk doge:config'
        )

        this.dogeConfig = config
        this.dogeConfigFile = configPath
        this.log(chalk.blue(`Using Dogecoin config file: ${configPath}`))

        await this.refreshSessions()
    }

    private executeInteractiveCommand(command: string, args: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            this.log(chalk.yellow(`Executing: ${command} ${args.join(' ')}`))
            this.log(chalk.yellow(`Working directory: ${process.cwd()}`))

            const child = spawn(command, args, {
                stdio: 'inherit',
                shell: true,
                cwd: process.cwd()
            })

            child.on('close', (code) => {
                this.log(chalk.yellow(`Command exited with code: ${code}`))
                resolve(code === 0)
            })

            child.on('error', (error) => {
                console.error(chalk.red(`Error executing command: ${error.message}`))
                resolve(false)
            })
        })
    }

    private async refreshSessions() {
        this.log(chalk.blue(`Current working directory: ${process.cwd()}`))

        // Check if logged in, if not, perform login
        try {
            const result = await execAsync("cs session list")
            if (result.stdout.trim()) {
                this.log(chalk.green('Already logged in, skipping login'))
            } else {
                this.log(chalk.yellow('No active session found, proceeding with login'))
                throw new Error('No active session')
            }
        } catch (error) {
            this.log(chalk.yellow('Not logged in, proceeding with login'))
            const orgId = await input({
                message: chalk.cyan('Enter your cubesigner organization ID:'),
                default: 'Org#14b38f70-9f97-4e39-b2ce-a54ce6045b08',
                validate: (value: string) => {
                    if (!value || value.trim() === '') {
                        return 'Organization ID cannot be empty'
                    }
                    return true
                }
            })
            const email = await input({
                message: chalk.cyan('Enter your cubesigner account(email):'),
                validate: (value: string) => {
                    if (!value || value.trim() === '') {
                        return 'Email cannot be empty'
                    }
                    return true
                }
            })

            const environment = await input({
                message: chalk.cyan('Enter cubesigner environment:'),
                default: 'gamma',
                validate: (value: string) => {
                    if (!value || value.trim() === '') {
                        return 'Environment cannot be empty'
                    }
                    return true
                }
            })

            const loginSuccess = await this.executeInteractiveCommand('cs', [
                'login',
                '--env',
                environment,
                '--org-id',
                orgId,
                email
            ])

            if (!loginSuccess) {
                this.error(chalk.red('Login failed'))
                return false
            }

            this.log(chalk.green('Login successful'))
        }

        // Read roles from DogeConfig instead of calling API
        try {
            if (!this.dogeConfig.cubesigner || !this.dogeConfig.cubesigner.roles || this.dogeConfig.cubesigner.roles.length === 0) {
                this.error(chalk.red('No cubesigner roles found in config. Please run setup:cubesigner-init first to create and configure keys and roles.'))
                return false
            }

            const roles = this.dogeConfig.cubesigner.roles
            this.log(chalk.blue(`Found ${roles.length} roles in config, creating session files...`))

            for (let i = 0; i < roles.length; i++) {
                let role = roles[i]
                const assignRoleCommand = `cs session create --role-id=${role.role_id} > ./secrets/cubesigner-signer-${i}-session.json`
                this.log(chalk.yellow(`Executing: ${assignRoleCommand}`))
                await execAsync(assignRoleCommand)

                let secret = `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${role.keys[0].key_id}"\n`
                let envFile = `./secrets/cubesigner-signer-${i}.env`
                fs.writeFileSync(envFile, secret)
                this.log(chalk.green(`write ${envFile} success`))
            }

            this.log(chalk.green(`Successfully refreshed sessions for ${roles.length} roles`))
        } catch (error) {
            this.error(chalk.red(`Session refresh failed: ${error}`))
            return false
        }

        return true
    }
}
