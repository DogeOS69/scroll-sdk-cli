/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic TOML config operations */
import * as toml from '@iarna/toml'
import { input } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { DogeConfig } from '../../types/doge-config.js'

import {
  L1_INTERFACE_BEACON_API_ENDPOINT,
  L1_INTERFACE_RPC_ENDPOINT,
} from '../../config/constants.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'

type EnvVarMap = Record<string, string>

interface EnvFileWriteResult {
  changed: boolean
  removedVars: string[]
  updatedVars: string[]
}

interface L2NodeEnvGenerationResult {
  hasUnresolvedExternalPeers: boolean
  l2gethEnvPath: string
  l2rethEnvPath: string
}

export interface ComposeInitSyncResult {
  changed: boolean
  composePath: string
  initServices: string[]
  removedServices: string[]
  updatedServices: string[]
}

interface ComposeService {
  [key: string]: unknown
}

interface ComposeFile {
  services?: Record<string, ComposeService>
  volumes?: Record<string, unknown>
}

const L1_INTERFACE_LOCAL_ENV_KEYS = new Set([
  'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL',
  'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__USER',
  'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__PASS',
  'DOGEOS_L1_INTERFACE_DOGECOIN_RPC__BLOCKBOOK_API_KEY',
])

const L1_INTERFACE_ENV_ENDPOINT_KEYS = new Set([
  'DOGEOS_L1_INTERFACE_ETHEREUM_DA__L1_RPC_URL',
  'DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__BEACON_NODE__URL',
])

const DOCKER_COMPOSE_NETWORK_ENV_DIR = `./envs/\${NETWORK}`
const L2GETH_L1_ENDPOINT_SHELL_EXPANSION = `\${L2GETH_L1_ENDPOINT:-http://l1-interface:8545}`

function parseEnvKey(line: string): string | undefined {
  const trimmedLine = line.trim()
  if (!trimmedLine || trimmedLine.startsWith('#') || !trimmedLine.includes('=')) return undefined

  const [key] = trimmedLine.split('=')
  const normalizedKey = key?.trim()
  return normalizedKey || undefined
}

function parsePeerListValue(value: string | undefined): string[] | undefined {
  if (!value) return undefined

  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed
    }
  } catch {
    return undefined
  }

  return undefined
}

function isCelestiaEnvKey(key: string): boolean {
  return key.toUpperCase().includes('CELESTIA')
}

function isSecretLikeEnvKey(key: string): boolean {
  return /(?:^|_)(?:user|pass|password|token|api_key|secret)(?:_|$)/i.test(key.replaceAll('__', '_'))
}

function isInternalEndpointValue(value: string | undefined): boolean {
  if (!value) return false

  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return host === 'localhost' ||
      host === '127.0.0.1' ||
      host === 'l1-devnet' ||
      host === 'l1-devnet-lighthouse' ||
      host === 'l1-interface' ||
      host.endsWith('.svc') ||
      host.endsWith('.svc.cluster.local')
  } catch {
    return false
  }
}

function isUnsafeL1InterfaceEnvVar(key: string, value: string | undefined): boolean {
  if (isCelestiaEnvKey(key)) return true
  if (L1_INTERFACE_LOCAL_ENV_KEYS.has(key)) return false
  if (isSecretLikeEnvKey(key)) return true

  return L1_INTERFACE_ENV_ENDPOINT_KEYS.has(key) && isInternalEndpointValue(value)
}

function hasLoadBalancerPlaceholder(value: string | undefined): boolean {
  return typeof value === 'string' && value.includes('<LoadBalancer-Domain-For-')
}

function hasClusterLocalPeer(value: string | undefined): boolean {
  return typeof value === 'string' && /@l2-(?:bootnode|sequencer)-\d+(?:[.:][^:]+)*:\d+/.test(value)
}

function hasUnresolvedExternalPeer(value: string | undefined): boolean {
  return hasLoadBalancerPlaceholder(value) || hasClusterLocalPeer(value)
}

function composeDump(compose: ComposeFile): string {
  return yaml.dump(compose, {
    forceQuotes: false,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  })
}

function composeServiceChanged(before: ComposeService | undefined, after: ComposeService): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after)
}

function envArrayToComposeEnvironment(env: unknown): Record<string, string> | undefined {
  if (!Array.isArray(env)) return undefined

  const environment: Record<string, string> = {}
  for (const item of env) {
    if (!item || typeof item !== 'object') continue
    const {name} = item as { name?: unknown }
    if (typeof name !== 'string' || name.trim() === '') continue
    const {value} = item as { value?: unknown }
    environment[name] = value === undefined || value === null ? '' : String(value)
  }

  return Object.keys(environment).length > 0 ? environment : undefined
}

function escapeComposeCommandInterpolation(command: string): string {
  return command.replaceAll('$', '$$$$')
}

function findComposeVolumeSourceForMount(targetService: ComposeService, mountPath: string): string | undefined {
  if (!Array.isArray(targetService.volumes)) return undefined

  for (const volume of targetService.volumes) {
    if (typeof volume === 'string') {
      const parts = volume.split(':')
      if (parts.length >= 2 && parts[1] === mountPath) {
        return parts[0]
      }
    } else if (volume && typeof volume === 'object') {
      const {target} = volume as { target?: unknown }
      if (target === mountPath) {
        const {source} = volume as { source?: unknown }
        return typeof source === 'string' ? source : undefined
      }
    }
  }

  return undefined
}

