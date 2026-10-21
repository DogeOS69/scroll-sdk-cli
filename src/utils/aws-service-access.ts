/* eslint-disable @typescript-eslint/no-explicit-any -- AWS metadata and Helm values. */
import * as toml from '@iarna/toml'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {ARCHIVE_WRITER_POLICY_NAMES, applyArtifactAccess, buildArchiveWriterPolicy, planArtifactAccess} from './artifact-access.js'
import {AwsCliRunner} from './aws-cli.js'
import {sanitizeName} from './kms-signer-provisioner.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'
import {defaultProofSecretName, readOptionalProofAwsConfig} from './proof-aws-config.js'
import {buildProofArtifactStorePolicy} from './proof-aws-provisioner.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'
import {specAwsSecretPrefix} from './spec-secret-prefix.js'

export const AWS_ACCESS_RECORD = '.data/aws-service-access.json'
export const AWS_ACCESS_PLAN = '.scrollsdk/aws-service-access.json'
const ANNOTATION = 'eks.amazonaws.com/role-arn'
const POLICY = 'scrollsdk-service-access'
const TOKENS = new Set(['proof-work-token', 'prover-worker-master'])
type Reader = {roleName: string; secrets: string[]; serviceAccount: string}
export interface AwsAccessPlan {cluster: string; namespace: string; prefix: string; proofSecret?: {name: string; region: string}; reader: Reader; region: string; runtimePermissions: Record<string, unknown>; serviceSecrets: Record<string, string[]>}
interface AwsAccessRecord extends AwsAccessPlan {account: string; reader: {roleArn?: string} & Reader; runtime: Record<string, {name: string; roleArn: string}>}

export function managesAwsAccess(spec: DeploymentSpec): boolean {return spec.preparation?.awsAccess?.mode === 'managed'}

export function validateAwsAccess(spec: DeploymentSpec): void {
  const access = spec.preparation?.awsAccess
  if (!access) return
  if (!['external', 'managed'].includes(access.mode)) throw new Error('awsAccess.mode must be managed or external')
  if (!managesAwsAccess(spec)) return
  if (spec.infrastructure.provider !== 'aws' || !spec.infrastructure.aws?.eksClusterName) throw new Error('Managed AWS access requires an EKS cluster')
  if (spec.preparation?.secretUpload?.provider === 'vault') throw new Error('Managed AWS access requires AWS Secrets Manager')
  if (spec.proofArtifacts?.s3 && spec.preparation?.proofAws?.action !== 'create') throw new Error('Managed proof permissions require proofAws.action: create (creates missing resources and reconciles existing resources); reuse remains read-only')
  if (spec.ethereumDa?.blobArchive?.s3?.enabled && (!spec.preparation?.archive || spec.preparation.archive.publicRead === undefined)) throw new Error('Managed DA access requires archive.action and an explicit archive.publicRead')
  if (spec.preparation?.archive?.writerRoleArn && spec.preparation.archive.writerRoleArn !== spec.identities?.ethDaSubmitter?.kms?.roleArn) throw new Error('Managed DA permissions bind the service runtime role; remove archive.writerRoleArn or select the same explicit KMS role')
  if (spec.snapshots?.s3 && (!access.snapshot || typeof access.snapshot.publicRead !== 'boolean' || !['configure', 'create'].includes(access.snapshot.action))) throw new Error('Managed snapshots require awsAccess.snapshot.action and publicRead')
  if (access.secretReaderServiceAccount && !/^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(access.secretReaderServiceAccount)) throw new Error('Secret reader ServiceAccount must be a DNS label')
  if (access.snapshot && (access.snapshot.serviceAccount ?? 'snapshot-writer') === (access.secretReaderServiceAccount ?? 'external-secrets')) throw new Error('Snapshot writer and Secret reader require separate ServiceAccounts')
  if (access.snapshot?.serviceAccount && !/^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/.test(access.snapshot.serviceAccount)) throw new Error('Snapshot ServiceAccount must be a DNS label')
  if (access.snapshot && !spec.snapshots?.s3) throw new Error('Snapshot preparation requires snapshots.s3')
  if (access.secretsKmsKeyArn && !/^arn:aws:kms:[\w-]+:\d{12}:key\/[\w-]+$/.test(access.secretsKmsKeyArn)) throw new Error('secretsKmsKeyArn must be an exact KMS key ARN')
}

