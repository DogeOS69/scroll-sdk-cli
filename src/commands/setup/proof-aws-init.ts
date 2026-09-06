import {confirm, input, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'
import { sanitizeName, truncateIamRoleName } from '../../utils/kms-signer-provisioner.js'
import {
  DEFAULT_PROOF_AWS_CONFIG,
  LEGACY_SHARED_PROOF_SECRET_NAME,
  buildProofAwsConfig,
  defaultProofSecretName,
  readOptionalProofAwsConfig,
  writeProofAwsConfig,
} from '../../utils/proof-aws-config.js'
import {ProofAwsDiscovery} from '../../utils/proof-aws-discovery.js'
import {
  type ProofArtifactPublicReadMode,
  ProofAwsProvisioner,
  normalizeProofArtifactPublicEndpoint,
  normalizeProofBucketName,
  proofArtifactS3Endpoint,
} from '../../utils/proof-aws-provisioner.js'
import {readSharedArtifactStore} from '../../utils/proof-shared-artifact-store.js'

export const PROOF_AWS_INIT_NEXT_STEPS =
  'run scrollsdk setup proof-materials, then scrollsdk setup doge-config --proof-topology, '
  + 'then run scrollsdk setup prep-charts'

export default class ProofAwsInit extends Command {
  static override description = 'Provision proof AWS resources and persist their non-secret resource facts as prep-charts input; never read or modify generated Helm values'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --aws-region us-west-2 --eks-cluster dogeos-testnet --deployment-alias dev0829 --artifact-public-read-mode direct-s3 -N',
    '<%= config.bin %> <%= command.id %> --artifact-public-read-mode existing-gateway --artifact-public-endpoint-url https://objects.example.com',
    '<%= config.bin %> <%= command.id %> --rotate-tokens',
  ]

  static override flags = {
    'artifact-public-endpoint-url': Flags.string({description: 'Existing credential-free HTTPS S3-compatible gateway root; used only with --artifact-public-read-mode=existing-gateway'}),
    'artifact-public-read-mode': Flags.string({description: 'Public proof artifact delivery: direct anonymous S3 prefix read, or an existing HTTPS gateway backed by private S3', options: ['direct-s3', 'existing-gateway']}),
    'artifact-read-route-table-id': Flags.string({description: 'Advanced override: EKS subnet route table to associate with the S3 gateway endpoint (repeatable; normally auto-discovered)', multiple: true}),
    'artifact-read-vpc-endpoint-id': Flags.string({description: 'Advanced override: existing S3 Gateway VPC endpoint (normally auto-discovered or created)'}),
    'aws-profile': Flags.string({ description: 'AWS CLI profile used for provisioning' }),
    'aws-region': Flags.string({description: 'AWS region containing EKS and the proof token secret (auto-detected when omitted)'}),
    bucket: Flags.string({ description: 'Advanced consistency assertion for the shared artifact bucket; the value is read from doge-config' }),
    config: Flags.string({ default: DEFAULT_PROOF_AWS_CONFIG, description: 'Output config file consumed by setup prep-charts' }),
    'coordinator-service-account': Flags.string({description: 'Kubernetes service account used by proof-coordinator (default: proof-coordinator)'}),
    'deployment-alias': Flags.string({description: 'Unique deployment instance alias used to derive deterministic bucket and IAM role names'}),
    'doge-config': Flags.string({default: '.data/doge-config.toml', description: 'DogeOS config containing the canonical ethereumDa.blobArchive.s3 store'}),
    'eks-cluster': Flags.string({description: 'EKS cluster name used by the IRSA trust policies (selected interactively when omitted)'}),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'key-prefix': Flags.string({description: 'Advanced consistency assertion for the shared artifact key prefix; the value is read from doge-config'}),
    namespace: Flags.string({description: 'Kubernetes namespace of the proof workloads (default: default)'}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Run without prompts; missing values must be discoverable, already configured, or passed as flags'}),
    'rotate-tokens': Flags.boolean({ default: false, description: 'Replace the proof-work/prover-worker tokens in an existing secret (both workloads must be restarted afterwards)' }),
    'secret-name': Flags.string({description: 'Secrets Manager secret holding proof-work-token and prover-worker-token (default: scroll/<deployment-alias>/proof-coordinator-secrets)'}),
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
      const shared = readSharedArtifactStore('.', flags['doge-config']).store
      const discovery = new ProofAwsDiscovery(flags['aws-profile'])
      const awsRegion = await this.resolveRequiredValue({
        defaultValue: existing?.kubernetes.awsRegion || discovery.configuredRegion(),
        explicit: flags['aws-region'],
        flag: '--aws-region',
        message: 'Enter the AWS region containing the EKS cluster:',
        nonInteractive,
      })
      const eksCluster = await this.resolveEksCluster({
        configured: existing?.kubernetes.eksCluster,
        discovery,
        explicit: flags['eks-cluster'],
        nonInteractive,
        region: awsRegion,
      })
      const deploymentAlias = await this.resolveRequiredValue({
        defaultValue: existing?.kubernetes.deploymentAlias
          || (nonInteractive ? undefined : sanitizeName(path.basename(process.cwd()))),
        explicit: flags['deployment-alias'],
        flag: '--deployment-alias',
        message: 'Enter a unique alias for this DogeOS deployment instance (for example dev0829):',
        nonInteractive,
      })
      const alias = sanitizeName(deploymentAlias)
      if (!alias) {
        throw new Error('deployment alias must contain at least one ASCII letter or digit')
      }

      const cluster = sanitizeName(eksCluster)
      const bucket = normalizeProofBucketName(shared.bucket)
      if (flags.bucket && normalizeProofBucketName(flags.bucket) !== bucket) {
        throw new Error(`--bucket must match canonical ethereumDa.blobArchive.s3.bucket (${bucket})`)
      }

      const defaultPublicReadMode = existing?.artifactReadTransport.publicReadMode || 'direct-s3'
      let publicReadMode = flags['artifact-public-read-mode'] as ProofArtifactPublicReadMode | undefined
      if (!publicReadMode) {
        if (nonInteractive) {
          if (!existing?.artifactReadTransport.publicReadMode) {
            throw new Error(
              '--artifact-public-read-mode is required in non-interactive mode when .data/proof-aws.json does not provide it',
            )
          }

          publicReadMode = existing.artifactReadTransport.publicReadMode
        } else {
          publicReadMode = await select({
            choices: [
              {
                name: 'Direct AWS S3 (public GetObject only for required DA/proof object paths)',
                value: 'direct-s3',
              },
              {
                name: 'Existing HTTPS gateway (keep the S3 bucket private)',
                value: 'existing-gateway',
              },
            ],
            default: defaultPublicReadMode,
            message: 'How should external Workers and partner Signers read proof artifacts?',
          }) as ProofArtifactPublicReadMode
        }
      }

      if (publicReadMode === 'direct-s3' && flags['artifact-public-endpoint-url']) {
        throw new Error(
          '--artifact-public-endpoint-url is only valid with --artifact-public-read-mode=existing-gateway',
        )
      }

      const publicEndpointUrl = publicReadMode === 'direct-s3'
        ? proofArtifactS3Endpoint(shared.region)
        : await this.resolveRequiredValue({
            defaultValue: existing?.artifactReadTransport.publicReadMode === 'existing-gateway'
              ? existing.artifactReadTransport.publicEndpointUrl
              : undefined,
            explicit: flags['artifact-public-endpoint-url'],
            flag: '--artifact-public-endpoint-url',
            message: 'Enter the existing credential-free HTTPS S3-compatible gateway root:',
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

      if (shared.region !== awsRegion && advancedVpcInput) {
        throw new Error(
          `S3 Gateway endpoint overrides cannot be used because EKS is in ${awsRegion} while the shared artifact bucket is in ${shared.region}`,
        )
      }

      const configureVpcEndpoint = shared.region !== awsRegion || flags['skip-vpc-endpoint']
        ? false
        : nonInteractive || advancedVpcInput
          ? true
          : await confirm({
              default: true,
              message: 'Configure EKS-internal S3 routing through an auto-discovered Gateway VPC endpoint?',
            })
      const namespace = flags.namespace || existing?.kubernetes.namespace || 'default'
      const {keyPrefix} = shared
      if (flags['key-prefix'] && flags['key-prefix'] !== keyPrefix) {
        throw new Error(`--key-prefix must match canonical ethereumDa.blobArchive.s3.keyPrefix (${keyPrefix})`)
      }

      const sameDeployment = existing?.kubernetes.deploymentAlias === deploymentAlias
      const reusableSecretName = sameDeployment
        && existing?.secret.name !== LEGACY_SHARED_PROOF_SECRET_NAME
        ? existing?.secret.name
        : undefined
      const secretName = flags['secret-name']
        || reusableSecretName
        || defaultProofSecretName(alias)
      const coordinatorServiceAccount = flags['coordinator-service-account']
        || existing?.serviceAccounts.proofCoordinator.name
        || 'proof-coordinator'
      const withdrawalServiceAccount = flags['withdrawal-service-account']
        || existing?.serviceAccounts.withdrawalProcessor.name
        || 'withdrawal-processor'
      const canReuseVpcFacts = shared.region === awsRegion
        && existing?.artifactStore.region === shared.region
        && existing.kubernetes.awsRegion === awsRegion
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
        this.log(`  EKS/secret AWS region:  ${awsRegion}`)
        this.log(`  EKS cluster/namespace:  ${eksCluster} / ${namespace}`)
        this.log(`  Shared DA/proof store:  s3://${bucket}/${keyPrefix} (${shared.region})`)
        this.log(`  Public read mode:       ${publicReadMode}`)
        this.log(`  External artifact endpoint: ${publicEndpointUrl}`)
        this.log(`  EKS S3 Gateway route:   ${configureVpcEndpoint ? 'auto-discover/create' : 'skipped'}`)
        this.log(`  Secrets Manager secret: ${secretName}`)
        this.log('')
        if (!(await confirm({default: true, message: 'Create or update the AWS resources shown above?'}))) {
          throw new Error('proof AWS provisioning cancelled')
        }
      }

      const provisioner = new ProofAwsProvisioner(json, flags['aws-profile'])
      const identity = {
        artifactRegion: shared.region,
        awsRegion,
        deploymentAlias,
        eksCluster,
        namespace,
      }
      const result = provisioner.provision(
        identity,
        {
          artifactRead: {
            publicEndpointUrl,
            publicReadMode,
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
          artifactRegion: shared.region,
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
        + PROOF_AWS_INIT_NEXT_STEPS,
      )
      json.addWarning(
        result.artifactReadTransport.publicReadMode === 'direct-s3'
          ? `anonymous GetObject is limited to the required external-consumer object paths under s3://${result.bucket}/${keyPrefix}; the segmentation sidecar, list/write/delete remain private, but external reachability is unverified`
          : `the partner/external artifact route ${result.artifactReadTransport.publicEndpointUrl} is operator-managed and unverified; scroll-sdk-cli did not change the bucket policy or Public Access Block settings`,
      )
      json.addWarning(
        'require HTTP 200 for one exact digest-scoped object from every external Worker and partner Signer network before activation',
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
    explicit?: string
    nonInteractive: boolean
    region: string
  }): Promise<string> {
    if (options.explicit?.trim()) return options.explicit.trim()
    if (options.nonInteractive) {
      if (options.configured?.trim()) return options.configured.trim()
      throw new Error('--eks-cluster is required in non-interactive mode when .data/proof-aws.json does not provide it')
    }

    const clusters = options.discovery.eksClusters(options.region)
    if (clusters.length === 0) {
      return this.resolveRequiredValue({
        defaultValue: options.configured,
        flag: '--eks-cluster',
        message: `No EKS clusters were listed in ${options.region}; enter the cluster name:`,
        nonInteractive: false,
      })
    }

    const choices = clusters.map(cluster => ({name: cluster, value: cluster}))
    if (options.configured && !clusters.includes(options.configured)) {
      choices.unshift({
        name: `${options.configured} (configured previously; not returned in ${options.region})`,
        value: options.configured,
      })
    }

    return select({
      choices,
      default: options.configured,
      message: `Select the EKS cluster in ${options.region}:`,
    })
  }

  private async resolveRequiredValue(options: {
    defaultValue?: string
    explicit?: string
    flag: string
    message: string
    nonInteractive: boolean
    normalize?: (value: string) => string
  }): Promise<string> {
    const normalize = options.normalize || ((value: string) => value.trim())
    if (options.explicit?.trim()) return normalize(options.explicit)
    const defaultValue = options.defaultValue?.trim()
      ? normalize(options.defaultValue)
      : undefined
    if (options.nonInteractive) {
      if (defaultValue) return defaultValue
      throw new Error(`${options.flag} is required in non-interactive mode when it cannot be discovered or reused`)
    }

    return input({
      default: defaultValue,
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