function initContainerVolumeMountsToComposeVolumes(initContainer: unknown, targetService: ComposeService): string[] | undefined {
  const {volumeMounts} = initContainer as { volumeMounts?: unknown }
  if (!Array.isArray(volumeMounts)) return undefined

  const volumes: string[] = []
  for (const mount of volumeMounts) {
    if (!mount || typeof mount !== 'object') continue
    const {mountPath} = mount as { mountPath?: unknown }
    if (typeof mountPath !== 'string' || mountPath.trim() === '') continue

    const source = findComposeVolumeSourceForMount(targetService, mountPath)
    if (!source) continue

    const {readOnly} = mount as { readOnly?: unknown }
    volumes.push(`${source}:${mountPath}${readOnly ? ':ro' : ''}`)
  }

  return volumes.length > 0 ? volumes : undefined
}

function initContainerCommandToComposeService(initContainer: unknown, service: ComposeService): void {
  const {command} = initContainer as { command?: unknown }
  if (!Array.isArray(command) || command.length === 0) return

  const commandParts = command.map(String)
  if (commandParts.length >= 3 && commandParts[0].endsWith('sh') && commandParts[1] === '-c') {
    service.entrypoint = [commandParts[0], commandParts[1]]
    service.command = [escapeComposeCommandInterpolation(commandParts.slice(2).join('\n'))]
    return
  }

  service.entrypoint = commandParts
}

function initContainerSecurityContextToComposeUser(initContainer: unknown): string | undefined {
  const {securityContext} = initContainer as { securityContext?: unknown }
  if (!securityContext || typeof securityContext !== 'object') return undefined

  const {runAsGroup, runAsUser} = securityContext as { runAsGroup?: unknown; runAsUser?: unknown }
  if (runAsUser === undefined && runAsGroup === undefined) return undefined

  return `${runAsUser ?? ''}${runAsGroup === undefined ? '' : `:${runAsGroup}`}`
}

function normalizeDependsOn(dependsOn: unknown): Record<string, { condition: string }> {
  if (Array.isArray(dependsOn)) {
    return Object.fromEntries(dependsOn.map(item => [String(item), { condition: 'service_started' }]))
  }

  if (dependsOn && typeof dependsOn === 'object') {
    const normalized: Record<string, { condition: string }> = {}
    for (const [serviceName, dependencyConfig] of Object.entries(dependsOn)) {
      const condition = dependencyConfig && typeof dependencyConfig === 'object' && 'condition' in dependencyConfig
        ? String((dependencyConfig as { condition: unknown }).condition)
        : 'service_started'
      normalized[serviceName] = { condition }
    }

    return normalized
  }

  return {}
}

function setDependsOnCondition(service: ComposeService, dependencyName: string, condition: string): void {
  service.depends_on = {
    ...normalizeDependsOn(service.depends_on),
    [dependencyName]: { condition },
  }
}

function removeDependsOnService(service: ComposeService, dependencyName: string): boolean {
  if (Array.isArray(service.depends_on)) {
    const nextDependsOn = service.depends_on.filter(item => String(item) !== dependencyName)
    if (nextDependsOn.length === service.depends_on.length) return false

    if (nextDependsOn.length > 0) {
      service.depends_on = nextDependsOn
    } else {
      delete service.depends_on
    }

    return true
  }

  if (!service.depends_on || typeof service.depends_on !== 'object') return false

  const dependsOn = service.depends_on as Record<string, unknown>
  if (!(dependencyName in dependsOn)) return false

  delete dependsOn[dependencyName]
  if (Object.keys(dependsOn).length === 0) {
    delete service.depends_on
  }

  return true
}

function sanitizeComposeServiceName(name: string): string {
  return name.toLowerCase().replaceAll(/[^\da-z-]+/g, '-').replaceAll(/^-|-$/g, '')
}

export function normalizeConfigMapEnvData(envData: unknown): EnvVarMap {
  if (!envData || typeof envData !== 'object' || Array.isArray(envData)) {
    throw new TypeError('configMaps.env.data not found or invalid')
  }

  const normalized: EnvVarMap = {}
  for (const [key, value] of Object.entries(envData)) {
    if (value === undefined || value === null || isCelestiaEnvKey(key)) continue
    normalized[key] = String(value)
  }

  return normalized
}

export function convertPeersToExternalDomains(peers: string[], loadBalancerDomains: Record<string, string> = {}): string[] {
  return peers.map(peer => {
    // External RPC packages should peer through bootnode public p2p LoadBalancers
    // created by `setup bootnode-public-p2p`.
    // Format: enode://nodekey@hostname:port
    const match = peer.match(/@l2-bootnode-(\d+)(?:[.:][^:]+)*:(\d+)/)
    if (match) {
      const nodeIndex = match[1]
      const port = match[2]
      const serviceName = `l2-bootnode-${nodeIndex}-p2p`
      const domain = loadBalancerDomains[serviceName] || `<LoadBalancer-Domain-For-l2-bootnode-${nodeIndex}>`
      return peer.replace(/@l2-bootnode-\d+(?:[.:][^:]+)*:\d+/, `@${domain}:${port}`)
    }

    return peer
  })
}

