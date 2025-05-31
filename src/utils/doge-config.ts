import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { DogeConfig, Network } from '../types/doge-config.js'


export async function loadDogeConfig(configPath: string): Promise<DogeConfig> {
  const resolvedPath = path.resolve(configPath)

  if (!fs.existsSync(resolvedPath)) {
    const shouldCreate = await confirm({
      default: true,
      message: `Config file not found at ${resolvedPath}. Would you like to create a default one now?`,
    })

    if (!shouldCreate) {
      throw new Error(`Config file not found at ${resolvedPath}, and not created.`)
    }

    console.log('Creating a new default Dogecoin configuration file...')

    const network = (await select({
      choices: [
        { name: 'mainnet', value: 'mainnet' as const },
        { name: 'testnet', value: 'testnet' as const },
      ],
      default: 'mainnet',
      message: 'Select network for the new default config:',
    })) as Network

    const apiKey = await input({
      message: 'Enter your NowNodes API key (get one at nownodes.io - required for network operations):',
      validate: (value) => (value ? true : 'API key is required'),
    })


    const defaultConfig: DogeConfig = {
      defaults: {
        chainId: '0x221122',
        evmAddress: '0x151a64570e4997739458455ba4ab5A535FD2E306',
        recipient: '',
        dogecoinIndexerStartHeight: '4000000',
      },
      frontend: {},
      network,
      rpc: {
        username: '',
        password: '',
        apiKey,
        blockbookAPIUrl:
          network === 'mainnet' ? 'https://dogebook.nownodes.io/api/v2' : 'https://dogebook-testnet.nownodes.io/api/v2',
        url: network === 'mainnet' ? '' : 'https://testnet.doge.xyz/',
      },
      dogecoinClusterRpc: {
        username: "",
        password: "",
      },
      test: {},
      wallet: {
        path: network === 'mainnet' ? '.data/doge-wallet-mainnet.json' : '.data/doge-wallet-testnet.json',
      },
      da: {
        celestiaIndexerStartBlock: network === 'mainnet' ? '0' : '6338800',
        //rpcUrl: network === 'mainnet' ? 'http://celestia-mainnet:26658' : 'http://celestia-testnet-mocha:26658',
        tendermintRpcUrl: '',
        daNamespace: network === 'mainnet' ? '' : '98E6DED48612C0B8E4FA',
        signerAddress: network === 'mainnet' ? '' : 'celestia1ps9llfyvul24z2l74m9x7xgs7gcc2taplan5r5',
        genesisBlobCommitment: network === 'mainnet' ? '' : 'Pnw/8OJ8jGtL3P8Kihs1IIpouOS6yPbLF40GFJ91XBg=',
      }
    }

    const configDir = path.dirname(resolvedPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.writeFileSync(resolvedPath, toml.stringify(defaultConfig as any))
    console.log(
      `Created new default ${network} config file at ${resolvedPath}. You can further customize it with 'scrollsdk doge:config'.`,
    )
    return defaultConfig
  }

  try {
    const configContent = fs.readFileSync(resolvedPath, 'utf8')
    const parsedConfig = toml.parse(configContent) as unknown as DogeConfig

    if (!parsedConfig.network || (parsedConfig.network !== 'mainnet' && parsedConfig.network !== 'testnet')) {
      throw new Error(
        `Config file ${resolvedPath} has an invalid 'network' value: ${parsedConfig.network}. Must be 'mainnet' or 'testnet'.`,
      )
    }

    if (!parsedConfig.wallet || !parsedConfig.wallet.path) {
      throw new Error(`Config file ${resolvedPath} is missing 'wallet.path'.`)
    }

    if (!parsedConfig.rpc || !parsedConfig.rpc.blockbookAPIUrl) {
      throw new Error(`Config file ${resolvedPath} is missing 'rpc.blockbookAPIUrl'. Run 'doge:config' to set it.`)
    }

    return parsedConfig
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Config file')) throw error
    throw new Error(
      `Failed to load or parse Dogecoin config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)
      }. Try running 'scrollsdk doge:config' to regenerate it.`,
    )
  }
}
