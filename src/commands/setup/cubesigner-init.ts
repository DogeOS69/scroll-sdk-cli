/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { exec } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

import type { CubesignerRole, DogeConfig } from '../../types/doge-config.js'

import { SETUP_DEFAULTS_TEMPLATE, getSetupDefaultsPath } from '../../config/constants.js'
import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { CliExitError, JsonOutputContext } from '../../utils/json-output.js'
const execAsync = promisify(exec)
const TEE_KEY_COUNT = 1

export default class SetupCubesignerSetup extends Command {
    static override description = 'Setup a CubeSigner TEE key and role'

    static override examples = [
        '<%= config.bin %> <%= command.id %> --roles tee_role',
        '<%= config.bin %> <%= command.id %> --new --role-prefix tee',
        '<%= config.bin %> <%= command.id %> --roles tee_role --doge-config .data/doge-config.toml',
        '<%= config.bin %> <%= command.id %>',
        '<%= config.bin %> <%= command.id %> --non-interactive --new --role-prefix tee --doge-config .data/doge-config.toml',
        '<%= config.bin %> <%= command.id %> --non-interactive --json --roles tee_role --doge-config .data/doge-config.toml',
    ]

    static override flags = {
        'count': Flags.integer({
            description: 'Number of TEE keys/roles to create (must be 1; default 1)',
            required: false,
        }),
        'doge-config': Flags.string({
            description: 'Path to Dogecoin config file',
            required: false,
        }),
        'json': Flags.boolean({
            default: false,
            description: 'Output in JSON format (stdout for data, stderr for logs)',
        }),
        'new': Flags.boolean({
            default: false,
            description: 'Create new roles and keys',
            required: false,
        }),
        'non-interactive': Flags.boolean({
            char: 'N',
            default: false,
            description: 'Run without prompts. Requires --doge-config and either --new (with --role-prefix) or --roles.',
        }),
        'role-prefix': Flags.string({
            description: 'Prefix for role names (when using --new)',
            required: false,
        }),
        'roles': Flags.string({
            description: 'Comma-separated list of existing role names to use',
            multiple: true,
            required: false,
        }),
        'threshold': Flags.integer({
            description: 'Deprecated; ignored because cubesigner-init configures the single TEE key.',
            required: false,
        }),
    }

    private dogeConfig: DogeConfig = {} as DogeConfig
    private dogeConfigFile: string = ''
    private jsonCtx!: JsonOutputContext
    private jsonMode: boolean = false
    private nonInteractive: boolean = false

