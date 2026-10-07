import {confirm, input, select} from '@inquirer/prompts'
import {Command, Flags} from '@oclif/core'
import path from 'node:path'

import {JsonOutputContext} from '../../utils/json-output.js'
import {
  DEFAULT_PROOF_MATERIALS_RECEIPT,
  DEFAULT_PROOF_MATERIALS_ROOT,
  prepareProofMaterials,
  resolveImmutableProofImage,
} from '../../utils/proof-materials.js'
import {readProofReleasePreparation} from '../../utils/proof-release-preparation.js'
import {
  assertProofWorkerImageMatchesPreparation,
  readProofWorkerImageCheck,
} from '../../utils/proof-worker-image-check.js'

export default class ProofMaterials extends Command {
  static description = 'Prepare shared proof identities for mock, or identities plus real proving artifacts for production'

  static examples = [
    '$ scrollsdk setup proof-materials --generation mock',
    '$ scrollsdk setup proof-materials --generation mock --identity-env /build/real-identity.env --worker-identity-bundle /build/worker-identity-bundle.json',
    '$ scrollsdk setup proof-materials --generation real --artifact-root /build/bake --expected-core-revision <40-hex-sha> --identity-env /build/bake/real-identity.env --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --production-worker-image repo/worker@sha256:... --compiler-image repo/compiler@sha256:...',
    '$ scrollsdk setup proof-materials --generation real --bridge-artifact-dir /build/bake/bridge --protocol-context .data/protocol_context.json',
    '$ scrollsdk setup proof-materials --preparation-receipt .data/proof-release-preparation-v1.json --production-worker-receipt .data/proof-worker-image-check-v1.json --chunk-materializer /build/materialize-chunk-oneshot --batch-materializer /build/scroll-runtime-materializer --compiler-image repo/compiler@sha256:...',
  ]