function buildComposeInitService(
  chartName: string,
  initContainerName: string,
  initContainer: unknown,
  targetService: ComposeService,
): ComposeService {
  const {image} = initContainer as { image?: unknown }
  const initServiceName = `${chartName}-init-${sanitizeComposeServiceName(initContainerName)}`
  const initService: ComposeService = {
    container_name: initServiceName,
    image: typeof image === 'string' && image.trim() !== '' ? image : 'alpine:latest',
    restart: 'no',
  }

  const {env} = initContainer as { env?: unknown }
  const environment = envArrayToComposeEnvironment(env)
  if (environment) {
    initService.environment = environment
  }

  const user = initContainerSecurityContextToComposeUser(initContainer)
  if (user) {
    initService.user = user
  }

  const volumes = initContainerVolumeMountsToComposeVolumes(initContainer, targetService)
  if (volumes) {
    initService.volumes = volumes
  }

  initContainerCommandToComposeService(initContainer, initService)

  return initService
}

function hasWaitForL1InitContainer(valuesYaml: unknown): boolean {
  const {initContainers} = valuesYaml as { initContainers?: unknown }
  if (!initContainers || typeof initContainers !== 'object' || Array.isArray(initContainers)) return false

  return Object.values(initContainers).some(initContainer => {
    const {command} = initContainer as { command?: unknown }
    return Array.isArray(command) && command.map(String).join(' ').includes('wait-for-l1')
  })
}

function loadYamlIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return undefined
  return yaml.load(fs.readFileSync(filePath, 'utf8')) as unknown
}

function syncL1InterfaceInitContainers(
  compose: ComposeFile,
  valuesYaml: unknown,
  result: ComposeInitSyncResult,
): void {
  const {initContainers} = valuesYaml as { initContainers?: unknown }
  if (!initContainers || typeof initContainers !== 'object' || Array.isArray(initContainers)) return

  if (!compose.services) {
    compose.services = {}
  }

  const {services} = compose
  const targetService = services['l1-interface']
  if (!targetService) return

  for (const [initContainerName, initContainer] of Object.entries(initContainers)) {
    const initServiceName = `l1-interface-init-${sanitizeComposeServiceName(initContainerName)}`
    const previousInitService = services[initServiceName]
    const nextInitService = buildComposeInitService('l1-interface', initContainerName, initContainer, targetService)
    services[initServiceName] = nextInitService
    setDependsOnCondition(targetService, initServiceName, 'service_completed_successfully')

    if (composeServiceChanged(previousInitService, nextInitService)) {
      result.initServices.push(initServiceName)
    }
  }

  if (!result.updatedServices.includes('l1-interface')) {
    result.updatedServices.push('l1-interface')
  }
}

function syncL2RpcWaitForL1InitContainer(compose: ComposeFile, valuesYaml: unknown, result: ComposeInitSyncResult): void {
  if (!hasWaitForL1InitContainer(valuesYaml)) return

  if (!compose.services) {
    compose.services = {}
  }

  const {services} = compose
  const l1InterfaceService = services['l1-interface']
  const l2gethService = services['l2geth-node']
  const l2rethService = services['l2reth-node']
  if (!l1InterfaceService || !l2gethService || !l2rethService) return

  const waitServiceName = 'l2-rpc-init-wait-for-l1'
  const previousWaitService = services[waitServiceName]
  const l2gethEnvFile = `${DOCKER_COMPOSE_NETWORK_ENV_DIR}/l2geth.env`
  const waitService: ComposeService = {
    command: [[
      'set -eu',
      `endpoint="${L2GETH_L1_ENDPOINT_SHELL_EXPANSION}"`,
      'echo "Waiting for L1 interface at $endpoint"',
      'for i in $(seq 1 120); do',
      '  if curl -fsS --max-time 2 -H "content-type: application/json" --data \'{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}\' "$endpoint" >/dev/null; then',
      '    echo "L1 interface is ready"',
      '    exit 0',
      '  fi',
      '  sleep 5',
      'done',
      'echo "Timed out waiting for L1 interface at $endpoint" >&2',
      'exit 1',
    ].map(line => escapeComposeCommandInterpolation(line)).join('\n')],
    container_name: waitServiceName,
    depends_on: {
      'l1-interface': { condition: 'service_started' },
    },
    entrypoint: ['/bin/sh', '-c'],
    env_file: Array.isArray(l2gethService.env_file) ? l2gethService.env_file : ['./envs/common/l2geth.env', l2gethEnvFile],
    image: 'curlimages/curl:8.20.0',
    restart: 'no',
  }

  services[waitServiceName] = waitService
  for (const serviceName of ['l2geth-node', 'l2reth-node']) {
    setDependsOnCondition(services[serviceName], waitServiceName, 'service_completed_successfully')
    if (!result.updatedServices.includes(serviceName)) {
      result.updatedServices.push(serviceName)
    }
  }

  if (composeServiceChanged(previousWaitService, waitService)) {
    result.initServices.push(waitServiceName)
  }
}

function removeCelestiaComposeArtifacts(compose: ComposeFile, result: ComposeInitSyncResult): void {
  const {services} = compose
  if (services?.['celestia-light-node']) {
    delete services['celestia-light-node']
    result.removedServices.push('celestia-light-node')
  }

  if (services) {
    for (const [serviceName, service] of Object.entries(services)) {
      if (removeDependsOnService(service, 'celestia-light-node') && !result.updatedServices.includes(serviceName)) {
        result.updatedServices.push(serviceName)
      }
    }
  }

  if (compose.volumes && 'celestia_data' in compose.volumes) {
    delete compose.volumes.celestia_data
  }
}

