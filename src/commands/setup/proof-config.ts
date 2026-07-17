import { Command, Flags } from '@oclif/core'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofFamily, ProvingMode } from '../../utils/proof-configurator.js'

import { parseTomlConfig } from '../../utils/config-parser.js'
import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import {
  DEFAULT_BRIDGE_BACKEND_PROFILE,
  DEFAULT_PROOF_ARTIFACT_MANIFEST,
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  DEFAULT_SCROLL_BATCH_BACKEND_PROFILE,
  DEFAULT_STATEMENT_NAMESPACE_CONFIG,
  configureProofValues,
} from '../../utils/proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from '../../utils/proof-coordinator-scaffold.js'
import {
  PROVER_WORKER_MOCK_BUNDLE_DIR,
  readProverWorkerTokenFromSecretsManager,
  writeProverWorkerMockBundle,
} from '../../utils/prover-worker-mock-bundle.js'
import { WITHDRAWAL_NATIVE_CONFIG_RELPATH } from '../../utils/withdrawal-config.js'

export {
  DEFAULT_PROOF_ARTIFACT_MANIFEST,
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  DEFAULT_STATEMENT_NAMESPACE_CONFIG,
} from '../../utils/proof-configurator.js'

const PROOF_SECRET_NAME = 'scroll/proof-coordinator-secrets'
export const DEFAULT_PROOF_VALUES_DIR = 'values'
export const DEFAULT_DEPLOYMENT_CONFIG = 'config.toml'
export const DEFAULT_DOGE_CONFIG = '.data/doge-config.toml'

export interface ProofDeploymentPaths {
  artifactManifest: string
  coordinatorConfig: string
  deploymentConfig: string
  deploymentDir: string
  dogeConfig: string
  programManifests: string[]
  statementNamespace: string
  valuesDir: string
  withdrawalConfig: string
  workerBundleDir: string
}

function fromDeploymentRoot(root: string, override: string | undefined, conventionalPath: string): string {
  return path.resolve(root, override || conventionalPath)
}

/**
 * Resolve the proof deployment's conventional filesystem contract from one
 * root directory. Individual path flags remain escape hatches for migrations;
 * ordinary runs need only --deployment-dir (or no path flag from that root).
 */
export function resolveProofDeploymentPaths(options: {
  artifactManifest?: string
  coordinatorConfig?: string
  deploymentConfig?: string
  deploymentDir?: string
  dogeConfig?: string
  programManifests?: string[]
  valuesDir?: string
  withdrawalConfig?: string
} = {}): ProofDeploymentPaths {
  const deploymentDir = path.resolve(options.deploymentDir || '.')
  return {
    artifactManifest: fromDeploymentRoot(deploymentDir, options.artifactManifest, DEFAULT_PROOF_ARTIFACT_MANIFEST),
    coordinatorConfig: fromDeploymentRoot(deploymentDir, options.coordinatorConfig, DEFAULT_PROOF_COORDINATOR_CONFIG),
    deploymentConfig: fromDeploymentRoot(deploymentDir, options.deploymentConfig, DEFAULT_DEPLOYMENT_CONFIG),
    deploymentDir,
    dogeConfig: fromDeploymentRoot(deploymentDir, options.dogeConfig, DEFAULT_DOGE_CONFIG),
    programManifests: (options.programManifests || DEFAULT_PROOF_PROGRAM_MANIFESTS)
      .map(item => path.resolve(deploymentDir, item)),
    statementNamespace: fromDeploymentRoot(deploymentDir, undefined, DEFAULT_STATEMENT_NAMESPACE_CONFIG),
    valuesDir: fromDeploymentRoot(deploymentDir, options.valuesDir, DEFAULT_PROOF_VALUES_DIR),
    withdrawalConfig: fromDeploymentRoot(deploymentDir, options.withdrawalConfig, WITHDRAWAL_NATIVE_CONFIG_RELPATH),
    workerBundleDir: fromDeploymentRoot(deploymentDir, undefined, PROVER_WORKER_MOCK_BUNDLE_DIR),
  }
}

function parseVerifierIds(values: string[]): Partial<Record<ProofFamily, string>> {
  const result: Partial<Record<ProofFamily, string>> = {}
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator < 1) throw new Error(`Invalid --verifier-id ${value}; expected FAMILY=ID`)
    const family = value.slice(0, separator) as ProofFamily
    if (!['bridge_transition', 'scroll_batch', 'scroll_chunk'].includes(family)) {
      throw new Error(`Invalid proof family in --verifier-id: ${family}`)
    }

    result[family] = value.slice(separator + 1)
  }

  return result
}

