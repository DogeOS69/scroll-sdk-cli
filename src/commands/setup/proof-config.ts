import { Command, Flags } from '@oclif/core'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProofFamily } from '../../utils/proof-configurator.js'
import type { ProofSystemMode } from '../../utils/proof-system-mode.js'

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
  configureDisabledProofValues,
  configureProofValues,
  readStagedSignerProofArtifactBaseUrl,
} from '../../utils/proof-configurator.js'
import { scaffoldProofCoordinatorConfig } from '../../utils/proof-coordinator-scaffold.js'
import { writeProofDeploymentContract } from '../../utils/proof-deployment-contract.js'
import {
  PROVER_WORKER_MOCK_BUNDLE_DIR,
  type ProverWorkerMockBundleResult,
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
  static override description = 'Select and generate one deployment-wide proof posture: disabled uses direct-sign attestation with no proof infrastructure, mock enables the full deterministic proof lifecycle, and production enables release-artifact proving. The selected mode and artifact URL are persisted in doge-config; a deployment contract is written for mode-agnostic Helm installation.'

  static override examples = [
    '# Direct-sign posture: no proof coordinator, storage, manifests, or worker',
    '<%= config.bin %> <%= command.id %> --mode disabled',
    '',
    '# Mock proof lifecycle: no release artifacts; ProofCoordinator.toml is scaffolded when missing',
    '<%= config.bin %> <%= command.id %> --mode mock --proof-artifact-base-url https://proofs.example.com/proof-topology',
    '',
    '# Run from elsewhere with one root path; re-runs reuse the staged URL and mode',
    '<%= config.bin %> <%= command.id %> --deployment-dir /srv/dogeos-deployment',
  ]

  static override flags = {
    'artifact-manifest': Flags.string({ description: `Real-proving artifact manifest (default: ${DEFAULT_PROOF_ARTIFACT_MANIFEST}); not used in mock proving mode`, hidden: true }),
    'aws-profile': Flags.string({ description: 'AWS CLI profile used to read the prover-worker token (mock mode)' }),
    'aws-region': Flags.string({ description: `AWS region of the ${PROOF_SECRET_NAME} secret (mock mode; default: the externalSecrets secretRegion in the values)` }),
    'bridge-backend-profile': Flags.string({ description: `Backend profile stamped onto bridge prove work (default: ${DEFAULT_BRIDGE_BACKEND_PROFILE}, mock: bridge-topology-prover-v1)` }),
    config: Flags.string({ char: 'c', description: `Advanced override for doge-config.toml (default under deployment root: ${DEFAULT_DOGE_CONFIG})`, hidden: true }),
    'coordinator-config': Flags.string({ description: `Advanced override for native ProofCoordinator.toml (default under deployment root: ${DEFAULT_PROOF_COORDINATOR_CONFIG})`, hidden: true }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root containing config.toml, .data/, values/, proof-coordinator/, withdrawal-processor/, and proof-artifacts/' }),
    'enable-withdrawal-proof': Flags.boolean({ default: false, description: 'Deprecated compatibility flag; mock and production modes are always proof-enabled', hidden: true }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    mode: Flags.string({ description: 'Deployment-wide proof posture; disabled = direct-sign/no proof infrastructure, mock = enabled deterministic proof lifecycle, production = enabled release-artifact lifecycle', options: ['disabled', 'mock', 'production'] }),
    'program-manifest': Flags.string({ description: 'Advanced ProofProgramManifestV1 path override; repeat for a non-standard layout; not used in mock proving mode', hidden: true, multiple: true }),
    'proof-artifact-base-url': Flags.string({ description: 'Credential-free public GET root for the proof object key prefix; prover-workers read inputs and partner signers read accepted proof objects below this same root' }),
    'proving-mode': Flags.string({ description: 'Deprecated alias for --mode mock|production', hidden: true, options: ['mock', 'production'] }),
    'scaffold-coordinator-config': Flags.boolean({ allowNo: true, default: true, description: 'Generate ProofCoordinator.toml from prepared withdrawal configuration when missing (default: true; never overwrites an existing file)' }),
    'scroll-batch-backend-profile': Flags.string({ description: `Backend profile stamped onto Scroll batch prove work (default: ${DEFAULT_SCROLL_BATCH_BACKEND_PROFILE}, mock: scroll-batch-topology-prover-v1)` }),
    'signer-proof-artifact-base-url': Flags.string({ description: 'Deprecated alias for --proof-artifact-base-url', hidden: true }),
    'skip-worker-bundle': Flags.boolean({ default: false, description: 'Deprecated compatibility flag; mock mode now requires a complete worker bundle', hidden: true }),
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
      const loaded = await loadDogeConfigWithSelection(layout.dogeConfig, 'scrollsdk setup doge-config')
      const mode = this.resolveProofSystemMode(flags.mode, flags['proving-mode'], loaded.config, layout.valuesDir, json)
      const disabled = mode === 'disabled'
      const provingMode = disabled ? undefined : mode
      const mock = mode === 'mock'
      if (flags['enable-withdrawal-proof']) {
        if (disabled) {
          throw new Error('--enable-withdrawal-proof is retired; select --mode mock or --mode production to enable the complete proof lifecycle')
        }

        json.addWarning('--enable-withdrawal-proof is deprecated and has no effect; mock and production modes are always proof-enabled')
      }

      if (flags['proof-artifact-base-url'] && flags['signer-proof-artifact-base-url']) {
        throw new Error('--proof-artifact-base-url and its deprecated --signer-proof-artifact-base-url alias are mutually exclusive')
      }

      if (disabled) {
        json.info('Proof system mode: DISABLED — attestation signers use direct-sign/dev_permissive policy and proof infrastructure is not required.')
        if (flags['artifact-manifest'] || flags['program-manifest']) {
          throw new Error('--artifact-manifest/--program-manifest are not used with --mode disabled')
        }
      } else if (mock) {
        json.info('Proving mode: MOCK — dev_dummy topology with deterministic NON-cryptographic proofs. Never deploy this posture to a value-bearing bridge.')
        if (flags['artifact-manifest'] || flags['program-manifest']) {
          throw new Error('--artifact-manifest/--program-manifest are release-artifact inputs; they are not used with --mode mock')
        }

        if (flags['skip-worker-bundle']) {
          throw new Error('--skip-worker-bundle is no longer supported: --mode mock requires the complete mock proof lifecycle and worker bundle')
        }
      }

      const {
        coordinatorConfig: coordinatorConfigPath,
        valuesDir,
        withdrawalConfig: withdrawalConfigPath,
      } = layout
      const tsoValuesPath = path.join(valuesDir, 'tso-service-production.yaml')
      if (!fs.existsSync(tsoValuesPath)) {
        throw new Error(`TSO values file not found: ${tsoValuesPath}`)
      }

      let scaffolded = false
      if (!disabled && flags['scaffold-coordinator-config']) {
        const scaffold = scaffoldProofCoordinatorConfig({ coordinatorConfigPath, provingMode: provingMode!, valuesDir, withdrawalConfigPath })
        scaffolded = scaffold.created
        json.logSuccess(scaffold.created
          ? `Scaffolded ${scaffold.configFile} from the withdrawal-processor deployment configuration (${provingMode} proving)`
          : `${scaffold.configFile} already exists; scaffold skipped`)
      }

      const explicitBaseUrl = flags['proof-artifact-base-url'] || flags['signer-proof-artifact-base-url']
      const stagedBaseUrl = fs.existsSync(withdrawalConfigPath)
        ? readStagedProofArtifactBaseUrl(withdrawalConfigPath)
        : undefined
      const proofArtifactBaseUrl = disabled
        ? undefined
        : explicitBaseUrl || loaded.config.proofSystem?.artifactReadBaseUrl || stagedBaseUrl
      if (!disabled && !proofArtifactBaseUrl) {
        throw new Error('--proof-artifact-base-url is required on the first mock/production setup run')
      }

      let result: ReturnType<typeof configureDisabledProofValues> | ReturnType<typeof configureProofValues>
      if (disabled) {
        result = configureDisabledProofValues({ valuesDir, withdrawalConfigPath })
        json.logSuccess('Configured proof-disabled withdrawal values and native config')
      } else {
        const coordinatorIngressHost = readCoordinatorIngressHost(layout.deploymentConfig)
        result = configureProofValues({
          artifactManifestPath: mock ? undefined : layout.artifactManifest,
          bridgeBackendProfile: flags['bridge-backend-profile'],
          coordinatorConfigPath,
          coordinatorIngressHost,
          manifestPaths: mock ? undefined : layout.programManifests,
          provingMode: provingMode!,
          scrollBatchBackendProfile: flags['scroll-batch-backend-profile'],
          signerProofArtifactBaseUrl: proofArtifactBaseUrl,
          statementNamespacePath: layout.statementNamespace,
          valuesDir,
          verifierIds: parseVerifierIds(flags['verifier-id'] || []),
          withdrawalConfigPath,
        })
        json.logSuccess(`Configured ${provingMode} proof values for: ${result.families.join(', ')}`)
      }

      if (!disabled && 'artifactReadBaseUrlMapping' in result && result.artifactReadBaseUrlMapping === 'custom-gateway-root') {
        json.addWarning(
          `custom proof artifact gateway root ${result.signerProofArtifactBaseUrl} does not expose the S3 key prefix in its URL path; `
          + 'verify that the gateway maps this root to the configured artifact-store prefix and preflight an exact artifact key from every worker/signer network'
        )
      }

      if (!disabled && 'signerProofArtifactBaseUrlSource' in result && result.signerProofArtifactBaseUrlSource === 'staged') {
        json.info(`--signer-proof-artifact-base-url not given; reusing staged value ${result.signerProofArtifactBaseUrl} from WithdrawalProcessor.toml`)
      }

      let workerBundleDir: string | undefined
      let workerBundleId: string | undefined
      if (mock && !flags['skip-worker-bundle']) {
        const coordinatorIngressHost = readCoordinatorIngressHost(layout.deploymentConfig)
        const workerBundle = this.writeWorkerBundle(
          flags,
          json,
          coordinatorIngressHost,
          'signerProofArtifactBaseUrl' in result ? result.signerProofArtifactBaseUrl : proofArtifactBaseUrl!,
          layout.workerBundleDir,
          valuesDir
        )
        workerBundleDir = workerBundle.bundleDir
        workerBundleId = workerBundle.bundleId
      }

      loaded.config.proofSystem = {
        ...loaded.config.proofSystem,
        mode,
        ...(proofArtifactBaseUrl ? { artifactReadBaseUrl: proofArtifactBaseUrl } : {}),
      }
      delete loaded.config.proofSystem.provingMode
      if (disabled) delete loaded.config.proofSystem.artifactReadBaseUrl
      fs.writeFileSync(loaded.configPath, dogeConfigToToml(loaded.config))

      const contract = writeProofDeploymentContract({
        deploymentDir: layout.deploymentDir,
        mode,
        proofArtifactBaseUrl,
        proofCoordinator: {
          enabled: !disabled,
          setFiles: result.helmSetFiles.proofCoordinator,
          valuesFile: disabled ? undefined : path.join(valuesDir, 'proof-coordinator-production.yaml'),
        },
        tsoValuesFile: tsoValuesPath,
        withdrawalProcessor: {
          setFiles: result.helmSetFiles.withdrawalProcessor,
          valuesFile: path.join(valuesDir, 'withdrawal-processor-production.yaml'),
        },
        worker: { bundleDir: workerBundleDir, bundleId: workerBundleId },
      })
      json.logSuccess(`Wrote proof deployment contract ${contract.generationId} (${mode})`)

      if (!json.isJsonEnabled) {
        json.logSection('Required Helm --set-file bindings')
        if (!disabled) {
          json.log('proof-coordinator:')
          for (const binding of result.helmSetFiles.proofCoordinator) {
            json.log(`  --set-file '${binding.key}=${binding.filePath}'`)
          }
        }

        json.log('withdrawal-processor:')
        for (const binding of result.helmSetFiles.withdrawalProcessor) {
          json.log(`  --set-file '${binding.key}=${binding.filePath}'`)
        }
      }

      json.success({
        ...result,
        contract,
        deploymentDir: layout.deploymentDir,
        mode,
        scaffoldedCoordinatorConfig: scaffolded,
        workerBundleDir,
        workerBundleId,
      })
    } catch (error) {
      json.error('E701_PROOF_CONFIG_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }

  private resolveProofSystemMode(
    modeFlag: string | undefined,
    legacyProvingMode: string | undefined,
    config: Awaited<ReturnType<typeof loadDogeConfigWithSelection>>['config'],
    valuesDir: string,
    json: JsonOutputContext
  ): ProofSystemMode {
    if (modeFlag && legacyProvingMode) throw new Error('--mode and deprecated --proving-mode are mutually exclusive')
    if (modeFlag) return modeFlag as ProofSystemMode
    if (legacyProvingMode) {
      json.addWarning('--proving-mode is deprecated; use --mode. mock/production now imply proof enabled.')
      return legacyProvingMode as ProofSystemMode
    }

    if (config.proofSystem?.mode) return config.proofSystem.mode
    if (config.proofSystem?.provingMode) {
      const valuesPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
      const enabled = readLegacyWithdrawalProofEnabled(valuesPath)
      const migrated = enabled ? config.proofSystem.provingMode : 'disabled'
      json.addWarning(`migrating legacy proofSystem.provingMode + withdrawalProof.enabled to proofSystem.mode = ${migrated}`)
      return migrated
    }

    return 'disabled'
  }

  private writeWorkerBundle(
    flags: { 'aws-profile'?: string; 'aws-region'?: string },
    json: JsonOutputContext,
    coordinatorIngressHost: string | undefined,
    artifactReadBaseUrl: string,
    bundleDir: string,
    valuesDir: string
  ): ProverWorkerMockBundleResult {
      if (!coordinatorIngressHost) {
        throw new Error(
        'mock proving generates the required prover-worker-mock bundle, which needs the public coordinator URL: set [ingress].PROOF_COORDINATOR_HOST in config.toml'
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
    json.logSuccess(
      `prover-worker-mock bundle ${bundle.bundleId} written to ${bundle.bundleDir} — sync the complete directory, `
      + `run scrollsdk setup proof-worker-check --expected-bundle-id ${bundle.bundleId} on the worker host, then docker compose up -d`
    )
    return bundle
  }
}

/** config.toml owns ingress hosts (setup domains); the coordinator host is optional. */
function readCoordinatorIngressHost(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) return undefined
  const host = parseTomlConfig(configPath)?.ingress?.PROOF_COORDINATOR_HOST
  return typeof host === 'string' && host.trim() !== '' ? host.trim() : undefined
}

function readStagedProofArtifactBaseUrl(withdrawalConfigPath: string): string | undefined {
  return readStagedSignerProofArtifactBaseUrl(fs.readFileSync(withdrawalConfigPath, 'utf8'))
}

function readLegacyWithdrawalProofEnabled(valuesPath: string): boolean {
  if (!fs.existsSync(valuesPath)) return false
  try {
    const values = yaml.load(fs.readFileSync(valuesPath, 'utf8')) as { withdrawalProof?: { enabled?: unknown } }
    return values?.withdrawalProof?.enabled === true
  } catch {
    return false
  }
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