export function syncRpcPackageInitContainersToCompose(valuesDir: string, rpcPackageDir: string): ComposeInitSyncResult {
  const composePath = path.join(rpcPackageDir, 'docker-compose.yml')
  if (!fs.existsSync(composePath)) {
    throw new Error(`docker-compose.yml not found at: ${composePath}`)
  }

  const existingContent = fs.readFileSync(composePath, 'utf8')
  const compose = yaml.load(existingContent) as ComposeFile
  if (!compose || typeof compose !== 'object') {
    throw new Error(`Failed to parse docker-compose.yml at: ${composePath}`)
  }

  const result: ComposeInitSyncResult = {
    changed: false,
    composePath,
    initServices: [],
    removedServices: [],
    updatedServices: [],
  }

  const l1InterfaceValues = loadYamlIfExists(path.resolve(valuesDir, 'l1-interface-production.yaml'))
  if (l1InterfaceValues) {
    syncL1InterfaceInitContainers(compose, l1InterfaceValues, result)
  }

  const l2RpcValues = loadYamlIfExists(path.resolve(valuesDir, 'l2-rpc-production.yaml'))
  if (l2RpcValues) {
    syncL2RpcWaitForL1InitContainer(compose, l2RpcValues, result)
  }

  removeCelestiaComposeArtifacts(compose, result)

  const nextContent = composeDump(compose)
  result.changed = nextContent !== existingContent
  if (result.changed) {
    fs.writeFileSync(composePath, nextContent)
  }

  return result
}

function mergeEnvFileContent(
  existingLines: string[],
  newVars: EnvVarMap,
  options: {
    header: string[]
    removeKey?: (key: string, value: string | undefined) => boolean
  }
): { content: string; removedVars: string[]; updatedVars: string[] } {
  const remainingVars = new Map(Object.entries(newVars))
  const updatedVars: string[] = []
  const removedVars: string[] = []
  const nextLines: string[] = existingLines.length > 0 ? [] : [...options.header]

  for (const existingLine of existingLines) {
    const key = parseEnvKey(existingLine)
    if (!key) {
      nextLines.push(existingLine)
      continue
    }

    const existingValue = existingLine.slice(existingLine.indexOf('=') + 1).trim()
    if (options.removeKey?.(key, existingValue)) {
      removedVars.push(key)
      continue
    }

    if (remainingVars.has(key)) {
      const newValue = remainingVars.get(key) as string
      const nextLine = `${key}=${newValue}`
      if (existingLine.trim() !== nextLine) {
        updatedVars.push(key)
      }

      nextLines.push(nextLine)
      remainingVars.delete(key)
      continue
    }

    nextLines.push(existingLine)
  }

  for (const [key, value] of remainingVars) {
    nextLines.push(`${key}=${value}`)
    updatedVars.push(key)
  }

  return {
    content: nextLines.join('\n').replace(/\n*$/, '') + '\n',
    removedVars,
    updatedVars,
  }
}

export default class SetupGenRpcPackage extends Command {
  static override description = 'Generate configuration files for dogeos-rpc-package to enable external RPC nodes'

  static override examples = [
    '# Generate RPC package (dogeos-rpc-package directory is required)',
    '<%= config.bin %> <%= command.id %> -d ~/github/dogeos-rpc-package/',
    '',
    '# Generate mainnet RPC package with specific config and namespace',
    '<%= config.bin %> <%= command.id %> --doge-config .data/doge-config.toml -d ~/github/dogeos-rpc-package/ -n scroll-mainnet',
    '',
    '# First clone the project: git clone https://github.com/dogeos69/dogeos-rpc-package',
    '<%= config.bin %> <%= command.id %> -d ./dogeos-rpc-package/ --namespace default',
  ]

