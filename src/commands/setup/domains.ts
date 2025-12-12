import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { writeConfigs } from '../../utils/config-writer.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  type NonInteractiveContext,
  createNonInteractiveContext,
  resolveConfirm,
  resolveOrPrompt,
  resolveOrSelect,
  validateAndExit,
} from '../../utils/non-interactive.js'

export default class SetupDomains extends Command {
  static override description = 'Set up domain configurations for external services'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --non-interactive',
    '<%= config.bin %> <%= command.id %> --non-interactive --json',
  ]

  static override flags = {
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
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

    type L1Network = 'anvil' | 'dogeos' | 'holesky' | 'mainnet' | 'other' | 'sepolia'
    const validL1Networks: L1Network[] = ['dogeos', 'anvil', 'holesky', 'mainnet', 'other', 'sepolia']

    // Infer L1 network from existing config for non-interactive mode
    const inferL1Network = (config: any): L1Network | undefined => {
      const chainName = config.general?.CHAIN_NAME_L1?.toLowerCase()
      if (!chainName) return undefined
      if (chainName.includes('doge')) return 'dogeos'
      if (chainName === 'mainnet' || chainName === 'ethereum') return 'mainnet'
      if (chainName === 'sepolia') return 'sepolia'
      if (chainName === 'holesky') return 'holesky'
      if (chainName === 'anvil' || chainName.includes('anvil')) return 'anvil'
      return 'other'
    }

    const l1Network = await resolveOrSelect<L1Network>(
      niCtx,
      () => select({
        choices: [
          { name: 'DogeOS Testnet', value: 'dogeos' },
          { name: 'Ethereum Mainnet', value: 'mainnet' },
          { name: 'Ethereum Sepolia Testnet', value: 'sepolia' },
          { name: 'Ethereum Holesky Testnet', value: 'holesky' },
          { name: 'Other...', value: 'other' },
          { name: 'Anvil (Local)', value: 'anvil' },
        ],
        default: existingConfig.general?.CHAIN_NAME_L1?.toLowerCase() || 'dogeos',
        message: 'Select the L1 network:',
      }) as Promise<L1Network>,
      inferL1Network(existingConfig),
      validL1Networks,
      {
        configPath: '[general].CHAIN_NAME_L1',
        description: 'L1 network type (inferred from CHAIN_NAME_L1)',
        field: 'L1 Network',
      }
    ) as L1Network

    const l1ExplorerUrls: Partial<Record<L1Network, string>> = {
      holesky: 'https://holesky.etherscan.io',
      mainnet: 'https://etherscan.io',
      sepolia: 'https://sepolia.etherscan.io',
    }

    const l1RpcUrls: Partial<Record<L1Network, string>> = {
      holesky: 'https://rpc.ankr.com/eth_holesky',
      mainnet: 'https://rpc.ankr.com/eth',
      sepolia: 'https://rpc.ankr.com/eth_sepolia',
    }

    const l1ChainIds: Partial<Record<L1Network, string>> = {
      anvil: '111111',
      dogeos: '111111',
      holesky: '17000',
      mainnet: '1',
      sepolia: '11155111',
    }

    const generalConfig: Record<string, string> = {}
    let domainConfig: Record<string, string> = {}
    const frontendConfig: Record<string, string> = {}

    const usesAnvil = l1Network === 'anvil'
    const usesDogeos = l1Network === 'dogeos'

    if (l1Network === 'other' || l1Network === 'anvil' || l1Network === 'dogeos') {
      const chainNameL1 = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.general?.CHAIN_NAME_L1 || (usesDogeos ? 'DOGE L1' : 'Custom L1'),
          message: 'Enter the L1 Chain Name:',
        }),
        existingConfig.general?.CHAIN_NAME_L1 || (usesDogeos ? 'DOGE L1' : undefined),
        {
          configPath: '[general].CHAIN_NAME_L1',
          description: 'L1 chain name (e.g., "DOGE L1")',
          field: 'CHAIN_NAME_L1',
        }
      )
      generalConfig.CHAIN_NAME_L1 = chainNameL1 || ''

      const chainIdL1 = await resolveOrPrompt(
        niCtx,
        () => input({
          default: existingConfig.general?.CHAIN_ID_L1 || l1ChainIds[l1Network] || '',
          message: 'Enter the L1 Chain ID:',
        }),
        existingConfig.general?.CHAIN_ID_L1 || l1ChainIds[l1Network],
        {
          configPath: '[general].CHAIN_ID_L1',
          description: 'L1 chain ID (e.g., 111111 for DogeOS)',
          field: 'CHAIN_ID_L1',
        }
      )
      generalConfig.CHAIN_ID_L1 = chainIdL1 || ''
    } else {
      generalConfig.CHAIN_NAME_L1 = l1Network.charAt(0).toUpperCase() + l1Network.slice(1)
      generalConfig.CHAIN_ID_L1 = l1ChainIds[l1Network]!
      domainConfig.EXTERNAL_EXPLORER_URI_L1 = l1ExplorerUrls[l1Network]!
      domainConfig.EXTERNAL_RPC_URI_L1 = l1RpcUrls[l1Network]!
    }

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
    if (l1Network !== 'anvil' && !usesDogeos) {
      logKeyValue('L1 Explorer URL', domainConfig.EXTERNAL_EXPLORER_URI_L1)
      logKeyValue('L1 Public RPC URL', domainConfig.EXTERNAL_RPC_URI_L1)
    }

    logKeyValue('L1 Chain Name', generalConfig.CHAIN_NAME_L1)
    logKeyValue('L1 Chain ID', generalConfig.CHAIN_ID_L1)

    if (usesDogeos) {
      generalConfig.DA_PUBLISHER_ENDPOINT = 'http://da-publisher:8545'
      generalConfig.L1_RPC_ENDPOINT = 'http://l1-interface:8545'
      generalConfig.L1_RPC_ENDPOINT_WEBSOCKET = ''
      generalConfig.BEACON_RPC_ENDPOINT = 'http://l1-interface:5052'
    } else if (l1Network === 'anvil') {
      generalConfig.L1_RPC_ENDPOINT = 'http://l1-devnet:8545'
      generalConfig.L1_RPC_ENDPOINT_WEBSOCKET = 'ws://l1-devnet:8546'
    } else {
      // In non-interactive mode, use existing config values or defaults
      const setL1RpcEndpoint = await resolveConfirm(
        niCtx,
        () => confirm({
          message: 'Do you want to set custom (private) L1 RPC endpoints for the SDK backend?',
        }),
        existingConfig.general?.L1_RPC_ENDPOINT ? true : undefined,
        false // Default to not setting custom endpoints
      )

      if (setL1RpcEndpoint) {
        const l1RpcEndpoint = await resolveOrPrompt(
          niCtx,
          () => input({
            default: existingConfig.general?.L1_RPC_ENDPOINT || domainConfig.EXTERNAL_RPC_URI_L1,
            message: 'Enter the L1 RPC HTTP endpoint for SDK backend:',
          }),
          existingConfig.general?.L1_RPC_ENDPOINT || domainConfig.EXTERNAL_RPC_URI_L1,
          {
            configPath: '[general].L1_RPC_ENDPOINT',
            description: 'L1 RPC HTTP endpoint for SDK backend',
            field: 'L1_RPC_ENDPOINT',
          }
        )
        generalConfig.L1_RPC_ENDPOINT = l1RpcEndpoint || ''

        const l1RpcWs = await resolveOrPrompt(
          niCtx,
          () => input({
            default:
              existingConfig.general?.L1_RPC_ENDPOINT_WEBSOCKET || domainConfig.EXTERNAL_RPC_URI_L1.replace('http', 'ws'),
            message: 'Enter the L1 RPC WebSocket endpoint for SDK backend:',
          }),
          existingConfig.general?.L1_RPC_ENDPOINT_WEBSOCKET || domainConfig.EXTERNAL_RPC_URI_L1?.replace('http', 'ws'),
          {
            configPath: '[general].L1_RPC_ENDPOINT_WEBSOCKET',
            description: 'L1 RPC WebSocket endpoint for SDK backend',
            field: 'L1_RPC_ENDPOINT_WEBSOCKET',
          },
          false // Not strictly required
        )
        generalConfig.L1_RPC_ENDPOINT_WEBSOCKET = l1RpcWs || ''
      } else {
        generalConfig.L1_RPC_ENDPOINT = domainConfig.EXTERNAL_RPC_URI_L1
        generalConfig.L1_RPC_ENDPOINT_WEBSOCKET = domainConfig.EXTERNAL_RPC_URI_L1.replace('http', 'ws')
      }
    }

    if (usesDogeos) {
      logSuccess(`Updated [general] DA_PUBLISHER_ENDPOINT = "${generalConfig.DA_PUBLISHER_ENDPOINT}"`)
      logSuccess(`Updated [general] BEACON_RPC_ENDPOINT = "${generalConfig.BEACON_RPC_ENDPOINT}"`)
    }

    logSuccess(`Updated [general] L1_RPC_ENDPOINT = "${generalConfig.L1_RPC_ENDPOINT}"`)
    logSuccess(`Updated [general] L1_RPC_ENDPOINT_WEBSOCKET = "${generalConfig.L1_RPC_ENDPOINT_WEBSOCKET}"`)

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
        message: `Do you want to use another RPC gateway for websocket host(${ingressConfig.RPC_GATEWAY_WS_HOST})`,
      }),
      existingConfig.ingress?.RPC_GATEWAY_WS_HOST !== `ws.${existingConfig.ingress?.RPC_GATEWAY_HOST}`,
      false
    )

    if (needRpcGateWay) {
      const wsHost = await resolveOrPrompt(
        niCtx,
        () => input({
          message: 'Enter the WebSocket RPC gateway URL (RPC_GATEWAY_WS_HOST) for the SDK backend:',
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
        message: 'Enter the L1 Chain Symbol:',
      }),
      existingConfig.frontend?.ETH_SYMBOL || 'DOGE',
      {
        configPath: '[frontend].ETH_SYMBOL',
        description: 'L1 chain symbol (e.g., DOGE)',
        field: 'ETH_SYMBOL',
      },
      false
    )
    frontendConfig.ETH_SYMBOL = ethSymbol || 'DOGE'

    const walletProjectId = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.CONNECT_WALLET_PROJECT_ID || "14efbaafcf5232a47d93a68229b71028",
        message: 'Enter wallet project ID:',
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

    const dogeRpcL1 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.DOGE_EXTERNAL_RPC_URI_L1 || "https://sochain.com/DOGETEST",
        message: 'Enter the L1 Public RPC URL:',
      }),
      existingConfig.frontend?.DOGE_EXTERNAL_RPC_URI_L1 || "https://sochain.com/DOGETEST",
      {
        configPath: '[frontend].DOGE_EXTERNAL_RPC_URI_L1',
        description: 'L1 public RPC URL',
        field: 'DOGE_EXTERNAL_RPC_URI_L1',
      },
      false
    )
    frontendConfig.DOGE_EXTERNAL_RPC_URI_L1 = dogeRpcL1 || "https://sochain.com/DOGETEST"

    const dogeExplorerL1 = await resolveOrPrompt(
      niCtx,
      () => input({
        default: existingConfig.frontend?.DOGE_EXTERNAL_EXPLORER_URI_L1 || "https://sochain.com/DOGETEST",
        message: 'Enter the L1 Explorer URL:',
      }),
      existingConfig.frontend?.DOGE_EXTERNAL_EXPLORER_URI_L1 || "https://sochain.com/DOGETEST",
      {
        configPath: '[frontend].DOGE_EXTERNAL_EXPLORER_URI_L1',
        description: 'L1 explorer URL',
        field: 'DOGE_EXTERNAL_EXPLORER_URI_L1',
      },
      false
    )
    frontendConfig.DOGE_EXTERNAL_EXPLORER_URI_L1 = dogeExplorerL1 || "https://sochain.com/DOGETEST"

    // Final confirmation - in non-interactive mode, always proceed
    const confirmUpdate = await resolveConfirm(
      niCtx,
      () => confirm({
        message: 'Do you want to update the config.toml file with these new configurations?',
      }),
      true, // In non-interactive, we always want to update
      true
    )

    if (confirmUpdate) {
      await this.updateConfigFile(domainConfig, ingressConfig, generalConfig, frontendConfig, flags.json)

      // Output JSON response on success
      if (flags.json) {
        jsonCtx.success({
          domain: domainConfig,
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

  private async getExistingConfig(): Promise<any> {
    const configPath = path.join(process.cwd(), 'config.toml')
    if (!fs.existsSync(configPath)) {
      this.error('config.toml not found in the current directory.')
      return {}
    }

    const configContent = fs.readFileSync(configPath, 'utf8')
    return toml.parse(configContent) as any
  }


  private mergeTomlContent(original: string, updated: string): string {
    const originalLines = original.split('\n')
    const updatedLines = updated.split('\n')
    const mergedLines: string[] = []

    let originalIndex = 0
    let updatedIndex = 0

    while (originalIndex < originalLines.length && updatedIndex < updatedLines.length) {
      const originalLine = originalLines[originalIndex]
      const updatedLine = updatedLines[updatedIndex]

      if (originalLine.trim().startsWith('#') || originalLine.trim() === '') {
        // Preserve comments and empty lines from the original file
        mergedLines.push(originalLine)
        originalIndex++
      } else if (originalLine === updatedLine) {
        // Lines are identical, keep either one
        mergedLines.push(originalLine)
        originalIndex++
        updatedIndex++
      } else {
        // Lines differ, use the updated line
        mergedLines.push(updatedLine)
        updatedIndex++
        // Skip original lines until we find a match or reach a new section
        while (
          originalIndex < originalLines.length &&
          !originalLines[originalIndex].includes('=') &&
          !originalLines[originalIndex].trim().startsWith('[')
        ) {
          originalIndex++
        }
      }
    }

    // Add any remaining lines from the updated content
    while (updatedIndex < updatedLines.length) {
      mergedLines.push(updatedLines[updatedIndex])
      updatedIndex++
    }

    return mergedLines.join('\n')
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
        CELESTIA_HOST: `celestia.${urlEnding}`,
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
        CELESTIA_HOST: await resolveIngressHost(
          'CELESTIA_HOST',
          'celestia.scrollsdk',
          'Celestia node host'
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
    jsonMode: boolean = false,
  ): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    const existingConfig = await this.getExistingConfig()

    // Ensure sections exist
    if (!existingConfig.frontend) existingConfig.frontend = {}
    if (!existingConfig.ingress) existingConfig.ingress = {}
    if (!existingConfig.general) existingConfig.general = {}

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

    // Remove L1_DEVNET_HOST from ingress if not using Anvil
    // if (generalConfig.CHAIN_NAME_L1 !== 'Anvil L1' && existingConfig.ingress.L1_DEVNET_HOST) {
    //   delete existingConfig.ingress.L1_DEVNET_HOST
    // }

    // // Remove L1_EXPLORER_HOST from ingress if not using Anvil
    // if (generalConfig.CHAIN_NAME_L1 !== 'Anvil L1' && existingConfig.ingress.L1_EXPLORER_HOST) {
    //   delete existingConfig.ingress.L1_EXPLORER_HOST
    // }


    existingConfig.contracts.verification.EXPLORER_URI_L1 = domainConfig.EXTERNAL_EXPLORER_URI_L1;
    existingConfig.contracts.verification.EXPLORER_URI_L2 = domainConfig.EXTERNAL_EXPLORER_URI_L2;
    existingConfig.contracts.verification.RPC_URI_L1 = domainConfig.EXTERNAL_RPC_URI_L1;
    existingConfig.contracts.verification.RPC_URI_L2 = domainConfig.EXTERNAL_RPC_URI_L2;


    // Convert the updated config back to TOML string
    const updatedContent = toml.stringify(existingConfig)

    // Merge the updated content with the original content to preserve comments
    const mergedContent = this.mergeTomlContent(fs.readFileSync(configPath, 'utf8'), updatedContent)

    // Pass silent=true when in JSON mode to avoid stdout pollution
    if (writeConfigs(mergedContent, undefined, undefined, jsonMode) && // Only log to stdout in non-JSON mode (writeConfigs handles its own logging when not silent)
      !jsonMode) {
        this.log(chalk.green('config.toml has been updated with the new domain configurations.'))
      }
  }
}
