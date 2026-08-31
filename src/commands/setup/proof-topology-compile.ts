import {Command, Flags} from '@oclif/core'
import * as path from 'node:path'

import {loadDogeConfigWithSelection} from '../../utils/doge-config.js'
import {JsonOutputContext} from '../../utils/json-output.js'
import {resolveDogecoinServiceRpcUrl} from '../../utils/kubernetes-endpoints.js'
import {resolveProofIntent} from '../../utils/proof-intent.js'
import {
  DEFAULT_PROOF_TOPOLOGY_OUTPUT,
  compileProofTopology,
} from '../../utils/proof-topology-compiler.js'

export default class ProofTopologyCompile extends Command {
  static description = 'Compile the selected proof topology through the pinned dogeos-core compiler without touching Kubernetes'

  static examples = [
    '<%= config.bin %> <%= command.id %> --deployment-dir .',
    '<%= config.bin %> <%= command.id %> --preflight mock',
  ]

  static flags = {
    'compiler-binary': Flags.string({description: 'Development-only local dogeos-proof-topology binary', exclusive: ['compiler-image']}),
    'compiler-image': Flags.string({description: 'Override the configured digest-pinned compiler image', exclusive: ['compiler-binary']}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment root'}),
    'doge-config': Flags.string({description: 'doge-config.toml path'}),
    'eth-da-submitter-config': Flags.string({description: 'Deployment-relative eth-da-submitter native base config'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    output: Flags.string({default: DEFAULT_PROOF_TOPOLOGY_OUTPUT, description: 'Deployment-relative output directory'}),
    preflight: Flags.string({description: 'Validate the staged active profile for this generation', options: ['mock', 'real']}),
    'proof-coordinator-config': Flags.string({default: 'proof-coordinator/ProofCoordinator.toml', description: 'Proof Coordinator base config'}),
    spec: Flags.string({description: 'Optional DeploymentSpec proof source'}),
    'withdrawal-processor-config': Flags.string({default: 'withdrawal-processor/WithdrawalProcessor.toml', description: 'Withdrawal Processor base config'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProofTopologyCompile)
    const output = new JsonOutputContext('setup proof-topology-compile', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const configPath = flags['doge-config']
        ? path.resolve(deploymentDir, flags['doge-config'])
        : path.join(deploymentDir, '.data/doge-config.toml')
      const {config} = await loadDogeConfigWithSelection(configPath, 'scrollsdk setup doge-config')
      const intent = resolveProofIntent({deploymentDir, dogeConfig: config, dogeConfigPath: configPath, required: true, specPath: flags.spec})!
      const clusterRpc = config.dogecoinClusterRpc || {password: '', username: ''}
      const result = compileProofTopology({
        bridge: {
          dogecoinNetwork: config.network,
          dogecoinRpcPassword: clusterRpc.password || '',
          dogecoinRpcUrl: resolveDogecoinServiceRpcUrl({kubernetes: config.kubernetes, network: config.network}),
          dogecoinRpcUser: clusterRpc.username || '',
        },
        compilerBinary: flags['compiler-binary'],
        compilerImage: flags['compiler-image'],
        deploymentDir,
        deploymentName: intent.deploymentName,
        ethDaSubmitterBaseConfig: flags['eth-da-submitter-config'],
        ethereumL1RpcUrl: config.ethereumDa?.submitterRpcUrl,
        network: intent.network,
        outputDir: flags.preflight && flags.output === DEFAULT_PROOF_TOPOLOGY_OUTPUT
          ? `.data/generated/proof-topology-preflight-${flags.preflight}`
          : flags.output,
        preflightMode: flags.preflight as 'mock' | 'real' | undefined,
        proofCoordinatorBaseConfig: flags['proof-coordinator-config'],
        proofTopology: intent.proofTopology,
        withdrawalProcessorBaseConfig: flags['withdrawal-processor-config'],
      })
      output.logSuccess(`${result.manifest.preflight_only ? 'Preflighted' : 'Compiled'} proof topology`)
      output.logKeyValue('Mode', result.mode)
      output.logKeyValue('Generation', result.generation)
      output.logKeyValue('Enforcement', result.enforcement)
      output.logKeyValue('Bundle revision', result.manifest.bundle_revision)
      output.logKeyValue('Bundle', result.bundleDir)
      output.success({
        bundleDir: result.bundleDir,
        bundleRevision: result.manifest.bundle_revision,
        enforcement: result.enforcement,
        generation: result.generation,
        mode: result.mode,
        preflightOnly: result.manifest.preflight_only,
        worker: result.worker,
      })
    } catch (error) {
      output.error('E716_PROOF_TOPOLOGY_COMPILE_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
