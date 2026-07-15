/* eslint-disable @typescript-eslint/no-explicit-any -- Helm values are dynamic documents. */

import { Command, Flags } from '@oclif/core'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { JsonOutputContext } from '../../utils/json-output.js'
import { sanitizeName, truncateIamRoleName } from '../../utils/kms-signer-provisioner.js'
import { ProofAwsProvisioner, applyProofAwsValues } from '../../utils/proof-aws-provisioner.js'

export const DEFAULT_PROOF_SECRET_NAME = 'scroll/proof-coordinator-secrets'

function readValues(filePath: string): any {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Values file not found: ${filePath}; run scrollsdk setup prep-charts first`)
  }

  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Values file must contain a YAML mapping: ${filePath}`)
  }

  return parsed
}

function writeValuesAtomic(filePath: string, value: any): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporaryPath, yaml.dump(value, { lineWidth: -1, noRefs: true }), { mode: 0o600 })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}

export default class ProofAwsInit extends Command {
  static override description = 'Provision the AWS side of the proof system (artifact S3 bucket, IRSA IAM roles, bearer-token secret) and project the results into the proof values files'

  static override examples = [
    '<%= config.bin %> <%= command.id %> --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet',
    '<%= config.bin %> <%= command.id %> --aws-region us-west-2 --eks-cluster dogeos-testnet --network-alias testnet --bucket my-proof-artifacts --rotate-tokens',
  ]

  static override flags = {
    'aws-profile': Flags.string({ description: 'AWS CLI profile used for provisioning' }),
    'aws-region': Flags.string({ description: 'AWS region for the bucket, roles, and secret', required: true }),
    bucket: Flags.string({ description: 'Proof artifact S3 bucket (default: dogeos-<network-alias>-proof-artifacts)' }),
    'coordinator-service-account': Flags.string({ default: 'proof-coordinator', description: 'Kubernetes service account used by proof-coordinator (must match the Helm release-derived name or an explicit serviceAccount.name)' }),
    'eks-cluster': Flags.string({ description: 'EKS cluster name used by the IRSA trust policies', required: true }),
    json: Flags.boolean({ default: false, description: 'Output structured JSON' }),
    'key-prefix': Flags.string({ default: 'proof-topology', description: 'Object key prefix for the proof artifact store' }),
    namespace: Flags.string({ default: 'default', description: 'Kubernetes namespace of the proof workloads' }),
    'network-alias': Flags.string({ description: 'Resource alias used to derive deterministic bucket and IAM role names', required: true }),
    'rotate-tokens': Flags.boolean({ default: false, description: 'Replace the proof-work/prover-worker tokens in an existing secret (both workloads must be restarted afterwards)' }),
    'secret-name': Flags.string({ default: DEFAULT_PROOF_SECRET_NAME, description: 'Secrets Manager secret holding proof-work-token and prover-worker-token' }),
    'values-dir': Flags.string({ default: 'values', description: 'Directory containing *-production.yaml files' }),
    'withdrawal-service-account': Flags.string({ default: 'withdrawal-processor', description: 'Kubernetes service account used by withdrawal-processor' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProofAwsInit)
    const json = new JsonOutputContext('setup proof-aws-init', flags.json)
    try {
      const valuesDir = path.resolve(flags['values-dir'])
      const coordinatorValuesPath = path.join(valuesDir, 'proof-coordinator-production.yaml')
      const withdrawalValuesPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
      const coordinatorValues = readValues(coordinatorValuesPath)
      const withdrawalValues = readValues(withdrawalValuesPath)

      const alias = sanitizeName(flags['network-alias'])
      const cluster = sanitizeName(flags['eks-cluster'])
      const bucket = flags.bucket || `dogeos-${alias}-proof-artifacts`
      const provisioner = new ProofAwsProvisioner(json, flags['aws-profile'])
      const result = provisioner.provision(
        {
          awsRegion: flags['aws-region'],
          eksCluster: flags['eks-cluster'],
          namespace: flags.namespace,
          networkAlias: flags['network-alias'],
        },
        {
          bucket,
          coordinatorRole: {
            description: 'DogeOS proof-coordinator artifact store role',
            roleName: truncateIamRoleName(`dogeos-${alias}-${cluster}-proof-coordinator`),
            serviceAccount: flags['coordinator-service-account'],
          },
          rotateTokens: flags['rotate-tokens'],
          secretName: flags['secret-name'],
          withdrawalRole: {
            description: 'DogeOS withdrawal-processor proof transport role',
            roleName: truncateIamRoleName(`dogeos-${alias}-${cluster}-wp-proof`),
            serviceAccount: flags['withdrawal-service-account'],
          },
        }
      )

      applyProofAwsValues(coordinatorValues, withdrawalValues, {
        bucket: result.bucket,
        coordinatorRoleArn: result.coordinatorRoleArn,
        coordinatorServiceAccount: flags['coordinator-service-account'],
        keyPrefix: flags['key-prefix'],
        region: flags['aws-region'],
        secretName: flags['secret-name'],
        withdrawalRoleArn: result.withdrawalRoleArn,
        withdrawalServiceAccount: flags['withdrawal-service-account'],
      })
      writeValuesAtomic(coordinatorValuesPath, coordinatorValues)
      writeValuesAtomic(withdrawalValuesPath, withdrawalValues)

      json.logSuccess(`Provisioned proof AWS resources: bucket=${result.bucket} secret=${result.secretName} (${result.secretAction})`)
      json.success({
        ...result,
        files: [coordinatorValuesPath, withdrawalValuesPath],
      })
    } catch (error) {
      json.error('E710_PROOF_AWS_INIT_FAILED', error instanceof Error ? error.message : String(error), 'CONFIGURATION', true)
    }
  }
}
