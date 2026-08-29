import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import {verifyCompiledProverWorkerBundle} from '../../utils/compiled-prover-worker-bundle.js'
import { loadDogeConfigWithSelection } from '../../utils/doge-config.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { assertPreTsukiDirectSignPosture } from '../../utils/pre-tsuki-direct-sign.js'
import {
  DEFAULT_PROOF_DEPLOYMENT_CONTRACT,
  resolveContractFile,
  validateProofDeploymentContract,
} from '../../utils/proof-deployment-contract.js'
import { resolveProofIntent } from '../../utils/proof-intent.js'
import {
  readPreparedProofRelease,
  readPreparedProofSoftwareRelease,
  validatePreparedProofRelease,
  validatePreparedProofSoftwareRelease,
} from '../../utils/proof-release.js'
import {validateProofTopologyBundle} from '../../utils/proof-topology-compiler.js'

export default class ProofConfigCheck extends Command {
  static override description = 'Validate the proof deployment contract, generated values/native configs, mode consistency, and generated worker bundle without contacting Kubernetes or printing secrets'

  static override flags = {
    config: Flags.string({ char: 'c', description: 'doge-config.toml path; it is the proof source when [proof_topology] is present' }),
    contract: Flags.string({ default: DEFAULT_PROOF_DEPLOYMENT_CONTRACT, description: 'Proof deployment contract path relative to the deployment root' }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    spec: Flags.string({ description: 'Optional DeploymentSpec proof source; conflicts with doge-config [proof_topology]' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofConfigCheck)
    const json = new JsonOutputContext('setup proof-config-check', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const contract = validateProofDeploymentContract(
        deploymentDir,
        flags.contract,
      )
      const recordedConfig = contract.intentSource?.kind === 'doge-config'
        ? resolveContractFile(deploymentDir, contract.intentSource.path)
        : undefined
      const configPath = flags.config || recordedConfig
        || path.join(deploymentDir, '.data/doge-config.toml')
      const { config, configPath: loadedConfigPath } = await loadDogeConfigWithSelection(
        configPath,
        'scrollsdk setup prep-charts',
      )
      const recordedSpec = contract.intentSource?.kind === 'deployment-spec'
        ? resolveContractFile(deploymentDir, contract.intentSource.path)
        : undefined
      const configuredIntent = resolveProofIntent({
        deploymentDir,
        dogeConfig: config,
        dogeConfigPath: loadedConfigPath,
        specPath: flags.spec || recordedSpec,
      })!
      if (
        configuredIntent.source.kind === 'doge-config'
        && config.proof_release?.deploymentLockPath
      ) {
        validatePreparedProofRelease(readPreparedProofRelease(path.resolve(
          deploymentDir,
          config.proof_release.deploymentLockPath,
        )))
      } else if (
        configuredIntent.source.kind === 'doge-config'
        && config.proof_release?.softwareReleaseManifestPath
      ) {
        validatePreparedProofSoftwareRelease(readPreparedProofSoftwareRelease(path.resolve(
          deploymentDir,
          config.proof_release.softwareReleaseManifestPath,
        )))
      }

      if (configuredIntent.source.sha256 !== contract.intentSource.sha256) {
        throw new Error(
          `${configuredIntent.source.path} changed after proof configuration generation; `
          + 'rerun scrollsdk setup prep-charts',
        )
      }

      const configuredMode = configuredIntent.intent.mode
      assertPreTsukiDirectSignPosture({
        mode: configuredMode,
        network: config.network,
        preTsukiDirectSign: configuredIntent.intent.preTsukiDirectSign,
        source: configuredIntent.source.path,
      })
      if (configuredMode !== contract.mode) {
        throw new Error(
          `${configuredIntent.source.kind} proof mode ${configuredMode} does not match deployment contract mode ${contract.mode}`,
        )
      }

      const configuredDirectSignPin =
        configuredIntent.intent.preTsukiDirectSign?.maxEndBatchHeight
      const contractDirectSignPin = contract.preTsukiDirectSign?.maxEndBatchHeight
      if (configuredDirectSignPin !== contractDirectSignPin) {
        throw new Error(
          `${configuredIntent.source.kind} pre-Tsuki direct-sign pin `
          + `${String(configuredDirectSignPin)} does not match deployment contract pin `
          + `${String(contractDirectSignPin)}`,
        )
      }

      let workerBundleId: string | undefined
      let topologyDigest: string | undefined
      if (contract.topology) {
        const {topology} = contract
        const bundle = validateProofTopologyBundle(
          resolveContractFile(deploymentDir, topology.bundleDir),
          {mode: contract.mode, preflightOnly: false},
        )
        if (
          bundle.plan.to_digest !== topology.digest
          || bundle.plan.to_deployment_revision !== topology.deploymentRevision
        ) {
          throw new Error('compiler bundle digest/revision does not match deployment contract')
        }

        topologyDigest = bundle.plan.to_digest
      }

      switch (contract.worker.kind) {
        case 'compiled-external': {
          const result = verifyCompiledProverWorkerBundle({
            bundleDir: resolveContractFile(deploymentDir, contract.worker.bundleDir!),
            expectedBundleId: contract.worker.bundleId,
          })
          workerBundleId = result.bundleId
          break
        }

        case 'compiled-local': {
          break
        }

      }

      json.logSuccess(`Verified ${contract.mode} proof deployment contract ${contract.generationId}`)
      json.success({
        contract: path.resolve(deploymentDir, flags.contract),
        generationId: contract.generationId,
        mode: contract.mode,
        topologyDigest,
        workerBundleId,
      })
    } catch (error) {
      json.error(
        'E712_PROOF_DEPLOYMENT_INVALID',
        error instanceof Error ? error.message : String(error),
        'VALIDATION',
        true
      )
    }
  }
}
