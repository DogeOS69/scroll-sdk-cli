import * as toml from '@iarna/toml'
import { input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import Docker from 'dockerode'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { CliExitError, JsonOutputContext } from '../../utils/json-output.js'

export class BridgeInitCommand extends Command {
    static description = 'Initialize bridge for mainnet or testnet'

    static examples = [
        '$ scrollsdk doge:bridge-init',
        '$ scrollsdk doge:bridge-init -s 123456',
        '$ scrollsdk doge:bridge-init --seed 123456',
        '$ scrollsdk doge:bridge-init --image-tag 0.2.0-debug',
        '$ scrollsdk doge:bridge-init --non-interactive --seed 123456 --image-tag 0.2.0-rc.3',
        '$ scrollsdk doge:bridge-init --non-interactive --json --seed 123456',
    ]

    static flags = {
        'image-tag': Flags.string({
            description: 'Specify the Docker image tag to use (defaults to 0.2.0-rc.3)',
            required: false,
        }),
        'json': Flags.boolean({
            default: false,
            description: 'Output in JSON format (stdout for data, stderr for logs)',
        }),
        'non-interactive': Flags.boolean({
            char: 'N',
            default: false,
            description: 'Run without prompts. Requires --seed flag.',
        }),
        seed: Flags.string({
            char: 's',
            description: 'seed which will regenerate the sequencer and fee wallet',
        }),
    }

    private jsonCtx!: JsonOutputContext
    private jsonMode: boolean = false
    private nonInteractive: boolean = false

    async run(): Promise<void> {
        const { flags } = await this.parse(BridgeInitCommand)

        this.nonInteractive = flags['non-interactive']
        this.jsonMode = flags.json
        this.jsonCtx = new JsonOutputContext('doge bridge-init', this.jsonMode)

        let {seed} = flags
        let imageTag = flags['image-tag']

        // In non-interactive mode, require seed
        if (this.nonInteractive && !seed) {
            this.jsonCtx.error(
                'E601_MISSING_FIELD',
                '--seed flag is required in non-interactive mode',
                'CONFIGURATION',
                true,
                { flag: '--seed' }
            )
        }

        // Read existing seed from setup_defaults.toml
        const setupDefaultsPath = getSetupDefaultsPath();
        if (!fs.existsSync(setupDefaultsPath)) {
            this.jsonCtx.error(
                'E103_DOGE_CONFIG_MISSING',
                'setup_defaults.toml not found, please run `scrollsdk doge:config` first',
                'CONFIGURATION',
                true,
                { path: setupDefaultsPath }
            )
            // jsonCtx.error throws, so this is unreachable
        }

        const existingConfigStr = fs.readFileSync(setupDefaultsPath, 'utf8');
        const existingConfig = toml.parse(existingConfigStr) as any;
        const existingSeed = existingConfig.seed_string || '';

        if (!seed) {
            seed = await input({
                default: existingSeed,
                message: 'Enter the seed string',
            })
        }

        const configPath = path.join(process.cwd(), 'config.toml')
        let configData: any;
        if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf8')
            configData = toml.parse(configContent)
        } else {
            this.jsonCtx.addWarning('config.toml not found. Some values may not be populated correctly.')
        }

        const newConfig = toml.parse(existingConfigStr);
        newConfig.seed_string = seed;
        newConfig.deposit_eth_recipient_address_hex = this.getNestedValue(configData, "accounts.DEPLOYER_ADDR")
        fs.writeFileSync(setupDefaultsPath, toml.stringify(newConfig));

        imageTag = await this.getDockerImageTag(imageTag)
        this.jsonCtx.info(`Using Docker image tag: ${imageTag}`)
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

        const movedFiles: string[] = []
        for (const fileName of outputFiles) {
            const sourceFile = path.join(process.cwd(), fileName);
            const targetFile = path.join(dataDir, fileName);

            if (fs.existsSync(sourceFile)) {
                fs.renameSync(sourceFile, targetFile);
                this.jsonCtx.info(`Moved ${fileName} to .data directory`);
                movedFiles.push(targetFile)
            }
        }

        // Parse confirmed block height from output-test-data.json and update doge-config
        let confirmedBlockHeight: number | undefined
        let confirmedBlockHash: string | undefined
        const testDataPath = path.join(dataDir, 'output-test-data.json')
        if (fs.existsSync(testDataPath)) {
            // Parse the JSON file
            let testData: any
            try {
                testData = JSON.parse(fs.readFileSync(testDataPath, 'utf8'))
            } catch (parseError) {
                this.jsonCtx.addWarning(`Failed to parse output-test-data.json: ${parseError}. dogecoinIndexerStartHeight was NOT updated.`)
                testData = null
            }

            if (testData) {
                confirmedBlockHeight = testData.confirmed_block_height
                confirmedBlockHash = testData.confirmed_block_hash

                if (confirmedBlockHeight && confirmedBlockHeight > 0) {
                    this.jsonCtx.info(`Bridge transactions confirmed at block height: ${confirmedBlockHeight}`)
                    this.updateDogeConfigBlockHeight(setupDefaultsPath, dataDir, confirmedBlockHeight)
                }
            }
        }

        // JSON success output
        this.jsonCtx.success({
            confirmedBlockHash,
            confirmedBlockHeight,
            imageTag,
            outputFiles: movedFiles,
            seed,
            setupDefaultsPath
        })
    }

    async runGenerateTestKeys(imageTag: string): Promise<void> {
        const docker = new Docker();
        const image = `docker.io/dogeos69/generate-test-keys:${imageTag}`;
        try {
            this.jsonCtx.info(`Pulling Docker Image: ${image}`)
            // Pull the image if it doesn't exist locally
            const pullStream = await docker.pull(image)
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(pullStream, (err, res) => {
                    if (err) {
                        reject(err)
                    } else {
                        this.jsonCtx.info('Image pulled successfully')
                        resolve(res)
                    }
                })
            })

            this.jsonCtx.info('Creating Docker Container...')
            // Create and run the container
            const container = await docker.createContainer({
                Cmd: [], // Add any command if needed
                HostConfig: {
                    Binds: [`${process.cwd()}:/app`],
                },
                Image: image,
                WorkingDir: '/app',
            })

            this.jsonCtx.info('Starting Container')
            await container.start()

            // Wait for the container to finish and get the logs
            const stream = await container.logs({
                follow: true,
                stderr: true,
                stdout: true,
            })

            const logTarget = this.jsonMode ? process.stderr : process.stdout
            stream.pipe(logTarget)

            try {
                // Wait for the container to finish
                const { StatusCode } = await new Promise<{ StatusCode: number }>((resolve, reject) => {
                    container.wait((err: Error | null, data: { StatusCode: number }) => {
                        if (err) reject(err)
                        else resolve(data)
                    })
                })

                if (StatusCode !== 0) {
                    this.jsonCtx.error(
                        'E401_DOCKER_CONTAINER_FAILED',
                        `Container exited with status code: ${StatusCode}`,
                        'DOCKER',
                        false,
                        { statusCode: StatusCode }
                    )
                }
            } finally {
                // Clean up stream to prevent process hang
                stream.unpipe(logTarget)
                if ('destroy' in stream && typeof stream.destroy === 'function') {
                    stream.destroy()
                }

                // Remove container (suppress 404/409 if already removed or in use)
                try {
                    await container.remove()
                } catch (removeError: any) {
                    const statusCode = removeError?.statusCode
                    if (statusCode !== 404 && statusCode !== 409) {
                        this.jsonCtx.addWarning(`Failed to remove container: ${removeError}`)
                    }
                }
            }
        } catch (error) {
            if (error instanceof CliExitError) throw error
            this.jsonCtx.error(
                'E401_DOCKER_CONTAINER_FAILED',
                `Failed to run Docker command: ${error}`,
                'DOCKER',
                false,
                { error: String(error) }
            )
        } finally {
            // Close Docker HTTP agent to release event loop
            const { agent } = docker.modem as any
            if (agent && typeof agent.destroy === 'function') {
                agent.destroy()
            }
        }
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
            this.jsonCtx.error(
                'E400_DOCKER_TAG_FETCH_FAILED',
                `Failed to fetch Docker tags: ${error}`,
                'DOCKER',
                true,
                { error: String(error) }
            )
        }
    }

    private async getDockerImageTag(providedTag: string | undefined): Promise<string> {
        const defaultTag = '0.2.0-rc.3'

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

        // In non-interactive mode, fail if provided tag isn't valid
        if (this.nonInteractive) {
            this.jsonCtx.error(
                'E400_INVALID_DOCKER_TAG',
                `Docker image tag "${providedTag}" not found. Available tags include: ${tags.slice(0, 5).join(', ')}...`,
                'DOCKER',
                true,
                { availableTags: tags, providedTag }
            )
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

    /**
     * Update dogecoinIndexerStartHeight in the appropriate doge-config file.
     * Tries network-specific config first, then falls back to generic config.
     */
    private updateDogeConfigBlockHeight(
        setupDefaultsPath: string,
        dataDir: string,
        blockHeight: number
    ): void {
        try {
            const setupDefaults = toml.parse(fs.readFileSync(setupDefaultsPath, 'utf8'))
            const network = (setupDefaults as any).network || 'testnet'

            const configPaths = [
                path.join(dataDir, `doge-config-${network}.toml`),
                path.join(dataDir, 'doge-config.toml'),
            ]

            for (const configPath of configPaths) {
                if (fs.existsSync(configPath)) {
                    let content = fs.readFileSync(configPath, 'utf8')
                    content = content.replace(
                        /dogecoinIndexerStartHeight\s*=\s*["']?\d*["']?/,
                        `dogecoinIndexerStartHeight = "${blockHeight}"`
                    )
                    fs.writeFileSync(configPath, content)
                    this.jsonCtx.info(`Updated ${configPath} with dogecoinIndexerStartHeight = ${blockHeight}`)
                    return
                }
            }
        } catch (configError) {
            this.jsonCtx.addWarning(`Failed to update doge-config with block height: ${configError}`)
        }
    }
}
export default BridgeInitCommand