export default class ProofConfig extends Command {
  static override description = 'Generate the proof topology for the K8s withdrawal-processor/proof-coordinator services and, in mock mode, a Linux docker-compose prover-worker bundle. --proving-mode mock uses the e2e_harness dev_dummy identities and deterministic non-cryptographic proofs; production uses release artifacts. Partner attestation-signer policy is exported separately with setup export-signer-policy. withdrawalProof.enabled changes only with --enable-withdrawal-proof'

  static override examples = [
    '# Production: run from the deployment root; standard paths are automatic',
    '<%= config.bin %> <%= command.id %> --proof-artifact-base-url https://proofs.example.com/proof-topology',
    '',
    '# Mock proving: no release artifacts; ProofCoordinator.toml is scaffolded when missing',
    '<%= config.bin %> <%= command.id %> --proving-mode mock --proof-artifact-base-url https://proofs.example.com/proof-topology',
    '',
    '# Run from elsewhere with one root path; re-runs reuse the staged URL and mode',
    '<%= config.bin %> <%= command.id %> --deployment-dir /srv/dogeos-deployment --enable-withdrawal-proof',
  ]

  static override flags = {
    'artifact-manifest': Flags.string({ description: `Real-proving artifact manifest (default: ${DEFAULT_PROOF_ARTIFACT_MANIFEST}); not used in mock proving mode`, hidden: true }),
    'aws-profile': Flags.string({ description: 'AWS CLI profile used to read the prover-worker token (mock mode)' }),
    'aws-region': Flags.string({ description: `AWS region of the ${PROOF_SECRET_NAME} secret (mock mode; default: the externalSecrets secretRegion in the values)` }),
    'bridge-backend-profile': Flags.string({ description: `Backend profile stamped onto bridge prove work (default: ${DEFAULT_BRIDGE_BACKEND_PROFILE}, mock: bridge-topology-prover-v1)` }),
    config: Flags.string({ char: 'c', description: `Advanced override for doge-config.toml (default under deployment root: ${DEFAULT_DOGE_CONFIG})`, hidden: true }),
    'coordinator-config': Flags.string({ description: `Advanced override for native ProofCoordinator.toml (default under deployment root: ${DEFAULT_PROOF_COORDINATOR_CONFIG})`, hidden: true }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root containing config.toml, .data/, values/, proof-coordinator/, withdrawal-processor/, and proof-artifacts/' }),
    'enable-withdrawal-proof': Flags.boolean({ default: false, description: 'Set withdrawalProof.enabled=true after staging and atomically project the explicit runtime env; without this flag the activation state is preserved as-is' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'program-manifest': Flags.string({ description: 'Advanced ProofProgramManifestV1 path override; repeat for a non-standard layout; not used in mock proving mode', hidden: true, multiple: true }),
    'proof-artifact-base-url': Flags.string({ description: 'Credential-free public GET root for the proof object key prefix; prover-workers read inputs and partner signers read accepted proof objects below this same root' }),
    'proving-mode': Flags.string({ description: 'Proof implementation to stage; persisted into doge-config [proofSystem].provingMode so every proof command agrees (default: the persisted value, else production)', options: ['mock', 'production'] }),
    'scaffold-coordinator-config': Flags.boolean({ allowNo: true, default: true, description: 'Generate ProofCoordinator.toml from prepared withdrawal configuration when missing (default: true; never overwrites an existing file)' }),
    'scroll-batch-backend-profile': Flags.string({ description: `Backend profile stamped onto Scroll batch prove work (default: ${DEFAULT_SCROLL_BATCH_BACKEND_PROFILE}, mock: scroll-batch-topology-prover-v1)` }),
    'signer-proof-artifact-base-url': Flags.string({ description: 'Deprecated alias for --proof-artifact-base-url', hidden: true }),
    'skip-worker-bundle': Flags.boolean({ default: false, description: 'Mock mode: do not generate the prover-worker-mock docker-compose bundle' }),
    'values-dir': Flags.string({ description: `Advanced values directory override (default under deployment root: ${DEFAULT_PROOF_VALUES_DIR})`, hidden: true }),
    'verifier-id': Flags.string({ description: 'Optional FAMILY=ID override; repeat per family', multiple: true }),
    'withdrawal-config': Flags.string({ description: `Advanced native WithdrawalProcessor.toml override (default under deployment root: ${WITHDRAWAL_NATIVE_CONFIG_RELPATH})`, hidden: true }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfig)
    const json = new JsonOutputContext('setup proof-config', flags.json)
    try {
      const layout = resolveProofDeploymentPaths({
        artifactManifest: flags['artifact-manifest'],
        coordinatorConfig: flags['coordinator-config'],
        deploymentDir: flags['deployment-dir'],
        dogeConfig: flags.config,
        programManifests: flags['program-manifest'],
        valuesDir: flags['values-dir'],
        withdrawalConfig: flags['withdrawal-config'],
      })
      const provingMode = await this.resolveProvingMode(
        { config: layout.dogeConfig, 'proving-mode': flags['proving-mode'] },
        json
      )
      const mock = provingMode === 'mock'
      if (flags['proof-artifact-base-url'] && flags['signer-proof-artifact-base-url']) {
        throw new Error('--proof-artifact-base-url and its deprecated --signer-proof-artifact-base-url alias are mutually exclusive')
      }

      if (mock) {
        json.info('Proving mode: MOCK — dev_dummy topology with deterministic NON-cryptographic proofs. Never deploy this posture to a value-bearing bridge.')
        if (flags['artifact-manifest'] || flags['program-manifest']) {
          throw new Error('--artifact-manifest/--program-manifest are release-artifact inputs; they are not used with --proving-mode mock')
        }
      }

      const {
        coordinatorConfig: coordinatorConfigPath,
        valuesDir,
        withdrawalConfig: withdrawalConfigPath,
      } = layout
      let scaffolded = false
      if (flags['scaffold-coordinator-config']) {
        const scaffold = scaffoldProofCoordinatorConfig({ coordinatorConfigPath, provingMode, valuesDir, withdrawalConfigPath })
        scaffolded = scaffold.created
        json.logSuccess(scaffold.created
          ? `Scaffolded ${scaffold.configFile} from the withdrawal-processor deployment configuration (${provingMode} proving)`
          : `${scaffold.configFile} already exists; scaffold skipped`)
      }

      const coordinatorIngressHost = readCoordinatorIngressHost(layout.deploymentConfig)
      const result = configureProofValues({
        artifactManifestPath: mock ? undefined : layout.artifactManifest,
        bridgeBackendProfile: flags['bridge-backend-profile'],
        coordinatorConfigPath,
        coordinatorIngressHost,
        enableWithdrawalProof: flags['enable-withdrawal-proof'],
        manifestPaths: mock ? undefined : layout.programManifests,
        provingMode,
        scrollBatchBackendProfile: flags['scroll-batch-backend-profile'],
        signerProofArtifactBaseUrl: flags['proof-artifact-base-url'] || flags['signer-proof-artifact-base-url'],
        statementNamespacePath: layout.statementNamespace,
        valuesDir,
        verifierIds: parseVerifierIds(flags['verifier-id'] || []),
        withdrawalConfigPath,
      })
      json.logSuccess(`Configured ${provingMode} proof values for: ${result.families.join(', ')}`)
      if (result.signerProofArtifactBaseUrlSource === 'staged') {
        json.info(`--signer-proof-artifact-base-url not given; reusing staged value ${result.signerProofArtifactBaseUrl} from WithdrawalProcessor.toml`)
      }

      if (coordinatorIngressHost) {
        json.info(`proof-coordinator ingress host: https://${coordinatorIngressHost} (from config.toml [ingress].PROOF_COORDINATOR_HOST)`)
      }

      let workerBundleDir: string | undefined
      if (mock && !flags['skip-worker-bundle']) {
        workerBundleDir = this.writeWorkerBundle(
          flags,
          json,
          coordinatorIngressHost,
          result.signerProofArtifactBaseUrl,
          layout.workerBundleDir,
          valuesDir
        )
      }

      if (flags['enable-withdrawal-proof']) {
        json.logSuccess('withdrawalProof.enabled set to true and runtime env projected atomically — verify coordinator readiness, S3 identity, and prover workers before deploying')
      }

      if (!json.isJsonEnabled) {
        json.logSection('Required Helm --set-file bindings')
        json.log('proof-coordinator:')
        for (const binding of result.helmSetFiles.proofCoordinator) {
          json.log(`  --set-file '${binding.key}=${binding.filePath}'`)
        }

        json.log('withdrawal-processor:')
        for (const binding of result.helmSetFiles.withdrawalProcessor) {
          json.log(`  --set-file '${binding.key}=${binding.filePath}'`)
        }
      }

      json.success({ ...result, deploymentDir: layout.deploymentDir, scaffoldedCoordinatorConfig: scaffolded, workerBundleDir })
    } catch (error) {
      json.error('E701_PROOF_CONFIG_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  /**
   * Resolve the proving mode: explicit flag wins and is persisted into
   * doge-config so later runs (and other proof commands) agree; otherwise the
   * persisted value applies; production is the fail-safe default.
   */
  private async resolveProvingMode(
    flags: { config?: string; 'proving-mode'?: string },
    json: JsonOutputContext
  ): Promise<ProvingMode> {
    const flagMode = flags['proving-mode'] as ProvingMode | undefined
    let loaded: Awaited<ReturnType<typeof loadDogeConfigWithSelection>> | undefined
    try {
      loaded = await loadDogeConfigWithSelection(flags.config, 'scrollsdk setup doge-config')
    } catch (error) {
      if (flagMode) {
        json.addWarning(`--proving-mode not persisted: doge-config unavailable (${error instanceof Error ? error.message : String(error)})`)
      }
    }

    const persisted = loaded?.config.proofSystem?.provingMode
    const provingMode: ProvingMode = flagMode || persisted || 'production'
    if (flagMode && loaded && persisted !== flagMode) {
      loaded.config.proofSystem = { ...loaded.config.proofSystem, provingMode: flagMode }
      fs.writeFileSync(loaded.configPath, dogeConfigToToml(loaded.config))
      json.info(`Persisted provingMode = ${flagMode} to ${loaded.configPath}`)
    }

    return provingMode
  }

  private writeWorkerBundle(
    flags: { 'aws-profile'?: string; 'aws-region'?: string },
    json: JsonOutputContext,
    coordinatorIngressHost: string | undefined,
    artifactReadBaseUrl: string,
    bundleDir: string,
    valuesDir: string
  ): string {
    if (!coordinatorIngressHost) {
      throw new Error(
        'mock proving generates the prover-worker-mock bundle, which needs the public coordinator URL: set [ingress].PROOF_COORDINATOR_HOST in config.toml (or pass --skip-worker-bundle)'
      )
    }

    const awsRegion = flags['aws-region'] || readSecretRegionFromValues(valuesDir)
    const workerToken = readProverWorkerTokenFromSecretsManager({
      awsProfile: flags['aws-profile'],
      awsRegion,
      secretName: PROOF_SECRET_NAME,
    })
    const bundle = writeProverWorkerMockBundle({
      artifactReadBaseUrl,
      coordinatorUrl: `https://${coordinatorIngressHost}`,
      dir: bundleDir,
      workerToken,
    })
    json.logSuccess(`prover-worker-mock bundle written to ${bundle.bundleDir} — sync to the worker host and run docker compose up -d`)
    return bundle.bundleDir
  }
}

/** config.toml owns ingress hosts (setup domains); the coordinator host is optional. */
function readCoordinatorIngressHost(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) return undefined
  const host = parseTomlConfig(configPath)?.ingress?.PROOF_COORDINATOR_HOST
  return typeof host === 'string' && host.trim() !== '' ? host.trim() : undefined
}

/** The externalSecrets blocks already record the Secrets Manager region. */
function readSecretRegionFromValues(valuesDir: string): string | undefined {
  for (const file of ['proof-coordinator-production.yaml', 'withdrawal-processor-production.yaml']) {
    const filePath = path.join(valuesDir, file)
    if (!fs.existsSync(filePath)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Helm values are dynamic documents
      const values = yaml.load(fs.readFileSync(filePath, 'utf8')) as any
      for (const secret of Object.values(values?.externalSecrets || {})) {
        const region = (secret as { secretRegion?: unknown })?.secretRegion
        if (typeof region === 'string' && region.trim() !== '') return region.trim()
      }
    } catch {
      // Region discovery is best-effort; the AWS CLI default chain still applies.
    }
  }

  return undefined
}