    public async run(): Promise<void> {
        const { flags } = await this.parse(SetupCubesignerSetup)

        this.nonInteractive = flags['non-interactive']
        this.jsonMode = flags.json
        this.jsonCtx = new JsonOutputContext('setup cubesigner-init', this.jsonMode)

        // Validate flag combinations
        if (flags.new && flags.roles) {
            this.jsonCtx.error(
                'E601_INVALID_FLAGS',
                'Cannot specify both --new and --roles flags',
                'CONFIGURATION',
                true,
                { flags: ['--new', '--roles'] }
            )
        }

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

        // In non-interactive mode, require either --new or --roles
        if (this.nonInteractive && !flags.new && !flags.roles) {
            this.jsonCtx.error(
                'E601_MISSING_FIELD',
                'Either --new or --roles flag is required in non-interactive mode',
                'CONFIGURATION',
                true,
                { requiredFlags: ['--new', '--roles'] }
            )
        }

        if (flags.threshold !== undefined) {
            this.jsonCtx.info('Ignoring deprecated --threshold flag; CubeSigner now configures the single TEE key.')
        }

        // Use the new common function to load config
        const { config, configPath } = await loadDogeConfigWithSelection(
            flags['doge-config'],
            'scrollsdk setup doge-config'
        )

        this.dogeConfig = config
        this.dogeConfigFile = configPath
        this.jsonCtx.info(`Using Dogecoin config file: ${configPath}`)

        // Check cubesigner login
        await this.checkCubesignerLogin()

        // Determine operation mode
        let useNew = flags.new
        let useExistingRoles = flags.roles

        if (!useNew && !useExistingRoles) {
            // This path should not be reached in non-interactive mode due to earlier validation
            const operationMode = await select({
                choices: [
                    { name: 'Create new roles and keys', value: 'new' },
                    { name: 'Use existing roles', value: 'existing' }
                ],
                message: chalk.cyan('Do you want to create new roles or use existing ones?')
            })
            useNew = operationMode === 'new'
        }

        if (useNew) {
            let {count} = flags
            let rolePrefix = flags['role-prefix']
            count = count || TEE_KEY_COUNT

            if (count !== TEE_KEY_COUNT) {
                this.jsonCtx.error(
                    'E600_INVALID_VALUE',
                    `CubeSigner TEE setup supports exactly ${TEE_KEY_COUNT} key/role`,
                    'VALIDATION',
                    true,
                    { count, expectedCount: TEE_KEY_COUNT }
                )
            }

            // In non-interactive mode, require role-prefix
            if (this.nonInteractive && !rolePrefix) {
                this.jsonCtx.error(
                    'E601_MISSING_FIELD',
                    '--role-prefix flag is required when using --new in non-interactive mode',
                    'CONFIGURATION',
                    true,
                    { flag: '--role-prefix' }
                )
            }

            if (!rolePrefix) {
                rolePrefix = await input({
                    default: 'tee',
                    message: chalk.cyan('Enter TEE role name prefix:'),
                    validate(value: string) {
                        if (!value || value.trim() === '') {
                            return 'Role prefix cannot be empty'
                        }

                        return true
                    }
                })
            }

            this.jsonCtx.info(`You will have ${TEE_KEY_COUNT} CubeSigner TEE key.`)
            await this.createNewRolesAndKeys(count, rolePrefix)
        } else {
            if (!useExistingRoles || useExistingRoles.length === 0) {
                if (this.nonInteractive) {
                    this.jsonCtx.error(
                        'E601_MISSING_FIELD',
                        '--roles flag must specify at least one role in non-interactive mode',
                        'CONFIGURATION',
                        true,
                        { flag: '--roles' }
                    )
                }

                useExistingRoles = await this.selectExistingRoles()
            }

            if (!useExistingRoles) {
                this.jsonCtx.error(
                    'E601_MISSING_FIELD',
                    'No roles selected',
                    'CONFIGURATION',
                    true
                )
                // jsonCtx.error throws, so this is unreachable
            }

            if (useExistingRoles.length !== TEE_KEY_COUNT) {
                this.jsonCtx.error(
                    'E600_INVALID_VALUE',
                    `CubeSigner TEE setup requires exactly ${TEE_KEY_COUNT} role`,
                    'VALIDATION',
                    true,
                    { expectedCount: TEE_KEY_COUNT, roleCount: useExistingRoles.length }
                )
            }

            this.jsonCtx.info(`You will have ${TEE_KEY_COUNT} CubeSigner TEE key.`)
            await this.useExistingRoles(useExistingRoles)
        }
    }

    private async checkCubesignerLogin(): Promise<void> {
        try {
            const result = await execAsync("cs session list")
            if (result.stdout.trim()) {
                this.jsonCtx.info('Already logged in to cubesigner')
            } else {
                this.jsonCtx.error(
                    'E101_CUBESIGNER_NOT_LOGGED_IN',
                    'Not logged in to cubesigner. Please run "cs login" interactively first, then re-run this command.',
                    'PREREQUISITE',
                    true,
                    { hint: 'CubeSigner requires OIDC authentication which cannot be automated. Login once, then use --non-interactive for this command.' }
                )
            }
        } catch {
            this.jsonCtx.error(
                'E101_CUBESIGNER_NOT_LOGGED_IN',
                'Not logged in to cubesigner. Please run "cs login" interactively first, then re-run this command.',
                'PREREQUISITE',
                true,
                { hint: 'CubeSigner requires OIDC authentication which cannot be automated. Login once, then use --non-interactive for this command.' }
            )
        }
    }

