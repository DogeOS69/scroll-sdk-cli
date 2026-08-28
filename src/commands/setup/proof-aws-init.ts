import {confirm, input, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {loadDogeNetworkFromDogeConfig} from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { sanitizeName, truncateIamRoleName } from '../../utils/kms-signer-provisioner.js'
import {
  DEFAULT_PROOF_AWS_CONFIG,
  buildProofAwsConfig,
  readOptionalProofAwsConfig,
  writeProofAwsConfig,
} from '../../utils/proof-aws-config.js'
import {ProofAwsDiscovery} from '../../utils/proof-aws-discovery.js'
import {
  ProofAwsProvisioner,
  normalizeProofArtifactPublicEndpoint,
} from '../../utils/proof-aws-provisioner.js'

export const DEFAULT_PROOF_SECRET_NAME = 'scroll/proof-coordinator-secrets'

export default class ProofAwsInit extends Command {
  static override description = 'Provision proof AWS resources and persist their non-secret resource facts as prep-charts input; never read or modify generated Helm values'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet --artifact-public-endpoint-url https://objects.example.com -N',
    '<%= config.bin %> <%= command.id %> --bucket my-proof-artifacts --rotate-tokens',
  ]

  static override flags = {
    'artifact-public-endpoint-url': Flags.string({description: 'Credential-free HTTPS S3-compatible endpoint root reachable by external Workers and partner Attestation Signers'}),
    'artifact-read-route-table-id': Flags.string({description: 'Advanced override: EKS subnet route table to associate with the S3 gateway endpoint (repeatable; normally auto-discovered)', multiple: true}),
    'artifact-read-vpc-endpoint-id': Flags.string({description: 'Advanced override: existing S3 Gateway VPC endpoint (normally auto-discovered or created)'}),
    'aws-profile': Flags.string({ description: 'AWS CLI profile used for provisioning' }),
    'aws-region': Flags.string({description: 'AWS region for the bucket, roles, and secret (auto-detected when omitted)'}),
    bucket: Flags.string({ description: 'Proof artifact S3 bucket (default: dogeos-<network-alias>-proof-artifacts)' }),
    config: Flags.string({ default: DEFAULT_PROOF_AWS_CONFIG, description: 'Output config file consumed by setup prep-charts' }),
    'coordinator-service-account': Flags.string({description: 'Kubernetes service account used by proof-coordinator (default: proof-coordinator)'}),
    'eks-cluster': Flags.string({description: 'EKS cluster name used by the IRSA trust policies (selected interactively when omitted)'}),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'key-prefix': Flags.string({description: 'Object key prefix for the proof artifact store (default: proof-topology)'}),
    namespace: Flags.string({description: 'Kubernetes namespace of the proof workloads (default: default)'}),
    'network-alias': Flags.string({description: 'Resource alias used to derive deterministic bucket and IAM role names (defaults to doge-config network)'}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Run without prompts; missing values must be discoverable, already configured, or passed as flags'}),
    'rotate-tokens': Flags.boolean({ default: false, description: 'Replace the proof-work/prover-worker tokens in an existing secret (both workloads must be restarted afterwards)' }),
    'secret-name': Flags.string({description: `Secrets Manager secret holding proof-work-token and prover-worker-token (default: ${DEFAULT_PROOF_SECRET_NAME})`}),
    'skip-vpc-endpoint': Flags.boolean({default: false, description: 'Do not auto-discover or create an S3 Gateway VPC endpoint for EKS-internal S3 traffic'}),
    'withdrawal-service-account': Flags.string({description: 'Kubernetes service account used by withdrawal-processor (default: withdrawal-processor)'}),
    yes: Flags.boolean({char: 'y', default: false, description: 'Apply the displayed AWS resource plan without confirmation'}),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofAwsInit)
    const json = new JsonOutputContext('setup proof-aws-init', flags.json)
    try {
      const nonInteractive = flags['non-interactive'] || flags.json
      const existing = readOptionalProofAwsConfig('.', flags.config)?.config
      const discovery = new ProofAwsDiscovery(flags['aws-profile'])
      const awsRegion = await this.resolveRequiredValue({
        configured: flags['aws-region'] || existing?.artifactStore.region || discovery.configuredRegion(),
        flag: '--aws-region',
        message: 'Enter the AWS region containing the EKS cluster:',
        nonInteractive,
      })
      const eksCluster = await this.resolveEksCluster({
        configured: flags['eks-cluster'] || existing?.kubernetes.eksCluster,
        discovery,
        nonInteractive,
        region: awsRegion,
      })
      const dogeConfigPath = path.resolve('.data/doge-config.toml')
      const dogeNetwork = fs.existsSync(dogeConfigPath)
        ? loadDogeNetworkFromDogeConfig(dogeConfigPath)
        : undefined
      const networkAlias = await this.resolveRequiredValue({
        configured: flags['network-alias'] || existing?.kubernetes.networkAlias || dogeNetwork,
        flag: '--network-alias',
        message: 'Enter the deployment network alias used in AWS resource names:',
        nonInteractive,
      })
      const alias = sanitizeName(networkAlias)
      const cluster = sanitizeName(eksCluster)
      const bucket = flags.bucket
        || (existing?.kubernetes.networkAlias === networkAlias
          ? existing.artifactStore.bucket
          : undefined)
        || `dogeos-${alias}-proof-artifacts`
      if (!nonInteractive
        && !flags['artifact-public-endpoint-url']
        && !existing?.artifactReadTransport.publicEndpointUrl) {
        this.log('')
        this.log('External Workers and partner Attestation Signers fetch proof objects without AWS credentials.')
        this.log('The CLI keeps S3 private, so enter the root of your controlled public S3-compatible gateway.')
        this.log(`It must serve this bucket as https://${bucket}.<gateway-host>/<key-prefix>/...`)
        this.log('')
      }

      const publicEndpointUrl = await this.resolveRequiredValue({
        configured: flags['artifact-public-endpoint-url']
          || existing?.artifactReadTransport.publicEndpointUrl,
        flag: '--artifact-public-endpoint-url',
        message: 'Enter the credential-free HTTPS S3-compatible endpoint root reachable by partner Signers:',
        nonInteractive,
        normalize: normalizeProofArtifactPublicEndpoint,
      })
      const advancedVpcInput = Boolean(
        flags['artifact-read-vpc-endpoint-id']
        || flags['artifact-read-route-table-id']?.length,
      )
      if (flags['skip-vpc-endpoint'] && advancedVpcInput) {
        throw new Error(
          '--skip-vpc-endpoint cannot be combined with --artifact-read-vpc-endpoint-id or --artifact-read-route-table-id',
        )
      }

      const configureVpcEndpoint = flags['skip-vpc-endpoint']
        ? false
        : nonInteractive || flags.yes || advancedVpcInput
          ? true
          : await confirm({
              default: true,
              message: 'Configure EKS-internal S3 routing through an auto-discovered Gateway VPC endpoint?',
            })
      const namespace = flags.namespace || existing?.kubernetes.namespace || 'default'
      const keyPrefix = flags['key-prefix'] || existing?.artifactStore.keyPrefix || 'proof-topology'
      const secretName = flags['secret-name'] || existing?.secret.name || DEFAULT_PROOF_SECRET_NAME
      const coordinatorServiceAccount = flags['coordinator-service-account']
        || existing?.serviceAccounts.proofCoordinator.name
        || 'proof-coordinator'
      const withdrawalServiceAccount = flags['withdrawal-service-account']
        || existing?.serviceAccounts.withdrawalProcessor.name
        || 'withdrawal-processor'
      const canReuseVpcFacts = existing?.artifactStore.region === awsRegion
        && existing.kubernetes.eksCluster === eksCluster
      const artifactReadVpcEndpointId = flags['artifact-read-vpc-endpoint-id']
        || (canReuseVpcFacts
          ? existing?.artifactReadTransport.vpcEndpoint?.vpcEndpointId
          : undefined)
      const artifactReadRouteTableIds = flags['artifact-read-route-table-id']?.length
        ? flags['artifact-read-route-table-id']
        : canReuseVpcFacts
          ? existing?.artifactReadTransport.vpcEndpoint?.routeTableIds
          : undefined

      if (!nonInteractive && !flags.yes) {
        this.log('')
        this.log('Proof AWS resource plan:')
        this.log(`  AWS region:             ${awsRegion}`)
        this.log(`  EKS cluster/namespace:  ${eksCluster} / ${namespace}`)
        this.log(`  S3 artifact prefix:     s3://${bucket}/${keyPrefix}`)
        this.log(`  Partner HTTPS endpoint: ${publicEndpointUrl}`)
        this.log(`  EKS S3 Gateway route:   ${configureVpcEndpoint ? 'auto-discover/create' : 'skipped'}`)
        this.log(`  Secrets Manager secret: ${secretName}`)
        this.log('')
        if (!(await confirm({default: true, message: 'Provision or reconcile these AWS resources?'}))) {
          throw new Error('proof AWS provisioning cancelled')
        }
      }

      const provisioner = new ProofAwsProvisioner(json, flags['aws-profile'])
      const identity = {
        awsRegion,
        eksCluster,
        namespace,
        networkAlias,
      }
      const result = provisioner.provision(
        identity,
        {
          artifactRead: {
            publicEndpointUrl,
            ...(configureVpcEndpoint
              ? {
                  vpcEndpoint: {
                    enabled: true,
                    routeTableIds: artifactReadRouteTableIds,
                    vpcEndpointId: artifactReadVpcEndpointId,
                  },
                }
              : {}),
          },
          bucket,
          coordinatorRole: {
            description: 'DogeOS proof-coordinator artifact store role',
            roleName: truncateIamRoleName(`dogeos-${alias}-${cluster}-proof-coordinator`),
            serviceAccount: coordinatorServiceAccount,
          },
          keyPrefix,
          rotateTokens: flags['rotate-tokens'],
          secretName,
          withdrawalRole: {
            description: 'DogeOS withdrawal-processor proof transport role',
            roleName: truncateIamRoleName(`dogeos-${alias}-${cluster}-wp-proof`),
            serviceAccount: withdrawalServiceAccount,
          },
        }
      )

      const configResult = writeProofAwsConfig(
        path.resolve(flags.config),
        buildProofAwsConfig({
          coordinatorServiceAccount,
          identity,
          keyPrefix,
          provisioned: result,
          withdrawalServiceAccount,
        }),
      )

      json.logSuccess(`Provisioned proof AWS resources: bucket=${result.bucket} secret=${result.secretName} (${result.secretAction})`)
      json.logSuccess(
        `${configResult.changed ? 'Wrote' : 'Reused'} proof AWS config ${configResult.filePath}; `
        + 'run scrollsdk setup prep-charts once to generate final values and deployment contract',
      )
      json.addWarning(
        `the partner/external artifact route ${result.artifactReadTransport.publicEndpointUrl} is recorded but operator-managed and unverified; require HTTP 200 for one exact digest-scoped object from every external Worker and partner Signer network before activation`,
      )
      if (result.artifactReadTransport.vpcEndpoint) {
        json.addWarning(
          `EKS-internal credential-free GET and route-table associations are configured via ${result.artifactReadTransport.vpcEndpoint.vpcEndpointId}, but this private route does not provide access to partner Signers outside the VPC`,
        )
      }

      json.success({
        ...result,
        config: configResult.config,
        configChanged: configResult.changed,
        files: [configResult.filePath],
      })
    } catch (error) {
      json.error('E710_PROOF_AWS_INIT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  private async resolveEksCluster(options: {
    configured?: string
    discovery: ProofAwsDiscovery
    nonInteractive: boolean
    region: string
  }): Promise<string> {
    if (options.configured?.trim()) return options.configured.trim()
    if (options.nonInteractive) {
      throw new Error('--eks-cluster is required in non-interactive mode when .data/proof-aws.json does not provide it')
    }

    const clusters = options.discovery.eksClusters(options.region)
    if (clusters.length === 0) {
      return this.resolveRequiredValue({
        flag: '--eks-cluster',
        message: `No EKS clusters were listed in ${options.region}; enter the cluster name:`,
        nonInteractive: false,
      })
    }

    return select({
      choices: clusters.map(cluster => ({name: cluster, value: cluster})),
      message: `Select the EKS cluster in ${options.region}:`,
    })
  }

  private async resolveRequiredValue(options: {
    configured?: string
    flag: string
    message: string
    nonInteractive: boolean
    normalize?: (value: string) => string
  }): Promise<string> {
    const normalize = options.normalize || ((value: string) => value.trim())
    if (options.configured?.trim()) return normalize(options.configured)
    if (options.nonInteractive) {
      throw new Error(`${options.flag} is required in non-interactive mode when it cannot be discovered or reused`)
    }

    return input({
      message: options.message,
      validate(value) {
        try {
          return normalize(value) ? true : `${options.flag} must not be empty`
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    }).then(normalize)
  }
}
