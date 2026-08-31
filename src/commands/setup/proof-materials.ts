import {confirm, input, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {
  DEFAULT_MOCK_PROVER_WORKER_IMAGE,
  DEFAULT_PROOF_MATERIALS_RECEIPT,
  DEFAULT_PROOF_MATERIALS_ROOT,
  DEFAULT_PROOF_TOPOLOGY_COMPILER_IMAGE,
  prepareProofMaterials,
  resolveImmutableProofImage,
} from '../../utils/proof-materials.js'

export default class ProofMaterials extends Command {
  static description = 'Prepare shared proof identities for mock, or identities plus real proving artifacts for production'

  static examples = [
    '$ scrollsdk setup proof-materials --generation mock',
    '$ scrollsdk setup proof-materials --generation real --software-manifest /build/real-proving-artifacts.json --identity-env /build/real-identity.env --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --mock-worker-image repo/mock@sha256:... --production-worker-image repo/worker@sha256:... --compiler-image repo/compiler@sha256:...',
    '$ scrollsdk setup proof-materials --generation real --bridge-artifact-dir /build/bridge --protocol-context .data/protocol_context.json',
  ]

  static flags = {
    'batch-materializer': Flags.string({description: 'Built dogeos-core Batch materializer binary; real only'}),
    'bridge-artifact-dir': Flags.string({description: 'Optional output of prover-worker --stage-bridge-artifact; real only'}),
    'chunk-materializer': Flags.string({description: 'Built dogeos-core Chunk materializer binary; real only'}),
    'compiler-image': Flags.string({description: `dogeos-proof-topology release tag or digest (default: ${DEFAULT_PROOF_TOPOLOGY_COMPILER_IMAGE})`}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment directory'}),
    generation: Flags.string({description: 'Materials to prepare: mock imports shared identities only; real imports the full proving release', options: ['mock', 'real']}),
    'identity-env': Flags.string({description: 'Optional real-identity.env for staging real identities during mock; required for real'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'materials-dir': Flags.string({default: DEFAULT_PROOF_MATERIALS_ROOT, description: 'Deployment-relative material destination'}),
    'mock-worker-image': Flags.string({description: `Mock Worker release tag or digest (default: ${DEFAULT_MOCK_PROVER_WORKER_IMAGE})`}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Do not prompt; omitted generation defaults to mock'}),
    output: Flags.string({default: DEFAULT_PROOF_MATERIALS_RECEIPT, description: 'Deployment-relative receipt path'}),
    'production-worker-image': Flags.string({description: 'Real Worker release tag or digest; real only'}),
    'protocol-context': Flags.string({description: 'Deployment protocol_context.json required with --bridge-artifact-dir; real only'}),
    'software-manifest': Flags.string({description: 'real-proving-artifacts.json written by dogeos-core --check-only; real only'}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ProofMaterials)
    const output = new JsonOutputContext('setup proof-materials', flags.json)
    try {
      const required = async (value: string | undefined, message: string, name: string, defaultValue?: string): Promise<string> => {
        if (value?.trim()) return value.trim()
        if (flags['non-interactive']) {
          if (defaultValue) return defaultValue
          throw new Error(`Missing required flag --${name}`)
        }

        return input({default: defaultValue, message, validate: answer => answer.trim() === '' ? 'A value is required' : true})
      }

      const deploymentDir = path.resolve(flags['deployment-dir'])
      const generation = (flags.generation ?? (flags['non-interactive'] ? 'mock' : await select({
        choices: [
          {name: 'Mock — use dogeos-core synthetic identities (no OpenVM materials or local compilation)', value: 'mock'},
          {name: 'Real — import the complete production proving materials', value: 'real'},
        ],
        default: 'mock',
        message: 'Which proof generation materials do you want to prepare?',
      }))) as 'mock' | 'real'
      if (generation === 'mock' && [
        flags['batch-materializer'],
        flags['bridge-artifact-dir'],
        flags['chunk-materializer'],
        flags['production-worker-image'],
        flags['protocol-context'],
        flags['software-manifest'],
      ].some(Boolean)) {
        throw new Error('Real-only flags were supplied with --generation mock; remove them or select --generation real')
      }

      const identityEnv = generation === 'real'
        ? await required(flags['identity-env'], 'Enter the dogeos-core real-identity.env path:', 'identity-env')
        : flags['identity-env']?.trim()
      const softwareManifest = generation === 'real' ? await required(flags['software-manifest'], 'Enter the dogeos-core real-proving artifact manifest path:', 'software-manifest') : undefined
      const chunkMaterializer = generation === 'real' ? await required(flags['chunk-materializer'], 'Enter the built Chunk materializer binary path:', 'chunk-materializer') : undefined
      const batchMaterializer = generation === 'real' ? await required(flags['batch-materializer'], 'Enter the built Batch materializer binary path:', 'batch-materializer') : undefined
      const compilerImage = await required(
        flags['compiler-image'],
        'Enter the dogeos-core proof-topology compiler image:',
        'compiler-image',
        DEFAULT_PROOF_TOPOLOGY_COMPILER_IMAGE,
      )
      const mockWorkerImage = await required(
        flags['mock-worker-image'],
        'Enter the dogeos-core mock Worker image:',
        'mock-worker-image',
        DEFAULT_MOCK_PROVER_WORKER_IMAGE,
      )
      const productionWorkerImage = generation === 'real'
        ? await required(flags['production-worker-image'], 'Enter the real Worker release tag or immutable digest:', 'production-worker-image')
        : undefined

      let bridgeArtifactDir = generation === 'real' ? flags['bridge-artifact-dir'] : undefined
      if (generation === 'real' && !flags['non-interactive'] && bridgeArtifactDir === undefined) {
        const include = await confirm({
          default: false,
          message: 'Import a deployment-bound Bridge bake now?',
        })
        if (include) {
          bridgeArtifactDir = await input({
            message: 'Enter the directory written by prover-worker --stage-bridge-artifact:',
            validate: answer => answer.trim() === '' ? 'A directory is required' : true,
          })
        }
      }

      let protocolContext = flags['protocol-context']
      if (bridgeArtifactDir) {
        protocolContext = await required(
          protocolContext,
          'Enter the protocol_context.json used for this Bridge bake:',
          'protocol-context',
        )
      }

      const result = prepareProofMaterials({
        batchMaterializer: batchMaterializer ? path.resolve(batchMaterializer) : undefined,
        bridgeArtifactDir: bridgeArtifactDir ? path.resolve(bridgeArtifactDir) : undefined,
        chunkMaterializer: chunkMaterializer ? path.resolve(chunkMaterializer) : undefined,
        deploymentDir,
        generation,
        identityEnv: identityEnv ? path.resolve(identityEnv) : undefined,
        images: {
          mockWorker: resolveImmutableProofImage(mockWorkerImage, '--mock-worker-image'),
          ...(productionWorkerImage ? {
            productionWorker: resolveImmutableProofImage(productionWorkerImage, '--production-worker-image'),
          } : {}),
          topologyCompiler: resolveImmutableProofImage(compilerImage, '--compiler-image'),
        },
        outputReceipt: flags.output,
        outputRoot: flags['materials-dir'],
        producerManifest: softwareManifest ? path.resolve(softwareManifest) : undefined,
        protocolContext: protocolContext ? path.resolve(protocolContext) : undefined,
      })

      output.logSuccess(`Prepared proof materials ${result.receiptPath}`)
      if (generation === 'mock') {
        output.addWarning(result.receipt.software.identitySource === 'dogeos_core_synthetic_mock_v1'
          ? 'Prepared PR #937 synthetic identities for mock/observe only; rerun proof-materials --generation real before selecting real generation'
          : 'Prepared real identities without real program files; mock is available, but real generation still requires the full real materials path')
      } else if (!result.receipt.bridge) {
        output.addWarning('Bridge material is not present; mock generation can be configured, but real full-topology preflight remains unavailable')
      }

      if (!result.receipt.images.productionWorker) {
        output.addWarning('Production Worker image is not staged; disabled/mock are available, and generation=real remains unavailable')
      }

      output.success({
        bridgePrepared: Boolean(result.receipt.bridge),
        generation,
        receipt: result.receiptPath,
        schema: result.receipt.schema,
      })
    } catch (error) {
      output.error(
        'E731_PROOF_MATERIALS_FAILED',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
      )
    }
  }
}
