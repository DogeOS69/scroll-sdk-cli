import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import * as fs from 'node:fs'
import { getSetupDefaultsPath } from '../../config/constants.js'

export class BridgeInitCommand extends Command {
    static description = 'Initialize bridge for mainnet or testnet'

    static examples = [
        '$ scrollsdk doge:bridge-init',
        '$ scrollsdk doge:bridge-init -s 123456',
        '$ scrollsdk doge:bridge-init --seed 123456',
        '$ scrollsdk doge:bridge-init --image-tag v1.0.6-test',
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
        const defaultTag = 'v1.0.6-test'

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

        let newConfig = toml.parse(existingConfigStr);
        newConfig.seed_string = seed;
        fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));

        imageTag = await this.getDockerImageTag(imageTag)
        this.log(chalk.blue(`Using Docker image tag: ${imageTag}`))
        await this.runGenerateTestKeys(imageTag);
    }
}
export default BridgeInitCommand
