import {Command, Flags} from '@oclif/core'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {loadDeploymentSpec, resolveDeploymentSpecEnvRefs, validateDeploymentSpec} from '../../utils/deployment-spec-generator.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {resolveDogecoinKubernetesEndpoints} from '../../utils/kubernetes-endpoints.js'
import {
  DEFAULT_PROOF_TOPOLOGY_OUTPUT,
  type DurableProofRows,
  type ProofTopologyPreflightMode,
  compileProofTopology,
} from '../../utils/proof-topology-compiler.js'

function discoverSpec(deploymentDir: string, explicit?: string): string {
  if (explicit) return path.resolve(deploymentDir, explicit)
  const matches = ['deployment-spec.yaml', 'deployment-spec.yml']
    .map(name => path.join(deploymentDir, name))
    .filter(file => fs.existsSync(file))
  if (matches.length === 0) {
    throw new Error(
      `no DeploymentSpec found in ${deploymentDir}; create deployment-spec.yaml or pass --spec`,
    )
  }

  if (matches.length > 1) {
    throw new Error(`multiple DeploymentSpec files found; select one with --spec: ${matches.join(', ')}`)
  }

  return matches[0]
}

export default class ProofTopologyCompile extends Command {
  static override description = 'Compile DeploymentSpec proofTopology through the pinned dogeos-core compiler; validates and installs a deployment-neutral bundle without touching Kubernetes'

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
      description: 'Override digest-pinned compiler image (repository@sha256:...); normally read from DeploymentSpec',
      exclusive: ['compiler-binary'],
    }),
    'deployment-dir': Flags.string({
      default: '.',
      description: 'Deployment root containing service base configs and DeploymentSpec',
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
      description: 'DeploymentSpec path; defaults to deployment-spec.yaml/yml in --deployment-dir',
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
      const specPath = discoverSpec(deploymentDir, flags.spec)
      if (!fs.existsSync(specPath)) throw new Error(`DeploymentSpec not found: ${specPath}`)
      const spec = resolveDeploymentSpecEnvRefs(loadDeploymentSpec(specPath))
      const validation = validateDeploymentSpec(spec)
      for (const warning of validation.warnings) {
        json.addWarning(`${warning.path}: ${warning.message}`)
      }

      if (!validation.valid) {
        throw new Error(
          `DeploymentSpec validation failed:\n${validation.errors
            .map(error => `- ${error.path}: ${error.message}`)
            .join('\n')}`,
        )
      }

      if (!spec.proofTopology) {
        throw new Error(`${specPath}: proofTopology is required`)
      }

      const endpoints = resolveDogecoinKubernetesEndpoints({
        kubernetes: spec.dogecoin.kubernetes,
        network: spec.dogecoin.network,
      })
      const clusterRpc = spec.dogecoin.clusterRpc || {
        password: spec.dogecoin.rpc?.password || '',
        username: spec.dogecoin.rpc?.username || '',
      }
      const result = compileProofTopology({
        bridge: {
          dogecoinNetwork: spec.dogecoin.network,
          dogecoinRpcPassword: clusterRpc.password,
          dogecoinRpcUrl: endpoints.rpcUrl,
          dogecoinRpcUser: clusterRpc.username,
        },
        compilerBinary: flags['compiler-binary'],
        compilerImage: flags['compiler-image'],
        deploymentDir,
        durableProofRows: flags['durable-proof-rows'] as DurableProofRows,
        ethDaSubmitterBaseConfig: flags['eth-da-submitter-config'],
        ethereumL1RpcUrl: spec.ethereumDa?.l1RpcUrl,
        lastActiveDigest: flags['last-active-digest'],
        outputDir: flags.preflight && flags.output === DEFAULT_PROOF_TOPOLOGY_OUTPUT
          ? `.data/generated/proof-topology-preflight-${flags.preflight}`
          : flags.output,
        preflightMode: flags.preflight as ProofTopologyPreflightMode | undefined,
        previousSidecar: flags['previous-sidecar'],
        proofCoordinatorBaseConfig: flags['proof-coordinator-config'],
        spec,
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
