/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Network } from '../../types/doge-config.js'

import { L1_INTERFACE_RPC_ENDPOINT } from '../../config/constants.js'
import { writeConfigs } from '../../utils/config-writer.js'
import { getOptionalDogeNetworkFromConfig, normalizeDogeNetwork, setDogeNetworkInConfig } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  type NonInteractiveContext,
  createNonInteractiveContext,
  resolveConfirm,
  resolveOrPrompt,
  resolveOrSelect,
  validateAndExit,
} from '../../utils/non-interactive.js'

type EthereumDaChain = 'devnet' | 'mainnet' | 'sepolia'

const ETHEREUM_DA_DEFAULTS: Record<EthereumDaChain, {
  beaconRpcUrl: string
  chainId: string
  minFinality: 'finalized' | 'safe'
  submitterRpcUrl: string
}> = {
  devnet: {
    beaconRpcUrl: 'http://l1-devnet-lighthouse:5052',
    chainId: '32382',
    minFinality: 'safe',
    submitterRpcUrl: 'http://l1-devnet:8545',
  },
  mainnet: {
    beaconRpcUrl: 'https://ethereum-beacon-api.publicnode.com',
    chainId: '1',
    minFinality: 'finalized',
    submitterRpcUrl: 'https://eth.drpc.org',
  },
  sepolia: {
    beaconRpcUrl: 'https://ethereum-sepolia-beacon-api.publicnode.com',
    chainId: '11155111',
    minFinality: 'safe',
    submitterRpcUrl: 'https://sepolia.drpc.org',
  },
}

