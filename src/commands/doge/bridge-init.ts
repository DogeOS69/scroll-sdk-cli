import * as toml from '@iarna/toml'
import { input } from '@inquirer/prompts'
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
    ]

    static flags = {
        seed: Flags.string({
            char: 's',
            description: 'seed which will regenerate the sequencer and fee wallet',
        }),
    }
    async runGenerateTestKeys(): Promise<void> {
        const docker = new Docker();
        const image = `docker.io/dogeos69/generate-test-keys:v0.1.1-test`;
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
        await this.runGenerateTestKeys();
    }
}
export default BridgeInitCommand
