/* eslint-disable @typescript-eslint/no-explicit-any -- TOML and bitcore expose dynamic values */
import * as toml from '@iarna/toml'
import { input } from '@inquirer/prompts'
import { Command, Flags } from '@oclif/core'
import bitcore from 'bitcore-lib-doge'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'

import type { DeploymentSpec } from '../../types/deployment-spec.js'
import type { DogeConfig } from '../../types/doge-config.js'
import type { ResolvedAttestationSignerTopology } from '../../utils/deployment-spec-generator.js'

import { getSetupDefaultsPath } from '../../config/constants.js'
import { deriveCompressedSecp256k1PublicKeyFromSpkiDer, getAttestationSignerKmsRole } from '../../utils/attestation-kms.js'
import { loadDeploymentSpec, resolveAttestationSignerTopology, validateDeploymentSpec } from '../../utils/deployment-spec-generator.js'
import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { KmsSignerProvisioner, normalizeEksClusterName } from '../../utils/kms-signer-provisioner.js'
import { resolveEnvValue } from '../../utils/non-interactive.js'

const { Networks, PrivateKey } = bitcore
type Backend = 'aws_kms' | 'local'

function csv(value: string | undefined): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) || []
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function serviceUrl(releaseName: string): string {
  return `http://${releaseName}:4040`
}

function publicKeyFromWif(wif: string): string {
  return PrivateKey.fromWIF(wif).toPublicKey().toString()
}

function generateWif(network: string): string {
  const selected = network === 'mainnet'
    ? Networks.livenet
    : network === 'regtest' && (Networks as any).regtest
      ? (Networks as any).regtest
      : Networks.testnet
  return new PrivateKey(null, selected).toWIF()
}

export class AttestationSignerCommand extends Command {
  static description = 'Provision Kubernetes attestation-signer releases and select the bootstrap bridge keyset'

  static examples = [
    '$ scrollsdk setup attestation-signer --from-spec deployment-spec.yaml',
    '$ scrollsdk setup attestation-signer --signer-count 5 --active-signer-ids signer-0,signer-1,signer-2 --threshold 2',
    '$ scrollsdk setup attestation-signer --backend aws-kms --aws-region us-west-2 --eks-cluster dogeos-testnet --namespace dogeos',
  ]

