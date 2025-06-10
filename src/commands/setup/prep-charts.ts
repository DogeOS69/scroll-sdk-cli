import { Command, Flags } from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import { ChildProcess, exec } from 'child_process'
import { promisify } from 'util'
import * as yaml from 'js-yaml'
import * as toml from '@iarna/toml'
import { confirm, input, select } from '@inquirer/prompts'
import chalk from 'chalk'
import type { DogeConfig } from '../../types/doge-config.js'
import { YAML_DUMP_OPTIONS } from '../../config/constants.js'
import { DogeConfig as DogeConfigType } from '../../types/doge-config.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'

const execAsync = promisify(exec)

export default class SetupPrepCharts extends Command {
  static override description = 'Validate Makefile and prepare Helm charts for Scroll SDK'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --github-username=your-username --github-token=your-token',
    '<%= config.bin %> <%= command.id %> --values-dir=./custom-values',
    '<%= config.bin %> <%= command.id %> --skip-auth-check',
  ]

  static override flags = {
    'github-username': Flags.string({ description: 'GitHub username', required: false }),
    'github-token': Flags.string({ description: 'GitHub Personal Access Token', required: false }),
    'values-dir': Flags.string({ description: 'Directory containing values files', default: './values' }),
    'skip-auth-check': Flags.boolean({ description: 'Skip authentication check for individual charts', default: false }),
    'doge-config': Flags.string({ description: 'Path to config file (e.g., .data/doge-config-mainnet.toml or .data/doge-config-testnet.toml)' })
  }

  private configMapping: Record<string, string | ((chartName: string, productionNumber: string) => string)> = {
    'SCROLL_L1_RPC': 'general.L1_RPC_ENDPOINT',
    'SCROLL_L2_RPC': 'general.L2_RPC_ENDPOINT',
    'CHAIN_ID': 'general.CHAIN_ID_L2',
    'CHAIN_ID_L1': 'general.CHAIN_ID_L1',
    'CHAIN_ID_L2': 'general.CHAIN_ID_L2',
    'L2GETH_L1_ENDPOINT': 'general.L1_RPC_ENDPOINT',
    'L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK': 'general.L1_CONTRACT_DEPLOYMENT_BLOCK',
    'L1_RPC_ENDPOINT': 'general.L1_RPC_ENDPOINT',
    'L2_RPC_ENDPOINT': 'general.L2_RPC_ENDPOINT',
    'L1_SCROLL_CHAIN_PROXY_ADDR': 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR',
    'L2GETH_SIGNER_ADDRESS': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_SIGNER_ADDRESS' : `sequencer.sequencer-${productionNumber}.L2GETH_SIGNER_ADDRESS`,
    'L2GETH_PEER_LIST': 'sequencer.L2_GETH_STATIC_PEERS',
    'L2GETH_KEYSTORE': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_KEYSTORE' : `sequencer.sequencer-${productionNumber}.L2GETH_KEYSTORE`,
    'L2GETH_PASSWORD': (chartName, productionNumber) =>
      productionNumber === '0' ? 'sequencer.L2GETH_PASSWORD' : `sequencer.sequencer-${productionNumber}.L2GETH_PASSWORD`,
    'L2GETH_NODEKEY': (chartName, productionNumber) =>
      chartName.startsWith('l2-bootnode') ? `bootnode.bootnode-${productionNumber}.L2GETH_NODEKEY` :
        (productionNumber === '0' ? 'sequencer.L2GETH_NODEKEY' : `sequencer.sequencer-${productionNumber}.L2GETH_NODEKEY`),
    // Add ingress host mappings
    'FRONTEND_HOST': 'ingress.FRONTEND_HOST',
    'BRIDGE_HISTORY_API_HOST': 'ingress.BRIDGE_HISTORY_API_HOST',
    'ROLLUP_EXPLORER_API_HOST': 'ingress.ROLLUP_EXPLORER_API_HOST',
    'COORDINATOR_API_HOST': 'ingress.COORDINATOR_API_HOST',
    'RPC_GATEWAY_HOST': 'ingress.RPC_GATEWAY_HOST',
    'BLOCKSCOUT_HOST': 'ingress.BLOCKSCOUT_HOST',
    'ADMIN_SYSTEM_DASHBOARD_HOST': 'ingress.ADMIN_SYSTEM_DASHBOARD_HOST',
    'L1_DEVNET_HOST': 'ingress.L1_DEVNET_HOST',
    'L1_EXPLORER_HOST': 'ingress.L1_EXPLORER_HOST',
    'RPC_GATEWAY_WS_HOST': 'ingress.RPC_GATEWAY_WS_HOST',
    'GRAFANA_HOST': 'ingress.GRAFANA_HOST',

    // Add more mappings as needed
  }

  private configData: any = {}
  private contractsConfig: any = {}
  private dogeConfig: DogeConfig = {} as DogeConfig
  private withdrawalProcessorConfig: toml.JsonMap = {}

  // Generic ingress processing function
  private processIngressHosts(
    ingressConfig: any,
    hostConfigValue: string,
    changes: Array<{ key: string; oldValue: string; newValue: string }>,
    keyPrefix: string = 'ingress'
  ): boolean {
    let ingressUpdated = false;

    if (ingressConfig && typeof ingressConfig === 'object' && 'hosts' in ingressConfig) {
      const hosts = ingressConfig.hosts as Array<{ host: string; paths?: any[] }>;
      if (Array.isArray(hosts)) {
        for (let i = 0; i < hosts.length; i++) {
          if (typeof hosts[i] === 'object' && 'host' in hosts[i]) {
            if (hostConfigValue && hostConfigValue !== hosts[i].host) {
              changes.push({
                key: `${keyPrefix}.hosts[${i}].host`,
                oldValue: hosts[i].host,
                newValue: hostConfigValue
              });
              hosts[i].host = hostConfigValue;
              ingressUpdated = true;
            }
          }
        }
      }

      // Update TLS section if it exists and ingress was updated
      if (ingressUpdated && ingressConfig.tls) {
        const tlsEntries = ingressConfig.tls as Array<{ hosts: string[] }>;
        if (Array.isArray(tlsEntries)) {
          tlsEntries.forEach((tlsEntry) => {
            if (Array.isArray(tlsEntry.hosts)) {
              tlsEntry.hosts = hosts.map((host) => host.host);
            }
          });
        }
      }
    }

    return ingressUpdated;
  }

  private async loadConfigs(flags: any): Promise<void> {
    const configPath = path.join(process.cwd(), 'config.toml')
    const contractsConfigPath = path.join(process.cwd(), 'config-contracts.toml')

    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8')
      this.configData = toml.parse(configContent)
    } else {
      this.warn('config.toml not found. Some values may not be populated correctly.')
    }

    if (fs.existsSync(contractsConfigPath)) {
      const contractsConfigContent = fs.readFileSync(contractsConfigPath, 'utf-8')
      this.contractsConfig = toml.parse(contractsConfigContent)
    } else {
      this.warn('config-contracts.toml not found. Some values may not be populated correctly.')
    }

    const { config, configPath: resolvedPath } = await loadDogeConfigWithSelection(flags['doge-config'], 'scrollsdk doge:config')
    this.dogeConfig = config as DogeConfigType;

    return;
  }

  private getConfigValue(key: string): any {
    const [configType, ...rest] = key.split('.')
    const configKey = rest.join('.')

    if (configType === 'contractsFile') {
      return this.getNestedValue(this.contractsConfig, configKey)
    } else {
      return this.getNestedValue(this.configData, key)
    }
  }

  private async authenticateGHCR(username: string, token: string): Promise<void> {
    const command = `echo ${token} | docker login ghcr.io -u ${username} --password-stdin`
    await execAsync(command)
    this.log('Authenticated with GitHub Container Registry')
  }

  private async validateOCIAccess(ociUrl: string, ociVersion: string): Promise<boolean> {
    try {
      const versionArgument = ociVersion ? ` --version ${ociVersion}` : "";
      await execAsync(`helm show chart ${ociUrl}${versionArgument}`)
      return true
    } catch (error) {
      return false
    }
  }
  private getBaseUrl(url?: string) {
    if (!url) return url;
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname.endsWith('/api/v2')) {
        urlObj.pathname = urlObj.pathname.slice(0, -7);
      }
      return urlObj.toString();
    } catch {
      return url;
    }
  };
  private async processProductionYaml(valuesDir: string): Promise<{ updated: number; skipped: number }> {
    const productionFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-production.yaml') || file.match(/-production-\d+\.yaml$/))

    let updatedCharts = 0
    let skippedCharts = 0
    const isTestnet = this.dogeConfig.network == "testnet";
    const dogecoinInternalUrl = "http://dogecoin-" + (isTestnet ? "testnet:44555" : "mainnet:22555");

    for (const file of productionFiles) {
      const yamlPath = path.join(valuesDir, file)
      const chartName = file.replace(/-production(-\d+)?\.yaml$/, '')
      const productionNumber = file.match(/-production-(\d+)\.yaml$/)?.[1] || '0'

      this.log(`Processing ${file} for chart ${chartName}...`)

      const productionYamlContent = fs.readFileSync(yamlPath, 'utf8')
      let productionYaml = yaml.load(productionYamlContent) as any

      let updated = false
      const changes: Array<{ key: string; oldValue: string; newValue: string }> = []

      // Process configMaps
      if (productionYaml.configMaps) {
        for (const [configMapName, configMapData] of Object.entries(productionYaml.configMaps)) {
          if (configMapData && typeof configMapData === 'object' && 'data' in configMapData) {
            const envData = (configMapData as any).data
            for (const [key, value] of Object.entries(envData)) {
              const configPathOrResolver = this.configMapping[key]
              if (configPathOrResolver) {
                let configKey: string
                if (typeof configPathOrResolver === 'function') {
                  configKey = configPathOrResolver(chartName, productionNumber)
                } else {
                  configKey = configPathOrResolver
                }
                if (chartName === "l1-devnet" && key === "CHAIN_ID") {
                  configKey = "general.CHAIN_ID_L1";
                }

                const configValue = this.getConfigValue(configKey)
                if (configValue !== undefined && configValue !== null) {
                  let newValue: string | string[]
                  if (Array.isArray(configValue)) {
                    newValue = JSON.stringify(configValue)
                  } else {
                    newValue = String(configValue)
                  }
                  if (newValue != value) {
                    changes.push({ key, oldValue: JSON.stringify(value), newValue: newValue })
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
              for (let i = 0; i < hosts.length; i++) {
                if (typeof hosts[i] === 'object' && 'host' in hosts[i]) {
                  let configValue: string | undefined;

                  if (chartName === 'l2-rpc' && ingressKey === 'websocket') {
                    configValue = this.getConfigValue('ingress.RPC_GATEWAY_WS_HOST');
                  } else {
                    // Check for direct mapping first
                    const directMappingKey = `ingress.${chartName.toUpperCase().replace(/-/g, '_')}_HOST`;
                    configValue = this.getConfigValue(directMappingKey);
                    this.log(chalk.yellow(`${chartName}: ${directMappingKey} -> ${configValue}`));

                    // If direct mapping doesn't exist, try alternative mappings
                    if (!configValue) {
                      const alternativeMappings: Record<string, string> = {
                        'frontends': 'FRONTEND_HOST',
                        'bridge-history-api': 'BRIDGE_HISTORY_API_HOST',
                        'rollup-explorer-backend': 'ROLLUP_EXPLORER_API_HOST',
                        'coordinator-api': 'COORDINATOR_API_HOST',
                        'l2-rpc': 'RPC_GATEWAY_HOST',
                        'l1-devnet': 'L1_DEVNET_HOST',
                        'blockscout': 'BLOCKSCOUT_HOST',
                        'admin-system-dashboard': 'ADMIN_SYSTEM_DASHBOARD_HOST',
                        'tso-service': 'TSO_HOST',
                        'celestia-node': 'CELESTIA_HOST',
                        'dogecoin': 'DOGECOIN_HOST',
                      };

                      const alternativeKey = alternativeMappings[chartName];
                      if (alternativeKey) {
                        configValue = this.getConfigValue(`ingress.${alternativeKey}`);
                      } else {
                        this.error(`${chartName}: ${alternativeKey} not found in config`);
                      }
                    }
                  }

                  if (configValue && configValue !== hosts[i].host) {
                    changes.push({ key: `ingress.${ingressKey}.hosts[${i}].host`, oldValue: hosts[i].host, newValue: configValue });
                    hosts[i].host = configValue;
                    ingressUpdated = true;
                  }
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          for (const [ingressKey, ingressValue] of Object.entries(productionYaml.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                tlsEntries.forEach((tlsEntry) => {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                });
              }
            }
          }
        }
      }

      if (productionYaml["blockscout-stack"]) {
        let ingressUpdated = false;
        const blockscout = productionYaml["blockscout-stack"].blockscout;
        const frontend = productionYaml["blockscout-stack"].frontend;
        let blockscout_host = this.getConfigValue("ingress.BLOCKSCOUT_HOST");
        let blockscout_url = this.getConfigValue("frontend.EXTERNAL_EXPLORER_URI_L2");

        if (blockscout?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `ingress.blockscout.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, oldValue, newValue: blockscout_url });
            blockscout.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }

        if (blockscout?.ingress?.hostname) {
          const oldValue = blockscout.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `ingress.blockscout.hostname`, oldValue, newValue: blockscout_host });
            blockscout.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        //only enable tls if use command scrollsdk setup tls
        if (blockscout?.ingress?.tls?.enabled) {
          if (blockscout.ingress.tls.enabled !== false) {
            const oldValue = blockscout.ingress.tls.enabled;
            blockscout.ingress.tls.enabled = false; // Ensure it's boolean false
            changes.push({ key: `ingress.blockscout.tls.enabled`, oldValue: String(oldValue), newValue: "false" });
            ingressUpdated = true;
          }
        }

        if (frontend?.env?.NEXT_PUBLIC_API_HOST) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_HOST;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.env.NEXT_PUBLIC_API_HOST`, oldValue, newValue: blockscout_host });
            frontend.env.NEXT_PUBLIC_API_HOST = blockscout_host;
            ingressUpdated = true;
          }
        }

        let protocol = blockscout_url.startsWith("https") ? "https" : "http";
        if (frontend?.env?.NEXT_PUBLIC_API_PROTOCOL) {
          const oldValue = frontend.env.NEXT_PUBLIC_API_PROTOCOL;
          if (oldValue !== protocol) {
            changes.push({
              key: `frontend.env.NEXT_PUBLIC_API_PROTOCOL`,
              oldValue,
              newValue: protocol
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
              oldValue,
              newValue: protocol
            });
            frontend.env.NEXT_PUBLIC_APP_PROTOCOL = protocol;
            ingressUpdated = true;
          }
        }

        if (frontend?.ingress?.annotations?.["nginx.ingress.kubernetes.io/cors-allow-origin"]) {
          const oldValue = frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"];
          if (oldValue !== blockscout_url) {
            changes.push({ key: `frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"]`, oldValue, newValue: blockscout_url });
            frontend.ingress.annotations["nginx.ingress.kubernetes.io/cors-allow-origin"] = blockscout_url;
            ingressUpdated = true;
          }
        }
        if (frontend?.ingress?.hostname) {
          const oldValue = frontend.ingress.hostname;
          if (oldValue !== blockscout_host) {
            changes.push({ key: `frontend.ingress.hostname`, oldValue, newValue: blockscout_host });
            frontend.ingress.hostname = blockscout_host;
            ingressUpdated = true;
          }
        }

        //only enable tls if use command scrollsdk setup tls
        if (frontend?.ingress?.tls?.enabled) {
          if (frontend.ingress.tls.enabled !== false) {
            const oldValue = frontend.ingress.tls.enabled;
            changes.push({ key: `frontend.ingress.tls.enabled`, oldValue: String(oldValue), newValue: "false" });
            frontend.ingress.tls.enabled = false;
            ingressUpdated = true;
          }
        }

        interface BlockscoutEnvMapping {
          key: string;
          configKey: string;
          defaultValue?: string;
        }

        const BLOCKSCOUT_ENV_MAPPINGS: BlockscoutEnvMapping[] = [
          {
            key: 'INDEXER_SCROLL_L1_BATCH_START_BLOCK',
            configKey: '',
            defaultValue: '0'
          },
          {
            key: 'INDEXER_SCROLL_L1_MESSENGER_START_BLOCK',
            configKey: '',
            defaultValue: '0'
          },
          {
            key: 'INDEXER_SCROLL_L1_CHAIN_CONTRACT',
            configKey: 'contractsFile.L1_SCROLL_CHAIN_PROXY_ADDR'
          },
          {
            key: 'INDEXER_SCROLL_L1_MESSENGER_CONTRACT',
            configKey: 'L1_SCROLL_MESSENGER_PROXY_ADDR'
          },
          {
            key: 'INDEXER_SCROLL_L2_MESSENGER_CONTRACT',
            configKey: 'L2_DOGEOS_MESSENGER_PROXY_ADDR'
          },
          {
            key: 'INDEXER_SCROLL_L2_GAS_ORACLE_CONTRACT',
            configKey: 'L1_GAS_PRICE_ORACLE_ADDR'
          },
          {
            key: 'INDEXER_SCROLL_L1_RPC',
            configKey: 'general.L1_RPC_ENDPOINT'
          }


        ];
        const benv = productionYaml["blockscout-stack"].blockscout.env;

        BLOCKSCOUT_ENV_MAPPINGS.forEach(mapping => {
          const { key, configKey, defaultValue } = mapping;

          let newValue = this.getConfigValue(configKey);
          if (!newValue) {
            newValue = configKey ? this.contractsConfig[configKey] : defaultValue;
          }

          let oldValue = benv[key];

          if (newValue !== oldValue) {
            changes.push({
              key: `blockscout.env.${key}`,
              oldValue: benv[key],
              newValue: newValue
            });
            benv[key] = newValue;
            updated = true;
          } else {
            this.log(chalk.yellow(`No value found for ${key}`));
          }
        });
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

        let existingDomain = productionYaml.grafana?.["grafana.ini"]?.server?.domain ?? null;
        let existingRootUrl = productionYaml.grafana?.["grafana.ini"]?.server?.root_url ?? null;

        let newDomain = this.getConfigValue("ingress.GRAFANA_HOST");
        if (existingDomain != newDomain) {
          changes.push({ key: `grafana["grafana.ini"].server.domain`, oldValue: existingDomain, newValue: newDomain });
          productionYaml.grafana["grafana.ini"].server.domain = newDomain;
          updated = true;
        }

        let newRootUrl = this.getConfigValue("frontend.GRAFANA_URI");
        if (existingRootUrl != newRootUrl) {
          changes.push({ key: `grafana["grafana.ini"].server.root_url`, oldValue: existingRootUrl, newValue: newRootUrl });
          productionYaml.grafana["grafana.ini"].server.root_url = newRootUrl;
          updated = true;
        }



        let ingressUpdated = false;
        let ingressValue = productionYaml.grafana.ingress;
        if (ingressValue && typeof ingressValue === 'object' && 'hosts' in ingressValue) {
          const hosts = ingressValue.hosts as Array<string>;
          if (Array.isArray(hosts)) {
            for (let i = 0; i < hosts.length; i++) {
              if (typeof (hosts[i]) === 'string') {
                let configValue: string | undefined;
                configValue = this.getConfigValue("ingress.GRAFANA_HOST");

                if (configValue && (configValue !== hosts[i])) {
                  changes.push({ key: `ingress.hosts[${i}]`, oldValue: hosts[i], newValue: configValue });
                  hosts[i] = configValue;
                  ingressUpdated = true;
                }
              }
            }
          }
        }

        if (ingressUpdated) {
          updated = true;
          // Update the tls section if it exists
          for (const [ingressKey, ingressValue] of Object.entries(productionYaml.grafana.ingress)) {
            if (ingressValue && typeof ingressValue === 'object' && 'tls' in ingressValue && 'hosts' in ingressValue) {
              const tlsEntries = ingressValue.tls as Array<{ hosts: string[] }>;
              const hosts = ingressValue.hosts as Array<{ host: string }>;
              if (Array.isArray(tlsEntries) && Array.isArray(hosts)) {
                tlsEntries.forEach((tlsEntry) => {
                  if (Array.isArray(tlsEntry.hosts)) {
                    tlsEntry.hosts = hosts.map((host) => host.host);
                  }
                });
              }
            }
          }
        }
      }

      if (chartName == "celestia-node") {
        let ingressUpdated = false;
        if (!productionYaml.ingress) {
          productionYaml.ingress = {
            enabled: true,
            className: "nginx",
            annotations: {
              "cert-manager.io/cluster-issuer": "letsencrypt-prod",
              "nginx.ingress.kubernetes.io/ssl-redirect": "true"
            },
            hosts: [
              {
                host: this.getConfigValue("ingress.CELESTIA_HOST"),
                paths: [{ path: "/", pathType: "Prefix" }]
              }
            ],
          };
          changes.push({ key: `ingress`, oldValue: "undefined", newValue: JSON.stringify(productionYaml.ingress) });
          ingressUpdated = true;
        } else {
          let ingressValue = productionYaml.ingress;
          ingressValue.enabled = true;
          const configValue = this.getConfigValue('ingress.CELESTIA_HOST');
          ingressUpdated = this.processIngressHosts(ingressValue, configValue, changes);
        }

        if (ingressUpdated) {
          updated = true;
        }
      }

      else if (chartName == 'withdrawal-processor') {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }

        const todoMappings = {
          "DOGEOS_WITHDRAWAL_DATABASE_URL": "sqlite:///app/data/withdrawal_processor.db",
          "DOGEOS_WITHDRAWAL_NETWORK_STR": this.withdrawalProcessorConfig["network_str"],
          "DOGEOS_WITHDRAWAL_BRIDGE_ADDRESS": this.withdrawalProcessorConfig["bridge_address"],
          "DOGEOS_WITHDRAWAL_BRIDGE_SCRIPT_HEX": this.withdrawalProcessorConfig["bridge_script_hex"],
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__MESSENGER_ADDRESS": this.getConfigValue("contractsFile.L2_DOGEOS_MESSENGER_PROXY_ADDR"),
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__MESSAGE_QUEUE_ADDRESS": this.getConfigValue("contractsFile.L2_MESSAGE_QUEUE_ADDR"),

          "DOGEOS_WITHDRAWAL_DOGECOIN_RPC_URL": dogecoinInternalUrl,
          "DOGEOS_WITHDRAWAL_BLOCKBOOK_URL": this.getBaseUrl(this.dogeConfig.rpc?.blockbookAPIUrl),
          "DOGEOS_WITHDRAWAL_TSO_URL": "http://tso-service:3000",
          "DOGEOS_WITHDRAWAL_DOGECOIN_INDEXER__START_HEIGHT": this.dogeConfig.defaults?.dogecoinIndexerStartHeight,
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__START_BLOCK": "0",
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__START_BLOCK": this.dogeConfig.da?.celestiaIndexerStartBlock,
          "DOGEOS_WITHDRAWAL_DOGEOS_INDEXER__RPC_URL": this.getConfigValue("general.L2_RPC_ENDPOINT"),
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_RPC_URL": this.dogeConfig.network == "mainnet" ? "" : "http://celestia-testnet-mocha:26658",
          // "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__TENDERMINT_RPC_URL": this.dogeConfig.da?.tendermintRpcUrl,
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__DA_NAMESPACE": this.dogeConfig.da?.daNamespace,
          "DOGEOS_WITHDRAWAL_CELESTIA_INDEXER__SIGNER_ADDRESS": this.dogeConfig.da?.signerAddress,
          "DOGEOS_WITHDRAWAL_GENESIS_SEQUENCER_VOUT": this.withdrawalProcessorConfig["genesis_sequencer_vout"],
          "DOGEOS_WITHDRAWAL_GENESIS_SEQUENCER_TXID": this.withdrawalProcessorConfig['genesis_sequencer_txid']
        }

        for (const [envKey, newVal] of Object.entries(todoMappings)) {
          let envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newVal) {
              const oldValue = envVar.value;
              envVar.value = newVal;
              updated = true;
              changes.push({ key: `env.${envKey}`, oldValue, newValue: newVal });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newVal });
            updated = true;
            changes.push({ key: `env.${envKey}`, oldValue: 'undefined', newValue: newVal });
          }
        }

        // Replace TSO signer URIs based on signerUrls array, ensuring only 'Correctness' roles are updated sequentially
        if (productionYaml.tsoSigners && Array.isArray(productionYaml.tsoSigners)) {
          const signerUrls = this.dogeConfig.signerUrls || [];

          // extract existing Correctness signer URIs
          const existingCorrectnessIdx: number[] = [];
          const existingUris: string[] = [];
          productionYaml.tsoSigners.forEach((s: any, idx: number) => {
            if (s.role === 'Correctness') {
              existingCorrectnessIdx.push(idx);
              existingUris.push(s.uri);
            }
          });

          const isSame = existingUris.length === signerUrls.length && existingUris.every((u, idx) => u === signerUrls[idx]);

          if (!isSame) {
            // 1) remove all existing Correctness signers
            for (let j = existingCorrectnessIdx.length - 1; j >= 0; j--) {
              const idx = existingCorrectnessIdx[j];
              const removed = productionYaml.tsoSigners.splice(idx, 1)[0];
              updated = true;
              changes.push({ key: `tsoSigners[${idx}]`, oldValue: JSON.stringify(removed), newValue: 'removed' });
            }

            // 2) re-insert Correctness signers based on signerUrls
            signerUrls.forEach((url) => {
              const newSigner = { role: 'Correctness', uri: url, network: this.dogeConfig.network } as any;
              productionYaml.tsoSigners.push(newSigner);
              updated = true;
              const newIndex = productionYaml.tsoSigners.length - 1;
              changes.push({ key: `tsoSigners[${newIndex}]`, oldValue: 'undefined', newValue: JSON.stringify(newSigner) });
            });
          }

          // 3) sync network field for all signers
          for (let i = 0; i < productionYaml.tsoSigners.length; i++) {
            const signer = productionYaml.tsoSigners[i];
            if (signer.network !== this.dogeConfig.network) {
              const oldVal = signer.network;
              signer.network = this.dogeConfig.network;
              updated = true;
              changes.push({ key: `tsoSigners[${i}].network`, oldValue: oldVal, newValue: this.dogeConfig.network });
            }
          }
        }
      }

      else if (chartName == "cubesigner-signer") {
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
        let envVar = productionYaml.env.find((item: any) => item.name === envVarName);

        if (envVar) {
          // Update existing value
          if (envVar.value !== configValue) {
            const oldValue = envVar.value;
            envVar.value = configValue;
            updated = true;
            changes.push({ key: `env.${envVarName}`, oldValue, newValue: configValue });
          }
        } else {
          // Add new environment variable
          productionYaml.env.push({ name: envVarName, value: configValue });
          updated = true;
          changes.push({ key: `env.${envVarName}`, oldValue: 'undefined', newValue: configValue });
        }
      }
      else if (chartName == "dogeos-da") {
        const todoMappings = {
          //TODO what if mainnet ?
          "CELESTIA_URL": this.dogeConfig.network == "mainnet" ? "" : "celestia-testnet-mocha:26658",

          "CELESTIA_NAMESPACE": this.dogeConfig.da?.daNamespace
        }

        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          let envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newValue) {
              const oldValue = envVar.value;
              envVar.value = newValue;
              updated = true;
              changes.push({ key: `env.${envKey}`, oldValue: String(oldValue), newValue: String(newValue) });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newValue });
            updated = true;
            changes.push({ key: `env.${envKey}`, oldValue: 'undefined', newValue: String(newValue) });
          }
        }
      }
      else if (chartName == "dogeos-deposit-processor") {
        // Check and ensure configMaps.env.data exists
        if (!productionYaml.configMaps?.env?.data) {
          this.warn(`${chartName}: configMaps.env.data not found, skipping configuration update`);
          continue;
        }
        const depositProcessorMappings = {
          //'DOGEOS_DEPOSIT_PROCESSOR_NOWNODES_API_KEY': this.dogeConfig.rpc?.apiKey, //TODO this is a secret
          'DOGEOS_DEPOSIT_PROCESSOR_DOGE_RPC_URL': this.getBaseUrl(this.dogeConfig.rpc?.blockbookAPIUrl),
          'DOGEOS_DEPOSIT_PROCESSOR_DEPOSIT_DOGE_ADDRESS': this.withdrawalProcessorConfig["bridge_address"],
          'DOGEOS_DEPOSIT_PROCESSOR_MOAT_ADDRESS': this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          'DOGEOS_DEPOSIT_PROCESSOR_ANVIL_RPC_URL': this.getConfigValue("general.L1_RPC_ENDPOINT"),
          'DOGEOS_DEPOSIT_PROCESSOR_L1_MESSENGER_ADDRESS': this.getConfigValue("contractsFile.L1_SCROLL_MESSENGER_PROXY_ADDR")
        };

        for (const [envKey, newValue] of Object.entries(depositProcessorMappings)) {
          if (newValue !== undefined && productionYaml.configMaps.env.data[envKey] !== newValue) {
            const oldValue = productionYaml.configMaps.env.data[envKey];
            productionYaml.configMaps.env.data[envKey] = newValue;
            updated = true;
            changes.push({ key: `configMaps.env.data["${envKey}"]`, oldValue, newValue });
          }
        }
      }
      else if (chartName == "tso-service") {
        if (!productionYaml.env) {
          this.error(`${chartName}: env not found in config`);
        }
        const todoMappings = {
          "DOGE_NETWORK": this.dogeConfig.network
        }

        for (const [envKey, newValue] of Object.entries(todoMappings)) {
          let envVar = productionYaml.env.find((item: any) => item.name === envKey);
          if (envVar) {
            if (envVar.value !== newValue) {
              const oldValue = envVar.value;
              envVar.value = newValue;
              updated = true;
              changes.push({ key: `env.${envKey}`, oldValue, newValue });
            }
          } else {
            productionYaml.env.push({ name: envKey, value: newValue });
            updated = true;
            changes.push({ key: `env.${envKey}`, oldValue: 'undefined', newValue });
          }
        }
      }
      else if (chartName == "metrics-exporter") {

        const l1MessageQueueProxyAddr = this.getConfigValue("contractsFile.L1_MESSAGE_QUEUE_V2_PROXY_ADDR");
        const expected_basicAuth = this.dogeConfig.dogecoinClusterRpc?.password ? Buffer.from(this.dogeConfig.dogecoinClusterRpc?.username + ":" + this.dogeConfig.dogecoinClusterRpc?.password).toString('base64') : "";
        if (!productionYaml.metricsConfig) {
          productionYaml.metricsConfig = {
            l1Network: {
              url: this.getConfigValue("general.L1_RPC_ENDPOINT"),
              L1_MESSAGE_QUEUE_PROXY_ADDR: l1MessageQueueProxyAddr
            },
            dogecoin: {
              url: dogecoinInternalUrl
            }
          };
          updated = true;
          changes.push({
            key: `metricsConfig`, oldValue: "undefined",
            newValue: JSON.stringify(productionYaml.metricsConfig)
          });
        } else {
          if (productionYaml.metricsConfig.l1Network.url != this.getConfigValue("general.L1_RPC_ENDPOINT")) {
            productionYaml.metricsConfig.l1Network.url = this.getConfigValue("general.L1_RPC_ENDPOINT");
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.url`, oldValue: productionYaml.metricsConfig.l1Network.url,
              newValue: this.getConfigValue("general.L1_RPC_ENDPOINT")
            });
          }
          if (productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR != l1MessageQueueProxyAddr) {
            productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR = l1MessageQueueProxyAddr;
            updated = true;
            changes.push({
              key: `metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR`, oldValue: productionYaml.metricsConfig.l1Network.L1_MESSAGE_QUEUE_PROXY_ADDR,
              newValue: l1MessageQueueProxyAddr
            });
          }
          if (productionYaml.metricsConfig.dogecoin.url != dogecoinInternalUrl) {
            productionYaml.metricsConfig.dogecoin.url = dogecoinInternalUrl;
            updated = true;
            changes.push({
              key: `metricsConfig.dogecoin.url`, oldValue: productionYaml.metricsConfig.dogecoin.url,
              newValue: dogecoinInternalUrl
            });
          }
        }
      }
      else if (chartName == "dogecoin") {
        const isTestnet = this.dogeConfig.network == "testnet";

        let dogecoinConf_testnet = productionYaml.dogecoinConf?.testnet;
        const expected_testnet = isTestnet ? 1 : 0;
        if (dogecoinConf_testnet != expected_testnet) {
          productionYaml.dogecoinConf.testnet = expected_testnet;
          updated = true;
          changes.push({ key: `dogecoinConf.testnet`, oldValue: String(dogecoinConf_testnet), newValue: String(expected_testnet) });
        }

        let service_port = productionYaml.service?.port;
        const expected_service_port = isTestnet ? 44556 : 22556;
        if (service_port != expected_service_port) {
          productionYaml.service.port = expected_service_port;
          updated = true;
          changes.push({ key: `service.port`, oldValue: String(service_port), newValue: String(expected_service_port) });
        }

        let service_rpcPort = productionYaml.service?.rpcPort;
        const expected_service_rpcPort = isTestnet ? 44555 : 22555;
        if (service_rpcPort != expected_service_rpcPort) {
          productionYaml.service.rpcPort = expected_service_rpcPort;
          updated = true;
          changes.push({ key: `service.rpcPort`, oldValue: String(service_rpcPort), newValue: String(expected_service_rpcPort) });
        }

        let storage_size = productionYaml.storage?.size;
        const expected_storage_size = isTestnet ? "50Gi" : "250Gi";
        if (storage_size != expected_storage_size) {
          productionYaml.storage.size = expected_storage_size;
          updated = true;
          changes.push({ key: `storage.size`, oldValue: String(storage_size), newValue: String(expected_storage_size) });
        }

        // let rpcPassword = productionYaml.rpcPassword;
        // let expectedRpcPassword = this.dogeConfig.dogecoinClusterRpc?.password;
        // if (rpcPassword != expectedRpcPassword) {
        //   productionYaml.rpcPassword = expectedRpcPassword;
        //   updated = true;
        //   changes.push({ key: `rpcPassword`, oldValue: String(rpcPassword), newValue: String(expectedRpcPassword) });
        // }

        let rpcUser = productionYaml.dogecoinConf?.rpcuser;
        let expectedRpcUser = this.dogeConfig.dogecoinClusterRpc?.username;
        if (rpcUser != expectedRpcUser) {
          productionYaml.dogecoinConf.rpcuser = expectedRpcUser;
          updated = true;
          changes.push({ key: `dogecoinConf.rpcuser`, oldValue: String(rpcUser), newValue: String(expectedRpcUser) });
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

      if (updated) {
        this.log(`\nFor ${chalk.cyan(file)}:`)
        this.log(chalk.green('Changes:'))
        for (const change of changes) {
          this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`)
        }

        const shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` })
        if (shouldUpdate) {
          const yamlString = yaml.dump(productionYaml, YAML_DUMP_OPTIONS)

          fs.writeFileSync(yamlPath, yamlString)
          this.log(chalk.green(`Updated ${file}`))
          updatedCharts++
        } else {
          this.log(chalk.yellow(`Skipped updating ${file}`))
          skippedCharts++
        }
      } else {
        this.log(chalk.yellow(`No changes needed in ${file}`))
        skippedCharts++
      }
    }


    return { updated: updatedCharts, skipped: skippedCharts }
  }

  private async processConfigYaml(valuesDir: string): Promise<{ updated: number, skipped: number }> {
    let updatedCharts = 0
    let skippedCharts = 0
    const configFiles = fs.readdirSync(valuesDir)
      .filter(file => file.endsWith('-config.yaml'))

    for (const file of configFiles) {
      const yamlPath = path.join(valuesDir, file)
      this.log(chalk.cyan(`Processing ${yamlPath}`));
      let chartName = file.replace(/-config\.yaml$/, '');
      let yamlData = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as any;
      let changes: Array<{ key: string; oldValue: string; newValue: string }> = [];
      if (chartName == "frontends") {
        let scrollConfig = yamlData["scrollConfig"];
        let scrollConfigToml: any = {};
        try {
          scrollConfigToml = toml.parse(scrollConfig);
        } catch (e: any) {
          this.log(chalk.red("scrollConfig failed: " + e.message));
        }
        const configUpdates = {
          REACT_APP_EXTERNAL_DOCS_URI: "https://docs.dogeos.com/en/home",
          REACT_APP_FAUCET_URI: "https://faucet." + this.getConfigValue("ingress.FRONTEND_HOST"),
          REACT_APP_DOGE_NETWORK: this.dogeConfig.network,
          REACT_APP_DOGE_BRIDGE_ADDRESS: this.withdrawalProcessorConfig["bridge_address"],
          REACT_APP_MOAT_ADDRESS: this.getConfigValue("contractsFile.L2_MOAT_PROXY_ADDR"),
          REACT_APP_L1_STANDARD_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L1_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: "",
          REACT_APP_L2_CUSTOM_ERC20_GATEWAY_PROXY_ADDR: ""
        };

        let updated = false;
        for (const [key, newValue] of Object.entries(configUpdates)) {
          const oldValue = scrollConfigToml[key];
          if (oldValue !== newValue) {
            changes.push({ key, oldValue: String(oldValue || ''), newValue: String(newValue) });
            scrollConfigToml[key] = newValue;
            updated = true;
          }
        }

        if (updated) {
          this.log(`\nFor ${chalk.cyan(file)}:`);
          this.log(chalk.green('Changes:'));
          for (const change of changes) {
            this.log(`  ${chalk.yellow(change.key)}: ${change.oldValue} -> ${change.newValue}`);
          }

          const shouldUpdate = await confirm({ message: `Do you want to apply these changes to ${file}?` });
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
            this.log(chalk.green(`Updated ${file}`));
            updatedCharts++;
          } else {
            this.log(chalk.yellow(`Skipped updating ${file}`));
            skippedCharts++;
          }
        } else {
          this.log(chalk.yellow(`No changes needed in ${file}`));
          skippedCharts++;
        }
      }
    }
    return { updated: updatedCharts, skipped: skippedCharts };
  }


  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((prev, curr) => prev && prev[curr], obj)
  }


  private async validateMakefile(skipAuthCheck: boolean): Promise<void> {
    const makefilePath = path.join(process.cwd(), 'Makefile')
    if (!fs.existsSync(makefilePath)) {
      this.error('Makefile not found in the current directory.')
    }

    const makefileContent = fs.readFileSync(makefilePath, 'utf-8')
    const installCommands = makefileContent.match(/helm\s+upgrade\s+-i.*?(?=\n\n|\Z)/gs)

    if (!installCommands) {
      this.warn('No Helm upgrade commands found in the Makefile.')
      return
    }

    for (const command of installCommands) {
      const chartNameMatch = command.match(/upgrade\s+-i\s+(\S+)/)
      const ociMatch = command.match(/oci:\/\/([^\s]+)/)
      const ociVersionMatch = command.match(/--version\s*=\s*(\S+)\s+/);

      if (chartNameMatch && ociMatch) {
        const chartName = chartNameMatch[1]
        const ociUrl = ociMatch[0]
        const ociVersion = ociVersionMatch && ociVersionMatch.length > 1 ? ociVersionMatch[1] : "";

        if (!skipAuthCheck) {
          const hasAccess = await this.validateOCIAccess(ociUrl, ociVersion)

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

        const valuesFileMatches = command.match(/-f\s+([^\s]+)/g)
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

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupPrepCharts)

    this.log('Starting chart preparation...')

    // Load configs before processing yaml files
    await this.loadConfigs(flags)

    if (flags['github-username'] && flags['github-token']) {
      try {
        await this.authenticateGHCR(flags['github-username'], flags['github-token'])
      } catch (error) {
        this.log('Failed to authenticate with GitHub Container Registry')
      }
    }

    let skipAuthCheck = flags['skip-auth-check']
    if (!skipAuthCheck) {
      skipAuthCheck = !(await confirm({ message: 'Do you want to perform authentication checks for individual charts?' }))
    }

    // Validate Makefile
    await this.validateMakefile(skipAuthCheck)

    // Process production.yaml files
    const valuesDir = flags['values-dir']

    const { updated, skipped } = await this.processProductionYaml(valuesDir);
    const { updated: updatedConfig, skipped: skippedConfig } = await this.processConfigYaml(valuesDir);

    this.log(chalk.green(`\nUpdated production YAML files for ${updated} chart(s).`))
    this.log(chalk.yellow(`Skipped ${skipped} chart(s).`))

    this.log(chalk.green(`\nUpdated config YAML files for ${updatedConfig} chart(s).`))
    this.log(chalk.yellow(`Skipped ${skippedConfig} chart(s).`))

    this.log('Chart preparation completed.')
  }
}