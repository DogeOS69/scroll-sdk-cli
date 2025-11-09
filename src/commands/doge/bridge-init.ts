import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getSetupDefaultsPath } from '../../config/constants.js'

export class BridgeInitCommand extends Command {
    static description = 'Initialize bridge for mainnet or testnet'

    static examples = [
        '$ scrollsdk doge:bridge-init',
        '$ scrollsdk doge:bridge-init -s 123456',
        '$ scrollsdk doge:bridge-init --seed 123456',
        '$ scrollsdk doge:bridge-init --image-tag 0.2.0-debug',
    ]

    static flags = {
        seed: Flags.string({
            char: 's',
            description: 'seed which will regenerate the sequencer and fee wallet',
        }),
        'image-tag': Flags.string({
            description: 'Specify the Docker image tag to use',
            required: false,
        }),
    }

    private async fetchDockerTags(): Promise<string[]> {
        try {
            const response = await fetch(
                'https://registry.hub.docker.com/v2/repositories/dogeos69/generate-test-keys/tags?page_size=100',
            )
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }

            const data = await response.json()
            return data.results.map((tag: any) => tag.name)
        } catch (error) {
            this.error(`Failed to fetch Docker tags: ${error}`)
        }
    }

    private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
        const defaultTag = '0.2.0-rc.0-71a4fcb4'

        if (!providedTag) {
            return defaultTag
        }

        const tags = await this.fetchDockerTags()

        if (tags.includes(providedTag)) {
            return providedTag
        }

        if (providedTag.startsWith('v') && tags.includes(providedTag)) {
            return providedTag
        }

        if (/^\d+\.\d+\.\d+(-test)?$/.test(providedTag) && tags.includes(`v${providedTag}`)) {
            return `v${providedTag}`
        }

        const selectedTag = await select({
            choices: tags.map((tag) => ({ name: tag, value: tag })),
            message: 'Select a Docker image tag:',
        })

        return selectedTag
    }

    async runGenerateTestKeys(imageTag: string): Promise<void> {
        const docker = new Docker();
        const image = `docker.io/dogeos69/generate-test-keys:${imageTag}`;
        try {
            this.log(chalk.cyan(`Pulling Docker Image: ${image}`))
            // Pull the image if it doesn't exist locally
            const pullStream = await docker.pull(image)
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(pullStream, (err, res) => {
                    if (err) {
                        reject(err)
                    } else {
                        this.log(chalk.green('Image pulled successfully'))
                        resolve(res)
                    }
                })
            })

            this.log(chalk.cyan('Creating Docker Container...'))
            // Create and run the container
            const container = await docker.createContainer({
                Cmd: [], // Add any command if needed
                HostConfig: {
                    Binds: [`${process.cwd()}:/app`],
                },
                WorkingDir: '/app',
                Image: image,
            })

            this.log(chalk.cyan('Starting Container'))
            await container.start()

            // Wait for the container to finish and get the logs
            const stream = await container.logs({
                follow: true,
                stderr: true,
                stdout: true,
            })

            // Print the logs
            stream.pipe(process.stdout)

            // Wait for the container to finish
            await new Promise((resolve) => {
                container.wait((err, data) => {
                    if (err) {
                        this.error(`Container exited with error: ${err}`)
                    } else if (data.StatusCode !== 0) {
                        this.error(`Container exited with status code: ${data.StatusCode}`)
                    }
                    resolve(null)
                })
            })

            // Remove the container
            await container.remove()
        } catch (error) {
            this.error(`Failed to run Docker command: ${error}`)
        }
    }

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
    }
    async run(): Promise<void> {
        const { flags } = await this.parse(BridgeInitCommand)
        let seed = flags.seed
        let imageTag = flags['image-tag']

        // Read existing seed from setup_defaults.toml
        const setupDefaultsPath = getSetupDefaultsPath();
        if (!fs.existsSync(setupDefaultsPath)) {
            this.error('setup_defaults.toml not found, please run `scrollsdk doge:config` first')
            return
        }
        const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf-8');
        const existingConfig = toml.parse(existingConfigStr) as any;
        const existingSeed = existingConfig.seed_string || '';

        if (!seed) {
            seed = await input({
                message: 'Enter the seed string',
                default: existingSeed,
            })
        }

        const configPath = path.join(process.cwd(), 'config.toml')
        let configData: any;
        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf-8')
            configData = toml.parse(configContent)
        } else {
            this.warn('config.toml not found. Some values may not be populated correctly.')
        }

        let newConfig = toml.parse(existingConfigStr);
        newConfig.seed_string = seed;
        newConfig.deposit_eth_recipient_address_hex=this.getNestedValue(configData,"accounts.DEPLOYER_ADDR")
        fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));

        imageTag = await this.getDockerImageTag(imageTag)
        this.log(chalk.blue(`Using Docker image tag: ${imageTag}`))
        await this.runGenerateTestKeys(imageTag);
        
        // Move output files to .data directory
        const dataDir = path.join(process.cwd(), '.data');
        const outputFiles = [
            'output-withdrawal-processor.toml',
            'output-dummy-signer-keys.json',
            'output-test-data.json'
        ];
        
        // Create .data directory if it doesn't exist
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        for (const fileName of outputFiles) {
            const sourceFile = path.join(process.cwd(), fileName);
            const targetFile = path.join(dataDir, fileName);
            
            if (fs.existsSync(sourceFile)) {
                fs.renameSync(sourceFile, targetFile);
                this.log(chalk.green(`Moved ${fileName} to .data directory`));
            }
        }
    }
}
export default BridgeInitCommand