/** Public, offline inventory from the pinned SDK. No credentials or provider calls. */
export function planAwsAccess(spec: DeploymentSpec, templates: Record<string, string>): AwsAccessPlan | undefined {
  validateAwsAccess(spec)
  if (!managesAwsAccess(spec)) return
  if (!templates.Makefile?.includes('install-aws-identities:')) throw new Error('Managed AWS access requires an SDK revision with the install-aws-identities target')
  const prefix = specAwsSecretPrefix(spec)
  const {namespace} = specKubernetesTarget(spec)
  const serviceSecrets: Record<string, string[]> = {}
  const proofSecret = spec.preparation?.proofAws ? {name: spec.preparation.proofAws.secretName ?? defaultProofSecretName(sanitizeName(spec.metadata.name)), region: spec.infrastructure.aws!.region} : undefined
  const reader: Reader = {
    roleName: `dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(namespace)}-secrets`,
    secrets: [],
    serviceAccount: spec.preparation!.awsAccess!.secretReaderServiceAccount ?? 'external-secrets',
  }
  if (reader.roleName.length > 64) throw new Error('Deployment/namespace names are too long for the shared reader role; use shorter names')
  const add = (service: string, names: string[]) => {serviceSecrets[service] = [...new Set(names)].sort()}

  for (const [file, text] of Object.entries(templates)) {
    const match = /^values\/(.+)-production\.yaml$/.exec(file)
    if (!match) continue
    const service = match[1]
    if (service === 'cubesigner-signer' && !spec.signing?.cubesigner) continue
    const values = yaml.load(text) as any
    const names = Object.values(values?.externalSecrets ?? {}).flatMap((entry: any) => (entry.data ?? []).map((item: any) => {
      if (proofSecret && ['proof-coordinator', 'withdrawal-processor'].includes(service) && TOKENS.has(item.remoteRef?.property)) return proofSecret.name
      const name = item.remoteRef?.key?.split('/').at(-1)
      return name ? `${prefix}/${name}` : undefined
    })).filter((name: unknown): name is string => typeof name === 'string')
    // These references may be added only during final RPC reconciliation.
    if (service === 'proof-coordinator') names.push(`${prefix}/proof-coordinator-rpc-env`)
    if (service === 'scroll-monitor') names.push(`${prefix}/scroll-monitor-balance-env`)
    const node = /^l2-reth-(sequencer|bootnode)$/.exec(service)
    if (node) {
      const count = node[1] === 'sequencer' ? spec.infrastructure.sequencerCount : spec.infrastructure.bootnodeCount
      for (let i = 0; i < count; i++) add(`${service}-${i}`, names.map(name => name.replace('__INSTANCE_INDEX__', String(i))))
    } else if (names.length > 0) add(service, names)
  }

  reader.secrets = [...new Set(Object.values(serviceSecrets).flat())].sort()
  const runtimePermissions: Record<string, unknown> = {}
  const proof = spec.proofArtifacts?.s3
  if (proof) {
    runtimePermissions['proof-coordinator'] = buildProofArtifactStorePolicy(proof.bucket, proof.keyPrefix, {deleteObjects: true, listObjects: true})
    runtimePermissions['withdrawal-processor'] = buildProofArtifactStorePolicy(proof.bucket, proof.keyPrefix)
  }

  const da = spec.ethereumDa?.blobArchive?.s3
  if (da?.enabled) runtimePermissions['eth-da-submitter'] = buildArchiveWriterPolicy('da', {bucket: da.bucket!, keyPrefix: da.keyPrefix}, proof)
  if (spec.snapshots?.s3) runtimePermissions['snapshot-writer'] = snapshotWriterPolicy(spec.snapshots.s3)
  for (const [service, identity] of [
    ['eth-da-submitter', spec.identities?.ethDaSubmitter], ['fee-oracle', spec.identities?.feeOracle],
    ...(spec.identities?.sequencers ?? []).map(node => [`l2-reth-sequencer-${node.index}`, node.signer] as const),
  ] as const) {
    if (identity?.backend === 'aws_kms') runtimePermissions[`${service}:signing`] = {actions: ['kms:GetPublicKey', 'kms:Sign'], key: identity.kms?.keyId ?? 'created by identities', role: 'service runtime role'}
  }

  if (spec.preparation?.bridge?.production?.sequencerKms) runtimePermissions['withdrawal-processor:signing'] = {actions: ['kms:GetPublicKey', 'kms:Sign'], key: spec.preparation.bridge.production.sequencerKms.keyId ?? 'created by bridge-sequencer-kms'}
  if (spec.preparation?.dstack?.providers?.includes('aws')) runtimePermissions['dstack-controller'] = {network: spec.preparation.dstack.aws?.vpcIds, preparation: spec.preparation.dstack.aws?.action ?? 'external', project: spec.preparation.dstack.project ?? 'main'}
  return {cluster: spec.infrastructure.aws!.eksClusterName, namespace, prefix, proofSecret, reader, region: spec.preparation?.secretUpload?.awsRegion ?? spec.infrastructure.aws!.region, runtimePermissions, serviceSecrets}
}

