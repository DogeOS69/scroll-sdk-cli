/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI and runtime configuration documents. */
import bitcore from 'bitcore-lib-doge'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {deriveCompressedSecp256k1PublicKeyFromSpkiDer} from './attestation-kms.js'
import {AwsCliRunner} from './aws-cli.js'
import {sanitizeName, truncateIamRoleName} from './kms-signer-provisioner.js'
import {productionFeeWallet} from './preparation-fee-wallet.js'
import {digest, localPath, writeJson} from './preparation-io.js'
import {readOptionalProofAwsConfig} from './proof-aws-config.js'

const RECORD = '.data/bridge-sequencer-kms.json'
interface SequencerKmsRecord {
  intentHash: string
  keyArn: string
  publicKey: string
  ready: boolean
  region: string
  roleArn?: string
  schema: 'dogeos/bridge-sequencer-kms/v1'
  serviceAccount?: string
}
const intentHash = (spec: DeploymentSpec) => digest(JSON.stringify({aws: spec.infrastructure.aws, kms: spec.preparation!.bridge.production!.sequencerKms, name: spec.metadata.name, namespace: spec.infrastructure.namespace, serviceAccount: spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'}))

export function readPreparedSequencerKms(root: string): SequencerKmsRecord | undefined {
  const file = localPath(root, RECORD)
  if (!fs.existsSync(file)) return undefined
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as SequencerKmsRecord
  if (record.schema !== 'dogeos/bridge-sequencer-kms/v1' || !record.ready || !record.roleArn || !record.serviceAccount || !record.keyArn || !record.region || !/^(02|03)[\da-f]{64}$/.test(record.publicKey)) throw new Error('Bridge sequencer KMS record is incomplete')
  return record
}

export function productionSequencer(root: string, spec: DeploymentSpec): {kms?: {expected_pubkey: string; key_id: string; region: string}; publicKey: string; roleArn?: string; serviceAccount?: string} {
  const policy = spec.preparation!.bridge.production!
  if (!policy.sequencerKms) return {publicKey: policy.sequencerPublicKey!}
  const record = readPreparedSequencerKms(root)
  if (!record || record.intentHash !== intentHash(spec)) throw new Error('Bridge sequencer KMS identity is not prepared for this spec')
  if (!/^(02|03)[\da-f]{64}$/.test(record.publicKey)) throw new Error('Invalid saved Bridge sequencer KMS public key')
  bitcore.PublicKey.fromString(record.publicKey)
  return {kms: {expected_pubkey: record.publicKey, key_id: record.keyArn, region: record.region}, publicKey: record.publicKey, roleArn: record.roleArn, serviceAccount: record.serviceAccount}
}

/** A single WP service account must carry both proof-store access and KMS signing. */
export function prepareSequencerKms(root: string, spec: DeploymentSpec, runner?: AwsCliRunner): void {
  const feeWallet = productionFeeWallet(root, spec)
  const intent = spec.preparation!.bridge.production!.sequencerKms!
  const aws = runner ?? new AwsCliRunner(intent.awsProfile)
  const infrastructure = spec.infrastructure.aws!
  const region = intent.region ?? infrastructure.region
  const call = (args: string[], selectedRegion = region) => aws.json(args, {region: selectedRegion})
  const account = call(['sts', 'get-caller-identity']).Account
  if (!/^\d{12}$/.test(account) || infrastructure.accountId && account !== infrastructure.accountId) throw new Error('Bridge KMS AWS account differs from infrastructure.aws.accountId')
  const alias = `alias/dogeos/${sanitizeName(spec.metadata.name)}/${sanitizeName(infrastructure.eksClusterName!)}/bridge-sequencer`
  const recordFile = localPath(root, RECORD)
  let saved: SequencerKmsRecord | undefined = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : undefined
  if (saved && (saved.schema !== 'dogeos/bridge-sequencer-kms/v1' || saved.intentHash !== intentHash(spec))) throw new Error('Existing Bridge KMS record belongs to a different intent; do not replace the identity')
  let metadata: any
  try {metadata = call(['kms', 'describe-key', '--key-id', saved?.keyArn ?? intent.keyId ?? alias]).KeyMetadata} catch (error) {
    if (saved || intent.action !== 'create' || !String(error).includes('NotFoundException')) throw error
    metadata = call(['kms', 'create-key', '--key-spec', 'ECC_SECG_P256K1', '--key-usage', 'SIGN_VERIFY', '--description', 'DogeOS Bridge sequencer signing key']).KeyMetadata
    // Persist the ARN before alias/IAM writes so a normal retry never creates another key.
    saved = {intentHash: intentHash(spec), keyArn: metadata.Arn, publicKey: '', ready: false, region, schema: 'dogeos/bridge-sequencer-kms/v1'}
    writeJson(recordFile, saved)
  }

  if (metadata?.KeySpec !== 'ECC_SECG_P256K1' || metadata.KeyUsage !== 'SIGN_VERIFY' || metadata.KeyState !== 'Enabled' || !metadata.Arn?.startsWith(`arn:aws:kms:${region}:${account}:key/`)) throw new Error('Bridge sequencer needs an enabled ECC_SECG_P256K1 SIGN_VERIFY KMS key in the selected account/region')
  const key = call(['kms', 'get-public-key', '--key-id', metadata.Arn])
  if (key.KeySpec !== 'ECC_SECG_P256K1' || key.KeyUsage !== 'SIGN_VERIFY' || !key.SigningAlgorithms?.includes('ECDSA_SHA_256')) throw new Error('Bridge sequencer KMS signing algorithm is not supported')
  const publicKey = deriveCompressedSecp256k1PublicKeyFromSpkiDer(key.PublicKey)
  bitcore.PublicKey.fromString(publicKey)
  if (saved?.publicKey && (saved.keyArn !== metadata.Arn || saved.publicKey !== publicKey)) throw new Error('Bridge sequencer KMS public identity changed')
  if (publicKey === feeWallet.publicKey) throw new Error('Production sequencer and fee wallet must have different keys')
  saved = {...saved, intentHash: intentHash(spec), keyArn: metadata.Arn, publicKey, ready: false, region, schema: 'dogeos/bridge-sequencer-kms/v1'}
  writeJson(recordFile, saved)
  if (intent.action === 'create') {
    let existing: any
    try {existing = call(['kms', 'describe-key', '--key-id', alias]).KeyMetadata} catch (error) {if (!String(error).includes('NotFoundException')) throw error}
    if (existing && existing.Arn !== metadata.Arn) throw new Error('Bridge sequencer KMS alias points to another key; refusing to retarget it')
    if (!existing) call(['kms', 'create-alias', '--alias-name', alias, '--target-key-id', metadata.Arn])
  }

  const proof = readOptionalProofAwsConfig(root)?.config
  const serviceAccount = spec.proofCoordinator?.withdrawalProcessorServiceAccount?.name ?? 'withdrawal-processor'
  if (proof && (proof.kubernetes.eksCluster !== infrastructure.eksClusterName || proof.kubernetes.namespace !== (spec.infrastructure.namespace ?? 'default') || proof.serviceAccounts.withdrawalProcessor.name !== serviceAccount)) throw new Error('Proof AWS withdrawal identity differs from Bridge KMS workload')
  const proofRole = proof?.serviceAccounts.withdrawalProcessor.roleArn
  if (proofRole && intent.roleArn && proofRole !== intent.roleArn) throw new Error('WP proof access and Bridge KMS must use the same IAM role')
  const roleArn = intent.roleArn ?? proofRole ?? `arn:aws:iam::${account}:role/${truncateIamRoleName(`dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(infrastructure.eksClusterName!)}-wp-kms`)}`
  const roleName = roleArn.split('/').at(-1)!
  if (!roleArn.startsWith(`arn:aws:iam::${account}:role/`)) throw new Error('Bridge KMS workload role must belong to the selected AWS account')
  const issuer = call(['eks', 'describe-cluster', '--name', infrastructure.eksClusterName!], infrastructure.region).cluster?.identity?.oidc?.issuer
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) throw new Error('EKS OIDC issuer is required for Bridge KMS')
  const issuerPath = issuer.slice(8)
  const provider = `arn:aws:iam::${account}:oidc-provider/${issuerPath}`
  call(['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', provider])
  const subject = `system:serviceaccount:${spec.infrastructure.namespace ?? 'default'}:${serviceAccount}`
  let role: any
  try {role = call(['iam', 'get-role', '--role-name', roleName]).Role} catch (error) {
    if (intent.action !== 'create' || intent.roleArn || proofRole || !String(error).includes('NoSuchEntity')) throw error
    const trust = {Statement: [{Action: 'sts:AssumeRoleWithWebIdentity', Condition: {StringEquals: {[`${issuerPath}:aud`]: 'sts.amazonaws.com', [`${issuerPath}:sub`]: subject}}, Effect: 'Allow', Principal: {Federated: provider}}], Version: '2012-10-17'}
    role = call(['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', JSON.stringify(trust)]).Role
  }

  const trust = typeof role?.AssumeRolePolicyDocument === 'string' ? JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument)) : role?.AssumeRolePolicyDocument
  const contains = (value: unknown, expected: string) => value === expected || Array.isArray(value) && value.includes(expected)
  const statements = Array.isArray(trust?.Statement) ? trust.Statement : [trust?.Statement]
  if (role?.Arn !== roleArn || !statements.some((s: any) => s?.Effect === 'Allow' && contains(s.Action, 'sts:AssumeRoleWithWebIdentity') && contains(s.Principal?.Federated, provider) && contains(s.Condition?.StringEquals?.[`${issuerPath}:aud`], 'sts.amazonaws.com') && contains(s.Condition?.StringEquals?.[`${issuerPath}:sub`], subject))) throw new Error('Bridge KMS IAM role does not trust the selected EKS service account')
  if (intent.action === 'create') {
    const policy = {Statement: [{Action: ['kms:GetPublicKey', 'kms:Sign'], Effect: 'Allow', Resource: metadata.Arn}], Version: '2012-10-17'}
    call(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'dogeos-bridge-sequencer-kms', '--policy-document', JSON.stringify(policy)])
  } else {
    const evaluation = call(['iam', 'simulate-principal-policy', '--policy-source-arn', roleArn, '--action-names', 'kms:GetPublicKey', 'kms:Sign', '--resource-arns', metadata.Arn]).EvaluationResults ?? []
    if (!['kms:GetPublicKey', 'kms:Sign'].every(action => evaluation.some((item: any) => item.EvalActionName === action && item.EvalResourceName === metadata.Arn && item.EvalDecision === 'allowed'))) throw new Error('Existing WP role must allow kms:GetPublicKey and kms:Sign for the sequencer key')
  }

  writeJson(recordFile, {...saved, ready: true, roleArn, serviceAccount})
}
