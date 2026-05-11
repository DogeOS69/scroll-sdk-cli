/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'

export class BridgeInitCommand extends Command {
    static description = 'Dogecoin wallet import'

    static examples = [

    ]

    static flags = {
        'doge-config': Flags.string({ description: 'Path to doge-config toml (e.g., .data/doge-config-testnet.toml)', required: false }),
        'image-tag': Flags.string({ description: 'Docker image tag', required: false }),
        'network': Flags.string({ description: 'Dogecoin network (e.g., testnet, mainnet)', required: false }),
        'rpc-url': Flags.string({ description: 'Dogecoin RPC URL', required: false }),
        'rpc-user': Flags.string({ description: 'Dogecoin RPC username', required: false }),
    }

    private configData: any = {}
    private dogeConfig: DogeConfig = {} as DogeConfig

    async run(): Promise<void> {
        const { flags } = await this.parse(BridgeInitCommand)
        let imageTag = flags['image-tag']

        const setupDefaultsPath = getSetupDefaultsPath();
        if (!fs.existsSync(setupDefaultsPath)) {
            this.error('setup_defaults.toml not found, please run `scrollsdk setup doge-config` first')
            return
        }

        const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf8');
        const configPath = path.join(process.cwd(), 'config.toml')
        let configData: any;
        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf8')
            configData = toml.parse(configContent)
        } else {
            this.warn('config.toml not found. Some values may not be populated correctly.')
        }

        const newConfig = toml.parse(existingConfigStr);
        newConfig.deposit_eth_recipient_address_hex = this.getNestedValue(configData, "accounts.DEPLOYER_ADDR")
        fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));

        // Load config files (config.toml, config-contracts.toml, doge-config, withdrawal-processor)
        await this.loadConfigs(flags)

        imageTag = await this.getDockerImageTag(imageTag)
        this.log(chalk.blue(`Using Docker image tag: ${imageTag}`))
        // Build CLI args from configs
        const network = flags.network || this.dogeConfig?.network || 'testnet'
        const isTestnet = network === 'testnet'
        const internalRpc = `http://dogecoin-${isTestnet ? 'testnet:44555' : 'mainnet:22555'}`
        const ingressHost = this.getNestedValue(this.configData, 'ingress.DOGECOIN_HOST')
        const rpcUrl = flags['rpc-url'] || (ingressHost ? `https://${ingressHost}` : internalRpc)
        const rpcUser = flags['rpc-user'] || this.dogeConfig?.dogecoinClusterRpc?.username || 'user'
        const rpcPassword = this.dogeConfig?.dogecoinClusterRpc?.password || 'password_test'
        const startHeight = String(this.dogeConfig?.defaults?.dogecoinIndexerStartHeight ?? '0')

        const output_test_data = fs.readFileSync("./.data/output-test-data.json", 'utf8');
        const output_test_data_json = JSON.parse(output_test_data);

        const { bridge_address, fee_wallet_address, sequencer_address } = output_test_data_json;

        const args = [
            '--rpc-url', rpcUrl,
            '--network', network,
            '--rpc-user', rpcUser,
            '--rpc-password', rpcPassword,
            '--address', bridge_address,
            '--address', sequencer_address,
            '--address', fee_wallet_address,
            '--label', 'watch',
            '--height', startHeight,
            '--rescan',
        ]
        await this.runImage(imageTag, args);

    }

    async runImage(imageTag: string, args: string[]): Promise<void> {
        const docker = new Docker();
        const image = `docker.io/dogeos69/dogecoin-wallet-import:${imageTag}`;
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
            const container = await docker.createContainer({
                Cmd: args,
                Env: ['RUST_LOG=trace'],
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

    private async fetchDockerTags(): Promise<string[]> {
        try {
            const response = await fetch(
                'https://registry.hub.docker.com/v2/repositories/dogeos69/dogecoin-wallet-import/tags?page_size=100',
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
        const defaultTag = '091625-00'
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

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
    }

    private async loadConfigs(flags: any): Promise<void> {
        const configPath = path.join(process.cwd(), 'config.toml')

        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf8')
            this.configData = toml.parse(configContent)
        } else {
            this.warn('config.toml not found. Some values may not be populated correctly.')
        }

        const { config } = await loadDogeConfigWithSelection(flags['doge-config'], 'scrollsdk setup doge-config')
        this.dogeConfig = config as DogeConfig
    }
}
export default BridgeInitCommand