  static flags = {
    'active-signer-ids': Flags.string({ description: 'Comma-separated signer IDs used only by initial bridge setup (M of N)' }),
    'aws-profile': Flags.string({ description: 'AWS CLI profile used for KMS and IAM provisioning' }),
    'aws-region': Flags.string({ description: 'AWS region for KMS keys and the EKS cluster' }),
    backend: Flags.string({ description: 'Kubernetes signer backend', options: ['aws-kms', 'local'] }),
    config: Flags.string({ char: 'c', description: 'Path to doge-config.toml' }),
    'eks-cluster': Flags.string({ description: 'EKS cluster name used by IRSA trust policies' }),
    'from-spec': Flags.string({ description: 'DeploymentSpec providing signer fleet, initial keyset, and profile' }),
    'generate-wif-keys': Flags.boolean({ allowNo: true, default: true, description: 'Generate local WIF keys' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'kms-key-ids': Flags.string({ description: 'Optional KMS IDs in signer instance order' }),
    'kms-role-arns': Flags.string({ description: 'Optional existing IRSA role ARNs in signer instance order' }),
    namespace: Flags.string({ description: 'Kubernetes namespace used by IRSA trust policies' }),
    'network-alias': Flags.string({ description: 'Stable deployment alias used for AWS resource names' }),
    'non-interactive': Flags.boolean({ char: 'N', default: false, description: 'Run without prompts' }),
    'signer-count': Flags.string({ description: 'Number of deployed signer releases (N)' }),
    threshold: Flags.string({ description: 'Initial bridge attestation threshold (T)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(AttestationSignerCommand)
    const json = new JsonOutputContext('setup attestation-signer', flags.json)
    const spec = flags['from-spec'] ? loadDeploymentSpec(path.resolve(flags['from-spec'])) : undefined
    if (spec) {
      const validation = validateDeploymentSpec(spec)
      if (!validation.valid) this.error(`DeploymentSpec validation failed: ${validation.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
    }

    const loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
    const { config } = loaded
    const topology = this.resolveTopology(spec, flags, config)
    const requestedProfile = spec?.signing.attestationSigner?.profile || config.attestationSigner?.profile || 'staging-local'
    const backend: Backend = flags.backend
      ? flags.backend === 'aws-kms' ? 'aws_kms' : 'local'
      : requestedProfile.endsWith('-kms') ? 'aws_kms' : 'local'

    if (requestedProfile === 'production-kms' && backend !== 'aws_kms') {
      this.error('production-kms requires the aws-kms backend')
    }

    this.log(chalk.blue(`Provisioning ${topology.instances.length} Kubernetes signer releases; ${topology.activeSignerIds.length} enter bridge init at threshold ${topology.threshold}.`))
    const instances = backend === 'aws_kms'
      ? await this.provisionKms(config, topology, flags, json)
      : await this.provisionLocal(config, topology, flags)

    config.attestationSigner = {
      activeSignerIds: topology.activeSignerIds,
      backend,
      instances,
      profile: requestedProfile,
      threshold: topology.threshold,
      ...(backend === 'aws_kms' ? {
        kms: {
          awsProfile: flags['aws-profile'],
          eksCluster: normalizeEksClusterName(resolveEnvValue(flags['eks-cluster']) || config.attestationSigner?.kms?.eksCluster || ''),
          instances: instances.map(instance => ({
            expectedSignerId: instance.expectedSignerId,
            index: instance.index,
            kmsKeyId: instance.kmsKeyId as string,
            roleArn: instance.roleArn as string,
            serviceAccount: instance.serviceAccount,
          })),
          namespace: resolveEnvValue(flags.namespace) || config.attestationSigner?.kms?.namespace || 'default',
          networkAlias: resolveEnvValue(flags['network-alias']) || config.attestationSigner?.kms?.networkAlias || config.network,
          region: resolveEnvValue(flags['aws-region']) || config.attestationSigner?.kms?.region || 'us-east-1',
        },
      } : {}),
    }
    config.signerUrls = topology.activeSignerIds.map(id => serviceUrl(instances.find(instance => instance.id === id)!.releaseName))
    fs.writeFileSync(loaded.configPath, dogeConfigToToml(config))
    this.writeInitialBridgeConfig(instances, topology.activeSignerIds, topology.threshold)

    const result = {
      activeSignerIds: topology.activeSignerIds,
      backend,
      instances,
      profile: requestedProfile,
      signerCount: instances.length,
      signerUrls: config.signerUrls,
      threshold: topology.threshold,
    }
    if (flags.json) json.success(result)
    else this.log(chalk.green(`Configured ${instances.length} signer releases; bridge init will use ${topology.activeSignerIds.join(', ')}.`))
  }

  private async provisionKms(config: DogeConfig, topology: ReturnType<AttestationSignerCommand['resolveTopology']>, flags: any, json: JsonOutputContext): Promise<NonNullable<DogeConfig['attestationSigner']>['instances']> {
    const existing = config.attestationSigner?.kms
    const region = resolveEnvValue(flags['aws-region']) || existing?.region || 'us-east-1'
    const eksCluster = normalizeEksClusterName(resolveEnvValue(flags['eks-cluster']) || existing?.eksCluster || '')
    if (!eksCluster) this.error('--eks-cluster is required for aws-kms')
    const namespace = resolveEnvValue(flags.namespace) || existing?.namespace || 'default'
    const networkAlias = resolveEnvValue(flags['network-alias']) || existing?.networkAlias || config.network
    const suppliedKeys = csv(resolveEnvValue(flags['kms-key-ids']))
    const suppliedRoles = csv(resolveEnvValue(flags['kms-role-arns']))
    const provisioner = new KmsSignerProvisioner(json, resolveEnvValue(flags['aws-profile']))

    const output: NonNullable<DogeConfig['attestationSigner']>['instances'] = []
    for (const instance of topology.instances) {
      const previous = config.attestationSigner?.instances?.find(item => item.id === instance.id)
      const provisioned = await provisioner.provision(
        getAttestationSignerKmsRole(instance.id),
        { awsRegion: region, eksCluster, namespace, networkAlias },
        {
          kmsKeyId: suppliedKeys[instance.index] || instance.kmsKeyId || previous?.kmsKeyId,
          roleArn: suppliedRoles[instance.index] || instance.roleArn || previous?.roleArn,
          serviceAccount: instance.serviceAccount,
        }
      )
      output.push({
        expectedSignerId: deriveCompressedSecp256k1PublicKeyFromSpkiDer(provisioned.publicKeyBase64),
        id: instance.id,
        index: instance.index,
        kmsKeyId: provisioned.signerConfig.kmsKeyId,
        releaseName: instance.releaseName,
        roleArn: provisioned.roleArn,
        serviceAccount: instance.serviceAccount,
      })
    }

    return output
  }

  private async provisionLocal(config: DogeConfig, topology: ReturnType<AttestationSignerCommand['resolveTopology']>, flags: any): Promise<NonNullable<DogeConfig['attestationSigner']>['instances']> {
    const shouldGenerate = flags['generate-wif-keys'] !== false
    const output: NonNullable<DogeConfig['attestationSigner']>['instances'] = []
    fs.mkdirSync(path.join(process.cwd(), 'secrets'), { recursive: true })
    for (const instance of topology.instances) {
      let wif: string
      const secretFile = path.join(process.cwd(), 'secrets', `${instance.releaseName}.env`)
      const existingWif = fs.existsSync(secretFile)
        ? fs.readFileSync(secretFile, 'utf8').match(/^ATTESTATION_SIGNER_WIF=(.+)$/m)?.[1]
        : undefined

      if (existingWif) wif = existingWif
      else if (shouldGenerate) wif = generateWif(config.network)
      else if (flags['non-interactive']) this.error(`WIF for ${instance.id} is required when --no-generate-wif-keys is used non-interactively`)
      else wif = await input({ message: `WIF for ${instance.id}`, required: true })
      fs.writeFileSync(secretFile, `ATTESTATION_SIGNER_WIF=${wif!}\n`, { mode: 0o600 })
      output.push({
        expectedSignerId: publicKeyFromWif(wif!),
        id: instance.id,
        index: instance.index,
        releaseName: instance.releaseName,
        serviceAccount: instance.serviceAccount,
      })
    }

    return output
  }

  private resolveTopology(spec: DeploymentSpec | undefined, flags: any, config: DogeConfig): ResolvedAttestationSignerTopology {
    const fromSpec = spec ? resolveAttestationSignerTopology(spec) : undefined
    const count = positiveInteger(flags['signer-count'], fromSpec?.instances.length || config.attestationSigner?.instances?.length || 3, 'signer-count')
    const instances = fromSpec?.instances || Array.from({ length: count }, (_value, index) => {
      const id = `signer-${index}`
      const releaseName = `attestation-signer-${index}`
      return { id, index, releaseName, serviceAccount: releaseName }
    })
    if (instances.length !== count && flags['signer-count']) throw new Error('--signer-count conflicts with DeploymentSpec instances')
    const requestedActiveSignerIds = csv(flags['active-signer-ids'])
    const activeSignerIds = requestedActiveSignerIds.length > 0
      ? requestedActiveSignerIds
      : fromSpec?.activeSignerIds || config.attestationSigner?.activeSignerIds || instances.map(instance => instance.id)
    const threshold = positiveInteger(flags.threshold, fromSpec?.threshold || config.attestationSigner?.threshold || Math.ceil(activeSignerIds.length * 2 / 3), 'threshold')
    const known = new Set(instances.map(instance => instance.id))
    if (new Set(activeSignerIds).size !== activeSignerIds.length || activeSignerIds.some(id => !known.has(id))) throw new Error('active-signer-ids must be unique members of the signer fleet')
    if (threshold > activeSignerIds.length) throw new Error('threshold cannot exceed the initial active signer count')
    return { activeSignerIds, instances, threshold }
  }

  private writeInitialBridgeConfig(instances: NonNullable<DogeConfig['attestationSigner']>['instances'], activeIds: string[], threshold: number): void {
    const file = getSetupDefaultsPath()
    if (!fs.existsSync(file)) this.error('setup_defaults.toml not found; run scrollsdk setup doge-config first')
    const data = toml.parse(fs.readFileSync(file, 'utf8')) as any
    const pubkeys = activeIds.map(id => instances.find(instance => instance.id === id)!.expectedSignerId)
    data.attestation_pubkeys = pubkeys
    data.attestation_key_count = pubkeys.length
    data.attestation_threshold = threshold
    fs.writeFileSync(file, toml.stringify(data))
  }
}

export default AttestationSignerCommand
