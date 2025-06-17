import { Command, Flags } from '@oclif/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as toml from '@iarna/toml';
import chalk from 'chalk';
import type { DogeConfig } from '../../types/doge-config.js';
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js';

function capitalize(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateL2GethEnvFile(
    parsedPublicConfig: any,
    dogeConfig: DogeConfig,
    rpcPackageParentDir: string,
): string {
    const network = dogeConfig.network;

    if (network !== 'mainnet' && network !== 'testnet') {
        throw new Error(
            `Invalid network type in dogeConfig: '${network}'. Expected 'mainnet' or 'testnet'.`
        );
    }

    const networkTitleCase = capitalize(network);
    const envLines: string[] = [];

    envLines.push(`# L2Geth ${networkTitleCase} Configuration`);
    envLines.push('');
    envLines.push(`# Network specific settings`);
    if (parsedPublicConfig?.general?.CHAIN_ID_L2 !== undefined) {
        envLines.push(`CHAIN_ID=${parsedPublicConfig.general.CHAIN_ID_L2}`);
    }
    if (parsedPublicConfig?.general?.L1_RPC_ENDPOINT) {
        envLines.push(`L2GETH_L1_ENDPOINT=${parsedPublicConfig.general.L1_RPC_ENDPOINT}`);
    }
    if (parsedPublicConfig?.general?.L1_CONTRACT_DEPLOYMENT_BLOCK !== undefined) {
        envLines.push(`L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK=${parsedPublicConfig.general.L1_CONTRACT_DEPLOYMENT_BLOCK}`);
    }
    envLines.push('');
    envLines.push(`# ${networkTitleCase} peer list`);
    if (parsedPublicConfig?.sequencer?.L2_GETH_STATIC_PEERS && Array.isArray(parsedPublicConfig.sequencer.L2_GETH_STATIC_PEERS)) {
        envLines.push(`L2GETH_PEER_LIST=${JSON.stringify(parsedPublicConfig.sequencer.L2_GETH_STATIC_PEERS)}`);
    }

    const envContent = envLines.join('\n') + '\n';
    const targetDirectory = path.resolve(rpcPackageParentDir, 'dogeos-rpc-package', 'envs', network);
    const envFilePath = path.join(targetDirectory, 'l2geth.env');

    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(envFilePath, envContent);
    return envFilePath;
}
export default class GenerateL2gethEnv extends Command {
    static override description = 'Generates the l2geth.env file for the dogeos-rpc-package.';

    static override examples = [
        '<%= config.bin %> <%= command.id %>',
        '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config-testnet.toml',
        '<%= config.bin %> <%= command.id %> --public-config ./config.public.toml',
        '<%= config.bin %> <%= command.id %> --rpc-package-parent-dir ../../',
    ];

    static override flags = {
        'doge-config': Flags.string({
            description: 'Path to the DogeConfig file (e.g., .data/doge-config-testnet.toml).',
            required: false,
        }),
        'public-config': Flags.string({
            description: 'Path to the config.public.toml file.',
            default: 'config.public.toml',
            required: false,
        }),
        'rpc-package-parent-dir': Flags.string({
            description: "Path to the directory that CONTAINS the 'dogeos-rpc-package' directory. Defaults to the parent of the current working directory.",
            required: false,
        }),
    };

    public async run(): Promise<void> {
        const { flags } = await this.parse(GenerateL2gethEnv);

        try {
            // 1. Load DogeConfig
            const { config: dogeConfig, configPath: dogeConfigPath } = await loadDogeConfigWithSelection(
                flags['doge-config'],
                `${this.config.bin} ${this.id}`
            );
            this.log(chalk.blue(`Using DogeConfig file: ${dogeConfigPath}`));

            // 2. Load config.public.toml
            const publicConfigPath = path.resolve(flags['public-config']);
            let parsedPublicConfig: any = {};
            if (fs.existsSync(publicConfigPath)) {
                try {
                    const publicConfigContent = fs.readFileSync(publicConfigPath, 'utf8');
                    parsedPublicConfig = toml.parse(publicConfigContent);
                    this.log(chalk.green(`Successfully parsed ${publicConfigPath}`));
                } catch (error: any) {
                    this.error(chalk.red(`Failed to parse ${publicConfigPath}: ${error.message}`), { exit: 1 });
                }
            } else {
                this.warn(chalk.yellow(`${publicConfigPath} not found. Some L2Geth env variables might be missing.`));
            }

            const rpcPackageParentDir = flags['rpc-package-parent-dir']
                ? path.resolve(flags['rpc-package-parent-dir'])
                : path.resolve(process.cwd(), './');

            this.log(chalk.blue(`Base directory for 'dogeos-rpc-package': ${rpcPackageParentDir}`));

            const generatedEnvFilePath = generateL2GethEnvFile(
                parsedPublicConfig,
                dogeConfig,
                rpcPackageParentDir
            );

            this.log(chalk.green(`Successfully generated l2geth.env file at: ${generatedEnvFilePath}`));

        } catch (error: any) {
            this.error(chalk.red(`Error generating l2geth.env file: ${error.message}`), { exit: 1 });
        }
    }
}