export default class SetupDomains extends Command {
  static override description = 'Set up domain configurations for external services'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --network testnet',
    '<%= config.bin %> <%= command.id %> --non-interactive',
    '<%= config.bin %> <%= command.id %> --non-interactive --json --network testnet',
  ]

  static override flags = {
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    network: Flags.string({
      char: 'n',
      description: 'Dogecoin network to write to [dogecoin].network',
      options: ['mainnet', 'testnet', 'regtest'],
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts, using config.toml values',
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupDomains)
    const existingConfig = await this.getExistingConfig()

    // Create non-interactive and JSON output contexts
    const niCtx = createNonInteractiveContext(
      'setup domains',
      flags['non-interactive'],
      flags.json
    )
    const jsonCtx = new JsonOutputContext('setup domains', flags.json)

    // In non-interactive mode, log to stderr to keep stdout clean for JSON
    const logSection = (title: string) => jsonCtx.logSection(title)
    const logKeyValue = (key: string, value: string) => jsonCtx.logKeyValue(key, value)
    const logSuccess = (msg: string) => jsonCtx.logSuccess(msg)

    logSection('Current domain configurations:')
    for (const [key, value] of Object.entries(existingConfig.frontend || {})) {
      if (key.includes('URI')) {
        logKeyValue(key, value as string)
      }
    }

    logSection('Current ingress configurations:')
    for (const [key, value] of Object.entries(existingConfig.ingress || {})) {
      logKeyValue(key, value as string)
    }

    let configuredDogeNetwork: Network | undefined
    try {
      configuredDogeNetwork = getOptionalDogeNetworkFromConfig(existingConfig, 'config.toml')
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error))
    }

    const flagNetwork = flags.network ? normalizeDogeNetwork(flags.network) : undefined
    if (flags.network && !flagNetwork) {
      this.error(`Invalid --network value: ${flags.network}. Must be 'mainnet', 'testnet', or 'regtest'.`)
    }

    let dogeNetwork = flagNetwork

    if (!dogeNetwork) {
      dogeNetwork = niCtx.enabled
        ? configuredDogeNetwork
        : await select({
          choices: [
            { name: 'Dogecoin Testnet', value: 'testnet' },
            { name: 'Dogecoin Mainnet', value: 'mainnet' },
            { name: 'Dogecoin Regtest', value: 'regtest' },
          ],
          default: configuredDogeNetwork || 'testnet',
          message: 'Select the Dogecoin network:',
        }) as Network
    }

    if (!dogeNetwork && niCtx.enabled) {
      niCtx.missingFields.push({
        configPath: '[dogecoin].network',
        description: 'Dogecoin network (mainnet, testnet, or regtest) must be set in config.toml or provided with --network',
        field: 'network',
      })
      validateAndExit(niCtx)
      return
    }

    const selectedDogeNetwork = dogeNetwork as Network

    const l1ChainNames: Record<Network, string> = {
      mainnet: 'Dogecoin Mainnet',
      regtest: 'Dogecoin Regtest',
      testnet: 'Dogecoin Testnet',
    }

    const l1ChainIds: Record<Network, string> = {
      mainnet: '1',
      regtest: '5555555',
      testnet: '111111',
    }

    const defaultEthereumDaChains: Record<Network, EthereumDaChain> = {
      mainnet: 'mainnet',
      regtest: 'devnet',
      testnet: 'sepolia',
    }

    const generalConfig: Record<string, string> = {}
    let domainConfig: Record<string, string> = {}
    const frontendConfig: Record<string, string> = {}

    const usesAnvil = false
    const usesDogeos = true
    generalConfig.CHAIN_ID_L1 = l1ChainIds[selectedDogeNetwork]

    const chainNameL1 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.general?.CHAIN_NAME_L1 || l1ChainNames[selectedDogeNetwork],
        message: 'Enter the L1 Chain Name:',
      }),
      existingConfig.general?.CHAIN_NAME_L1 || l1ChainNames[selectedDogeNetwork],
      {
        configPath: '[general].CHAIN_NAME_L1',
        description: 'L1 chain name (e.g., "Dogecoin Testnet")',
        field: 'CHAIN_NAME_L1',
      }
    )
    generalConfig.CHAIN_NAME_L1 = chainNameL1 || l1ChainNames[selectedDogeNetwork]

    const chainNameL2 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.general?.CHAIN_NAME_L2 || (usesDogeos ? 'DogeOS Testnet' : 'Custom L2'),
        message: 'Enter the L2 Chain Name:',
      }),
      existingConfig.general?.CHAIN_NAME_L2 || (usesDogeos ? 'DogeOS Testnet' : undefined),
      {
        configPath: '[general].CHAIN_NAME_L2',
        description: 'L2 chain name (e.g., "DogeOS Testnet")',
        field: 'CHAIN_NAME_L2',
      }
    )
    generalConfig.CHAIN_NAME_L2 = chainNameL2 || ''

    // Validate required fields before proceeding
    validateAndExit(niCtx)

    jsonCtx.info(`Using ${chalk.bold(generalConfig.CHAIN_NAME_L1)} network:`)
    logKeyValue('L1 Chain Name', generalConfig.CHAIN_NAME_L1)
    logKeyValue('L1 Chain ID', generalConfig.CHAIN_ID_L1)

    if (usesDogeos) {
      generalConfig.L1_RPC_ENDPOINT = L1_INTERFACE_RPC_ENDPOINT
      generalConfig.L1_RPC_ENDPOINT_WEBSOCKET = ''
    }

    logSuccess(`Using internal l1-interface JSON-RPC endpoint [general].L1_RPC_ENDPOINT = "${generalConfig.L1_RPC_ENDPOINT}"`)
    logSuccess(`Using no internal L1 WebSocket endpoint [general].L1_RPC_ENDPOINT_WEBSOCKET = "${generalConfig.L1_RPC_ENDPOINT_WEBSOCKET}"`)

    const { domainConfig: sharedDomainConfig, ingressConfig } = await this.setupSharedConfigs(existingConfig, usesAnvil, niCtx)

    // Merge the domainConfig from setupSharedConfigs with the one we've created here
    domainConfig = { ...domainConfig, ...sharedDomainConfig }

    logSection('New domain configurations:')
    for (const [key, value] of Object.entries(domainConfig)) {
      logKeyValue(key, value)
    }

    logSection('New ingress configurations:')
    for (const [key, value] of Object.entries(ingressConfig)) {
      logKeyValue(key, value)
    }

    logSection('New general configurations:')
    for (const [key, value] of Object.entries(generalConfig)) {
      logKeyValue(key, value)
    }

    // RPC Gateway WebSocket host
    ingressConfig.RPC_GATEWAY_WS_HOST = "ws." + ingressConfig.RPC_GATEWAY_HOST
    const needRpcGateWay = await resolveConfirm(
      niCtx,
      () => confirm({
        default: false,
        message: `Use a separate public WebSocket RPC gateway host for [ingress].RPC_GATEWAY_WS_HOST? Default: ${ingressConfig.RPC_GATEWAY_WS_HOST}`,
      }),
      existingConfig.ingress?.RPC_GATEWAY_WS_HOST !== `ws.${existingConfig.ingress?.RPC_GATEWAY_HOST}`,
      false
    )

    if (needRpcGateWay) {
      const wsHost = await resolveOrPrompt(
        niCtx,
        () => input({
          message: 'Enter [ingress].RPC_GATEWAY_WS_HOST (host only, for example ws.rpc.example.com):',
        }),
        existingConfig.ingress?.RPC_GATEWAY_WS_HOST,
        {
          configPath: '[ingress].RPC_GATEWAY_WS_HOST',
          description: 'WebSocket RPC gateway host',
          field: 'RPC_GATEWAY_WS_HOST',
        },
        false
      )
      if (wsHost) {
        ingressConfig.RPC_GATEWAY_WS_HOST = wsHost
      }
    }

    // Frontend config setup
    const ethSymbol = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.ETH_SYMBOL || 'DOGE',
        message: 'Enter the native token symbol displayed by the frontend ([frontend].ETH_SYMBOL):',
      }),
      existingConfig.frontend?.ETH_SYMBOL || 'DOGE',
      {
        configPath: '[frontend].ETH_SYMBOL',
        description: 'Native token symbol displayed by the frontend',
        field: 'ETH_SYMBOL',
      },
      false
    )
    frontendConfig.ETH_SYMBOL = ethSymbol || 'DOGE'

    const walletProjectId = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.CONNECT_WALLET_PROJECT_ID || "14efbaafcf5232a47d93a68229b71028",
        message: 'Enter the WalletConnect Project ID for the frontend ([frontend].CONNECT_WALLET_PROJECT_ID):',
      }),
      existingConfig.frontend?.CONNECT_WALLET_PROJECT_ID || "14efbaafcf5232a47d93a68229b71028",
      {
        configPath: '[frontend].CONNECT_WALLET_PROJECT_ID',
        description: 'WalletConnect project ID',
        field: 'CONNECT_WALLET_PROJECT_ID',
      },
      false
    )
    frontendConfig.CONNECT_WALLET_PROJECT_ID = walletProjectId || "14efbaafcf5232a47d93a68229b71028"

    const defaultDogeExternalUrl = selectedDogeNetwork === 'mainnet' ? 'https://sochain.com/DOGE' : 'https://sochain.com/DOGETEST'

    const dogeRpcL1 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.DOGE_EXTERNAL_RPC_URI_L1 || defaultDogeExternalUrl,
        message: 'Enter the public Dogecoin L1 API URL used by the frontend ([frontend].DOGE_EXTERNAL_RPC_URI_L1):',
      }),
      existingConfig.frontend?.DOGE_EXTERNAL_RPC_URI_L1 || defaultDogeExternalUrl,
      {
        configPath: '[frontend].DOGE_EXTERNAL_RPC_URI_L1',
        description: 'Public Dogecoin L1 API URL used by frontend wallet/deposit flows',
        field: 'DOGE_EXTERNAL_RPC_URI_L1',
      },
      false
    )
    frontendConfig.DOGE_EXTERNAL_RPC_URI_L1 = dogeRpcL1 || defaultDogeExternalUrl

    const dogeExplorerL1 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.DOGE_EXTERNAL_EXPLORER_URI_L1 || defaultDogeExternalUrl,
        message: 'Enter the public Dogecoin L1 explorer base URL for links ([frontend].DOGE_EXTERNAL_EXPLORER_URI_L1):',
      }),
      existingConfig.frontend?.DOGE_EXTERNAL_EXPLORER_URI_L1 || defaultDogeExternalUrl,
      {
        configPath: '[frontend].DOGE_EXTERNAL_EXPLORER_URI_L1',
        description: 'Public Dogecoin L1 explorer base URL for transaction/address links',
        field: 'DOGE_EXTERNAL_EXPLORER_URI_L1',
      },
      false
    )
    frontendConfig.DOGE_EXTERNAL_EXPLORER_URI_L1 = dogeExplorerL1 || defaultDogeExternalUrl

    const existingEthereumDa = existingConfig.ethereumDa as Record<string, string> | undefined
    const existingEthereumDaChain = existingEthereumDa?.chain as EthereumDaChain | undefined
    const defaultEthereumDaChain = existingEthereumDaChain || defaultEthereumDaChains[selectedDogeNetwork]
    const ethereumDaChain = await resolveOrSelect<EthereumDaChain>(
      niCtx,
      () => select({
        choices: [
          { name: 'Sepolia testnet', value: 'sepolia' },
          { name: 'Ethereum mainnet', value: 'mainnet' },
          { name: 'Devnet / private Ethereum chain', value: 'devnet' },
        ],
        default: defaultEthereumDaChain,
        message: 'Select the Ethereum chain used as the DA layer ([ethereumDa].chain):',
      }),
      existingEthereumDa?.chain || defaultEthereumDaChain,
      ['mainnet', 'sepolia', 'devnet'],
      {
        configPath: '[ethereumDa].chain',
        description: 'Ethereum DA chain',
        field: 'chain',
      },
    ) || defaultEthereumDaChain
    const ethereumDaDefaults = ETHEREUM_DA_DEFAULTS[ethereumDaChain]
    const shouldReuseExistingEthereumDaValues = niCtx.enabled || existingEthereumDaChain === ethereumDaChain
    const ethereumDaFieldDefault = (field: 'beaconRpcUrl' | 'chainId' | 'submitterRpcUrl') =>
      shouldReuseExistingEthereumDaValues
        ? existingEthereumDa?.[field] || ethereumDaDefaults[field]
        : ethereumDaDefaults[field]

    const ethereumDaSubmitterRpcUrl = await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('submitterRpcUrl'),
        message: 'Enter the real Ethereum execution JSON-RPC endpoint used by eth-da-submitter ([ethereumDa].submitterRpcUrl):',
      }),
      ethereumDaFieldDefault('submitterRpcUrl'),
      {
        configPath: '[ethereumDa].submitterRpcUrl',
        description: 'Real Ethereum execution JSON-RPC endpoint used by eth-da-submitter',
        field: 'submitterRpcUrl',
      },
    ) || ethereumDaDefaults.submitterRpcUrl

    const ethereumDaBeaconRpcUrl = await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('beaconRpcUrl'),
        message: 'Enter the real Ethereum beacon API endpoint used as the DA data source ([ethereumDa].beaconRpcUrl):',
      }),
      ethereumDaFieldDefault('beaconRpcUrl'),
      {
        configPath: '[ethereumDa].beaconRpcUrl',
        description: 'Real Ethereum beacon API endpoint used as the DA data source',
        field: 'beaconRpcUrl',
      },
    ) || ethereumDaDefaults.beaconRpcUrl

    const ethereumDaChainId = await resolveOrPrompt(
      niCtx,
      () => input({
        default: ethereumDaFieldDefault('chainId'),
        message: 'Enter the real Ethereum DA execution chain ID ([ethereumDa].chainId):',
      }),
      ethereumDaFieldDefault('chainId'),
      {
        configPath: '[ethereumDa].chainId',
        description: 'Real Ethereum DA execution chain ID. This is separate from [general].CHAIN_ID_L1 used by l1-interface/Dogecoin.',
        field: 'chainId',
      },
    ) || ethereumDaDefaults.chainId

    const ethereumDaConfig = {
      beaconRpcUrl: ethereumDaBeaconRpcUrl,
      chain: ethereumDaChain,
      chainId: ethereumDaChainId,
      minFinality: ethereumDaDefaults.minFinality,
      submitterRpcUrl: ethereumDaSubmitterRpcUrl,
    }

    logSection('New Ethereum DA configurations:')
    logKeyValue('chain', ethereumDaConfig.chain)
    logKeyValue('chainId', ethereumDaConfig.chainId)
    logKeyValue('submitterRpcUrl', ethereumDaConfig.submitterRpcUrl)
    logKeyValue('beaconRpcUrl', ethereumDaConfig.beaconRpcUrl)
    logKeyValue('minFinality', ethereumDaConfig.minFinality)

    // Final confirmation - in non-interactive mode, always proceed
    const confirmUpdate = await resolveConfirm(
      niCtx,
      () => confirm({
        message: 'Write these domain/frontend/internal endpoint/Ethereum DA settings to config.toml and sync config.public.toml?',
      }),
      true, // In non-interactive, we always want to update
      true
    )

    if (confirmUpdate) {
      const dogecoinConfig = { network: selectedDogeNetwork }
      await this.updateConfigFile(domainConfig, ingressConfig, generalConfig, frontendConfig, ethereumDaConfig, dogecoinConfig, flags.json)

      // Output JSON response on success
      if (flags.json) {
        jsonCtx.success({
          dogecoin: dogecoinConfig,
          domain: domainConfig,
          ethereumDa: ethereumDaConfig,
          frontend: frontendConfig,
          general: generalConfig,
          ingress: ingressConfig,
          updated: true,
        })
      }
    } else {
      jsonCtx.log(chalk.yellow('Configuration update cancelled.'))
    }
  }

  private collapseRepeatedBlankLines(content: string): string {
    return content.replaceAll(/\n{3,}/g, '\n\n')
  }

  private escapeRegExp(value: string): string {
    return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  }

  private findInlineCommentIndex(line: string): number {
    let quote: "'" | '"' | undefined
    let escaping = false
    let index = 0

    for (const char of line) {
      if (escaping) {
        escaping = false
        index++
        continue
      }

      if (quote === '"' && char === '\\') {
        escaping = true
        index++
        continue
      }

      if ((char === '"' || char === "'") && !quote) {
        quote = char
        index++
        continue
      }

      if (char === quote) {
        quote = undefined
        index++
        continue
      }

      if (char === '#' && !quote) {
        return index
      }

      index++
    }

    return -1
  }

  private formatTomlAssignment(key: string, value: string): string {
    return toml.stringify({ [key]: value }).trim()
  }

  private async getExistingConfig(): Promise<any> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error('config.toml not found in the current directory.')
      return {}
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    return toml.parse(configContent) as any
  }

  private replaceTomlAssignmentLine(line: string, key: string, value: string): string {
    const indentation = line.match(/^\s*/)?.[0] || ''
    const assignment = this.formatTomlAssignment(key, value)
    const commentIndex = this.findInlineCommentIndex(line)
    const comment = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : ''

    return `${indentation}${assignment}${comment ? ` ${comment}` : ''}`
  }

  private async setupSharedConfigs(
    existingConfig: any,
    usesAnvil: boolean,
    niCtx?: NonInteractiveContext,
  ): Promise<{
    domainConfig: Record<string, string>
    generalConfig: Record<string, string>
    ingressConfig: Record<string, string>
    protocol: string
  }> {
    let domainConfig: Record<string, string> = {}
    let ingressConfig: Record<string, string> = {}
    const generalConfig: Record<string, string> = {}
    let urlEnding = ''
    let protocol = ''

    // In non-interactive mode, determine shared ending from existing config
    // If FRONTEND_HOST exists, we infer shared URL ending from it
    const existingFrontendHost = existingConfig.ingress?.FRONTEND_HOST || ''
    const hasSharedEnding = Boolean(existingFrontendHost)

    // For non-interactive, infer shared ending if frontend host exists
    const sharedEnding: boolean = niCtx?.enabled ? hasSharedEnding : (await confirm({
        default: hasSharedEnding,
        message: 'Do you want all external URLs to share a URL ending?',
      }));

    if (sharedEnding) {
      const defaultUrlEnding =
        existingFrontendHost.startsWith('frontend.') || existingFrontendHost.startsWith('frontends.') || existingFrontendHost.startsWith('portal.')
          ? existingFrontendHost.split('.').slice(1).join('.')
          : existingFrontendHost || 'scrollsdk'

      urlEnding = niCtx?.enabled ? defaultUrlEnding : (await input({
          default: defaultUrlEnding,
          message: 'Enter the shared URL ending:',
        }));

      // Infer protocol from existing config
      const existingProtocol = existingConfig.frontend?.EXTERNAL_RPC_URI_L2?.startsWith('https') ? 'https' : 'http'
      protocol = niCtx?.enabled ? existingProtocol : (await select({
          choices: [
            { name: 'HTTP', value: 'http' },
            { name: 'HTTPS', value: 'https' },
          ],
          default: existingProtocol,
          message: 'Choose the protocol for the shared URLs:',
        }));

      // Infer frontend at root from existing config
      const existingFrontendAtRoot = existingFrontendHost && !existingFrontendHost.startsWith('portal.')
      const frontendAtRoot: boolean = niCtx?.enabled ? existingFrontendAtRoot : (await confirm({
          default: existingFrontendAtRoot,
          message: 'Do you want the frontends to be hosted at the root domain? (No will use a "portal" subdomain)',
        }));

      domainConfig = {
        ADMIN_SYSTEM_DASHBOARD_URI: `${protocol}://admin-system-dashboard.${urlEnding}`,
        BRIDGE_API_URI: `${protocol}://bridge-history-api.${urlEnding}/api`,
        EXTERNAL_EXPLORER_URI_L2: `${protocol}://blockscout.${urlEnding}`,
        EXTERNAL_RPC_URI_L2: `${protocol}://rpc.${urlEnding}`,
        GRAFANA_URI: `${protocol}://grafana.${urlEnding}`,
        ROLLUPSCAN_API_URI: `${protocol}://rollup-explorer-backend.${urlEnding}/api`,
      }

      if (usesAnvil) {
        domainConfig.EXTERNAL_RPC_URI_L1 = `${protocol}://l1-devnet.${urlEnding}`
        domainConfig.EXTERNAL_EXPLORER_URI_L1 = `${protocol}://l1-explorer.${urlEnding}`
      }

      ingressConfig = {
        ADMIN_SYSTEM_DASHBOARD_HOST: `admin-system-dashboard.${urlEnding}`,
        BLOCKSCOUT_BACKEND_HOST: `blockscout-backend.${urlEnding}`,
        BLOCKSCOUT_HOST: `blockscout.${urlEnding}`,
        BRIDGE_HISTORY_API_HOST: `bridge-history-api.${urlEnding}`,
        COORDINATOR_API_HOST: `coordinator-api.${urlEnding}`,
        FRONTEND_HOST: frontendAtRoot ? urlEnding : `portal.${urlEnding}`,
        GRAFANA_HOST: `grafana.${urlEnding}`,
        ROLLUP_EXPLORER_API_HOST: `rollup-explorer-backend.${urlEnding}`,
        RPC_GATEWAY_HOST: `rpc.${urlEnding}`,
        ...(usesAnvil ? { L1_DEVNET_HOST: `l1-devnet.${urlEnding}`, L1_EXPLORER_HOST: `l1-explorer.${urlEnding}` } : {}),
        BLOCKBOOK_HOST: `blockbook.${urlEnding}`,
        DOGECOIN_HOST: `dogecoin.${urlEnding}`,
        TSO_HOST: `tso.${urlEnding}`,
      }
    } else {
      // Non-shared URL ending path - each host configured individually
      // In non-interactive mode, use existing config values
      const existingProtocol = existingConfig.frontend?.EXTERNAL_RPC_URI_L1?.startsWith('https') ? 'https' : 'http'

      protocol = niCtx?.enabled ? existingProtocol : (await select({
          choices: [
            { name: 'HTTP', value: 'http' },
            { name: 'HTTPS', value: 'https' },
          ],
          default: existingProtocol,
          message: 'Choose the protocol for the URLs:',
        }));

      // Helper to resolve ingress hosts - uses existing config in non-interactive mode
      const resolveIngressHost = async (
        key: string,
        defaultValue: string,
        description: string
      ): Promise<string> => {
        const result = await resolveOrPrompt(
          niCtx!,
          () => input({
            default: existingConfig.ingress?.[key] || defaultValue,
            message: `Enter ${key}:`,
          }),
          existingConfig.ingress?.[key] || defaultValue,
          {
            configPath: `[ingress].${key}`,
            description,
            field: key,
          },
          false // Not strictly required - has defaults
        )
        return result || defaultValue
      }

      ingressConfig = {
        ADMIN_SYSTEM_DASHBOARD_HOST: await resolveIngressHost(
          'ADMIN_SYSTEM_DASHBOARD_HOST',
          'admin-system-dashboard.scrollsdk',
          'Admin system dashboard host'
        ),
        BLOCKBOOK_HOST: await resolveIngressHost(
          'BLOCKBOOK_HOST',
          'blockbook.scrollsdk',
          'Blockbook indexer host'
        ),
        BLOCKSCOUT_BACKEND_HOST: await resolveIngressHost(
          'BLOCKSCOUT_BACKEND_HOST',
          'blockscout-backend.scrollsdk',
          'Blockscout backend host'
        ),
        BLOCKSCOUT_HOST: await resolveIngressHost(
          'BLOCKSCOUT_HOST',
          'blockscout.scrollsdk',
          'Blockscout explorer host'
        ),
        BRIDGE_HISTORY_API_HOST: await resolveIngressHost(
          'BRIDGE_HISTORY_API_HOST',
          'bridge-history-api.scrollsdk',
          'Bridge history API host'
        ),
        COORDINATOR_API_HOST: await resolveIngressHost(
          'COORDINATOR_API_HOST',
          'coordinator-api.scrollsdk',
          'Coordinator API host'
        ),
        DOGECOIN_HOST: await resolveIngressHost(
          'DOGECOIN_HOST',
          'dogecoin.scrollsdk',
          'Dogecoin node host'
        ),
        FRONTEND_HOST: await resolveIngressHost(
          'FRONTEND_HOST',
          'portal.scrollsdk',
          'Frontend/portal host'
        ),
        GRAFANA_HOST: await resolveIngressHost(
          'GRAFANA_HOST',
          'grafana.scrollsdk',
          'Grafana monitoring host'
        ),
        ROLLUP_EXPLORER_API_HOST: await resolveIngressHost(
          'ROLLUP_EXPLORER_API_HOST',
          'rollup-explorer-backend.scrollsdk',
          'Rollup explorer API host'
        ),
        RPC_GATEWAY_HOST: await resolveIngressHost(
          'RPC_GATEWAY_HOST',
          'rpc.scrollsdk',
          'RPC gateway host'
        ),
        TSO_HOST: await resolveIngressHost(
          'TSO_HOST',
          'tso.scrollsdk',
          'TSO service host'
        ),
      }

      if (usesAnvil) {
        ingressConfig.L1_DEVNET_HOST = await resolveIngressHost(
          'L1_DEVNET_HOST',
          'l1-devnet.scrollsdk',
          'L1 devnet host (Anvil)'
        )
        ingressConfig.L1_EXPLORER_HOST = await resolveIngressHost(
          'L1_EXPLORER_HOST',
          'l1-explorer.scrollsdk',
          'L1 explorer host (Anvil)'
        )
      }

      // Helper to resolve domain URIs
      const resolveDomainUri = async (
        key: string,
        defaultValue: string,
        description: string
      ): Promise<string> => {
        const result = await resolveOrPrompt(
          niCtx!,
          () => input({
            default: existingConfig.frontend?.[key] || defaultValue,
            message: `Enter ${key}:`,
          }),
          existingConfig.frontend?.[key] || defaultValue,
          {
            configPath: `[frontend].${key}`,
            description,
            field: key,
          },
          false
        )
        return result || defaultValue
      }

      domainConfig = {
        ADMIN_SYSTEM_DASHBOARD_URI: await resolveDomainUri(
          'ADMIN_SYSTEM_DASHBOARD_URI',
          `${protocol}://${ingressConfig.ADMIN_SYSTEM_DASHBOARD_HOST}`,
          'Admin system dashboard URI'
        ),
        BRIDGE_API_URI: await resolveDomainUri(
          'BRIDGE_API_URI',
          `${protocol}://${ingressConfig.BRIDGE_HISTORY_API_HOST}/api`,
          'Bridge history API URI'
        ),
        EXTERNAL_EXPLORER_URI_L2: await resolveDomainUri(
          'EXTERNAL_EXPLORER_URI_L2',
          `${protocol}://${ingressConfig.BLOCKSCOUT_HOST}`,
          'L2 block explorer URI'
        ),
        EXTERNAL_RPC_URI_L2: await resolveDomainUri(
          'EXTERNAL_RPC_URI_L2',
          `${protocol}://${ingressConfig.RPC_GATEWAY_HOST}`,
          'L2 RPC endpoint URI'
        ),
        GRAFANA_URI: await resolveDomainUri(
          'GRAFANA_URI',
          `${protocol}://${ingressConfig.GRAFANA_HOST}`,
          'Grafana monitoring URI'
        ),
        ROLLUPSCAN_API_URI: await resolveDomainUri(
          'ROLLUPSCAN_API_URI',
          `${protocol}://${ingressConfig.ROLLUP_EXPLORER_API_HOST}/api`,
          'Rollup explorer API URI'
        ),
      }

      if (usesAnvil) {
        domainConfig.EXTERNAL_RPC_URI_L1 = await resolveDomainUri(
          'EXTERNAL_RPC_URI_L1',
          `${protocol}://l1-devnet.scrollsdk`,
          'L1 RPC endpoint URI (Anvil)'
        )
        domainConfig.EXTERNAL_EXPLORER_URI_L1 = await resolveDomainUri(
          'EXTERNAL_EXPLORER_URI_L1',
          `${protocol}://l1-explorer.scrollsdk`,
          'L1 block explorer URI (Anvil)'
        )
      }
    }

    return { domainConfig, generalConfig, ingressConfig, protocol }
  }

  private async updateConfigFile(
    domainConfig: Record<string, string>,
    ingressConfig: Record<string, string>,
    generalConfig: Record<string, string>,
    frontendConfig: Record<string, string>,
    ethereumDaConfig: Record<string, string>,
    dogecoinConfig: { network: Network },
    jsonMode: boolean = false,
  ): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    const existingConfig = await this.getExistingConfig()

    // Ensure sections exist
    if (!existingConfig.frontend) existingConfig.frontend = {}
    if (!existingConfig.ingress) existingConfig.ingress = {}
    if (!existingConfig.general) existingConfig.general = {}
    if (!existingConfig.ethereumDa) existingConfig.ethereumDa = {}
    if (!existingConfig.dogecoin) existingConfig.dogecoin = {}
    if (!existingConfig.contracts) existingConfig.contracts = {}
    if (!existingConfig.contracts.verification) existingConfig.contracts.verification = {}

    // Update only the specified keys
    for (const [key, value] of Object.entries(generalConfig)) {
      existingConfig.general[key] = value
    }

    for (const [key, value] of Object.entries(domainConfig)) {
      existingConfig.frontend[key] = value
    }

    for (const [key, value] of Object.entries(ingressConfig)) {
      existingConfig.ingress[key] = value
    }

    for (const [key, value] of Object.entries(frontendConfig)) {
      existingConfig.frontend[key] = value
    }

    for (const [key, value] of Object.entries(ethereumDaConfig)) {
      existingConfig.ethereumDa[key] = value
    }

    setDogeNetworkInConfig(existingConfig, dogecoinConfig.network)

    // Remove L1_DEVNET_HOST from ingress if not using Anvil
    // if (generalConfig.CHAIN_NAME_L1 !== 'Anvil L1' && existingConfig.ingress.L1_DEVNET_HOST) {
    //   delete existingConfig.ingress.L1_DEVNET_HOST
    // }

    // // Remove L1_EXPLORER_HOST from ingress if not using Anvil
    // if (generalConfig.CHAIN_NAME_L1 !== 'Anvil L1' && existingConfig.ingress.L1_EXPLORER_HOST) {
    //   delete existingConfig.ingress.L1_EXPLORER_HOST
    // }


    if (domainConfig.EXTERNAL_EXPLORER_URI_L1) {
      existingConfig.contracts.verification.EXPLORER_URI_L1 = domainConfig.EXTERNAL_EXPLORER_URI_L1;
    }

    existingConfig.contracts.verification.EXPLORER_URI_L2 = domainConfig.EXTERNAL_EXPLORER_URI_L2;
    if (domainConfig.EXTERNAL_RPC_URI_L1) {
      existingConfig.contracts.verification.RPC_URI_L1 = domainConfig.EXTERNAL_RPC_URI_L1;
    }

    existingConfig.contracts.verification.RPC_URI_L2 = domainConfig.EXTERNAL_RPC_URI_L2;


    const configText = this.updateTomlText(fs.readFileSync(configPath, 'utf8'), {
      'contracts.verification': {
        ...(domainConfig.EXTERNAL_EXPLORER_URI_L1 ? { EXPLORER_URI_L1: domainConfig.EXTERNAL_EXPLORER_URI_L1 } : {}),
        EXPLORER_URI_L2: domainConfig.EXTERNAL_EXPLORER_URI_L2,
        ...(domainConfig.EXTERNAL_RPC_URI_L1 ? { RPC_URI_L1: domainConfig.EXTERNAL_RPC_URI_L1 } : {}),
        RPC_URI_L2: domainConfig.EXTERNAL_RPC_URI_L2,
      },
      dogecoin: dogecoinConfig,
      ethereumDa: ethereumDaConfig,
      frontend: {
        ...domainConfig,
        ...frontendConfig,
      },
      general: generalConfig,
      ingress: ingressConfig,
    })

    // Pass silent=true when in JSON mode to avoid stdout pollution
    if (writeConfigs(configText, undefined, undefined, jsonMode) && // Only log to stdout in non-JSON mode (writeConfigs handles its own logging when not silent)
      !jsonMode) {
        this.log(chalk.green('config.toml has been updated with the new domain configurations.'))
      }
  }

  private updateTomlText(
    content: string,
    updates: Record<string, Record<string, string>>,
  ): string {
    let updatedContent = content

    for (const [section, values] of Object.entries(updates)) {
      for (const [key, value] of Object.entries(values)) {
        updatedContent = this.upsertTomlValue(updatedContent, section, key, value)
      }
    }

    return this.collapseRepeatedBlankLines(updatedContent)
  }

  private upsertTomlValue(content: string, section: string, key: string, value: string): string {
    const lines = content.split('\n')
    const sectionPattern = new RegExp(`^\\s*\\[${this.escapeRegExp(section)}\\]\\s*(?:#.*)?$`)
    const nextSectionPattern = /^\s*\[.+]\s*(?:#.*)?$/
    const keyPattern = new RegExp(`^\\s*${this.escapeRegExp(key)}\\s*=`)
    const sectionStart = lines.findIndex(line => sectionPattern.test(line))

    if (sectionStart < 0) {
      const needsBlankLine = lines.length > 0 && lines.at(-1)?.trim() !== ''
      lines.push(...(needsBlankLine ? [''] : []), `[${section}]`, this.formatTomlAssignment(key, value))
      return this.collapseRepeatedBlankLines(lines.join('\n'))
    }

    let insertAt = lines.length
    for (let index = sectionStart + 1; index < lines.length; index++) {
      if (nextSectionPattern.test(lines[index])) {
        insertAt = index
        break
      }

      if (keyPattern.test(lines[index])) {
        lines[index] = this.replaceTomlAssignmentLine(lines[index], key, value)
        return this.collapseRepeatedBlankLines(lines.join('\n'))
      }
    }

    const assignment = this.formatTomlAssignment(key, value)
    const insertLine = insertAt > sectionStart + 1 && lines[insertAt - 1]?.trim() === '' ? insertAt - 1 : insertAt
    lines.splice(insertLine, 0, assignment)
    return this.collapseRepeatedBlankLines(lines.join('\n'))
  }
}
