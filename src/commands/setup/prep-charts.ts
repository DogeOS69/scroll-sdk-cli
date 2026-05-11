/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic YAML/TOML config operations */
import * as toml from '@iarna/toml'
import { confirm } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import { YAML_DUMP_OPTIONS } from '../../config/constants.js'
import { DogeConfig as DogeConfigType } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'

/**
 * Strip port from hostname for Kubernetes Ingress
 * Kubernetes Ingress hosts cannot contain port numbers
 * e.g., "localhost:8545" -> "localhost"
 */
function stripPortFromHost(host: string): string {
  if (!host) return host
  // Handle IPv6 addresses like [::1]:8545
  if (host.includes('[')) {
    const bracketEnd = host.indexOf(']')
    if (bracketEnd !== -1 && host[bracketEnd + 1] === ':') {
      return host.slice(0, Math.max(0, bracketEnd + 1))
    }

    return host
  }

  // Handle regular hostname:port
  const colonIndex = host.lastIndexOf(':')
  if (colonIndex !== -1) {
    // Check if what's after the colon is a number (port)
    const potentialPort = host.slice(Math.max(0, colonIndex + 1))
    if (/^\d+$/.test(potentialPort)) {
      return host.slice(0, Math.max(0, colonIndex))
    }
  }

  return host
}

