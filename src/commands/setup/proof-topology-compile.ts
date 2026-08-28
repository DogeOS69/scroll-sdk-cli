import {Command, Flags} from '@oclif/core'
import * as path from 'node:path'

import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {resolveDogecoinKubernetesEndpoints} from '../../utils/kubernetes-endpoints.js'
import {resolveProofIntent} from '../../utils/proof-intent.js'
import {
  DEFAULT_PROOF_TOPOLOGY_OUTPUT,
  type DurableProofRows,
  type ProofTopologyPreflightMode,
  compileProofTopology,
} from '../../utils/proof-topology-compiler.js'

export default class ProofTopologyCompile extends Command {
  static override description = 'Compile proof topology from doge-config or DeploymentSpec through the pinned dogeos-core compiler without touching Kubernetes'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --deployment-dir .',
    '<%= config.bin %> <%= command.id %> --preflight production',
    '<%= config.bin %> <%= command.id %> --compiler-binary /workspace/dogeos-core/target/release/dogeos-proof-topology',
  ]

  static override flags = {
    'compiler-binary': Flags.string({
      description: 'Development-only local compiler binary; production uses proofTopology.compiler.image',
      exclusive: ['compiler-image'],
    }),
    'compiler-image': Flags.string({
      description: 'Override the configured digest-pinned compiler image (repository@sha256:...)',
      exclusive: ['compiler-binary'],
    }),
    'deployment-dir': Flags.string({
      default: '.',
      description: 'Deployment root containing service base configs and .data/doge-config.toml',
    }),
    'doge-config': Flags.string({
      description: 'doge-config.toml path; defaults to .data/doge-config.toml in --deployment-dir',
    }),
    'durable-proof-rows': Flags.string({
      default: 'unknown',
      description: 'Whether durable proof rows exist; used only for transition planning',
      options: ['yes', 'no', 'unknown'],
    }),
    'eth-da-submitter-config': Flags.string({
      description: 'Optional deployment-relative native submitter base config; omission emits a mergeable patch',
    }),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'last-active-digest': Flags.string({
      description: 'Last active proof-generation digest used when reactivating from disabled',
    }),
    output: Flags.string({
      default: DEFAULT_PROOF_TOPOLOGY_OUTPUT,
      description: 'Deployment-relative output directory atomically replaced after full validation',
    }),
    preflight: Flags.string({
      description: 'Validate a dormant profile without changing the checked-in mode or producing an applyable bundle',
      options: ['mock', 'production'],
    }),
    'previous-sidecar': Flags.string({
      description: 'Previous resolved-v1.json; defaults to the currently installed bundle sidecar',
    }),
    'proof-coordinator-config': Flags.string({
      default: 'proof-coordinator/ProofCoordinator.toml',
      description: 'Deployment-relative Proof Coordinator base config',
    }),
    spec: Flags.string({
      description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]',
    }),
    'withdrawal-processor-config': Flags.string({
      default: 'withdrawal-processor/WithdrawalProcessor.toml',
      description: 'Deployment-relative Withdrawal Processor base config',
    }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ProofTopologyCompile)
    const json = new JsonOutputContext('setup proof-topology-compile', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const configPath = flags['doge-config']
        ? path.resolve(deploymentDir, flags['doge-config'])
        : path.join(deploymentDir, '.data/doge-config.toml')
      const {config} = await loadDogeConfigWithSelection(
        configPath,
        'scrollsdk setup doge-config',
      )
      const resolved = resolveProofIntent({
        deploymentDir,
        dogeConfig: config,
        dogeConfigPath: configPath,
        specPath: flags.spec,
      })!
      for (const warning of resolved.warnings) json.addWarning(warning)

      const endpoints = resolveDogecoinKubernetesEndpoints({
        kubernetes: config.kubernetes,
        network: config.network,
      })
      const clusterRpc = config.dogecoinClusterRpc || {password: '', username: ''}
      const result = compileProofTopology({
        bridge: {
          dogecoinNetwork: config.network,
          dogecoinRpcPassword: clusterRpc.password || '',
          dogecoinRpcUrl: endpoints.rpcUrl,
          dogecoinRpcUser: clusterRpc.username || '',
        },
        compilerBinary: flags['compiler-binary'],
        compilerImage: flags['compiler-image'],
        deploymentDir,
        deploymentName: resolved.deploymentName,
        durableProofRows: flags['durable-proof-rows'] as DurableProofRows,
        ethDaSubmitterBaseConfig: flags['eth-da-submitter-config'],
        ethereumL1RpcUrl: config.ethereumDa?.submitterRpcUrl,
        lastActiveDigest: flags['last-active-digest'],
        network: resolved.network,
        outputDir: flags.preflight && flags.output === DEFAULT_PROOF_TOPOLOGY_OUTPUT
          ? `.data/generated/proof-topology-preflight-${flags.preflight}`
          : flags.output,
        preflightMode: flags.preflight as ProofTopologyPreflightMode | undefined,
        previousSidecar: flags['previous-sidecar'],
        proofCoordinatorBaseConfig: flags['proof-coordinator-config'],
        proofTopology: resolved.proofTopology,
        withdrawalProcessorBaseConfig: flags['withdrawal-processor-config'],
      })

      json.logSuccess(
        `${result.manifest.preflight_only ? 'Preflighted' : 'Compiled'} proof topology ${result.mode}`,
      )
      json.logKeyValue('Proof generation digest', result.plan.to_digest)
      json.logKeyValue('Deployment revision', result.plan.to_deployment_revision)
      json.logKeyValue('Bundle', result.bundleDir)
      if (result.plan.requires_proof_regeneration) {
        json.addWarning(
          `Transition requires durable proof-layer regeneration (${String(result.plan.regeneration)})`,
        )
      }

      json.success({
        bundleDir: result.bundleDir,
        deploymentRevision: result.plan.to_deployment_revision,
        digest: result.plan.to_digest,
        mode: result.mode,
        preflightOnly: result.manifest.preflight_only,
        requiresProofRegeneration: result.plan.requires_proof_regeneration,
        rolloutPlan: result.plan,
        worker: result.worker,
      })
    } catch (error) {
      json.error(
        'E716_PROOF_TOPOLOGY_COMPILE_FAILED',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
      )
    }
  }
}
