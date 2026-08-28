import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import {hydrateCompiledProverWorkerBundle} from '../../utils/compiled-prover-worker-bundle.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { readOptionalProofAwsConfig } from '../../utils/proof-aws-config.js'
import {
  readProofDeploymentContract,
  resolveContractFile,
} from '../../utils/proof-deployment-contract.js'
import {
  hydrateProverWorkerMockBundle,
  readProverWorkerTokenFromSecretsManager,
} from '../../utils/prover-worker-mock-bundle.js'
import { hydrateProverWorkerProductionBundle } from '../../utils/prover-worker-production-bundle.js'

const DEFAULT_PROOF_SECRET_NAME = 'scroll/proof-coordinator-secrets'

export default class ProofWorker extends Command {
  static override description = 'Hydrate a generated mock or production prover-worker Docker Compose bundle with its bearer token; run explicitly after deterministic K8s config generation'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --deployment-dir /srv/dogeos/testnet --aws-profile staging',
  ]

  static override flags = {
    'aws-profile': Flags.string({ description: 'AWS CLI profile used to read the prover-worker token' }),
    'aws-region': Flags.string({ description: 'AWS region of the proof coordinator secret; inferred from .data/proof-aws.json when omitted' }),
    'deployment-dir': Flags.string({ default: '.', description: 'Deployment root containing .data/proof-deployment.json' }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'secret-name': Flags.string({ description: 'Secrets Manager secret containing prover-worker-token; inferred from .data/proof-aws.json when omitted' }),
    'worker-token-env': Flags.string({ default: 'DOGEOS_PROVER_WORKER_TOKEN', description: 'Environment variable containing the worker token; when unset, read it from Secrets Manager' }),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(ProofWorker)
    const json = new JsonOutputContext('setup proof-worker', flags.json)
    try {
      const deploymentDir = path.resolve(flags['deployment-dir'])
      const {contract} = readProofDeploymentContract(deploymentDir)
      if (!['compiled-external', 'mock-compose', 'production-compose'].includes(contract.worker.kind)) {
        throw new Error(
          `setup proof-worker requires an external generated Compose worker bundle; `
          + `current mode is ${contract.mode} (${contract.worker.kind})`,
        )
      }

      if (!contract.worker.bundleDir || !contract.worker.bundleId) {
        throw new Error('deployment contract has no generated worker bundle; run scrollsdk setup prep-charts first')
      }

      const tokenFromEnvironment = process.env[flags['worker-token-env']]?.trim()
      const proofAwsConfig = readOptionalProofAwsConfig(deploymentDir)?.config
      const workerToken = tokenFromEnvironment || readProverWorkerTokenFromSecretsManager({
          awsProfile: flags['aws-profile'],
          awsRegion: flags['aws-region'] || proofAwsConfig?.secret.region,
          secretName: flags['secret-name'] || proofAwsConfig?.secret.name || DEFAULT_PROOF_SECRET_NAME,
        })
      const bundleDir = resolveContractFile(deploymentDir, contract.worker.bundleDir)
      const bundle = contract.worker.kind === 'compiled-external'
        ? hydrateCompiledProverWorkerBundle({bundleDir, workerToken})
        : contract.worker.kind === 'production-compose'
          ? hydrateProverWorkerProductionBundle({dir: bundleDir, workerToken})
          : hydrateProverWorkerMockBundle({dir: bundleDir, workerToken})
      if (bundle.bundleId !== contract.worker.bundleId) {
        throw new Error(
          `hydrated worker bundle ID ${bundle.bundleId} does not match deployment contract ${contract.worker.bundleId}; rerun setup prep-charts`,
        )
      }

      json.logSuccess(`Hydrated ${contract.mode} prover-worker bundle ${bundle.bundleId}`)
      if (contract.worker.kind === 'compiled-external') {
        json.info(
          'Sync the selected proof resources and exact compiler Worker bundle to the GPU host, '
          + `run scrollsdk setup proof-worker-check --bundle-dir ${bundle.bundleDir} `
          + `--expected-bundle-id ${bundle.bundleId}, then run docker compose config --quiet `
          + 'and docker compose up -d prover-worker.',
        )
      } else {
        const productionHint = contract.worker.kind === 'production-compose'
          ? 'Sync both the proof release and worker bundle to the GPU host, '
          : `Copy ${bundle.bundleDir} to the worker host, `
        json.info(
          productionHint
          + `run scrollsdk setup proof-worker-check --bundle-dir ${bundle.bundleDir} `
          + `--expected-bundle-id ${bundle.bundleId}, then docker compose --profile tools run --rm preflight `
          + 'and docker compose up -d prover-worker.',
        )
      }

      json.success(bundle)
    } catch (error) {
      json.error(
        'E713_PROOF_WORKER_CONFIG_FAILED',
        error instanceof Error ? error.message : String(error),
        'CONFIGURATION',
        true,
      )
    }
  }
}
