import { input } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { exec, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { promisify } from 'node:util'

import type { DogeConfig } from '../../types/doge-config.js'

import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
const execAsync = promisify(exec)

export default class SetupCubesignerRefresh extends Command {
    static override description = 'Refresh cubesigner session secrets'

    static override examples = [
        '<%= config.bin %> <%= command.id %>',
        '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config.toml',
        '<%= config.bin %> <%= command.id %> --non-interactive --doge-config .data/doge-config.toml',
        '<%= config.bin %> <%= command.id %> --non-interactive --json --doge-config .data/doge-config.toml --org-id Org#xxx --email user@example.com',
    ]

    static override flags = {
        'doge-config': Flags.string({
            description: 'Path to Dogecoin config file',
            required: false,
        }),
        'email': Flags.string({
            description: 'CubeSigner account email (for non-interactive login if not already logged in)',
            required: false,
        }),
        'environment': Flags.string({
            default: 'gamma',
            description: 'CubeSigner environment (default: gamma)',
            required: false,
        }),
        'json': Flags.boolean({
            default: false,
            description: 'Output in JSON format (stdout for data, stderr for logs)',
        }),
        'non-interactive': Flags.boolean({
            char: 'N',
            default: false,
            description: 'Run without prompts. Requires --doge-config. If not logged in, also requires --org-id and --email.',
        }),
        'org-id': Flags.string({
            description: 'CubeSigner organization ID (for non-interactive login if not already logged in)',
            required: false,
        }),
    }

    private dogeConfig: DogeConfig = {} as DogeConfig
    private dogeConfigFile: string = ''
    private jsonCtx!: JsonOutputContext
    private jsonMode: boolean = false
    private nonInteractive: boolean = false

    public async run(): Promise<void> {
        const { flags } = await this.parse(SetupCubesignerRefresh)

        this.nonInteractive = flags['non-interactive']
        this.jsonMode = flags.json
        this.jsonCtx = new JsonOutputContext('setup cubesigner-refresh', this.jsonMode)

        // In non-interactive mode, require --doge-config
        if (this.nonInteractive && !flags['doge-config']) {
            this.jsonCtx.error(
                'E601_MISSING_FIELD',
                '--doge-config flag is required in non-interactive mode',
                'CONFIGURATION',
                true,
                { flag: '--doge-config' }
            )
        }

        // Use the new common function to load config
        const { config, configPath } = await loadDogeConfigWithSelection(
            flags['doge-config'],
            'scrollsdk setup doge-config'
        )

        this.dogeConfig = config
        this.dogeConfigFile = configPath
        this.jsonCtx.info(`Using Dogecoin config file: ${configPath}`)

        await this.refreshSessions(flags)
    }

    private executeInteractiveCommand(command: string, args: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            this.jsonCtx.info(`Executing: ${command} ${args.join(' ')}`)
            this.jsonCtx.info(`Working directory: ${process.cwd()}`)

            // In JSON mode, capture output to avoid polluting stdout
            // In non-JSON mode, use inherit for interactive prompts
            const stdioOption = this.jsonMode ? 'pipe' : 'inherit'

            const child = spawn(command, args, {
                cwd: process.cwd(),
                shell: true,
                stdio: stdioOption
            })

            // In JSON mode, pipe output to stderr
            if (this.jsonMode) {
                child.stdout?.on('data', (data) => {
                    process.stderr.write(data)
                })
                child.stderr?.on('data', (data) => {
                    process.stderr.write(data)
                })
            }

            child.on('close', (code) => {
                this.jsonCtx.info(`Command exited with code: ${code}`)
                resolve(code === 0)
            })

            child.on('error', (error) => {
                this.jsonCtx.info(`Error executing command: ${error.message}`)
                resolve(false)
            })
        })
    }

    private async refreshSessions(flags: {
        'email'?: string
        'environment': string
        'org-id'?: string
    }) {
        this.jsonCtx.info(`Current working directory: ${process.cwd()}`)

        // Check if logged in, if not, perform login
        let needsLogin = false
        try {
            const result = await execAsync("cs session list")
            if (result.stdout.trim()) {
                this.jsonCtx.info('Already logged in, skipping login')
            } else {
                this.jsonCtx.info('No active session found, proceeding with login')
                needsLogin = true
            }
        } catch {
            this.jsonCtx.info('Not logged in, proceeding with login')
            needsLogin = true
        }

        if (needsLogin) {
            let orgId = flags['org-id']
            let {email} = flags
            const {environment} = flags

            // In non-interactive mode, require org-id and email if not logged in
            if (this.nonInteractive) {
                if (!orgId) {
                    this.jsonCtx.error(
                        'E601_MISSING_FIELD',
                        '--org-id flag is required in non-interactive mode when not already logged in',
                        'CONFIGURATION',
                        true,
                        { flag: '--org-id' }
                    )
                }

                if (!email) {
                    this.jsonCtx.error(
                        'E601_MISSING_FIELD',
                        '--email flag is required in non-interactive mode when not already logged in',
                        'CONFIGURATION',
                        true,
                        { flag: '--email' }
                    )
                }
            } else {
                // Interactive prompts
                if (!orgId) {
                    orgId = await input({
                        default: 'Org#14b38f70-9f97-4e39-b2ce-a54ce6045b08',
                        message: chalk.cyan('Enter your cubesigner organization ID:'),
                        validate(value: string) {
                            if (!value || value.trim() === '') {
                                return 'Organization ID cannot be empty'
                            }

                            return true
                        }
                    })
                }

                if (!email) {
                    email = await input({
                        message: chalk.cyan('Enter your cubesigner account(email):'),
                        validate(value: string) {
                            if (!value || value.trim() === '') {
                                return 'Email cannot be empty'
                            }

                            return true
                        }
                    })
                }
            }

            const loginSuccess = await this.executeInteractiveCommand('cs', [
                'login',
                '--env',
                environment,
                '--org-id',
                orgId!,
                email!
            ])

            if (!loginSuccess) {
                this.jsonCtx.error(
                    'E101_CUBESIGNER_LOGIN_FAILED',
                    'CubeSigner login failed',
                    'PREREQUISITE',
                    true,
                    { email, environment, orgId }
                )
                // jsonCtx.error throws, so this is unreachable
            }

            this.jsonCtx.info('Login successful')
        }

        // Read roles from DogeConfig instead of calling API
        try {
            if (!this.dogeConfig.cubesigner || !this.dogeConfig.cubesigner.roles || this.dogeConfig.cubesigner.roles.length === 0) {
                this.jsonCtx.error(
                    'E602_NO_ROLES_FOUND',
                    'No cubesigner roles found in config. Please run setup:cubesigner-init first to create and configure keys and roles.',
                    'CONFIGURATION',
                    true
                )
                // jsonCtx.error throws, so this is unreachable
            }

            const {roles} = this.dogeConfig.cubesigner
            this.jsonCtx.info(`Found ${roles.length} roles in config, creating session files...`)

            const sessionFiles: string[] = []
            const envFiles: string[] = []

            for (const [i, role] of roles.entries()) {
                const sessionFile = `./secrets/cubesigner-signer-${i}-session.json`
                const assignRoleCommand = `cs session create --role-id=${role.role_id} > ${sessionFile}`
                this.jsonCtx.info(`Executing: ${assignRoleCommand}`)
                await execAsync(assignRoleCommand)
                sessionFiles.push(sessionFile)

                const secret = `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${role.keys[0].key_id}"\n`
                const envFile = `./secrets/cubesigner-signer-${i}.env`
                fs.writeFileSync(envFile, secret)
                this.jsonCtx.info(`write ${envFile} success`)
                envFiles.push(envFile)
            }

            this.jsonCtx.info(`Successfully refreshed sessions for ${roles.length} roles`)

            // JSON success output
            this.jsonCtx.success({
                envFiles,
                roles: roles.map((r, i) => ({
                    index: i,
                    keyId: r.keys[0]?.key_id,
                    name: r.name,
                    role_id: r.role_id
                })),
                rolesCount: roles.length,
                sessionFiles
            })
        } catch (error) {
            this.jsonCtx.error(
                'E900_SESSION_REFRESH_FAILED',
                `Session refresh failed: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
            return false
        }

        return true
    }
}