    private async createNewRolesAndKeys(count: number, rolePrefix: string): Promise<void> {
        this.jsonCtx.info(`Creating ${count} new TEE role and key with prefix "${rolePrefix}"`)

        try {
            // Create keys
            const keyType = this.dogeConfig.network === 'mainnet' ? 'secp-doge' : 'secp-doge-test'
            const createKeyCommand = `cs key create --key-type ${keyType} --count ${count}`
            this.jsonCtx.info(`Executing: ${createKeyCommand}`)
            const createKeyOutput = (await execAsync(createKeyCommand)).stdout
            const keyResult = JSON.parse(createKeyOutput)
            const createdKeys = keyResult.keys
            this.jsonCtx.info(`Successfully created ${createdKeys.length} keys`)

            // Create roles and associate keys
            const selectedRoles: any[] = []
            for (let i = 0; i < count; i++) {
                const roleName = `${rolePrefix}${i}`
                const createRoleCommand = `cs role create --role-name "${roleName}"`
                this.jsonCtx.info(`Executing: ${createRoleCommand}`)
                const createRoleOutput = (await execAsync(createRoleCommand)).stdout
                const roleResult = JSON.parse(createRoleOutput)

                // Add key to role
                const addKeyCommand = `cs role add-key --role-id="${roleResult.role_id}" --key-id="${createdKeys[i].key_id}"`
                this.jsonCtx.info(`Executing: ${addKeyCommand}`)
                await execAsync(addKeyCommand)

                selectedRoles.push({
                    ...roleResult,
                    keys: [createdKeys[i]]
                })
            }

            this.jsonCtx.info(`Successfully created ${selectedRoles.length} roles`)
            await this.saveRolesToConfig(selectedRoles)

        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E900_CUBESIGNER_ERROR',
                `Failed to create roles and keys: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
        }
    }

    private async saveRolesToConfig(selectedRoles: any[]) {
        try {
            this.jsonCtx.info('Saving roles to DogeConfig...')

            // Convert selectedRoles to CubesignerRole format
            const cubesignerRoles: CubesignerRole[] = selectedRoles.map(role => ({
                keys: role.keys.map((key: any) => ({
                    key_id: key.key_id,
                    key_type: key.key_type,
                    material_id: key.material_id,
                    public_key: key.public_key,
                    purpose: key.purpose
                })),
                name: role.name,
                role_id: role.role_id
            }))

            // Update DogeConfig
            this.dogeConfig.cubesigner = {
                roles: cubesignerRoles
            }

            // Write to file
            fs.writeFileSync(this.dogeConfigFile, dogeConfigToToml(this.dogeConfig))
            this.jsonCtx.info(`Successfully saved ${cubesignerRoles.length} roles to ${this.dogeConfigFile}`)

            // Update setup_defaults.toml with the CubeSigner TEE public key
            await this.updateSetupDefaultsWithTeeKey(selectedRoles)

        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E900_CONFIG_SAVE_ERROR',
                `Failed to save roles to config: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
        }
    }