export default class SetupPrepCharts extends Command {
  static override description = 'Validate Makefile and prepare Helm charts for Scroll SDK'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --github-username=your-username --github-token=your-token',
    '<%= config.bin %> <%= command.id %> --values-dir=./custom-values',
    '<%= config.bin %> <%= command.id %> --skip-auth-check',
  ]

  static override flags = {
    'doge-config': Flags.string({ description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)' }),
    'github-token': Flags.string({ description: 'GitHub Personal Access Token', required: false }),
    'github-username': Flags.string({ description: 'GitHub username', required: false }),
    json: Flags.boolean({
      default: false,
      description: 'Output in JSON format (stdout for data, stderr for logs)',
    }),
    'non-interactive': Flags.boolean({
      char: 'N',
      default: false,
      description: 'Run without prompts. Auto-applies all detected changes.',
    }),
    'skip-auth-check': Flags.boolean({ default: false, description: 'Skip authentication check for individual charts' }),
    'values-dir': Flags.string({ default: './values', description: 'Directory containing values files' }),
  }

  private configData: any = {}

  private configMapping: Record<string, ((chartName: string, productionNumber: string) => string) | string> = {
    'ADMIN_SYSTEM_DASHBOARD_HOST': 'ingress.ADMIN_SYSTEM_DASHBOARD_HOST',
    'BLOCKSCOUT_HOST': 'ingress.BLOCKSCOUT_HOST',
    'BRIDGE_HISTORY_API_HOST': 'ingress.BRIDGE_HISTORY_API_HOST',
    'CHAIN_ID': 'general.CHAIN_ID_L2',
    'CHAIN_ID_L1': 'general.CHAIN_ID_L1',
    'CHAIN_ID_L2': 'general.CHAIN_ID_L2',
    'COORDINATOR_API_HOST': 'ingress.COORDINATOR_API_HOST',
    // Add ingress host mappings
    'FRONTEND_HOST': 'ingress.FRONTEND_HOST',
    'GRAFANA_HOST': 'ingress.GRAFANA_HOST',
    'L1_DEVNET_HOST': 'ingress.L1_DEVNET_HOST',
    'L1_EXPLORER_HOST': 'ingress.L1_EXPLORER_HOST',
    'L1_RPC_ENDPOINT': 'general.L1_RPC_ENDPOINT',
    'L1_SCROLL_CHAIN_PROXY_ADDR': 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR',
    'L2_RPC_ENDPOINT': 'general.L2_RPC_ENDPOINT',
    'L2GETH_DA_BLOB_BEACON_NODE': 'general.BEACON_RPC_ENDPOINT',
    // 'L2GETH_NODEKEY': (chartName, productionNumber) =>
    //   chartName.startsWith('l2-bootnode') ? `bootnode.bootnode-${productionNumber}.L2GETH_NODEKEY` :
    //     (productionNumber === '0' ? 'sequencer.L2GETH_NODEKEY' : `sequencer.sequencer-${productionNumber}.L2GETH_NODEKEY`),
    'L2GETH_KEYSTORE': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_KEYSTORE' : `sequencer.sequencer-${productionNumber}.L2GETH_KEYSTORE`,
    'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK': 'general.L1_CONTRACT_DEPLOYMENT_BLOCK',
    'L2GETH_L1_ENDPOINT': 'general.L1_RPC_ENDPOINT',
    'L2GETH_PASSWORD': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_PASSWORD' : `sequencer.sequencer-${productionNumber}.L2GETH_PASSWORD`,
    'L2GETH_PEER_LIST': 'sequencer.L2_GETH_STATIC_PEERS',
    'L2GETH_SIGNER_ADDRESS': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_SIGNER_ADDRESS' : `sequencer.sequencer-${productionNumber}.L2GETH_SIGNER_ADDRESS`,
    'ROLLUP_EXPLORER_API_HOST': 'ingress.ROLLUP_EXPLORER_API_HOST',
    'RPC_GATEWAY_HOST': 'ingress.RPC_GATEWAY_HOST',
    'RPC_GATEWAY_WS_HOST': 'ingress.RPC_GATEWAY_WS_HOST',
    'SCROLL_L1_RPC': 'general.L1_RPC_ENDPOINT',
    'SCROLL_L2_RPC': 'general.L2_RPC_ENDPOINT',

    // Add more mappings as needed
  }

  private contractsConfig: any = {}
  private dogeConfig: DogeConfig = {} as DogeConfig
  private flags: any; // To store parsed flags
  private jsonCtx!: JsonOutputContext
  private jsonMode: boolean = false
  private nonInteractive: boolean = false
  private withdrawalProcessorConfig: toml.JsonMap = {}

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPrepCharts)

    // Setup non-interactive/JSON mode
    this.nonInteractive = flags['non-interactive']
    this.jsonMode = flags.json
    this.jsonCtx = new JsonOutputContext('setup prep-charts', this.jsonMode)

    this.jsonCtx.info('Starting chart preparation...')

    // Load configs before processing yaml files
    await this.loadConfigs(flags)

    if (flags['github-username'] && flags['github-token']) {
      try {
        await this.authenticateGHCR(flags['github-username'], flags['github-token'])
      } catch {
        this.jsonCtx.addWarning('Failed to authenticate with GitHub Container Registry')
      }
    }

    let skipAuthCheck = flags['skip-auth-check']
    if (!skipAuthCheck && !this.nonInteractive) {
      skipAuthCheck = !(await confirm({ message: 'Do you want to perform authentication checks for individual charts?' }))
    } else if (this.nonInteractive && !skipAuthCheck) {
      // In non-interactive mode, default to skipping auth check unless explicitly configured
      skipAuthCheck = true
      this.jsonCtx.info('Non-interactive mode: Skipping authentication checks')
    }

    // Validate Makefile
    await this.validateMakefile(skipAuthCheck)

    // Process production.yaml files
    const valuesDir = flags['values-dir']
    const { skipped: skippedInstances, updated: updatedInstances } = await this.processMutipleInstance(valuesDir);
    const { skipped: skippedProduction, updated: updatedProduction } = await this.processProductionYaml(valuesDir);
    const { skipped: skippedConfig, updated: updatedConfig } = await this.processConfigYaml(valuesDir);

    this.jsonCtx.logSuccess(`Updated instance-specific YAML files for ${updatedInstances} chart(s).`);
    this.jsonCtx.info(`Skipped ${skippedInstances} instance-specific chart(s).`);

    this.jsonCtx.logSuccess(`Updated production YAML files for ${updatedProduction} chart(s).`)
    this.jsonCtx.info(`Skipped ${skippedProduction} chart(s).`)

    this.jsonCtx.logSuccess(`Updated config YAML files for ${updatedConfig} chart(s).`);
    this.jsonCtx.info(`Skipped ${skippedConfig} chart(s).`);

    this.jsonCtx.logSuccess('Chart preparation completed.')

    // JSON output
    if (this.jsonMode) {
      this.jsonCtx.success({
        configCharts: { skipped: skippedConfig, updated: updatedConfig },
        instanceCharts: { skipped: skippedInstances, updated: updatedInstances },
        productionCharts: { skipped: skippedProduction, updated: updatedProduction },
        totalSkipped: skippedInstances + skippedProduction + skippedConfig,
        totalUpdated: updatedInstances + updatedProduction + updatedConfig,
        valuesDir,
      })
    }
  }

  private async authenticateGHCR(username: string, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['login', 'ghcr.io', '-u', username, '--password-stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdin.write(token)
      child.stdin.end()
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`docker login exited with code ${code}`))
      })
      child.on('error', reject)
    })
    this.log('Authenticated with GitHub Container Registry')
  }

  private formatUrl(baseUrl: string, path: string = ''): string {
    // Remove trailing slash from baseUrl
    const cleanBase = baseUrl.replace(/\/+$/, '');
    // Remove leading slash from path and ensure it starts with a single slash if not empty
    const cleanPath = path ? '/' + path.replace(/^\/+/, '') : '';
    return cleanBase + cleanPath;
  }

  private getBaseUrl(url?: string) {
    if (!url) return url;
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname.endsWith('/api/v2')) {
        urlObj.pathname = urlObj.pathname.slice(0, -7) + '/api';
      }

      let urlString = urlObj.toString();
      // Remove trailing slash if it exists
      if (urlString.endsWith('/')) {
        urlString = urlString.slice(0, -1);
      }

      return urlString;
    } catch {
      return url;
    }
  }

  private getConfigValue(key: string): any {
    const [configType, ...rest] = key.split('.')
    const configKey = rest.join('.')

    if (configType === 'contractsFile') {
      return this.getNestedValue(this.contractsConfig, configKey)
    }
 
      return this.getNestedValue(this.configData, key)
    
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
  }

  private isL2Node(chartName: string): boolean {
    return chartName.startsWith("l2-bootnode") || chartName.startsWith("l2-rpc") || chartName.startsWith("l2-sequencer");
  }


  private async loadConfigs(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    const contractsConfigPath = path.join(process.cwd(), 'config-contracts.toml')

    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8')
      this.configData = toml.parse(configContent)
    } else {
      this.warn('config.toml not found. Some values may not be populated correctly.')
    }

    if (fs.existsSync(contractsConfigPath)) {
      const contractsConfigContent = fs.readFileSync(contractsConfigPath, 'utf8')
      this.contractsConfig = toml.parse(contractsConfigContent)
    } else {
      this.warn('config-contracts.toml not found. Some values may not be populated correctly.')
    }

    const { config } = await loadDogeConfigWithSelection(flags['doge-config'], 'scrollsdk setup doge-config')
    this.dogeConfig = config as DogeConfigType;


    const withdrawalProcessorConfigPath = path.join(process.cwd(), ".data/output-withdrawal-processor.toml")
    if (!fs.existsSync(withdrawalProcessorConfigPath)) {
      this.error("run scrollsdk setup bridge-init first");
      return
    }

    const withdrawalProcessorConfigContent = fs.readFileSync(withdrawalProcessorConfigPath, 'utf8');
    this.withdrawalProcessorConfig = toml.parse(withdrawalProcessorConfigContent);
    
  }

  private async processConfigYaml(valuesDir: string): Promise<{ skipped: number, updated: number }> {
    let updatedCharts = 0
    let skippedCharts = 0
    const configFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-config.yaml'))

    for (const file of configFiles) {
      const yamlPath = path.join(valuesDir, file)
      this.log(chalk.cyan(`Processing ${yamlPath}`));
      const chartName = file.replace(/-config\.yaml$/, '');
      const yamlData = yaml.load(fs.readFileSync(yamlPath, "utf8")) as any;
      const changes: Array<{ key: string; newValue: string; oldValue: string }> = [];

      if (chartName === "rollup-relayer") {
        let updated = false;
        const daPublisherEndpoint = this.getConfigValue("general.DA_PUBLISHER_ENDPOINT");

        // Parse the JSON string from scrollConfig
        let scrollConfigJson: any = {};
        try {
          scrollConfigJson = JSON.parse(yamlData.scrollConfig);
        } catch (error: any) {
          this.error(chalk.red(`Failed to parse scrollConfig JSON in ${file}: ` + error.message));
        }

        const currentL1Endpoint = scrollConfigJson.l1_config.endpoint;
        if (currentL1Endpoint !== "") {
          scrollConfigJson.l1_config.endpoint = "";
          updated = true;
          changes.push({ key: `l1_config.endpoint`, newValue: "", oldValue: currentL1Endpoint });
        }

        const currentEndpoint = scrollConfigJson.l2_config.relayer_config.sender_config.endpoint;
        if (currentEndpoint !== daPublisherEndpoint) {
          scrollConfigJson.l2_config.relayer_config.sender_config.endpoint = daPublisherEndpoint;
          updated = true;
          changes.push({ key: `l2_config.relayer_config.sender_config.endpoint`, newValue: daPublisherEndpoint, oldValue: currentEndpoint });
        }

        // Remove celestia_submit_endpoint if it exists
        if (scrollConfigJson.l2_config?.relayer_config?.celestia_submit_endpoint !== undefined) {
          const currentCelestiaEndpoint = scrollConfigJson.l2_config.relayer_config.celestia_submit_endpoint;
          delete scrollConfigJson.l2_config.relayer_config.celestia_submit_endpoint;
          updated = true;
          changes.push({ key: `l2_config.relayer_config.celestia_submit_endpoint`, newValue: "removed", oldValue: currentCelestiaEndpoint });
        }


        if (updated) {
          if (!this.jsonMode) {
            this.log(`\nFor ${chalk.cyan(file)}:`)
            this.log(chalk.green('Changes:'))
            for (const change of changes) {
              this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`)
            }
          }

          let shouldUpdate = this.nonInteractive
          if (!this.nonInteractive) {
            shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` })
          }

          if (shouldUpdate) {
            // Preserve the literal block scalar format for scrollConfig
            const jsonConfigString = JSON.stringify(scrollConfigJson, null, 2);

            // Manually construct to get exact "scrollConfig: |" format
            const indentedJson = jsonConfigString
              .trim()
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n');

            const yamlContent = `scrollConfig: |\n${indentedJson}\n`;

            fs.writeFileSync(yamlPath, yamlContent);
            this.jsonCtx.logSuccess(`Updated ${file}`)
            updatedCharts++;
          } else {
            this.jsonCtx.info(`Skipped updating ${file}`);
            skippedCharts++;
          }
        }
      } else {
        this.jsonCtx.info(`No changes needed in ${file}`);
        skippedCharts++;
      }

      if (chartName === "frontends") {
        const {scrollConfig} = yamlData;
        let scrollConfigToml: any = {};
        try {
          scrollConfigToml = toml.parse(scrollConfig);
        } catch (error: any) {
          this.error(chalk.red("scrollConfig failed: " + error.message));
        }

        let sharedHost = this.getConfigValue("ingress.FRONTEND_HOST")
        if (sharedHost && sharedHost.startsWith("portal.")) {
          sharedHost = sharedHost.slice(7)
        }

        const configUpdates = {

          REACT_APP_BASE_CHAIN: this.getConfigValue("general.CHAIN_NAME_L1"),
          REACT_APP_CONNECT_WALLET_PROJECT_ID: this.getConfigValue("frontend.CONNECT_WALLET_PROJECT_ID"),
          REACT_APP_DOGE_BRIDGE_ADDRESS: this.withdrawalProcessorConfig.bridge_address,
          REACT_APP_DOGE_NETWORK: this.dogeConfig.network,
          // new config
          REACT_APP_ETH_SYMBOL: this.getConfigValue("frontend.ETH_SYMBOL"),
          REACT_APP_EXTERNAL_DOCS_URI: this.formatUrl("https://docs." + sharedHost, "/en/home"),
          REACT_APP_EXTERNAL_EXPLORER_URI_L1: this.getConfigValue("frontend.DOGE_EXTERNAL_EXPLORER_URI_L1"),
          REACT_APP_EXTERNAL_RPC_URI_L1: this.getConfigValue("frontend.DOGE_EXTERNAL_RPC_URI_L1"),
          REACT_APP_FAUCET_URI: this.formatUrl("https://faucet." + sharedHost),

          REACT_APP_L1_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L1_STANDARD_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L2_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_MOAT_ADDRESS: this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          REACT_APP_ROLLUP: this.getConfigValue("general.CHAIN_NAME_L2"),
        };

        let updated = false;
        for (const [key, newValue] of Object.entries(configUpdates)) {
          const oldValue = scrollConfigToml[key];
          if (!oldValue || oldValue !== newValue) {
            changes.push({ key, newValue: String(newValue), oldValue: String(oldValue || '') });
            scrollConfigToml[key] = newValue;
            updated = true;
          }
        }

        if (updated) {
          if (!this.jsonMode) {
            this.log(`\nFor ${chalk.cyan(file)}:`);
            this.log(chalk.green('Changes:'));
            for (const change of changes) {
              this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`);
            }
          }

          let shouldUpdate = this.nonInteractive
          if (!this.nonInteractive) {
            shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` });
          }

          if (shouldUpdate) {
            // Preserve the literal block scalar format for scrollConfig
            const tomlConfigString = toml.stringify(scrollConfigToml);

            // Manually construct to get exact "scrollConfig: |" format (not "scrollConfig: |-")
            const indentedToml = tomlConfigString
              .trim()
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n');

            const yamlContent = `scrollConfig: |\n${indentedToml}\n`;

            fs.writeFileSync(yamlPath, yamlContent);
            this.jsonCtx.logSuccess(`Updated ${file}`);
            updatedCharts++;
          } else {
            this.jsonCtx.info(`Skipped updating ${file}`);
            skippedCharts++;
          }
        } else {
          this.jsonCtx.info(`No changes needed in ${file}`);
          skippedCharts++;
        }
      }
    }

    return { skipped: skippedCharts, updated: updatedCharts };
  }

  // Generic ingress processing function
  private processIngressHosts(
    ingressConfig: any,
    hostConfigValue: string,
    changes: Array<{ key: string; newValue: string; oldValue: string }>,
    keyPrefix: string = 'ingress'
  ): boolean {
    let ingressUpdated = false;

    if (ingressConfig && typeof ingressConfig === 'object' && 'hosts' in ingressConfig) {
      const hosts = ingressConfig.hosts as Array<{ host: string; paths?: any[] }>;
      if (Array.isArray(hosts)) {
        // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
        const sanitizedHost = hostConfigValue ? stripPortFromHost(hostConfigValue) : hostConfigValue;
        for (const [i, host] of hosts.entries()) {
          if (typeof host === 'object' && 'host' in host && sanitizedHost && sanitizedHost !== host.host) {
              changes.push({
                key: `${keyPrefix}.hosts[${i}].host`,
                newValue: sanitizedHost,
                oldValue: host.host
              });
              host.host = sanitizedHost;
              ingressUpdated = true;
            }
        }
      }

      // Update TLS section if it exists and ingress was updated
      if (ingressUpdated && ingressConfig.tls) {
        const tlsEntries = ingressConfig.tls as Array<{ hosts: string[] }>;
        if (Array.isArray(tlsEntries)) {
          for (const tlsEntry of tlsEntries) {
            if (Array.isArray(tlsEntry.hosts)) {
              tlsEntry.hosts = hosts.map((host) => host.host);
            }
          }
        }
      }
    }

    return ingressUpdated;
  }

  private async processMutipleInstance(valuesDir: string): Promise<{ skipped: number; updated: number }> {
    interface ChartConfig {
      chartName: string;
      configKey: null | string;
    }

    const names: ChartConfig[] = [{
      chartName: "l2-bootnode",
      configKey: "bootnode"
    }, {
      chartName: "l2-sequencer",
      configKey: "sequencer"
    }, {
      chartName: "cubesigner-signer",
      configKey: null
    }];
    let updatedCharts = 0;
    let skippedCharts = 0;

    for (const item of names) {
      const { chartName, configKey } = item;

      // Skip config validation for charts that don't need configKey (like cubesigner-signer)
      if (configKey && !this.configData[configKey]) {
        this.error(`${configKey} not found in config.toml`);
      }

      let releaseIndex = 0;
      const templateFilePath = path.join(valuesDir, `${chartName}-production.yaml`);
      if (!fs.existsSync(templateFilePath)) {
        this.warn(chalk.yellow(`Source file not found: ${templateFilePath}, skipping ${chartName} charts`));
        skippedCharts++;
        continue;
      }

      const templateContent = fs.readFileSync(templateFilePath, 'utf8');

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // For charts without configKey, we generate a fixed number of instances (e.g., 6 for cubesigner-signer)
        if (configKey) {
          const instanceKey = `${configKey}-${releaseIndex}`

          // instanceConfig is like this.configData.bootnode.bootnode-0, or this.configData.sequencer.sequencer-0
          const instanceConfig = this.configData[configKey][instanceKey]

          if (!instanceConfig && instanceKey !== "sequencer-0") {
            // No more bootnode instances defined
            this.log(chalk.yellow(`No more ${instanceKey} instances defined.`));
            break
          }
        } else {
          // Determine the number of instances dynamically for cubesigner-signer based on dogeConfig.cubesigner.roles
          const maxInstances = chartName === "cubesigner-signer"
            ? (this.dogeConfig.cubesigner?.roles?.length ?? 1)
            : 1;
          if (releaseIndex >= maxInstances) {
            break;
          }
        }

        const destFilePath = path.join(valuesDir, `${chartName}-production-${releaseIndex}.yaml`);

        const newYamlContent = templateContent.replaceAll('__INSTANCE_INDEX__', releaseIndex.toString());

        if (!fs.existsSync(destFilePath)) {
          fs.writeFileSync(destFilePath, newYamlContent);
          updatedCharts++;
        }

        releaseIndex++
      }
    }

    return { skipped: skippedCharts, updated: updatedCharts };
  }


  private async processProductionYaml(
    valuesDir: string
  ): Promise<{ skipped: number; updated: number }> {
    const productionFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-production.yaml') || file.match(/-production-\d+\.yaml$/))

    let updatedCharts = 0
    let skippedCharts = 0
    const isTestnet = this.dogeConfig.network === "testnet";
    const dogecoinInternalUrl = "http://dogecoin-" + (isTestnet ? "testnet:44555" : "mainnet:22555");

    for (const file of productionFiles) {
      const yamlPath = path.join(valuesDir, file)
      const chartName = file.replace(/-production(-\d+)?\.yaml$/, '')
      const productionNumber = file.match(/-production-(\d+)\.yaml$/)?.[1] || '0'

      this.log(`Processing ${file} for chart ${chartName}...`)

      const productionYamlContent = fs.readFileSync(yamlPath, 'utf8')
      const productionYaml = yaml.load(productionYamlContent) as any

      let updated = false
      const changes: Array<{ key: string; newValue: string; oldValue: string }> = []

      // Process configMaps
      if (productionYaml.configMaps) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [_configMapName, configMapData] of Object.entries(productionYaml.configMaps)) {
          if (configMapData && typeof configMapData === 'object' && 'data' in configMapData) {
            const envData = (configMapData as any).data
            for (const [key, oldValue] of Object.entries(envData)) {
              const configPathOrResolver = this.configMapping[key]
              if (configPathOrResolver) {
                let configKey: string
                configKey = typeof configPathOrResolver === 'function' ? configPathOrResolver(chartName, productionNumber) : configPathOrResolver;
                if (chartName === "l1-devnet" && key === "CHAIN_ID") {
                  configKey = "general.CHAIN_ID_L1";
                }

                if (chartName === "rollup-relayer" && key === "L1_RPC_ENDPOINT") {
                  configKey = "general.DA_PUBLISHER_ENDPOINT";
                }

                let configValue = this.getConfigValue(configKey)
                if (this.isL2Node(chartName) && key === "L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK") {
                  configValue = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
                }

                if (configValue !== undefined && configValue !== null) {
                  const newValue: string | string[] = Array.isArray(configValue) ? JSON.stringify(configValue) : String(configValue);
                  if (newValue !== oldValue) {
                    changes.push({ key, newValue, oldValue: JSON.stringify(oldValue) })
                    envData[key] = newValue
                    updated = true
                  }
                } else {
                  this.log(chalk.yellow(`${chartName}: No value found for ${configKey}`))
                }
              }
            }
          }
        }
      }

      // Process ingress
      if (productionYaml.ingress) {
        let ingressUpdated = false;
        for (const [ingressKey, ingressValue] of Object.entries(productionYaml.ingress)) {
          if (ingressValue && typeof ingressValue === 'object' && 'hosts' in ingressValue) {
            const hosts = ingressValue.hosts as Array<{ host: string }>;
            if (Array.isArray(hosts)) {
              for (const [i, host] of hosts.entries()) {
                if (typeof host === 'object' && 'host' in host) {
                  let configValue: string | undefined;

                  if (chartName === 'l2-rpc' && ingressKey === 'websocket') {
                    configValue = this.getConfigValue('ingress.RPC_GATEWAY_WS_HOST');
                  } else {
                    // Check for direct mapping first
                    const directMappingKey = `ingress.${chartName.toUpperCase().replaceAll('-', '_')}_HOST`;
                    configValue = this.getConfigValue(directMappingKey);
                    this.log(chalk.yellow(`${chartName}: ${directMappingKey} -> ${configValue}`));

                    // If direct mapping doesn't exist, try alternative mappings
                    if (!configValue) {
                      const alternativeMappings: Record<string, string> = {
                        'admin-system-dashboard': 'ADMIN_SYSTEM_DASHBOARD_HOST',
                        'blockbook': 'BLOCKBOOK_HOST',
                        'blockscout': 'BLOCKSCOUT_HOST',
                        'bridge-history-api': 'BRIDGE_HISTORY_API_HOST',
                        'celestia-node': 'CELESTIA_HOST',
                        'coordinator-api': 'COORDINATOR_API_HOST',
                        'dogecoin': 'DOGECOIN_HOST',
                        'frontends': 'FRONTEND_HOST',
                        'l1-devnet': 'L1_DEVNET_HOST',
                        'l2-rpc': 'RPC_GATEWAY_HOST',
                        'rollup-explorer-backend': 'ROLLUP_EXPLORER_API_HOST',
                        'tso-service': 'TSO_HOST',
                      };

                      const alternativeKey = alternativeMappings[chartName];
                      if (alternativeKey) {
                        configValue = this.getConfigValue(`ingress.${alternativeKey}`);
                      } else {
                        this.error(`${chartName}: ${alternativeKey} not found in config`);
                      }
                    }
                  }

                  if (configValue) {
                    // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
                    const sanitizedHost = stripPortFromHost(configValue);
                    if (sanitizedHost !== host.host) {
                      changes.push({ key: `ingress.${ingressKey}.hosts[${i}].host`, newValue: sanitizedHost, oldValue: host.host });
                      host.host = sanitizedHost;
                      ingressUpdated = true;
                    }
                  }
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const [_ingressKey, ingressValue] of Object.entries(productionYaml.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                for (const tlsEntry of tlsEntries) {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                }
              }
            }
          }
        }
      }



      if (productionYaml["blockscout-stack"]) {
        let ingressUpdated = false;
        const {blockscout} = productionYaml["blockscout-stack"];
        const {frontend} = productionYaml["blockscout-stack"];
        const blockscout_host = this.getConfigValue("ingress.BLOCKSCOUT_HOST");
        const blockscout_url = this.getConfigValue("frontend.EXTERNAL_EXPLORER_URI_L2");

        if (blockscout?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `ingress.blockscout.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, newValue: blockscout_url, oldValue });
            blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }

        if (blockscout?.ingress?.hostname) {
          const oldValue = blockscout.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `ingress.blockscout.hostname`, newValue: blockscout_host, oldValue });
            blockscout.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        // only enable tls if use command scrollsdk setup tls
        // if setup:tls was executed, all http protocol will be updated to https
        // so we don't support disable tls for now

        // if (blockscout?.ingress?.tls?.enabled) {
        //   if (blockscout.ingress.tls.enabled !== false) {
        //     const oldValue = blockscout.ingress.tls.enabled;
        //     blockscout.ingress.tls.enabled = false; // Ensure it's boolean false
        //     changes.push({ key: `ingress.blockscout.tls.enabled`, oldValue: String(oldValue), newValue: "false" });
        //     ingressUpdated = true;
        //   }
        // }

        if (frontend?.env?.NEXT_PUBLIC_API_HOST) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_HOST;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.env.NEXT_PUBLIC_API_HOST`, newValue: blockscout_host, oldValue });
            frontend.env.NEXT_PUBLIC_API_HOST = blockscout_host;
            ingressUpdated = true;
          }
        }

        const protocol = blockscout_url.startsWith("https") ? "https" : "http";
        if (frontend?.env?.NEXT_PUBLIC_API_PROTOCOL) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_PROTOCOL;
          if (oldValue !== protocol) {
            changes.push({
              key: `frontend.env.NEXT_PUBLIC_API_PROTOCOL`,
              newValue: protocol,
              oldValue
            });
            frontend.env.NEXT_PUBLIC_API_PROTOCOL = protocol;
            ingressUpdated = true;
          }
        }

        if (frontend?.env?.NEXT_PUBLIC_APP_PROTOCOL) {
          const oldValue = frontend.env.NEXT_PUBLIC_APP_PROTOCOL;
          if (oldValue !== protocol) {
            changes.push({
              key: `frontend.env.NEXT_PUBLIC_APP_PROTOCOL`,
              newValue: protocol,
              oldValue
            });
            frontend.env.NEXT_PUBLIC_APP_PROTOCOL = protocol;
            ingressUpdated = true;
          }
        }

        if (frontend?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, newValue: blockscout_url, oldValue });
            frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }

        if (frontend?.ingress?.hostname) {
          const oldValue = frontend.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.ingress.hostname`, newValue: blockscout_host, oldValue });
            frontend.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        /*
        NEXT_PUBLIC_NETWORK_ID: "221122420"
        */
        const oldNetworkName = frontend?.env?.NEXT_PUBLIC_NETWORK_NAME;
        const newNetworkName = this.getConfigValue("general.CHAIN_NAME_L2");
        if (!oldNetworkName || oldNetworkName !== newNetworkName) {
          changes.push({ key: `frontend.env.NEXT_PUBLIC_NETWORK_NAME`, newValue: newNetworkName, oldValue: oldNetworkName });
          frontend.env.NEXT_PUBLIC_NETWORK_NAME = newNetworkName;
          ingressUpdated = true;
        }

        const oldValue = frontend?.env?.NEXT_PUBLIC_NETWORK_ID;
        const newValue = this.getConfigValue("general.CHAIN_ID_L2");
        if (!oldValue || oldValue !== this.getConfigValue("general.CHAIN_ID_L2")) {
          changes.push({ key: `frontend.env.NEXT_PUBLIC_NETWORK_ID`, newValue, oldValue });
          frontend.env.NEXT_PUBLIC_NETWORK_ID = newValue;
          ingressUpdated = true;
        }


        interface BlockscoutEnvMapping {
          configKey: string;
          defaultValue?: string;
          key: string;
        }

        const BLOCKSCOUT_ENV_MAPPINGS: BlockscoutEnvMapping[] = [
          {
            configKey: '',
            defaultValue: '0',
            key: 'INDEXER_SCROLL_L1_BATCH_START_BLOCK'
          },
          {
            configKey: '',
            defaultValue: '0',
            key: 'INDEXER_SCROLL_L1_MESSENGER_START_BLOCK'
          },
          {
            configKey: 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L1_CHAIN_CONTRACT'
          },
          {
            configKey: 'L1_SCROLL_MESSENGER_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L1_MESSENGER_CONTRACT'
          },
          {
            configKey: 'L2_DOGEOS_MESSENGER_PROXY_ADDR',
            key: 'INDEXER_SCROLL_L2_MESSENGER_CONTRACT'
          },
          {
            configKey: 'L1_GAS_PRICE_ORACLE_ADDR',
            key: 'INDEXER_SCROLL_L2_GAS_ORACLE_CONTRACT'
          },
          {
            configKey: 'general.L1_RPC_ENDPOINT',
            key: 'INDEXER_SCROLL_L1_RPC'
          }


        ];
        const benv = productionYaml["blockscout-stack"].blockscout.env;

        for (const mapping of BLOCKSCOUT_ENV_MAPPINGS) {
          const { configKey, defaultValue, key } = mapping;

          let newValue = this.getConfigValue(configKey);
          if (!newValue) {
            newValue = configKey ? this.contractsConfig[configKey] : defaultValue;
          }

          const oldValue = benv[key];

          if (newValue === oldValue) {
            this.log(chalk.yellow(`No value found for ${key}`));
          } else {
            changes.push({
              key: `blockscout.env.${key}`,
              newValue,
              oldValue: benv[key]
            });
            benv[key] = newValue;
            updated = true;
          }
        }

        if (ingressUpdated) {
          updated = true;
        }
      }

      if (productionYaml.grafana) {
        /*
          grafana.ini:
            server:
              domain: grafana.scrollsdk
              root_url: "https://grafana.scrollsdk""
        */
        if (!productionYaml.grafana["grafana.ini"]) {
          productionYaml.grafana["grafana.ini"] = { server: {} };
        }

        if (!productionYaml.grafana["grafana.ini"].server) {
          productionYaml.grafana["grafana.ini"].server = {};
        }

        const existingDomain = productionYaml.grafana?.["grafana.ini"]?.server?.domain ?? null;
        const existingRootUrl = productionYaml.grafana?.["grafana.ini"]?.server?.root_url ?? null;

        const newDomain = this.getConfigValue("ingress.GRAFANA_HOST");
        if (existingDomain !== newDomain) {
          changes.push({ key: `grafana["grafana.ini"].server.domain`, newValue: newDomain, oldValue: existingDomain });
          productionYaml.grafana["grafana.ini"].server.domain = newDomain;
          updated = true;
        }

        const newRootUrl = this.getConfigValue("frontend.GRAFANA_URI");
        if (existingRootUrl !== newRootUrl) {
          changes.push({ key: `grafana["grafana.ini"].server.root_url`, newValue: newRootUrl, oldValue: existingRootUrl });
          productionYaml.grafana["grafana.ini"].server.root_url = newRootUrl;
          updated = true;
        }



        let ingressUpdated = false;
        const ingressValue = productionYaml.grafana.ingress;
        if (ingressValue && typeof ingressValue === 'object' && 'hosts' in ingressValue) {
          const hosts = ingressValue.hosts as Array<string>;
          if (Array.isArray(hosts)) {
            for (let i = 0; i < hosts.length; i++) {
              if (typeof (hosts[i]) === 'string') {
                const configValue: string | undefined = this.getConfigValue("ingress.GRAFANA_HOST");
                // Strip port from hostname - Kubernetes Ingress hosts cannot contain ports
                const sanitizedHost = configValue ? stripPortFromHost(configValue) : configValue;

                if (sanitizedHost && (sanitizedHost !== hosts[i])) {
                  changes.push({ key: `ingress.hosts[${i}]`, newValue: sanitizedHost, oldValue: hosts[i] });
                  hosts[i] = sanitizedHost;
                  ingressUpdated = true;
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for (const [_ingressKey, ingressValue] of Object.entries(productionYaml.grafana.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                for (const tlsEntry of tlsEntries) {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                }
              }
            }
          }
        }
      }

      // eslint-disable-next-line unicorn/prefer-switch
      if (chartName === "celestia-node") {
        let ingressUpdated = false;
        if (productionYaml.ingress) {
          const ingressValue = productionYaml.ingress;
          ingressValue.enabled = true;
          const configValue = this.getConfigValue('ingress.CELESTIA_HOST');
          ingressUpdated = this.processIngressHosts(ingressValue, configValue, changes);
        } else {
          productionYaml.ingress = {
            annotations: {
              "cert-manager.io/cluster-issuer": "letsencrypt-prod",
              "nginx.ingress.kubernetes.io/ssl-redirect": "true"
            },
            className: "nginx",
            enabled: true,
            hosts: [
              {
                host: this.getConfigValue("ingress.CELESTIA_HOST"),
                paths: [{ path: "/", pathType: "Prefix" }]
              }
            ],
          };
          changes.push({ key: `ingress`, newValue: JSON.stringify(productionYaml.ingress), oldValue: "undefined" });
          ingressUpdated = true;
        }

        if (ingressUpdated) {
          updated = true;
        }

        if ((!productionYaml.core || !productionYaml.core.rpc_url) && !productionYaml.core) {
            productionYaml.core = {
              rpc_url: ""
            };
          }

        const oldCoreRpcUrl = productionYaml.core.rpc_url;

        let newCoreRpcUrl = this.dogeConfig.da?.tendermintRpcUrl;
        if (!newCoreRpcUrl) {
          this.error(`Invalid tendermintRpcUrl URL: ${newCoreRpcUrl}`)
        }

        try {
          const urlObj = new URL(newCoreRpcUrl);
          newCoreRpcUrl = urlObj.hostname;
        } catch {
          this.error(`Invalid tendermintRpcUrl URL: ${newCoreRpcUrl}`);
        }

        if (oldCoreRpcUrl !== newCoreRpcUrl) {
          productionYaml.core.rpc_url = newCoreRpcUrl;
          updated = true;
          changes.push({ key: "core.rpc_url", "newValue": newCoreRpcUrl, oldValue: oldCoreRpcUrl });
        }
      } else if (chartName === 'blockbook') {
        let ingressUpdated = false;
        if (productionYaml.ingress) {
          const ingressValue = productionYaml.ingress;
          ingressValue.enabled = true;
          const configValue = this.getConfigValue('ingress.BLOCKBOOK_HOST');
          ingressUpdated = this.processIngressHosts(ingressValue, configValue, changes);
        } else {
          productionYaml.ingress = {
            annotations: {
              "cert-manager.io/cluster-issuer": "letsencrypt-prod",
              "nginx.ingress.kubernetes.io/ssl-redirect": "true"
            },
            className: "nginx",
            enabled: true,
            hosts: [
              {
                host: this.getConfigValue("ingress.BLOCKBOOK_HOST"),
                paths: [{ path: "/", pathType: "Prefix" }]
              }
            ],
          };
          changes.push({ key: `ingress`, newValue: JSON.stringify(productionYaml.ingress), oldValue: "undefined" });
          ingressUpdated = true;
        }

        if (ingressUpdated) {
          updated = true;
        }

        const oldValue = productionYaml.blockbook.blockHeight;
        const newValue = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
        if (oldValue !== newValue) {
          productionYaml.blockbook.blockHeight = this.dogeConfig.defaults?.dogecoinIndexerStartHeight;
          updated = true;
          changes.push({ key: `blockbook.blockHeight`, newValue: newValue || 'undefined', oldValue: oldValue || 'undefined' });
        }
      }

      else if (chartName === 'fee-oracle') {
        if (!productionYaml.configMaps?.env?.data) {
          this.error(`${chartName}: configMaps.env.data not found in config`);
        }

        const todoMappings = {
          "DOGEOS_FEE_ORACLE_CELESTIA__NAMESPACE_ID": this.dogeConfig.da?.daNamespace,
          "DOGEOS_FEE_ORACLE_DOGECOIN__NETWORK_STR": this.withdrawalProcessorConfig.network_str,
          "DOGEOS_FEE_ORACLE_DOGECOIN__RPC_URL": dogecoinInternalUrl,
          "DOGEOS_FEE_ORACLE_L2__CHAIN_ID": String(this.getConfigValue("general.CHAIN_ID_L2")),
          "DOGEOS_FEE_ORACLE_L2__GAS_ORACLE_CONTRACT": this.getConfigValue("contractsFile.L1_GAS_PRICE_ORACLE_ADDR"),
          "DOGEOS_FEE_ORACLE_L2__RPC_URL": this.getConfigValue("general.L2_RPC_ENDPOINT"),
        }

        for (const [envKey, newVal] of Object.entries(todoMappings)) {
          const oldValue = productionYaml.configMaps.env.data[envKey];
          if (oldValue !== newVal) {
            productionYaml.configMaps.env.data[envKey] = newVal;
            updated = true;
            changes.push({ key: `configMaps.env.data.${envKey}`, newValue: newVal, oldValue: oldValue || 'undefined' });
          }
        }
      }

      else if (chartName === 'l1-interface') {
        if (!productionYaml.configMaps?.env?.data) {
          this.error(`${chartName}: configMaps.env.data not found in config`);
        }

        const todoMappings = {
          "DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__BLOB_GET_ALL_FALLBACK_URL": new URL(this.dogeConfig.da?.tendermintRpcUrl || "").origin,
          "DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__DA_RPC_URL": this.dogeConfig.network === "mainnet" ? "" : "http://celestia-testnet-mocha:26658",
          "DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__NAMESPACE_ID": this.dogeConfig.da?.daNamespace,
          "DOGEOS_L1_INTERFACE_CELESTIA_INDEXER__START_BLOCK": this.dogeConfig.da?.celestiaIndexerStartBlock,
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__BRIDGE_ADDRESS": this.withdrawalProcessorConfig.bridge_address,
          "DOGEOS_L1_INTERFACE_DOGECOIN_INDEXER__START_HEIGHT": this.dogeConfig.defaults?.dogecoinIndexerStartHeight,
          "DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL": dogecoinInternalUrl,
          "DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER": this.getConfigValue("sequencer.L2GETH_SIGNER_ADDRESS"),
          "DOGEOS_L1_INTERFACE_L1_BASE_FEE_PER_GAS": this.getConfigValue("genesis.BASE_FEE_PER_GAS").toString(),
          "DOGEOS_L1_INTERFACE_L1_GENESIS_BLOCK": this.dogeConfig.defaults?.dogecoinIndexerStartHeight,
          "DOGEOS_L1_INTERFACE_L2_MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L2_DOGEOS_MESSENGER_PROXY_ADDR"),
          "DOGEOS_L1_INTERFACE_L2_MOAT_CONTRACT_ADDRESS": this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          "DOGEOS_L1_INTERFACE_NETWORK_STR": this.withdrawalProcessorConfig.network_str,
          "DOGEOS_L1_INTERFACE_SCROLL_CHAIN_ADDRESS": this.getConfigValue("contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR"),
          // "DOGEOS_L1_INTERFACE_SCROLL_MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L1_SCROLL_MESSENGER_PROXY_ADDR")
        }

        for (const [envKey, newVal] of Object.entries(todoMappings)) {
          const oldValue = productionYaml.configMaps.env.data[envKey];
          if (oldValue !== newVal) {
            productionYaml.configMaps.env.data[envKey] = newVal;
            updated = true;
            changes.push({ key: `configMaps.env.data.${envKey}`, newValue: newVal, oldValue: oldValue || 'undefined' });
          }
        }
      }

      else if (chartName === 'withdrawal-processor') {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const todoMappings = {
          "DOGEOS_WITHDRAWAL_BRIDGE_ADDRESS": this.withdrawalProcessorConfig.bridge_address,
          "DOGEOS_WITHDRAWAL_BRIDGE_SCRIPT_HEX": this.withdrawalProcessorConfig.bridge_script_hex,
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__BLOB_GET_ALL_FALLBACK_URL": new URL(this.dogeConfig.da?.tendermintRpcUrl || "").origin,
          // "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__TENDERMINT_RPC_URL": this.dogeConfig.da?.tendermintRpcUrl,
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_NAMESPACE": this.dogeConfig.da?.daNamespace,
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_RPC_URL": this.dogeConfig.network === "mainnet" ? "" : "http://celestia-testnet-mocha:26658",
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__SIGNER_ADDRESS": this.dogeConfig.da?.signerAddress,

          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__START_BLOCK": this.dogeConfig.da?.celestiaIndexerStartBlock,
          "DOGEOS_WITHDRAWAL_DATABASE_URL": "sqlite:///app/data/withdrawal_processor.db",
          "DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT": this.dogeConfig.defaults?.dogecoinIndexerStartHeight,
          "DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL": dogecoinInternalUrl,
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__MESSAGE_QUEUE_ADDRESS": this.getConfigValue("contractsFile.L2_MESSAGE_QUEUE_ADDR"),
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L2_DOGEOS_MESSENGER_PROXY_ADDR"),
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL": this.getConfigValue("general.L2_RPC_ENDPOINT"),
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__START_BLOCK": "0",
          "DOGEOS_WITHDRAWAL_GENESIS_SEQUENCER_TXID": this.withdrawalProcessorConfig.genesis_sequencer_txid,
          "DOGEOS_WITHDRAWAL_GENESIS_SEQUENCER_VOUT": this.withdrawalProcessorConfig.genesis_sequencer_vout,
          "DOGEOS_WITHDRAWAL_NETWORK_STR": this.withdrawalProcessorConfig.network_str,
          "DOGEOS_WITHDRAWAL_TSO_URL": "http://tso-service:3000"
        }

        for (const [envKey, newVal] of Object.entries(todoMappings)) {
          const envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newVal) {
              const oldValue = envVar.value;
              envVar.value = newVal;
              updated = true;
              changes.push({ key: `env.${envKey}`, newValue: newVal, oldValue });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newVal });
            updated = true;
            changes.push({ key: `env.${envKey}`, newValue: newVal, oldValue: 'undefined' });
          }
        }

        // Rebuild all TSO signers so stale roles do not remain.
        if (productionYaml.tsoSigners && Array.isArray(productionYaml.tsoSigners)) {
          const attestationSigners = (this.dogeConfig.cubesigner?.roles || []).map((_role, index) => ({
            network: this.dogeConfig.network,
            role: 'Attestation',
            uri: `http://cubesigner-signer-${index}:3000`,
          }) as any);
          const teeSigners = (this.dogeConfig.signerUrls || []).map((url) => ({
            network: this.dogeConfig.network,
            role: 'Tee',
            uri: url,
          }) as any);
          const newSigners = [...attestationSigners, ...teeSigners];
          const existingSigners = productionYaml.tsoSigners;
          productionYaml.tsoSigners = newSigners;
          updated = true;
          changes.push({
            key: 'tsoSigners',
            newValue: JSON.stringify(newSigners),
            oldValue: JSON.stringify(existingSigners),
          });
        }
      }

      else if (chartName === "cubesigner-signer") {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        /*
        env:
        - name: "DOGEOS_CUBESIGNER_SIGNER_PORT"
          value: "3000"
        - name: "DOGEOS_CUBESIGNER_SIGNER_NETWORK"
          value: "testnet"
        */
        const envVarName = 'DOGEOS_CUBESIGNER_SIGNER_NETWORK';
        const configValue = this.dogeConfig.network;

        // Find existing environment variable
        const envVar = productionYaml.env.find((item: any) => item.name === envVarName);

        if (envVar) {
          // Update existing value
          if (envVar.value !== configValue) {
            const oldValue = envVar.value;
            envVar.value = configValue;
            updated = true;
            changes.push({ key: `env.${envVarName}`, newValue: configValue, oldValue });
          }
        } else {
          // Add new environment variable
          productionYaml.env.push({ name: envVarName, value: configValue });
          updated = true;
          changes.push({ key: `env.${envVarName}`, newValue: configValue, oldValue: 'undefined' });
        }
      }
      else if (chartName === "da-publisher") {
        const todoMappings = {
          "DOGEOS_DA_PUBLISHER_CELESTIA_NAMESPACE": this.dogeConfig.da?.daNamespace,
          // TODO what if mainnet ?
          "DOGEOS_DA_PUBLISHER_CELESTIA_RPC_URL": this.dogeConfig.network === "mainnet" ? "" : "celestia-testnet-mocha:26658"
        }
       
        const envData = productionYaml.configMaps.env.data;
        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          if (Object.hasOwn(envData, envKey)) {
            if (envData[envKey] !== newValue) {
              const oldValue = envData[envKey];
              envData[envKey] = newValue;
              updated = true;
              changes.push({ key: `configMaps.env.data.${envKey}`, newValue: String(newValue), oldValue: String(oldValue) });
            }
          } else {
            envData[envKey] = newValue;
            updated = true;
            changes.push({ key: `configMaps.env.data.${envKey}`, newValue: String(newValue), oldValue: 'undefined' });
          }
        }
      }
      else if (chartName === "tso-service") {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const todoMappings = {
          "DOGE_NETWORK": this.dogeConfig.network
        }

        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          const envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newValue) {
              const oldValue = envVar.value;
              envVar.value = newValue;
              updated = true;
              changes.push({ key: `env.${envKey}`, newValue, oldValue });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newValue });
            updated = true;
            changes.push({ key: `env.${envKey}`, newValue, oldValue: 'undefined' });
          }
        }
      }
      else if (chartName === "metrics-exporter") {

        const rollupExplorerBackendUrl = "http://rollup-explorer-backend";
        const l2RpcEndpoint = this.getConfigValue("general.L2_RPC_ENDPOINT");
        const l2TxFeeVaultAddr = this.getConfigValue("contracts.overrides.L2_TX_FEE_VAULT");
        const l2BridgeFeeRecipientAddr = this.getConfigValue("contracts.L2_BRIDGE_FEE_RECIPIENT_ADDR");
        const isDogeos = this.getConfigValue("general.L1_RPC_ENDPOINT") === "http://l1-interface:8545";
        const l1MessageQueueProxyAddr = isDogeos ? "" : this.getConfigValue("contractsFile.L1_MESSAGE_QUEUE_V2_PROXY_ADDR");
        const l1RpcEndpoint = this.getConfigValue("general.L1_RPC_ENDPOINT");

        if (productionYaml.metricsConfig) {
          if (productionYaml.metricsConfig.rollup.url !== rollupExplorerBackendUrl) {
            updated = true;
            changes.push({
              key: `metricsConfig.rollup.url`, newValue: rollupExplorerBackendUrl,
              oldValue: productionYaml.metricsConfig.rollup.url
            });
            productionYaml.metricsConfig.rollup.url = rollupExplorerBackendUrl;
          }

          if (productionYaml.metricsConfig.l1Network.url !== l1RpcEndpoint) {
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.url`, newValue: l1RpcEndpoint,
              oldValue: productionYaml.metricsConfig.l1Network.url
            });
            productionYaml.metricsConfig.l1Network.url = l1RpcEndpoint;
          }

          if (productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR !== l1MessageQueueProxyAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR`, newValue: l1MessageQueueProxyAddr,
              oldValue: productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR
            });
            productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR = l1MessageQueueProxyAddr;
          }

          if (productionYaml.metricsConfig.dogecoin.url !== dogecoinInternalUrl) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogecoin.url`, newValue: dogecoinInternalUrl,
              oldValue: productionYaml.metricsConfig.dogecoin.url
            });
            productionYaml.metricsConfig.dogecoin.url = dogecoinInternalUrl;
          }

          if (productionYaml.metricsConfig.dogeos.url !== l2RpcEndpoint) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.url`, newValue: l2RpcEndpoint,
              oldValue: productionYaml.metricsConfig.dogeos.url
            });
            productionYaml.metricsConfig.dogeos.url = l2RpcEndpoint;
          }

          if (productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR !== l2TxFeeVaultAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR`, newValue: l2TxFeeVaultAddr,
              oldValue: productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR
            });
            productionYaml.metricsConfig.dogeos.L2_TX_FEE_VAULT_ADDR = l2TxFeeVaultAddr;
          }

          if (productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR !== l2BridgeFeeRecipientAddr) {
            updated = true;
            changes.push({
              key: `metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR`, newValue: l2BridgeFeeRecipientAddr,
              oldValue: productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR
            });
            productionYaml.metricsConfig.dogeos.L2_BRIDGE_FEE_RECIPIENT_ADDR = l2BridgeFeeRecipientAddr;
          }
        } else {
          productionYaml.metricsConfig = {
            dogecoin: {
              url: dogecoinInternalUrl
            },
            dogeos: {
              L2_BRIDGE_FEE_RECIPIENT_ADDR: l2BridgeFeeRecipientAddr,
              L2_TX_FEE_VAULT_ADDR: l2TxFeeVaultAddr,
              url: this.getConfigValue("general.L2_RPC_ENDPOINT")
            },
            l1Network: {
              L1_MESSAGE_QUEUE_PROXY_ADDR: l1MessageQueueProxyAddr,
              url: l1RpcEndpoint
            },
            rollup: {
              url: rollupExplorerBackendUrl
            }
          };
          updated = true;
          changes.push({
            key: `metricsConfig`, newValue: JSON.stringify(productionYaml.metricsConfig),
            oldValue: "undefined"
          });
        }
      }
      else if (chartName === "dogecoin") {
        const isTestnet = this.dogeConfig.network === "testnet";

        const dogecoinConf_testnet = productionYaml.dogecoinConf?.testnet;
        const expected_testnet = isTestnet ? 1 : 0;
        if (dogecoinConf_testnet !== expected_testnet) {
          productionYaml.dogecoinConf.testnet = expected_testnet;
          updated = true;
          changes.push({ key: `dogecoinConf.testnet`, newValue: String(expected_testnet), oldValue: String(dogecoinConf_testnet) });
        }

        const service_port = productionYaml.service?.port;
        const expected_service_port = isTestnet ? 44_556 : 22_556;
        if (service_port !== expected_service_port) {
          productionYaml.service.port = expected_service_port;
          updated = true;
          changes.push({ key: `service.port`, newValue: String(expected_service_port), oldValue: String(service_port) });
        }

        const service_rpcPort = productionYaml.service?.rpcPort;
        const expected_service_rpcPort = isTestnet ? 44_555 : 22_555;
        if (service_rpcPort !== expected_service_rpcPort) {
          productionYaml.service.rpcPort = expected_service_rpcPort;
          updated = true;
          changes.push({ key: `service.rpcPort`, newValue: String(expected_service_rpcPort), oldValue: String(service_rpcPort) });
        }

        const storage_size = productionYaml.storage?.size;
        const expected_storage_size = isTestnet ? "50Gi" : "250Gi";
        if (storage_size !== expected_storage_size) {
          productionYaml.storage.size = expected_storage_size;
          updated = true;
          changes.push({ key: `storage.size`, newValue: String(expected_storage_size), oldValue: String(storage_size) });
        }

        // let rpcPassword = productionYaml.rpcPassword;
        // let expectedRpcPassword = this.dogeConfig.dogecoinClusterRpc?.password;
        // if (rpcPassword !== expectedRpcPassword) {
        //   productionYaml.rpcPassword = expectedRpcPassword;
        //   updated = true;
        //   changes.push({ key: `rpcPassword`, oldValue: String(rpcPassword), newValue: String(expectedRpcPassword) });
        // }

        const rpcUser = productionYaml.dogecoinConf?.rpcuser;
        const expectedRpcUser = this.dogeConfig.dogecoinClusterRpc?.username;
        if (rpcUser !== expectedRpcUser) {
          productionYaml.dogecoinConf.rpcuser = expectedRpcUser;
          updated = true;
          changes.push({ key: `dogecoinConf.rpcuser`, newValue: String(expectedRpcUser), oldValue: String(rpcUser) });
        }

        // Process dogecoin ingress (similar to celestia)
        let ingressUpdated = false;
        if (productionYaml.ingress) {
          const configValue = this.getConfigValue('ingress.DOGECOIN_HOST');
          ingressUpdated = this.processIngressHosts(productionYaml.ingress, configValue, changes);
        }

        if (ingressUpdated) {
          updated = true;
        }
      }
      else if (chartName === "testnet-activity-helper") {
        const l2RpcEndpoint = this.getConfigValue("general.L2_RPC_ENDPOINT");
        if (productionYaml.config?.externalRpcUriL2 !== l2RpcEndpoint) {
          productionYaml.config.externalRpcUriL2 = l2RpcEndpoint;
          updated = true;
          changes.push({ key: `config.externalRpcUriL2`, newValue: l2RpcEndpoint, oldValue: productionYaml.config?.externalRpcUriL2 });
        }
      }

      if (updated) {
        if (!this.jsonMode) {
          this.log(`\nFor ${chalk.cyan(file)}:`)
          this.log(chalk.green('Changes:'))
          for (const change of changes) {
            this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`)
          }
        }

        let shouldUpdate = this.nonInteractive
        if (!this.nonInteractive) {
          shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` })
        }

        if (shouldUpdate) {
          const yamlString = yaml.dump(productionYaml, YAML_DUMP_OPTIONS)

          fs.writeFileSync(yamlPath, yamlString)
          this.jsonCtx.logSuccess(`Updated ${file}`)
          updatedCharts++
        } else {
          this.jsonCtx.info(`Skipped updating ${file}`)
          skippedCharts++
        }
      } else {
        this.jsonCtx.info(`No changes needed in ${file}`)
        skippedCharts++
      }
    }


    return { skipped: skippedCharts, updated: updatedCharts }
  }


  private async validateMakefile(skipAuthCheck: boolean): Promise<void> {
    this.log(chalk.blue('Validating Makefile...'))
    const makefilePath = path.join(process.cwd(), 'Makefile')
    if (!fs.existsSync(makefilePath)) {
      this.error('Makefile not found in the current directory.')
    }

    const makefileContent = fs.readFileSync(makefilePath, 'utf8')
    const installCommands = makefileContent.match(/helm\s+upgrade\s+-i.*?(?=\n\n|Z)/gs)

    if (!installCommands) {
      this.warn('No Helm upgrade commands found in the Makefile.')
      return
    }

    for (const command of installCommands) {
      const chartNameMatch = command.match(/upgrade\s+-i\s+(\S+)/)
      const ociMatch = command.match(/oci:\/\/(\S+)/)
      const ociVersionMatch = command.match(/--version\s*=\s*(\S+)\s+/);

      if (chartNameMatch && ociMatch) {
        const chartName = chartNameMatch[1]
        const ociUrl = ociMatch[0]
        const ociVersion = ociVersionMatch && ociVersionMatch.length > 1 ? ociVersionMatch[1] : "";

        if (!skipAuthCheck) {
          const hasAccess = this.validateOCIAccess(ociUrl, ociVersion)

          if (hasAccess) {
            this.log(chalk.green(`Access verified for chart: ${chartName}`))
          } else {
            this.log(chalk.red(`Unable to access chart: ${chartName}`))
            this.log('This might be due to authentication issues.')
            this.log('To authenticate, run the command with the following flags:')
            this.log('--github-username=your-username --github-token=your-personal-access-token')
            this.log('You can create a Personal Access Token at: https://github.com/settings/tokens')
            this.log('Ensure the token has the necessary permissions to access the required repositories.')
          }
        }

        const valuesFileMatches = command.match(/-f\s+(\S+)/g)
        if (valuesFileMatches) {
          for (const match of valuesFileMatches) {
            const valuesFile = match.split(' ')[1]
            if (fs.existsSync(valuesFile)) {
              this.log(chalk.green(`Values file verified: ${valuesFile}`))
            } else {
              this.log(chalk.red(`Values file not found: ${valuesFile}`))
            }
          }
        }
      }
    }
  }

  private validateOCIAccess(ociUrl: string, ociVersion: string): boolean {
    try {
      const args = ['show', 'chart', ociUrl]
      if (ociVersion) {
        args.push('--version', ociVersion)
      }

      execFileSync('helm', args, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
}
