import { Command, Flags } from '@oclif/core'
import * as path from 'node:path'

import {
  hydrateCompiledProverWorkerBundle,
  verifyCompiledProverWorkerBundle,
} from '../../utils/compiled-prover-worker-bundle.js'
import { JsonOutputContext } from '../../utils/json-output.js'
import { readOptionalProofAwsConfig } from '../../utils/proof-aws-config.js'
import {
  readProofDeploymentContract,
  resolveContractFile,
} from '../../utils/proof-deployment-contract.js'
import {readProverWorkerTokenFromSecretsManager} from '../../utils/proof-worker-token.js'

export default class ProofWorker extends Command {
  static override description = 'Hydrate a compiler-generated Docker Compose prover-worker bundle with its bearer token after deterministic configuration generation'

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
      if (!['compiled-compose', 'compiled-external'].includes(contract.worker.kind)) {
        throw new Error(
          `setup proof-worker requires a generated Docker Compose Worker bundle; `
          + `current mode is ${contract.mode} (${contract.worker.kind})`,
        )
      }

      if (!contract.worker.bundleDir || !contract.worker.bundleId) {
        throw new Error('deployment contract has no generated worker bundle; run scrollsdk setup prep-charts first')
      }

      const bundleDir = resolveContractFile(deploymentDir, contract.worker.bundleDir)
      verifyCompiledProverWorkerBundle({
        allowPendingCredential: true,
        bundleDir,
        expectedBundleId: contract.worker.bundleId,
      })

      const tokenFromEnvironment = process.env[flags['worker-token-env']]?.trim()
      const proofAwsConfig = readOptionalProofAwsConfig(deploymentDir)?.config
      const secretName = flags['secret-name'] || proofAwsConfig?.secret.name
      if (!tokenFromEnvironment && !secretName) {
        throw new Error(
          'cannot infer the deployment-specific proof secret; run setup proof-aws-init, '
          + 'pass --secret-name, or set the configured worker token environment variable',
        )
      }

      const workerToken = tokenFromEnvironment || readProverWorkerTokenFromSecretsManager({
          awsProfile: flags['aws-profile'],
          awsRegion: flags['aws-region'] || proofAwsConfig?.secret.region,
          secretName: secretName as string,
        })
      const bundle = hydrateCompiledProverWorkerBundle({
        bundleDir,
        expectedBundleId: contract.worker.bundleId,
        workerToken,
      })
      if (bundle.bundleId !== contract.worker.bundleId) {
        throw new Error(
          `hydrated worker bundle ID ${bundle.bundleId} does not match deployment contract ${contract.worker.bundleId}; rerun setup prep-charts`,
        )
      }

      json.logSuccess(`Hydrated ${contract.mode}/${contract.generation} prover-worker bundle ${bundle.bundleId}`)
      json.info(
        'Sync the selected proof resources and exact compiler Worker bundle to the worker host, '
        + `run scrollsdk setup proof-worker-check --bundle-dir ${bundle.bundleDir} `
        + `--expected-bundle-id ${bundle.bundleId}, then run ./prover-worker-compose config --quiet `
        + 'and ./prover-worker-compose up -d prover-worker. The launcher runs the container as '
        + 'the invoking host UID/GID so the 0600 token stays private and readable.',
      )

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