  static flags = {
    'aggregate-verifying-key': Flags.string({description: 'Root aggregate verifying key; required with mock real-materialization and supplied by --artifact-root for real generation'}),
    'artifact-root': Flags.string({description: 'prepare-real output holding chunk/, batch/ and verifier/aggregate-vk; real only'}),
    'batch-materializer': Flags.string({description: 'scroll-runtime-materializer from the release proof-coordinator image (setup proof-image-tools --action export); required for real materialization'}),
    'bridge-artifact-dir': Flags.string({description: 'Optional output of prover-worker --stage-bridge-artifact, including worker-identity-bundle.json; real only'}),
    'chunk-materializer': Flags.string({description: 'materialize-chunk-oneshot from the release proof-coordinator image (setup proof-image-tools --action export); required for real materialization'}),
    'compiler-image': Flags.string({description: 'dogeos-proof-topology tag or digest from the approved release lineage'}),
    'deployment-dir': Flags.string({default: '.', description: 'Deployment directory'}),
    'expected-core-revision': Flags.string({description: 'Full dogeos-core Git SHA that baked --artifact-root; real only'}),
    generation: Flags.string({description: 'Materials to prepare: mock imports shared identities only; real imports the full proving release', options: ['mock', 'real']}),
    'identity-env': Flags.string({description: 'Optional real-identity.env for staging real identities during mock; required for real'}),
    json: Flags.boolean({default: false, description: 'Output structured JSON'}),
    'materials-dir': Flags.string({default: DEFAULT_PROOF_MATERIALS_ROOT, description: 'Deployment-relative material destination'}),
    'mock-worker-image': Flags.string({description: 'Mock Worker tag or digest; plain mock only, where it supplies the compiler identity'}),
    'non-interactive': Flags.boolean({char: 'N', default: false, description: 'Do not prompt; omitted generation defaults to mock'}),
    output: Flags.string({default: DEFAULT_PROOF_MATERIALS_RECEIPT, description: 'Deployment-relative receipt path'}),
    'preparation-receipt': Flags.string({description: 'Validated proof-release-preparation-v1.json; supplies every real-material flag except the materializers'}),
    'production-worker-image': Flags.string({description: 'Real Worker release tag or digest; real only'}),
    'production-worker-receipt': Flags.string({description: 'Validated proof-worker-image-check-v1.json; excludes --production-worker-image'}),
    'protocol-context': Flags.string({description: 'Deployment protocol_context.json required with --bridge-artifact-dir; real only'}),
    'worker-identity-bundle': Flags.string({description: 'Canonical worker-identity-bundle.json from the matching dogeos-core bake; required for mock proving with real materialization'}),
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
      const preparation = flags['preparation-receipt']
        ? readProofReleasePreparation(path.resolve(deploymentDir, flags['preparation-receipt']))
        : undefined
      if (flags['production-worker-image'] && flags['production-worker-receipt']) {
        throw new Error('--production-worker-image and --production-worker-receipt are mutually exclusive')
      }

      const workerImageCheck = flags['production-worker-receipt']
        ? readProofWorkerImageCheck(path.resolve(deploymentDir, flags['production-worker-receipt']))
        : undefined
      if (preparation && workerImageCheck) assertProofWorkerImageMatchesPreparation(workerImageCheck, preparation)

      const manualPreparationFlags = [
        'aggregate-verifying-key',
        'artifact-root',
        'bridge-artifact-dir',
        'expected-core-revision',
        'identity-env',
        'protocol-context',
        'worker-identity-bundle',
      ] as const
      if (preparation) {
        const conflicting = manualPreparationFlags.find(flag => flags[flag])
        if (conflicting) {
          throw new Error(`--preparation-receipt cannot be combined with --${conflicting}`)
        }
      }

      const generation = (flags.generation ?? (preparation ? 'real' : flags['non-interactive'] ? 'mock' : await select({
        choices: [
          {name: 'Mock — import canonical identity from the pinned mock Worker image (no local compilation)', value: 'mock'},
          {name: 'Real — import the complete production proving materials', value: 'real'},
        ],
        default: 'mock',
        message: 'Which proof generation materials do you want to prepare?',
      }))) as 'mock' | 'real'
      if (preparation && generation !== 'real') {
        throw new Error('--preparation-receipt requires --generation real')
      }

      if (generation === 'mock' && [
        flags['bridge-artifact-dir'],
        flags['production-worker-image'],
        flags['production-worker-receipt'],
        flags['protocol-context'],
        flags['artifact-root'],
        flags['expected-core-revision'],
      ].some(Boolean)) {
        throw new Error('Real-only flags were supplied with --generation mock; remove them or select --generation real')
      }

      if (flags['worker-identity-bundle'] && !(generation === 'mock' && flags['identity-env'])) {
        throw new Error('--worker-identity-bundle requires mock with identity-env')
      }

      if (generation === 'real' && flags['aggregate-verifying-key']) {
        throw new Error('--aggregate-verifying-key is supplied by --artifact-root for --generation real')
      }

      const identityEnv = generation === 'real'
        ? preparation?.files.identityEnv.path
          ?? await required(flags['identity-env'], 'Enter the dogeos-core real-identity.env path:', 'identity-env')
        : flags['identity-env']?.trim()
      const workerIdentityBundle = generation === 'mock' && identityEnv
        ? await required(
          flags['worker-identity-bundle'],
          'Enter the matching dogeos-core worker-identity-bundle.json path:',
          'worker-identity-bundle',
        )
        : flags['worker-identity-bundle']?.trim()
      const aggregateVerifyingKey = generation === 'mock' && identityEnv
        ? await required(
          flags['aggregate-verifying-key'],
          'Enter the root aggregate verifying key path:',
          'aggregate-verifying-key',
        )
        : undefined
      let scrollArtifacts: Parameters<typeof prepareProofMaterials>[0]['scrollArtifacts']
      if (generation === 'real') {
        if (preparation) {
          const {scroll} = preparation.files
          scrollArtifacts = {
            aggregateVerifyingKey: scroll.aggregateVerifyingKey.path, batchAppConfig: scroll.batchAppConfig.path, batchAppExe: scroll.batchAppExe.path,
            chunkAppConfig: scroll.chunkAppConfig.path, chunkAppExe: scroll.chunkAppExe.path, coreRevision: preparation.coreRevision,
          }
        } else {
          const root = path.resolve(await required(flags['artifact-root'], 'Enter the prepare-real output directory:', 'artifact-root'))
          scrollArtifacts = {
            aggregateVerifyingKey: path.join(root, 'verifier/aggregate-vk'), batchAppConfig: path.join(root, 'batch/openvm.toml'), batchAppExe: path.join(root, 'batch/app.vmexe'),
            chunkAppConfig: path.join(root, 'chunk/openvm.toml'), chunkAppExe: path.join(root, 'chunk/app.vmexe'),
            coreRevision: await required(flags['expected-core-revision'], 'Enter the full dogeos-core revision that baked it:', 'expected-core-revision'),
          }
        }
      }

      const usesRealMaterializers = generation === 'real' || Boolean(identityEnv)
      const chunkMaterializer = usesRealMaterializers
        ? await required(flags['chunk-materializer'], 'Enter the release coordinator\'s Chunk materializer binary path:', 'chunk-materializer')
        : undefined
      const batchMaterializer = usesRealMaterializers
        ? await required(flags['batch-materializer'], 'Enter the release coordinator\'s Batch materializer binary path:', 'batch-materializer')
        : undefined
      const compilerImage = await required(
        flags['compiler-image'],
        'Enter the approved dogeos-core proof-topology compiler image:',
        'compiler-image',
      )
      const productionWorkerImage = generation === 'real'
        ? workerImageCheck
          ? `${workerImageCheck.image.repository}@${workerImageCheck.image.digest}`
          : await required(flags['production-worker-image'], 'Enter the real Worker release tag or immutable digest:', 'production-worker-image')
        : undefined

      let bridgeArtifactDir = generation === 'real'
        ? preparation ? path.dirname(preparation.files.bridge.nativeManifest.path) : flags['bridge-artifact-dir']
        : undefined
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

      let protocolContext = preparation?.files.protocolContext.path ?? flags['protocol-context']
      if (bridgeArtifactDir) {
        protocolContext = await required(
          protocolContext,
          'Enter the protocol_context.json used for this Bridge bake:',
          'protocol-context',
        )
      }

      // The compiler identity comes from the Bridge bake (real) or an imported bundle
      // (mock real-materialize); only plain mock extracts it from a mock Worker image.
      const bakedIdentity = generation === 'real' && bridgeArtifactDir
        ? path.join(bridgeArtifactDir, 'worker-identity-bundle.json')
        : undefined
      const mockWorkerImage = bakedIdentity || workerIdentityBundle
        ? flags['mock-worker-image']
        : await required(
          flags['mock-worker-image'],
          'Enter the approved dogeos-core mock Worker image:',
          'mock-worker-image',
        )
      const result = prepareProofMaterials({
        aggregateVerifyingKey: aggregateVerifyingKey ? path.resolve(aggregateVerifyingKey) : undefined,
        batchMaterializer: batchMaterializer ? path.resolve(batchMaterializer) : undefined,
        bridgeArtifactDir: bridgeArtifactDir ? path.resolve(bridgeArtifactDir) : undefined,
        chunkMaterializer: chunkMaterializer ? path.resolve(chunkMaterializer) : undefined,
        deploymentDir,
        generation,
        identityEnv: identityEnv ? path.resolve(identityEnv) : undefined,
        images: {
          ...(mockWorkerImage ? {mockWorker: resolveImmutableProofImage(mockWorkerImage, '--mock-worker-image')} : {}),
          ...(productionWorkerImage ? {
            productionWorker: resolveImmutableProofImage(productionWorkerImage, '--production-worker-image'),
          } : {}),
          topologyCompiler: resolveImmutableProofImage(compilerImage, '--compiler-image'),
        },
        outputReceipt: flags.output,
        outputRoot: flags['materials-dir'],
        protocolContext: protocolContext ? path.resolve(protocolContext) : undefined,
        refreshExistingImages: generation === 'mock'
          && Boolean(flags['compiler-image'])
          && Boolean(flags['mock-worker-image'])
          && !identityEnv,
        scrollArtifacts,
        workerIdentityBundle: workerIdentityBundle ? path.resolve(workerIdentityBundle) : bakedIdentity && path.resolve(bakedIdentity),
      })

      output.logSuccess(`Prepared proof materials ${result.receiptPath}`)
      if (generation === 'mock') {
        output.addWarning(result.receipt.software.identitySource === 'dogeos_core_synthetic_mock_v1'
          ? 'Prepared canonical Worker identity plus synthetic placeholders: active/mock will use development one-chunk materialization; pass --identity-env to prepare real segmentation/materialization while keeping mock proving'
          : 'Prepared real identities without real proving files: active/mock will use real segmentation and subprocess materializers; generation=real still requires the full real materials path')
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