/** Exact secret ARNs: selecting a JSON property is not a permission boundary. */
export function secretReaderPolicy(arns: string[], region: string, kmsKeyArn?: string): any {
  return {Statement: [
    {Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Effect: 'Allow', Resource: [...new Set(arns)].sort()},
    ...(kmsKeyArn ? [{Action: 'kms:Decrypt', Condition: {StringEquals: {'kms:EncryptionContext:SecretARN': [...new Set(arns)].sort(), 'kms:ViaService': [...new Set(arns.map(arn => `secretsmanager.${arn.split(':')[3] || region}.amazonaws.com`))]}}, Effect: 'Allow', Resource: kmsKeyArn}] : []),
  ], Version: '2012-10-17'}
}

export function irsaTrust(issuer: string, account: string, namespace: string, serviceAccount: string): any {
  return {Statement: [{Action: 'sts:AssumeRoleWithWebIdentity', Condition: {StringEquals: {
    [`${issuer}:aud`]: 'sts.amazonaws.com', [`${issuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
  }}, Effect: 'Allow', Principal: {Federated: `arn:aws:iam::${account}:oidc-provider/${issuer}`}}], Version: '2012-10-17'}
}

/** Mutates only explicit managed resources; existing unowned roles are never adopted. */
export function prepareAwsAccess(root: string, spec: DeploymentSpec, runner: Pick<AwsCliRunner, 'json' | 'run' | 'text'> = new AwsCliRunner(spec.preparation?.awsAccess?.awsProfile)): void {
  if (!managesAwsAccess(spec)) return
  validateAwsAccess(spec)
  const plan: AwsAccessPlan = JSON.parse(fs.readFileSync(localPath(root, AWS_ACCESS_PLAN), 'utf8'))
  if (!plan.reader || !plan.serviceSecrets) throw new Error('Regenerate the AWS access plan for the shared Secret reader workflow')
  const proof = readOptionalProofAwsConfig(root)?.config
  if (plan.proofSecret) {
    if (!proof) throw new Error('Prepare proof AWS resources before shared Secret access')
    const planned = plan.proofSecret.name
    plan.proofSecret = proof.secret
    for (const [service, names] of Object.entries(plan.serviceSecrets)) plan.serviceSecrets[service] = names.map(name => name === planned ? proof.secret.name : name)
    plan.reader.secrets = [...new Set(Object.values(plan.serviceSecrets).flat())].sort()
  }

  const access = spec.preparation!.awsAccess!
  const infrastructure = spec.infrastructure.aws!
  // Never include raw AWS stderr, command arguments, or SecretString in errors.
  const query = (args: string[], region = plan.region, missing?: RegExp): any => {
    try {return runner.json(args, {region})} catch (error) {
      if (missing?.test(String(error))) return undefined
      throw new Error(`AWS access preparation: ${args.slice(0, 2).join(' ')} failed; check operator permissions and selected profile`)
    }
  }

  const caller = query(['sts', 'get-caller-identity'])
  const account = caller.Account
  if (!/^\d{12}$/.test(account ?? '') || !caller.Arn?.startsWith('arn:aws:') || infrastructure.accountId && infrastructure.accountId !== account) throw new Error('AWS access account does not match the deployment')
  const issuerUrl = query(['eks', 'describe-cluster', '--name', plan.cluster], infrastructure.region).cluster?.identity?.oidc?.issuer
  if (typeof issuerUrl !== 'string' || !issuerUrl.startsWith('https://')) throw new Error('EKS cluster has no OIDC issuer')
  const issuer = issuerUrl.slice(8)
  const oidc = query(['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', `arn:aws:iam::${account}:oidc-provider/${issuer}`])
  if (!oidc.ClientIDList?.includes('sts.amazonaws.com')) throw new Error('Register the EKS IAM OIDC provider with sts.amazonaws.com before setup aws')
  const tags = {Cluster: plan.cluster, Deployment: spec.metadata.name, ManagedBy: 'scrollsdk-aws-access', Namespace: plan.namespace}
  const role = (name: string, sa: string, policy: any, policyName = POLICY): string => {
    const trust = irsaTrust(issuer, account, plan.namespace, sa)
    let found = query(['iam', 'get-role', '--role-name', name], plan.region, /\bNoSuchEntity\b/)?.Role
    if (found) {
      const actual = Object.fromEntries((found.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]))
      if (Object.entries({...tags, ServiceAccount: sa}).some(([key, value]) => actual[key] !== value)) throw new Error('IAM role exists without matching deployment ownership; choose another deployment name or external access mode')
      const inline = query(['iam', 'list-role-policies', '--role-name', name]).PolicyNames
      const attached = query(['iam', 'list-attached-role-policies', '--role-name', name]).AttachedPolicies
      if (!Array.isArray(inline) || !Array.isArray(attached) || inline.some(item => item !== policyName) || attached.length > 0) throw new Error('Managed IAM role has additional policies; remove them explicitly or select external access')
      query(['iam', 'update-assume-role-policy', '--role-name', name, '--policy-document', JSON.stringify(trust)])
    } else {
      found = query(['iam', 'create-role', '--role-name', name, '--assume-role-policy-document', JSON.stringify(trust), '--tags', JSON.stringify(Object.entries({...tags, ServiceAccount: sa}).map(([Key, Value]) => ({Key, Value})))]).Role
    }

    if (found?.Arn !== `arn:aws:iam::${account}:role/${name}`) throw new Error('Unexpected IAM role ARN')
    query(['iam', 'put-role-policy', '--role-name', name, '--policy-name', policyName, '--policy-document', JSON.stringify(policy)])
    return found.Arn
  }

  const secrets = new Map<string, string>()
  for (const name of plan.reader.secrets) {
    const isProof = name === plan.proofSecret?.name
    const region = isProof ? plan.proofSecret!.region : plan.region
    let secret = query(['secretsmanager', 'describe-secret', '--secret-id', name], region, /\bResourceNotFoundException\b/)
    if (!secret && isProof) throw new Error('Prepared proof token Secret does not exist')
    if (!secret) secret = query(['secretsmanager', 'create-secret', '--name', name, '--tags', JSON.stringify(Object.entries(tags).map(([Key, Value]) => ({Key, Value}))), ...(access.secretsKmsKeyArn ? ['--kms-key-id', access.secretsKmsKeyArn] : [])])
    if (secret.DeletedDate || secret.Name !== name || !secret.ARN?.startsWith(`arn:aws:secretsmanager:${region}:${account}:secret:${name}-`)) throw new Error('Secret metadata does not match the planned destination')
    if (secret.KmsKeyId && secret.KmsKeyId !== 'alias/aws/secretsmanager' && secret.KmsKeyId !== access.secretsKmsKeyArn) throw new Error('Existing Secret uses another KMS key; select its exact secretsKmsKeyArn or manage access externally')
    secrets.set(name, secret.ARN)
  }

  // The shared reader covers the deployment's union of exact Secret ARNs.
  // Existing proof tokens stay in their original object; never read or copy values.
  const reader: AwsAccessRecord['reader'] = {...plan.reader}
  if (secrets.size > 0) reader.roleArn = role(reader.roleName, reader.serviceAccount, secretReaderPolicy([...secrets.values()], plan.region, access.secretsKmsKeyArn))
  const runtime: AwsAccessRecord['runtime'] = {}
  const checkBucket = (bucket: string, region: string) => {
    query(['s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', account], region)
    const location = query(['s3api', 'get-bucket-location', '--bucket', bucket], region).LocationConstraint
    if ((location === 'EU' ? 'eu-west-1' : location || 'us-east-1') !== region) throw new Error('Bucket region differs from the service access plan')
    const encryption = query(['s3api', 'get-bucket-encryption', '--bucket', bucket], region, /ServerSideEncryptionConfigurationNotFoundError/)
    if (encryption?.ServerSideEncryptionConfiguration?.Rules?.some((rule: any) => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm !== 'AES256')) throw new Error('Managed artifact permissions currently require SSE-S3 buckets; configure SSE-KMS permissions in external mode')
  }

  const endpointFor = (region: string) => proof?.kubernetes.awsRegion === region ? proof.artifactReadTransport.vpcEndpoint?.vpcEndpointId : undefined
  if (spec.proofArtifacts?.s3) checkBucket(spec.proofArtifacts.s3.bucket, spec.proofArtifacts.s3.region ?? infrastructure.region)
  let config: any
  try {config = toml.parse(fs.readFileSync(localPath(root, '.data/doge-config.toml'), 'utf8'))} catch {throw new Error('Cannot read deployment configuration for AWS access (contents omitted)')}
  if (spec.ethereumDa?.blobArchive?.s3?.enabled) {
    const input = spec.ethereumDa.blobArchive.s3!
    const store = {bucket: input.bucket!, endpointUrl: input.endpointUrl, keyPrefix: input.keyPrefix!, region: input.region ?? infrastructure.region}
    checkBucket(store.bucket, store.region)
    const signer = config.signers?.l1CommitSender
    const name = signer?.serviceAccountName ?? 'eth-da-submitter'
    let arn = signer?.serviceAccountRoleArn
    if (!arn) arn = role(`dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(plan.namespace)}-da`, name, buildArchiveWriterPolicy('da', store, spec.proofArtifacts?.s3), ARCHIVE_WRITER_POLICY_NAMES.da)
    if (spec.preparation?.archive?.writerRoleArn && spec.preparation.archive.writerRoleArn !== arn) throw new Error('archive.writerRoleArn conflicts with the service runtime role')
    // KMS-backed services retain their signing role; only its named S3 policy is reconciled.
    try {applyArtifactAccess(runner, planArtifactAccess(runner, 'da', {...store, forcePathStyle: false}, {allowBucketPublicPolicy: spec.preparation!.archive!.publicRead, publicRead: spec.preparation!.archive!.publicRead, sidecarStore: spec.proofArtifacts?.s3 ? {...spec.proofArtifacts.s3, forcePathStyle: false, region: spec.proofArtifacts.s3.region ?? infrastructure.region} : undefined, vpcEndpointId: endpointFor(store.region), writerRoleArn: arn}))} catch {throw new Error('DA bucket access preparation failed; check bucket ownership, public access settings and writer policy')}
    runtime['eth-da-submitter'] = {name, roleArn: arn}
  }

  if (access.snapshot) {
    const store = spec.snapshots!.s3!
    let exists = true
    try {runner.json(['s3api', 'head-bucket', '--bucket', store.bucket, '--expected-bucket-owner', account], {region: store.region})} catch (error) {
      if (!/404|NoSuchBucket|NotFound/.test(String(error))) throw new Error('Cannot access snapshot bucket in the selected account')
      exists = false
    }

    if (!exists) {
      if (access.snapshot.action !== 'create') throw new Error('Snapshot bucket does not exist; select snapshot.action: create')
      query(['s3api', 'create-bucket', '--bucket', store.bucket, ...(store.region === 'us-east-1' ? [] : ['--create-bucket-configuration', JSON.stringify({LocationConstraint: store.region})])], store.region)
      query(['s3api', 'put-public-access-block', '--bucket', store.bucket, '--public-access-block-configuration', JSON.stringify({BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true})], store.region)
    }

    checkBucket(store.bucket, store.region)
    const name = access.snapshot.serviceAccount ?? 'snapshot-writer'
    const policy = snapshotWriterPolicy(store)
    const arn = role(`dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(plan.namespace)}-snapshot`, name, policy)
    try {applyArtifactAccess(runner, planArtifactAccess(runner, 'snapshot', {...store, forcePathStyle: false}, {allowBucketPublicPolicy: access.snapshot.publicRead, publicRead: access.snapshot.publicRead, vpcEndpointId: endpointFor(store.region)}))} catch {throw new Error('Snapshot bucket access preparation failed; check ownership and public access settings')}
    runtime['snapshot-writer'] = {name, roleArn: arn}
  }

  writeJson(localPath(root, AWS_ACCESS_RECORD), {...plan, account, reader, runtime})
}

/** Projection uses JSON fields, not a fingerprint or serialized-file equality. */
export function bindAwsAccessValues(values: any, service: string, record: AwsAccessRecord): void {
  const runtime = record.runtime[service]
  if (runtime) values.serviceAccount = {...values.serviceAccount, annotations: {...values.serviceAccount?.annotations, [ANNOTATION]: runtime.roleArn}, create: true, name: runtime.name}
  for (const entry of Object.values(values.externalSecrets ?? {}) as any[]) {
    if (entry.provider && entry.provider !== 'aws') throw new Error('Managed AWS access cannot bind a non-AWS SecretStore')
    const {reader} = record
    if (!reader.roleArn || !record.serviceSecrets[service]) throw new Error(`No prepared Secret access for ${service}`)
    const regions = new Set<string>()
    for (const item of entry.data ?? []) {
      if (!item.remoteRef?.key) continue
      const isProof = record.proofSecret && ['proof-coordinator', 'withdrawal-processor'].includes(service) && TOKENS.has(item.remoteRef.property)
      const remote = isProof ? record.proofSecret!.name : `${record.prefix}/${item.remoteRef.key.split('/').at(-1)}`
      regions.add(isProof ? record.proofSecret!.region : record.region)
      if (!record.serviceSecrets[service].includes(remote) || !reader.secrets.includes(remote)) throw new Error(`Secret reference for ${service} is outside its prepared access plan`)
      item.remoteRef.key = remote
    }

    if (regions.size > 1) throw new Error('One SecretStore cannot read Secrets from different AWS regions; use separate ExternalSecret entries')
    entry.provider = 'aws'
    entry.serviceAccount = reader.serviceAccount
    entry.secretRegion = [...regions][0] ?? record.region
  }
}

export function bindPreparedAwsAccess(root: string, valuesDirectory = 'values'): void {
  const file = localPath(root, AWS_ACCESS_RECORD)
  if (!fs.existsSync(file)) return
  const record: AwsAccessRecord = JSON.parse(fs.readFileSync(file, 'utf8'))
  const directory = localPath(root, valuesDirectory)
  for (const name of fs.readdirSync(directory)) {
    const match = /^(.+)-production(?:-(\d+))?\.yaml$/.exec(name)
    if (!match || match[1] === 'aws-access') continue
    // Base Reth templates contain __INSTANCE_INDEX__, never installed directly.
    if (/^l2-reth-(sequencer|bootnode)$/.test(match[1]) && match[2] === undefined) continue
    const service = match[2] === undefined ? match[1] : `${match[1]}-${match[2]}`
    const values = yaml.load(fs.readFileSync(path.join(directory, name), 'utf8')) as any
    if (!record.serviceSecrets[service] && !record.runtime[service]) continue
    bindAwsAccessValues(values, service, record)
    privateWrite(path.join(directory, name), yaml.dump(values, {lineWidth: -1, noRefs: true}))
  }

  const manifest = (name: string, roleArn: string) => yaml.dump({
    apiVersion: 'v1', automountServiceAccountToken: false, kind: 'ServiceAccount',
    metadata: {annotations: {[ANNOTATION]: roleArn}, name, namespace: record.namespace},
  }, {lineWidth: -1, noRefs: true})
  if (record.reader.roleArn) privateWrite(localPath(root, 'manifests/aws-secret-reader.yaml'), manifest(record.reader.serviceAccount, record.reader.roleArn))
  const snapshot = record.runtime['snapshot-writer']
  if (snapshot) privateWrite(localPath(root, 'manifests/snapshot-writer-serviceaccount.yaml'), manifest(snapshot.name, snapshot.roleArn))
}

/** Reject an upload destination override before any secret leaves the host. */
export function assertAwsAccessUpload(root: string, prefix: string, region: string): string | undefined {
  const file = localPath(root, AWS_ACCESS_RECORD)
  if (!fs.existsSync(file)) return
  const record: AwsAccessRecord = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (record.prefix !== prefix || record.region !== region) throw new Error('Upload destination differs from the prepared deployment AWS access; use the saved prefix and region')
  return record.account
}

function snapshotWriterPolicy(store: {bucket: string; keyPrefix?: string}): any {
  const policy = buildArchiveWriterPolicy('snapshot', store) as any
  policy.Statement[0].Action = ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts']
  return policy
}

/** Preserve a prepared reader even when push-secrets targets a single custom values file. */
export function preparedAwsReader(root: string, name: unknown): string | undefined {
  const file = localPath(root, AWS_ACCESS_RECORD)
  if (!fs.existsSync(file) || typeof name !== 'string') return
  const record: AwsAccessRecord = JSON.parse(fs.readFileSync(file, 'utf8'))
  return record.reader?.serviceAccount === name ? name : undefined
}