  static override flags = {
    'config-path': Flags.string({
      default: './config.toml',
      description: 'Path to config.toml file containing cluster configuration',
      required: false,
    }),
    'doge-config': Flags.string({
      description: 'Path to Dogecoin config file',
      required: false,
    }),
    'dogeos-rpc-package-dir': Flags.string({
      char: 'd',
      description: 'Path to dogeos-rpc-package project directory (clone from https://github.com/dogeos69/dogeos-rpc-package)',
      required: true,
    }),
    namespace: Flags.string({
      char: 'n',
      description: 'Kubernetes namespace',
    }),
    'values-dir': Flags.string({
      default: './values',
      description: 'Directory containing Helm values files (must include genesis.yaml)',
      required: false,
    }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(SetupGenRpcPackage)

    try {
      this.log(chalk.blue('🚀 Starting RPC package generation...'))
      this.log('')

      // Get namespace interactively if not provided
      let {namespace} = flags
      if (!namespace) {
        namespace = await input({
          default: 'default',
          message: 'Enter Kubernetes namespace:',
          validate(value: string) {
            if (!value || value.trim() === '') {
              return 'Namespace cannot be empty'
            }

            return true
          }
        })
      }

      // Verify dogeos-rpc-package directory exists
      const rpcPackageDir = path.resolve(flags['dogeos-rpc-package-dir'])
      if (!fs.existsSync(rpcPackageDir)) {
        this.log(chalk.red(`❌ dogeos-rpc-package directory not found: ${rpcPackageDir}`))
        this.log('')
        this.log(chalk.yellow('Please clone the dogeos-rpc-package project first:'))
        this.log(chalk.cyan('git clone https://github.com/dogeos69/dogeos-rpc-package'))
        this.log('')
        this.exit(1)
      }

      this.log(chalk.green(`✓ Using dogeos-rpc-package directory: ${rpcPackageDir}`))
      this.log('')

      // Step 1: Load DogeConfig
      const { config: dogeConfig, configPath: dogeConfigPath } = await loadDogeConfigWithSelection(
        flags['doge-config'],
        `${this.config.bin} ${this.id}`,
      )
      this.log(chalk.blue(`Using DogeConfig file: ${dogeConfigPath}`))

      // Step 2: Load config.toml if present. Values YAML is the source of
      // truth for generated env files; config.toml is only used for peer and
      // signer fallbacks.
      const config = this.loadConfig(flags['config-path'])
      if (config) {
        this.log(chalk.green('Successfully loaded config.toml'))
      } else {
        this.log(chalk.yellow(`config.toml not found at ${path.resolve(flags['config-path'])}; using values YAML only`))
      }

      // Step 3: Determine network type
      const {network} = dogeConfig
      if (network !== 'mainnet' && network !== 'testnet' && network !== 'regtest') {
        throw new Error(`Invalid network type in dogeConfig: '${network}'. Expected 'mainnet', 'testnet', or 'regtest'.`)
      }

      this.log(chalk.blue(`Network type: ${network}`))

      // Step 4: Setup directory structure  
      this.log(chalk.blue(`RPC package directory: ${rpcPackageDir}`))

      // Step 5: Get LoadBalancer domains
      this.log(chalk.blue('Step 1: Getting LoadBalancer domains...'))
      const loadBalancerDomains = await this.getLoadBalancerDomains(namespace)
      if (Object.keys(loadBalancerDomains).length > 0) {
        this.log(chalk.green(`✓ Found ${Object.keys(loadBalancerDomains).length} LoadBalancer domains`))
        for (const [service, domain] of Object.entries(loadBalancerDomains)) {
          this.log(chalk.cyan(`  ${service}: ${domain}`))
        }
      } else {
        this.log(chalk.yellow('⚠️  No LoadBalancer domains found - using placeholders'))
      }

      // Step 6: Generate L2 node env files from l2-rpc-production.yaml
      this.log(chalk.blue('Step 2: Generating L2 node env files from l2-rpc-production.yaml...'))

      const l2NodeEnv = this.generateL2NodeEnvFiles(config, dogeConfig, rpcPackageDir, loadBalancerDomains, namespace, flags['values-dir'])
      this.log(chalk.green(`✓ Generated l2geth.env at: ${l2NodeEnv.l2gethEnvPath}`))
      this.log(chalk.green(`✓ Generated l2reth.env at: ${l2NodeEnv.l2rethEnvPath}`))

      // Step 7: Extract genesis.json from genesis.yaml
      this.log(chalk.blue('Step 3: Extracting genesis.json from genesis.yaml...'))
      const genesisJsonPath = this.extractGenesisJson(flags['values-dir'], rpcPackageDir, network, dogeConfig)
      this.log(chalk.green(`✓ Extracted genesis.json at: ${genesisJsonPath}`))

      // Step 8: Generate l1-interface.env file
      this.log(chalk.blue('Step 4: Generating l1-interface.env file...'))
      const l1InterfaceEnvPath = this.generateL1InterfaceEnvFile(flags['values-dir'], rpcPackageDir, network, config)
      this.log(chalk.green(`✓ Generated l1-interface.env at: ${l1InterfaceEnvPath}`))

      // Step 9: Sync initContainers to docker-compose.yml
      this.log(chalk.blue('Step 5: Syncing initContainers into docker-compose.yml...'))
      const composeSync = syncRpcPackageInitContainersToCompose(flags['values-dir'], rpcPackageDir)
      if (composeSync.changed) {
        this.log(chalk.green(`✓ Updated docker-compose.yml at: ${composeSync.composePath}`))
        if (composeSync.initServices.length > 0) {
          this.log(chalk.green(`✓ Synced init services: ${composeSync.initServices.join(', ')}`))
        }

        if (composeSync.removedServices.length > 0) {
          this.log(chalk.green(`✓ Removed services: ${composeSync.removedServices.join(', ')}`))
        }
      } else {
        this.log(chalk.green('✓ No initContainer changes detected in docker-compose.yml'))
      }

      this.log('')
      this.log(chalk.blue('Generated files:'))
      this.log(chalk.cyan(`  - ${l2NodeEnv.l2gethEnvPath}`))
      this.log(chalk.cyan(`  - ${l2NodeEnv.l2rethEnvPath}`))
      this.log(chalk.cyan(`  - ${genesisJsonPath}`))
      this.log(chalk.cyan(`  - ${l1InterfaceEnvPath}`))
      this.log(chalk.cyan(`  - ${composeSync.composePath}`))
      this.log('')
      if (l2NodeEnv.hasUnresolvedExternalPeers) {
        this.log(chalk.yellow('⚠️  External peer domains could not be fully resolved.'))
        this.log(chalk.yellow('The generated l2geth.env/l2reth.env contains placeholder or cluster-local peer domains that need to be replaced.'))
        this.log(chalk.yellow('Run the following command to get the actual LoadBalancer domains:'))
        this.log(chalk.cyan(`kubectl get svc -n ${namespace} | grep p2p`))
        this.log('')
        this.log(chalk.yellow('Then replace unresolved peer hosts in l2geth.env/l2reth.env with the actual EXTERNAL-IP domains.'))
        this.error(`LoadBalancer domains generate fail`);
      } else if (Object.keys(loadBalancerDomains).length > 0) {
        this.log(chalk.green('✅ LoadBalancer domains have been automatically resolved and applied.'))
      } else {
        this.log(chalk.yellow('No LoadBalancer domains were found; peer list did not require placeholder replacement.'))
      }

      this.log('')
      this.log(chalk.green('🎉 RPC package generation completed successfully!'))

    } catch (error) {
      this.log('')
      this.log(chalk.red('❌ RPC package generation failed:'))
      this.log(chalk.red(error instanceof Error ? error.message : String(error)))
      this.exit(1)
    }
  }

  private addLoadBalancerHint(envFilePath: string, namespace: string): void {
    const hintLines = [
      '# NOTE: Placeholder or cluster-local peer domains need to be replaced with public p2p endpoints',
      `# Run: kubectl get svc -n ${namespace} | grep p2p`,
      '# Replace unresolved peer hosts with actual EXTERNAL-IP domains',
    ]
    const content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : ''
    const contentWithoutExistingHint = content
      .split('\n')
      .filter(line => line !== '# NOTE: Placeholder or cluster-local peer domains need to be replaced with public bootnode endpoints')
      .filter(line => !hintLines.includes(line))
      .filter(line => !/^# Run: kubectl get svc -n .+ \| grep p2p$/.test(line))
      .filter(line => line !== '# Replace unresolved peer hosts with actual EXTERNAL-IP domains')
      .join('\n')
      .replace(/\n*$/, '')
    const nextContent = `${contentWithoutExistingHint}\n${hintLines.join('\n')}\n`

    if (nextContent !== content) {
      fs.writeFileSync(envFilePath, nextContent)
    }
  }

  private capitalize(str: string): string {
    if (!str) return ''
    return str.charAt(0).toUpperCase() + str.slice(1)
  }

  private extractGenesisJson(valuesDir: string, rpcPackageDir: string, network: string, dogeConfig: DogeConfig): string {
    const genesisYamlPath = path.resolve(valuesDir, 'genesis.yaml')

    if (!fs.existsSync(genesisYamlPath)) {
      throw new Error(`genesis.yaml not found at: ${genesisYamlPath}`)
    }

    try {
      // Read and parse genesis.yaml
      const genesisYamlContent = fs.readFileSync(genesisYamlPath, 'utf8')
      const genesisYaml = yaml.load(genesisYamlContent) as any

      if (!genesisYaml) {
        throw new Error('Failed to parse genesis.yaml - file appears to be empty or invalid')
      }

      // Extract genesis.json from the YAML structure
      // The structure might be: { genesis: "JSON_STRING" } or { genesis: JSON_OBJECT }
      let genesisJson: any

      if (genesisYaml.scrollConfig) {
        if (typeof genesisYaml.scrollConfig === 'string') {
          // If genesis is a JSON string, parse it
          try {
            genesisJson = JSON.parse(genesisYaml.scrollConfig)
          } catch (parseError) {
            throw new Error(`Failed to parse genesis JSON string: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
          }
        } else if (typeof genesisYaml.scrollConfig === 'object') {
          // If genesis is already an object, use it directly
          genesisJson = genesisYaml.scrollConfig
        } else {
          throw new TypeError('Invalid genesis format in genesis.yaml - expected string or object')
        }
      } else {
        // If no 'genesis' key, assume the entire YAML is the genesis data
        genesisJson = genesisYaml
      }

      // Create target directory
      const targetDirectory = path.resolve(rpcPackageDir, 'configs', network)
      fs.mkdirSync(targetDirectory, { recursive: true })


      // Write genesis.json
      const genesisJsonPath = path.join(targetDirectory, 'l2geth-genesis.json')
      const genesisJsonContent = JSON.stringify(genesisJson, null, 2)
      fs.writeFileSync(genesisJsonPath, genesisJsonContent)

      // genesisJson for reth
      const genesisJsonForReth = JSON.parse(JSON.stringify(genesisJson));
      genesisJsonForReth.config.scroll.l1Config.startL1Block = dogeConfig.defaults?.dogecoinIndexerStartHeight;
      genesisJsonForReth.config.scroll.l1Config.systemContractAddress = genesisJsonForReth.config.systemContract.system_contract_address;
      fs.writeFileSync(path.join(targetDirectory, 'l2reth-genesis.json'), JSON.stringify(genesisJsonForReth, null, 2))

      return genesisJsonPath

    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to parse genesis')) {
        throw error
      }

      throw new Error(`Failed to extract genesis.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private generateL1InterfaceEnvFile(
    valuesDir: string,
    rpcPackageDir: string,
    network: string,
    _config: any,
  ): string {
    const l1InterfaceYamlPath = path.resolve(valuesDir, 'l1-interface-production.yaml')

    if (!fs.existsSync(l1InterfaceYamlPath)) {
      throw new Error(`l1-interface-production.yaml not found at: ${l1InterfaceYamlPath}`)
    }

    try {
      const envData = this.loadConfigMapEnvData(l1InterfaceYamlPath)

      // Create target directory
      const targetDirectory = path.resolve(rpcPackageDir, 'envs', network)
      fs.mkdirSync(targetDirectory, { recursive: true })

      // Generate env file path
      const envFilePath = path.join(targetDirectory, 'l1-interface.env')

      const newVars: Record<string, string> = {}

      // Process each environment variable from the YAML
      for (const [key, value] of Object.entries(envData)) {
        if (L1_INTERFACE_LOCAL_ENV_KEYS.has(key)) continue
        if (isUnsafeL1InterfaceEnvVar(key, value)) continue
        newVars[key] = value
      }

      const writeResult = this.writeEnvFile(envFilePath, newVars, {
        header: [`# L1 Interface ${this.capitalize(network)} Configuration`, ''],
        removeKey: isUnsafeL1InterfaceEnvVar,
      })

      if (!writeResult.changed) {
        this.log(chalk.green('✓ No changes detected in l1-interface.env - file is up to date'))
        return envFilePath
      }

      if (writeResult.updatedVars.length > 0) {
        this.log(chalk.green(`✓ Updated variables in l1-interface.env: ${writeResult.updatedVars.join(', ')}`))
      }

      if (writeResult.removedVars.length > 0) {
        this.log(chalk.green(`✓ Removed stale variables from l1-interface.env: ${writeResult.removedVars.join(', ')}`))
      }

      return envFilePath

    } catch (error) {
      throw new Error(`Failed to generate l1-interface.env: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private generateL2NodeEnvFiles(
    config: any | undefined,
    dogeConfig: DogeConfig,
    rpcPackageDir: string,
    loadBalancerDomains: Record<string, string> = {},
    namespace: string,
    valuesDir: string,
  ): L2NodeEnvGenerationResult {
    const {network} = dogeConfig
    const networkTitleCase = this.capitalize(network)
    const targetDirectory = path.resolve(rpcPackageDir, 'envs', network)
    const envFilePath = path.join(targetDirectory, 'l2geth.env')
    const envFilePathReth = path.join(targetDirectory, 'l2reth.env')
    const l2RpcYamlPath = path.resolve(valuesDir, 'l2-rpc-production.yaml')

    // Create directory structure
    fs.mkdirSync(targetDirectory, { recursive: true })

    if (!fs.existsSync(l2RpcYamlPath)) {
      throw new Error(`l2-rpc-production.yaml not found at: ${l2RpcYamlPath}`)
    }

    const l2RpcEnvData = this.loadConfigMapEnvData(l2RpcYamlPath)
    const l2gethVars: EnvVarMap = {...l2RpcEnvData}

    if (!l2gethVars.CHAIN_ID && config?.general?.CHAIN_ID_L2 !== undefined) {
      l2gethVars.CHAIN_ID = String(config.general.CHAIN_ID_L2)
    }

    if (!l2gethVars.L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK && dogeConfig?.defaults?.dogecoinIndexerStartHeight) {
      l2gethVars.L2GETH_L1_CONTRACT_DEPLOYMENT_BLOCK = dogeConfig.defaults.dogecoinIndexerStartHeight
    }

    if (!l2gethVars.L2GETH_L1_ENDPOINT) {
      l2gethVars.L2GETH_L1_ENDPOINT = L1_INTERFACE_RPC_ENDPOINT
    }

    if (!l2gethVars.L2GETH_DA_BLOB_BEACON_NODE) {
      l2gethVars.L2GETH_DA_BLOB_BEACON_NODE = L1_INTERFACE_BEACON_API_ENDPOINT
    }

    const peerListValue = this.resolveExternalPeerList(l2gethVars.L2GETH_PEER_LIST, config, loadBalancerDomains)
    if (peerListValue) {
      l2gethVars.L2GETH_PEER_LIST = peerListValue
    }

    const validSigner = this.resolveL2RethValidSigner(config, valuesDir)
    if (!validSigner) {
      this.warn('Unable to resolve L2RETH_VALID_SIGNER from config.toml or l1-interface-production.yaml')
    }

    const l2rethVars: EnvVarMap = {}
    if (l2gethVars.L2GETH_PEER_LIST) {
      l2rethVars.L2GETH_PEER_LIST = l2gethVars.L2GETH_PEER_LIST
    }

    l2rethVars.L2RETH_DA_BLOB_BEACON_NODE = l2gethVars.L2GETH_DA_BLOB_BEACON_NODE || L1_INTERFACE_BEACON_API_ENDPOINT
    l2rethVars.L2RETH_L1_ENDPOINT = l2gethVars.L2GETH_L1_ENDPOINT || L1_INTERFACE_RPC_ENDPOINT
    if (validSigner) {
      l2rethVars.L2RETH_VALID_SIGNER = validSigner
    }

    const gethWriteResult = this.writeEnvFile(envFilePath, l2gethVars, {
      header: [
        `# L2Geth ${networkTitleCase} Configuration`,
        '# Generated for external RPC package usage',
        '',
        '# Network specific settings',
      ],
      removeKey: key => isCelestiaEnvKey(key) || key.startsWith('L2RETH_'),
    })

    const rethWriteResult = this.writeEnvFile(envFilePathReth, l2rethVars, {
      header: [
        `# L2Reth ${networkTitleCase} Configuration`,
        '# Generated for external RPC package usage',
        '',
        '# Network specific settings',
      ],
      removeKey: key => isCelestiaEnvKey(key) || key === 'CHAIN_ID' || (key.startsWith('L2GETH_') && key !== 'L2GETH_PEER_LIST'),
    })

    if (gethWriteResult.changed) {
      this.logEnvWriteChanges('l2geth.env', gethWriteResult)
    } else {
      this.log(chalk.green('✓ No changes detected in l2geth.env - file is up to date'))
    }

    if (rethWriteResult.changed) {
      this.logEnvWriteChanges('l2reth.env', rethWriteResult)
    } else {
      this.log(chalk.green('✓ No changes detected in l2reth.env - file is up to date'))
    }

    const hasUnresolvedExternalPeers = hasUnresolvedExternalPeer(l2gethVars.L2GETH_PEER_LIST) ||
      hasUnresolvedExternalPeer(l2rethVars.L2GETH_PEER_LIST)

    if (hasUnresolvedExternalPeers) {
      this.addLoadBalancerHint(envFilePath, namespace)
      this.addLoadBalancerHint(envFilePathReth, namespace)
    }

    return {
      hasUnresolvedExternalPeers,
      l2gethEnvPath: envFilePath,
      l2rethEnvPath: envFilePathReth,
    }
  }

  private async getLoadBalancerDomains(namespace: string): Promise<Record<string, string>> {
    try {
      const { execSync } = await import('node:child_process')

      // Run kubectl command to get LoadBalancer services
      const output = execSync(`kubectl get svc -n ${namespace} -o json`, {
        encoding: 'utf8',
        timeout: 10_000 // 10 second timeout
      })

      const services = JSON.parse(output)
      const loadBalancerDomains: Record<string, string> = {}

      // setup bootnode-public-p2p creates LoadBalancer services matching l2-bootnode-{N}-p2p.
      for (const service of services.items) {
        if (service.spec?.type === 'LoadBalancer' &&
          service.status?.loadBalancer?.ingress?.[0]) {

          const serviceName = service.metadata?.name
          if (serviceName && /^l2-bootnode-\d+-p2p$/.test(serviceName)) {
            const {hostname, ip} = service.status.loadBalancer.ingress[0]
            const endpoint = hostname || ip
            if (endpoint) {
              loadBalancerDomains[serviceName] = endpoint
            }
          }
        }
      }

      return loadBalancerDomains
    } catch (error) {
      this.log(chalk.yellow(`Warning: Failed to get LoadBalancer domains: ${error instanceof Error ? error.message : String(error)}`))
      return {}
    }
  }

  private loadConfig(configPath: string): any | undefined {
    const resolvedPath = path.resolve(configPath)

    if (!fs.existsSync(resolvedPath)) {
      return undefined
    }

    try {
      const configContent = fs.readFileSync(resolvedPath, 'utf8')
      return toml.parse(configContent) as any
    } catch (error) {
      throw new Error(`Failed to parse config.toml: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private loadConfigMapEnvData(yamlPath: string): EnvVarMap {
    const yamlContent = fs.readFileSync(yamlPath, 'utf8')
    const parsedYaml = yaml.load(yamlContent) as any
    if (!parsedYaml) {
      throw new Error(`Failed to parse ${path.basename(yamlPath)} - file appears to be empty or invalid`)
    }

    try {
      return normalizeConfigMapEnvData(parsedYaml.configMaps?.env?.data)
    } catch (error) {
      throw new Error(`${path.basename(yamlPath)} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private logEnvWriteChanges(fileName: string, result: EnvFileWriteResult): void {
    if (result.updatedVars.length > 0) {
      this.log(chalk.green(`✓ Updated variables in ${fileName}: ${result.updatedVars.join(', ')}`))
    }

    if (result.removedVars.length > 0) {
      this.log(chalk.green(`✓ Removed stale variables from ${fileName}: ${result.removedVars.join(', ')}`))
    }
  }

  private resolveExternalPeerList(
    yamlPeerListValue: string | undefined,
    config: any | undefined,
    loadBalancerDomains: Record<string, string>,
  ): string | undefined {
    const configBootnodePeers = config?.bootnode?.L2_GETH_PUBLIC_PEERS
    if (Array.isArray(configBootnodePeers) && configBootnodePeers.length > 0) {
      return JSON.stringify(convertPeersToExternalDomains(configBootnodePeers.map(String), loadBalancerDomains))
    }

    const yamlPeers = parsePeerListValue(yamlPeerListValue)
    if (yamlPeers) {
      return JSON.stringify(convertPeersToExternalDomains(yamlPeers, loadBalancerDomains))
    }

    const staticPeers = config?.sequencer?.L2_GETH_STATIC_PEERS
    if (Array.isArray(staticPeers) && staticPeers.length > 0) {
      return JSON.stringify(convertPeersToExternalDomains(staticPeers.map(String), loadBalancerDomains))
    }

    const legacyPublicPeers = config?.sequencer?.L2_GETH_PUB_PEERS
    if (Array.isArray(legacyPublicPeers) && legacyPublicPeers.length > 0) {
      return JSON.stringify(convertPeersToExternalDomains(legacyPublicPeers.map(String), loadBalancerDomains))
    }

    return yamlPeerListValue
  }

  private resolveL2RethValidSigner(config: any | undefined, valuesDir: string): string | undefined {
    if (config?.sequencer?.L2GETH_SIGNER_ADDRESS) {
      return String(config.sequencer.L2GETH_SIGNER_ADDRESS)
    }

    const l1InterfaceYamlPath = path.resolve(valuesDir, 'l1-interface-production.yaml')
    if (!fs.existsSync(l1InterfaceYamlPath)) return undefined

    try {
      const l1InterfaceEnvData = this.loadConfigMapEnvData(l1InterfaceYamlPath)
      return l1InterfaceEnvData.DOGEOS_L1_INTERFACE_INITIAL_SYSTEM_SIGNER
    } catch {
      return undefined
    }
  }

  private writeEnvFile(
    envFilePath: string,
    newVars: EnvVarMap,
    options: {
      header: string[]
      removeKey?: (key: string, value: string | undefined) => boolean
    },
  ): EnvFileWriteResult {
    const existingContent = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : ''
    const existingLines = existingContent ? existingContent.split('\n') : []
    if (existingLines.at(-1) === '') existingLines.pop()

    const {content, removedVars, updatedVars} = mergeEnvFileContent(existingLines, newVars, options)
    const changed = content !== existingContent
    if (changed) {
      fs.writeFileSync(envFilePath, content)
    }

    return {
      changed,
      removedVars,
      updatedVars,
    }
  }

}