    private async selectExistingRoles(): Promise<string[]> {
        try {
            // List all available roles
            const listRoleCommand = `cs role list`
            const listRoleOutput = (await execAsync(listRoleCommand)).stdout
            const roleResult = JSON.parse(listRoleOutput)
            const availableRoles = roleResult.roles || []

            if (availableRoles.length === 0) {
                this.jsonCtx.error(
                    'E602_NO_ROLES_FOUND',
                    'No existing cubesigner roles found',
                    'CONFIGURATION',
                    true
                )
            }

            const roleChoices = availableRoles.map((role: any) => ({
                name: `${role.name} (${role.role_id}) - ${role.keys?.length || 0} keys`,
                value: role.name
            }))

            const selectedRoleName = await select({
                choices: roleChoices,
                message: chalk.cyan('Select the CubeSigner TEE role to use:'),
            }) as string

            return [selectedRoleName]

        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E900_CUBESIGNER_ERROR',
                `Failed to list roles: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
            return []
        }
    }

    private async updateSetupDefaultsWithTeeKey(selectedRoles: any[]) {
        try {
            this.jsonCtx.info('Updating setup_defaults.toml with CubeSigner TEE public key...')

            const setupDefaultsPath = getSetupDefaultsPath()

            if (!fs.existsSync(setupDefaultsPath)) {
                // Ensure the target directory exists
                const targetDir = path.dirname(setupDefaultsPath)
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true })
                }

                this.jsonCtx.info(`Creating setup defaults from embedded template at ${setupDefaultsPath}`)
                fs.writeFileSync(setupDefaultsPath, SETUP_DEFAULTS_TEMPLATE)
            }

            // Read existing config file from user's working directory
            const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf8')
            const setupConfig = toml.parse(existingConfigStr)

            const teePubkeys: string[] = []
            for (const role of selectedRoles) {
                if (role.keys && role.keys.length > 0) {
                    const key = role.keys[0] // Use first key of each role
                    teePubkeys.push(key.public_key.replace(/^0x/, ''))
                }
            }

            if (teePubkeys.length !== TEE_KEY_COUNT) {
                this.jsonCtx.error(
                    'E602_INVALID_CUBESIGNER_TEE_KEY_COUNT',
                    `Expected exactly ${TEE_KEY_COUNT} CubeSigner TEE public key, got ${teePubkeys.length}`,
                    'CONFIGURATION',
                    true,
                    { expectedCount: TEE_KEY_COUNT, keyCount: teePubkeys.length }
                )
            }

            setupConfig.tee_pubkey = teePubkeys[0]

            this.jsonCtx.info(`Configured ${TEE_KEY_COUNT} CubeSigner TEE key.`)
            // Write to setup_defaults.toml
            fs.writeFileSync(setupDefaultsPath, toml.stringify(setupConfig))
            this.jsonCtx.info(`Successfully updated ${setupDefaultsPath} with CubeSigner TEE public key`)

            // Output JSON success response
            this.jsonCtx.success({
                dogeConfigFile: this.dogeConfigFile,
                roles: selectedRoles.map(role => ({
                    keyCount: role.keys?.length || 0,
                    name: role.name,
                    role_id: role.role_id
                })),
                rolesCount: selectedRoles.length,
                setupDefaultsFile: setupDefaultsPath,
                teeKeyCount: TEE_KEY_COUNT,
                teePubkey: teePubkeys[0],
            })

        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E900_CONFIG_UPDATE_ERROR',
                `Failed to update setup_defaults.toml: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
        }
    }

    private async useExistingRoles(roleNames: string[]): Promise<void> {
        this.jsonCtx.info(`Using existing roles: ${roleNames.join(', ')}`)

        try {
            // List all available roles
            const listRoleCommand = `cs role list`
            const listRoleOutput = (await execAsync(listRoleCommand)).stdout
            const roleResult = JSON.parse(listRoleOutput)
            const availableRoles = roleResult.roles || []

            if (availableRoles.length === 0) {
                this.jsonCtx.error(
                    'E602_NO_ROLES_FOUND',
                    'No existing cubesigner roles found',
                    'CONFIGURATION',
                    true
                )
            }

            // Find specified roles and get their keys
            const selectedRoles: any[] = []
            for (const roleName of roleNames) {
                const role = availableRoles.find((r: any) => r.name === roleName)
                if (!role) {
                    this.jsonCtx.error(
                        'E602_ROLE_NOT_FOUND',
                        `Role "${roleName}" not found`,
                        'CONFIGURATION',
                        true,
                        { roleName }
                    )
                }

                // Get role details
                const roleDetailCommand = `cs role get --role-id="${role.role_id}"`
                const roleDetailOutput = (await execAsync(roleDetailCommand)).stdout
                const roleDetail = JSON.parse(roleDetailOutput)

                // Get detailed information for each key in this specific role
                const detailedKeys: any[] = []
                for (const keyRef of roleDetail.keys || []) {
                    const keyDetailCommand = `cs key get --key-id="${keyRef.key_id}" --role-id="${role.role_id}"`
                    const keyDetailOutput = (await execAsync(keyDetailCommand)).stdout
                    const keyDetail = JSON.parse(keyDetailOutput)
                    detailedKeys.push(keyDetail)
                }

                // Replace the basic key info with detailed key info
                roleDetail.keys = detailedKeys
                selectedRoles.push(roleDetail)
            }

            this.jsonCtx.info(`Found ${selectedRoles.length} existing roles`)
            await this.saveRolesToConfig(selectedRoles)

        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E900_CUBESIGNER_ERROR',
                `Failed to use existing roles: ${error}`,
                'INTERNAL',
                false,
                { error: String(error) }
            )
        }
    }
}
