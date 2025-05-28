import { Command, Flags } from '@oclif/core'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { input } from '@inquirer/prompts'
import chalk from 'chalk'
const execAsync = promisify(exec)

export default class SetupCubesigner extends Command {
    static override description = 'Refresh cubesigner session secrets'

    static override examples = [
        '<%= config.bin %> <%= command.id %>',
    ]

    public async run(): Promise<void> {
        await this.runCsCommand()
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

    private async runCsCommand() {
        this.log(chalk.blue(`Current working directory: ${process.cwd()}`))

        //if logined, skip login
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

            const loginSuccess = await this.executeInteractiveCommand('cs', [
                'login',
                '--env',
                'gamma',
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

        try {
            const listRoleCommand = `cs role list`
            const listRoleOutput = (await execAsync(listRoleCommand)).stdout
            const outRoot = JSON.parse(listRoleOutput)
            const roles = outRoot.roles
            for (let i = 0; i < roles.length; i++) {
                let role = roles[i]
                const assignRoleCommand = `cs session create --role-id=${role.role_id} > ./secrets/cubesigner-signer-${i}-session.json`
                this.log(chalk.yellow(`Executing: ${assignRoleCommand}`))
                await execAsync(assignRoleCommand)
            }
        } catch (error) {
            this.error(chalk.red(`Role assignment failed: ${error}`))
            return false
        }

        return true
    }
}