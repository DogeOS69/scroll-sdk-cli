/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import Docker from 'dockerode'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { DogeConfig } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { resolveDogecoinKubernetesEndpoints } from '../../utils/kubernetes-endpoints.js'

export class BridgeInitCommand extends Command {
    static description = 'Dogecoin wallet import'

    static examples = [

    ]

    static flags = {
        'all-replicas': Flags.boolean({ description: 'Import watch-only addresses into every Dogecoin StatefulSet replica using in-cluster pod DNS', required: false }),
        'doge-config': Flags.string({ description: 'Path to Dogecoin config file', required: false }),
        'image-tag': Flags.string({ description: 'Docker image tag', required: false }),
        'namespace': Flags.string({ default: 'default', description: 'Kubernetes namespace for --all-replicas mode', required: false }),
        'replicas': Flags.integer({ description: 'Dogecoin replica count for --all-replicas mode. Defaults to the StatefulSet replica count.', required: false }),
        'rpc-password': Flags.string({ description: 'Dogecoin RPC password', required: false }),
        'rpc-port': Flags.integer({ description: 'Dogecoin RPC port for --all-replicas mode', required: false }),
        'rpc-url': Flags.string({ description: 'Dogecoin RPC URL', required: false }),
        'rpc-user': Flags.string({ description: 'Dogecoin RPC username', required: false }),
        'service-name': Flags.string({ description: 'Stable Dogecoin Kubernetes service name for --all-replicas mode', required: false }),
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
        const { network } = this.dogeConfig
        const dogecoinEndpoints = resolveDogecoinKubernetesEndpoints({
            kubernetes: this.dogeConfig?.kubernetes,
            network,
        })
        const serviceName = flags['service-name'] || dogecoinEndpoints.serviceName
        const rpcPort = flags['rpc-port'] || dogecoinEndpoints.rpcPort
        const internalRpc = `http://${serviceName}:${rpcPort}`
        const ingressHost = this.getNestedValue(this.configData, 'ingress.DOGECOIN_HOST')
        const rpcUrl = flags['rpc-url'] || (ingressHost ? `https://${ingressHost}` : internalRpc)
        const rpcUser = flags['rpc-user'] || this.dogeConfig?.dogecoinClusterRpc?.username || 'user'
        const rpcPassword = flags['rpc-password'] || this.dogeConfig?.dogecoinClusterRpc?.password || 'password_test'
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
        await (flags['all-replicas'] ? this.runImageForKubernetesReplicas(imageTag, args, {
                namespace: flags.namespace,
                replicas: flags.replicas,
                rpcPort,
                serviceName,
            }) : this.runImage(imageTag, args));

    }

    async runImage(imageTag: string, args: string[]): Promise<void> {
        const docker = new Docker();
        const image = `docker.io/dogeos69/dogecoin-wallet-import:${imageTag}`;
        const hostUser =
            typeof process.getuid === 'function' && typeof process.getgid === 'function'
                ? `${process.getuid()}:${process.getgid()}`
                : undefined
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
                User: hostUser,
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

    async runImageForKubernetesReplicas(
        imageTag: string,
        baseArgs: string[],
        options: { namespace: string; replicas?: number; rpcPort: number; serviceName: string }
    ): Promise<void> {
        const replicas = options.replicas ?? this.getStatefulSetReplicas(options.namespace, options.serviceName)
        if (replicas < 1) {
            this.error(`Dogecoin StatefulSet ${options.serviceName} has no replicas`)
        }

        for (let index = 0; index < replicas; index++) {
            const rpcUrl = `http://${options.serviceName}-${index}.${options.serviceName}-headless:${options.rpcPort}`
            const args = this.withRpcUrl(baseArgs, rpcUrl)
            const podName = `dogecoin-wallet-import-${index}-${Date.now()}`
            this.log(chalk.cyan(`Importing watch-only addresses into ${rpcUrl}`))
            this.runKubernetesImage(podName, options.namespace, imageTag, args)
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

    private getStatefulSetReplicas(namespace: string, statefulSetName: string): number {
        const output = execFileSync('kubectl', [
            'get',
            'statefulset',
            statefulSetName,
            '-n',
            namespace,
            '-o',
            'jsonpath={.spec.replicas}',
        ], { encoding: 'utf8' }).trim()
        const replicas = Number(output || '1')
        if (!Number.isInteger(replicas)) {
            this.error(`Invalid replica count from StatefulSet ${statefulSetName}: ${output}`)
        }

        return replicas
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

    private runKubernetesImage(podName: string, namespace: string, imageTag: string, args: string[]): void {
        execFileSync('kubectl', [
            'run',
            podName,
            '-n',
            namespace,
            '--rm',
            '-i',
            '--restart=Never',
            '--image',
            `docker.io/dogeos69/dogecoin-wallet-import:${imageTag}`,
            '--',
            ...args,
        ], { stdio: 'inherit' })
    }

    private withRpcUrl(args: string[], rpcUrl: string): string[] {
        const nextArgs = [...args]
        const rpcUrlIndex = nextArgs.indexOf('--rpc-url')
        if (rpcUrlIndex === -1) {
            return ['--rpc-url', rpcUrl, ...nextArgs]
        }

        nextArgs[rpcUrlIndex + 1] = rpcUrl
        return nextArgs
    }
}
export default BridgeInitCommand
