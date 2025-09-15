import { Command, Flags } from '@oclif/core'
import { exec } from 'child_process'
import { promisify } from 'util'
import { input, select, checkbox } from '@inquirer/prompts'
import chalk from 'chalk'
import * as fs from 'fs'
import * as toml from '@iarna/toml'
import type { DogeConfig, CubesignerRole } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { getSetupDefaultsPath, SETUP_DEFAULTS_TEMPLATE } from '../../config/constants.js'
import * as path from 'path'
const execAsync = promisify(exec)

export default class SetupCubesignerSetup extends Command {
    static override description = 'Setup cubesigner keys and roles'

    static override examples = [
        '<%= config.bin %> <%= command.id %> --roles foo_role bar_role baz_role',
        '<%= config.bin %> <%= command.id %> --new --count 4 --role-prefix attestor',
        '<%= config.bin %> <%= command.id %> --new --count 3 --role-prefix validator',
        '<%= config.bin %> <%= command.id %> --roles role_a role_b --doge-config .data/doge-config-testnet.toml',
        '<%= config.bin %> <%= command.id %>',
    ]

    static override flags = {
        'doge-config': Flags.string({
            description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)',
            required: false,
        }),
        'roles': Flags.string({
            description: 'Comma-separated list of existing role names to use',
            required: false,
            multiple: true,
        }),
        'new': Flags.boolean({
            description: 'Create new roles and keys',
            required: false,
            default: false,
        }),
        'count': Flags.integer({
            description: 'Number of keys/roles to create (when using --new)',
            required: false,
        }),
        'role-prefix': Flags.string({
            description: 'Prefix for role names (when using --new)',
            required: false,
        }),
    }

    private dogeConfig: DogeConfig = {} as DogeConfig
    private dogeConfigFile: string = ''

    public async run(): Promise<void> {
        const { flags } = await this.parse(SetupCubesignerSetup)
        
        // Validate flag combinations
        if (flags.new && flags.roles) {
            this.error(chalk.red('Cannot specify both --new and --roles flags'))
        }
        
        // Use the new common function to load config
        const { config, configPath } = await loadDogeConfigWithSelection(
            flags['doge-config'], 
            'scrollsdk doge:config'
        )
        
        this.dogeConfig = config
        this.dogeConfigFile = configPath
        this.log(chalk.blue(`Using Dogecoin config file: ${configPath}`))
        
        // Check cubesigner login
        await this.checkCubesignerLogin()
        
        // Determine operation mode
        let useNew = flags.new
        let useExistingRoles = flags.roles
        
        if (!useNew && !useExistingRoles) {
            const operationMode = await select({
                message: chalk.cyan('Do you want to create new roles or use existing ones?'),
                choices: [
                    { name: 'Create new roles and keys', value: 'new' },
                    { name: 'Use existing roles', value: 'existing' }
                ]
            })
            useNew = operationMode === 'new'
        }
        
        if (useNew) {
            let count = flags.count
            let rolePrefix = flags['role-prefix']
            
            if (!count) {
                const countStr = await input({
                    message: chalk.cyan('How many roles/keys do you want to create?'),
                    default: '3',
                    validate: (value: string) => {
                        const num = parseInt(value)
                        if (isNaN(num) || num <= 0) {
                            return 'Please enter a valid positive number'
                        }
                        return true
                    }
                })
                count = parseInt(countStr)
            }
            
            if (!rolePrefix) {
                rolePrefix = await input({
                    message: chalk.cyan('Enter role name prefix:'),
                    default: 'devnet',
                    validate: (value: string) => {
                        if (!value || value.trim() === '') {
                            return 'Role prefix cannot be empty'
                        }
                        return true
                    }
                })
            }
            
            // Ask user to choose attestation_threshold right after count and rolePrefix
            this.log(chalk.cyan(`You will have ${count} attestation keys.`))
            
            let defaultThreshold: number
            if (count === 1) {
                defaultThreshold = 1
            } else if (count === 2) {
                defaultThreshold = 2
            } else {
                defaultThreshold = Math.ceil(count * 2 / 3) // 2/3 majority
            }
            
            const thresholdStr = await input({
                message: chalk.cyan(`Enter attestation threshold (how many signatures required, 1-${count}):`),
                default: defaultThreshold.toString(),
                validate: (value: string) => {
                    const num = parseInt(value)
                    if (isNaN(num) || num < 1 || num > count) {
                        return `Please enter a number between 1 and ${count}`
                    }
                    return true
                }
            })
            const threshold = parseInt(thresholdStr)
            
            await this.createNewRolesAndKeys(count, rolePrefix, threshold)
        } else {
            if (!useExistingRoles || useExistingRoles.length === 0) {
                useExistingRoles = await this.selectExistingRoles()
            }
            
            // Ensure useExistingRoles is not undefined
            if (!useExistingRoles) {
                this.error('No roles selected')
                return
            }
            
            // Ask user to choose attestation_threshold for existing roles
            this.log(chalk.cyan(`You will have ${useExistingRoles.length} attestation keys.`))
            
            let defaultThreshold: number
            if (useExistingRoles.length === 1) {
                defaultThreshold = 1
            } else if (useExistingRoles.length === 2) {
                defaultThreshold = 2
            } else {
                defaultThreshold = Math.ceil(useExistingRoles.length * 2 / 3) // 2/3 majority
            }
            
            const thresholdStr = await input({
                message: chalk.cyan(`Enter attestation threshold (how many signatures required, 1-${useExistingRoles.length}):`),
                default: defaultThreshold.toString(),
                validate: (value: string) => {
                    const num = parseInt(value)
                    if (isNaN(num) || num < 1 || num > useExistingRoles!.length) {
                        return `Please enter a number between 1 and ${useExistingRoles!.length}`
                    }
                    return true
                }
            })
            const threshold = parseInt(thresholdStr)
            
            await this.useExistingRoles(useExistingRoles, threshold)
        }
    }

    private async checkCubesignerLogin(): Promise<void> {
        try {
            const result = await execAsync("cs session list")
            if (result.stdout.trim()) {
                this.log(chalk.green('Already logged in to cubesigner'))
            } else {
                this.error(chalk.red('Not logged in to cubesigner. Please run login first.'))
            }
        } catch (error) {
            this.error(chalk.red('Not logged in to cubesigner. Please run login first.'))
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
                this.error(chalk.red('No existing roles found'))
            }

            const roleChoices = availableRoles.map((role: any) => ({
                name: `${role.name} (${role.role_id}) - ${role.keys?.length || 0} keys`,
                value: role.name
            }))

            const selectedRoleNames = await checkbox({
                message: chalk.cyan('Select roles to use:'),
                choices: roleChoices,
                validate: (answer: readonly any[]) => {
                    if (answer.length === 0) {
                        return 'Please select at least one role'
                    }
                    return true
                }
            }) as string[]

            return selectedRoleNames
            
        } catch (error) {
            this.error(chalk.red(`Failed to list roles: ${error}`))
            return []
        }
    }

    private async createNewRolesAndKeys(count: number, rolePrefix: string, threshold: number): Promise<void> {
        this.log(chalk.blue(`Creating ${count} new roles and keys with prefix "${rolePrefix}"`))
        
        try {
            // Create keys
            const keyType = this.dogeConfig.network === 'mainnet' ? 'secp-doge' : 'secp-doge-test'
            const createKeyCommand = `cs key create --key-type ${keyType} --count ${count}`
            this.log(chalk.yellow(`Executing: ${createKeyCommand}`))
            const createKeyOutput = (await execAsync(createKeyCommand)).stdout
            const keyResult = JSON.parse(createKeyOutput)
            const createdKeys = keyResult.keys
            this.log(chalk.green(`Successfully created ${createdKeys.length} keys`))

            // Create roles and associate keys
            const selectedRoles: any[] = []
            for (let i = 0; i < count; i++) {
                const roleName = `${rolePrefix}${i}`
                const createRoleCommand = `cs role create --role-name "${roleName}"`
                this.log(chalk.yellow(`Executing: ${createRoleCommand}`))
                const createRoleOutput = (await execAsync(createRoleCommand)).stdout
                const roleResult = JSON.parse(createRoleOutput)
                
                // Add key to role
                const addKeyCommand = `cs role add-key --role-id="${roleResult.role_id}" --key-id="${createdKeys[i].key_id}"`
                this.log(chalk.yellow(`Executing: ${addKeyCommand}`))
                await execAsync(addKeyCommand)
                
                selectedRoles.push({
                    ...roleResult,
                    keys: [createdKeys[i]]
                })
            }
            
            this.log(chalk.green(`Successfully created ${selectedRoles.length} roles`))
            await this.saveRolesToConfig(selectedRoles, threshold)
            
        } catch (error) {
            this.error(chalk.red(`Failed to create roles and keys: ${error}`))
        }
    }

    private async useExistingRoles(roleNames: string[], threshold: number): Promise<void> {
        this.log(chalk.blue(`Using existing roles: ${roleNames.join(', ')}`))
        
        try {
            // List all available roles
            const listRoleCommand = `cs role list`
            const listRoleOutput = (await execAsync(listRoleCommand)).stdout
            const roleResult = JSON.parse(listRoleOutput)
            const availableRoles = roleResult.roles || []
            
            if (availableRoles.length === 0) {
                this.error(chalk.red('No existing roles found'))
            }

            // Find specified roles and get their keys
            const selectedRoles: any[] = []
            for (const roleName of roleNames) {
                const role = availableRoles.find((r: any) => r.name === roleName)
                if (!role) {
                    this.error(chalk.red(`Role "${roleName}" not found`))
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
            
            this.log(chalk.green(`Found ${selectedRoles.length} existing roles`))
            await this.saveRolesToConfig(selectedRoles, threshold)
            
        } catch (error) {
            this.error(chalk.red(`Failed to use existing roles: ${error}`))
        }
    }

    private async saveRolesToConfig(selectedRoles: any[], threshold: number) {
        try {
            this.log(chalk.blue('Saving roles to DogeConfig...'))
            
            // Convert selectedRoles to CubesignerRole format
            const cubesignerRoles: CubesignerRole[] = selectedRoles.map(role => ({
                role_id: role.role_id,
                name: role.name,
                keys: role.keys.map((key: any) => ({
                    key_id: key.key_id,
                    key_type: key.key_type,
                    public_key: key.public_key,
                    material_id: key.material_id,
                    purpose: key.purpose
                }))
            }))
            
            // Update DogeConfig
            this.dogeConfig.cubesigner = {
                roles: cubesignerRoles
            }
            
            // Write to file
            fs.writeFileSync(this.dogeConfigFile, toml.stringify(this.dogeConfig as any))
            this.log(chalk.green(`Successfully saved ${cubesignerRoles.length} roles to ${this.dogeConfigFile}`))
            
            // Update setup_defaults.toml with attestation public keys
            await this.updateSetupDefaultsWithKeys(selectedRoles, threshold)
            
        } catch (error) {
            this.error(chalk.red(`Failed to save roles to config: ${error}`))
        }
    }

    private async updateSetupDefaultsWithKeys(selectedRoles: any[], threshold: number) {
        try {
            this.log(chalk.blue('Updating setup_defaults.toml with attestation public keys...'))
            
            const setupDefaultsPath = getSetupDefaultsPath()
            
            if (!fs.existsSync(setupDefaultsPath)) {
                // Ensure the target directory exists
                const targetDir = path.dirname(setupDefaultsPath)
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true })
                }
                
                this.log(chalk.blue(`Creating setup defaults from embedded template at ${setupDefaultsPath}`))
                fs.writeFileSync(setupDefaultsPath, SETUP_DEFAULTS_TEMPLATE)
            }
            
            // Read existing config file from user's working directory
            const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf-8')
            let setupConfig = toml.parse(existingConfigStr)
            
            // Collect public keys from selected roles
            const attestationPubkeys: string[] = []
            for (let i = 0; i < selectedRoles.length; i++) {
                const role = selectedRoles[i]
                if (role.keys && role.keys.length > 0) {
                    const key = role.keys[0] // Use first key of each role
                    attestationPubkeys.push(key.public_key.replace(/^0x/, ''))
                }
            }
            
            // Update attestation_pubkeys array
            setupConfig.attestation_pubkeys = attestationPubkeys
            
            // Update attestation_key_count
            setupConfig.attestation_key_count = attestationPubkeys.length
            
            // Ask user to choose attestation_threshold
            const keyCount = attestationPubkeys.length
            this.log(chalk.cyan(`You have configured ${keyCount} attestation keys.`))
            
            setupConfig.attestation_threshold = threshold
            
            // Write to setup_defaults.toml
            fs.writeFileSync(setupDefaultsPath, toml.stringify(setupConfig))
            this.log(chalk.green(`Successfully updated ${setupDefaultsPath} with ${attestationPubkeys.length} attestation public keys`))
            this.log(chalk.green(`Updated attestation_key_count to ${keyCount} and attestation_threshold to ${threshold}`))
            
        } catch (error) {
            this.error(chalk.red(`Failed to update setup_defaults.toml: ${error}`))
        }
    }
}
