import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {deriveCompressedSecp256k1PublicKeyFromSpkiDer} from './attestation-kms.js'
import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource} from './aws-resource-reader.js'
import {productionFeeWallet} from './preparation-fee-wallet.js'
import {digest, localPath, writeJson} from './preparation-io.js'
import {readOptionalProofAwsConfig} from './proof-aws-config.js'

const RECORD = '.data/bridge-sequencer-kms.json'
interface SequencerKmsRecord {
  intentHash: string
  keyArn: string
  /** `created` only when this CLI created the key; absent for supplied or pre-ownership keys. */
  origin?: 'created'
  publicKey: string
  ready: boolean
  region: string
  roleArn?: string
  schema: 'dogeos/bridge-sequencer-kms/v1'
  serviceAccount?: string
}
export const sequencerKmsIntentHash = (spec: DeploymentSpec) => digest(JSON.stringify({aws: {accountId: spec.infrastructure.aws?.accountId, eksClusterName: spec.infrastructure.aws?.eksClusterName, region: spec.infrastructure.aws?.region}, kms: spec.preparation!.bridge.production!.sequencerKms, name: spec.metadata.name, namespace: spec.infrastructure.namespace, serviceAccount: spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'}))

export function readPreparedSequencerKms(root: string, requireRole = true): SequencerKmsRecord | undefined {
  const file = localPath(root, RECORD)
  if (!fs.existsSync(file)) return undefined
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as SequencerKmsRecord
  if (record.schema !== 'dogeos/bridge-sequencer-kms/v1' || !record.ready || requireRole && !record.roleArn || !record.serviceAccount || !record.keyArn || !record.region || !/^(02|03)[\da-f]{64}$/.test(record.publicKey)) throw new Error('Bridge sequencer KMS record is incomplete')
  return record
}

export function productionSequencer(root: string, spec: DeploymentSpec): {kms?: {expected_pubkey: string; key_id: string; region: string}; publicKey: string; roleArn?: string; serviceAccount?: string} {
  const policy = spec.preparation!.bridge.production!
  if (!policy.sequencerKms) return {publicKey: policy.sequencerPublicKey!}
  const record = readPreparedSequencerKms(root)
  if (!record || record.intentHash !== sequencerKmsIntentHash(spec)) throw new Error('Bridge sequencer KMS identity is not prepared for this spec')
  if (!/^(02|03)[\da-f]{64}$/.test(record.publicKey)) throw new Error('Invalid saved Bridge sequencer KMS public key')
  bitcore.PublicKey.fromString(record.publicKey)
  if (record.publicKey === productionFeeWallet(root, spec).publicKey) throw new Error('Production sequencer and fee wallet must have different keys')
  return {kms: {expected_pubkey: record.publicKey, key_id: record.keyArn, region: record.region}, publicKey: record.publicKey, roleArn: record.roleArn, serviceAccount: record.serviceAccount}
}

/** Prepare the key only; one WP role carries proof-store access and KMS signing (aws-roles). */
export function prepareSequencerKms(root: string, spec: DeploymentSpec, runner?: AwsCliRunner): void {
  const intent = spec.preparation!.bridge.production!.sequencerKms!
  if (intent.action !== 'reuse' || !intent.keyId) throw new Error('Prepare the Bridge KMS key externally and select reuse with keyId')
  const aws = runner ?? new AwsCliRunner(intent.awsProfile)
  const infrastructure = spec.infrastructure.aws!
  const region = intent.region ?? infrastructure.region
  const call = (args: string[], selectedRegion = region) => readAwsResource(aws, args, selectedRegion)
  const recordFile = localPath(root, RECORD)
  const saved: SequencerKmsRecord | undefined = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : undefined
  if (saved && (saved.schema !== 'dogeos/bridge-sequencer-kms/v1' || saved.intentHash !== sequencerKmsIntentHash(spec))) throw new Error('Existing Bridge KMS record belongs to a different intent; do not replace the identity')
  const metadata = call(['kms', 'describe-key', '--key-id', intent.keyId]).KeyMetadata
  if (!metadata?.Arn) throw new Error('KMS metadata is missing its ARN')
  const key = call(['kms', 'get-public-key', '--key-id', metadata.Arn])
  const publicKey = deriveCompressedSecp256k1PublicKeyFromSpkiDer(key.PublicKey)
  bitcore.PublicKey.fromString(publicKey)
  if (saved?.publicKey && (saved.keyArn !== metadata.Arn || saved.publicKey !== publicKey)) throw new Error('Bridge sequencer KMS public identity changed')
  const proof = readOptionalProofAwsConfig(root)?.config
  const serviceAccount = spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'
  if (proof && (proof.kubernetes.eksCluster !== infrastructure.eksClusterName || proof.kubernetes.namespace !== (spec.infrastructure.namespace ?? 'default') || proof.serviceAccounts.withdrawalProcessor.name !== serviceAccount)) throw new Error('Proof AWS withdrawal identity differs from Bridge KMS workload')
  // The aws-roles step resolves the withdrawal-processor role and binds its ARN here.
  writeJson(recordFile, {intentHash: sequencerKmsIntentHash(spec), keyArn: metadata.Arn, publicKey, ready: true, region, schema: 'dogeos/bridge-sequencer-kms/v1', serviceAccount})
}
