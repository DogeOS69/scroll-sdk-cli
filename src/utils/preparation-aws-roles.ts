/* eslint-disable @typescript-eslint/no-explicit-any -- Deployment records and AWS metadata. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {getSequencerRethResourceName} from '../commands/setup/l2-sequencer-reth.js'
import {AwsCliRunner} from './aws-cli.js'
import {readAwsResource, readExternalRole} from './aws-resource-reader.js'
import {awsWorkloadIdentity} from './aws-workload-identity.js'
import {externalRoleArn, validateExternalAwsRoles} from './external-aws-roles.js'
import {DSTACK_AWS_RECORD, bindPreparedDstackAws, dstackAwsIntent} from './preparation-dstack-aws.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'
import {readPreparedSequencerKms} from './preparation-sequencer-kms.js'
import {readOptionalProofAwsConfig, writeProofAwsConfig} from './proof-aws-config.js'
import {resolveSpecIdentities} from './spec-identities.js'

export const AWS_ROLES_RECORD = '.data/aws-roles.json'

export function usesWorkloadRoles(spec: DeploymentSpec): boolean {
  const p = spec.preparation
  return spec.infrastructure?.provider === 'aws' && Boolean(JSON.stringify(spec.identities ?? {}).includes('aws_kms') || p?.proofAws || p?.bridge?.production?.sequencerKms || dstackAwsIntent(spec) || spec.infrastructure.aws?.roles?.externalSecrets)
}

/** Resolve supplied role ARNs and bind them to local service configuration. No policies or trust audits. */
export function prepareAwsRoles(root: string, spec: DeploymentSpec, aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner(spec.preparation?.awsIam?.awsProfile), log: (message: string) => void = message => process.stderr.write(`aws-roles: ${message}\n`)): void {
  validateExternalAwsRoles(spec)
  const {region} = (spec.infrastructure.aws!)
  const file = localPath(root, '.data/doge-config.toml')
  const config: any = fs.existsSync(file) ? toml.parse(fs.readFileSync(file, 'utf8')) : {}
  const mode = awsWorkloadIdentity(spec)
  config.awsWorkloadIdentity = mode
  const identities = resolveSpecIdentities(spec)
  const bindings: Array<{apply(arn: string): void; entry: string; serviceAccount: string}> = []
  const signer = (entry: string, serviceAccount: string, target: any) => {
    if (!target?.kmsKeyArn) throw new Error(`Missing prepared signing identity for ${entry}; run setup aws`)
    bindings.push({apply(arn) {target.serviceAccountName = serviceAccount; target.serviceAccountRoleArn = arn}, entry, serviceAccount})
  }

  if (identities?.ethDaSubmitter.backend === 'aws_kms') signer('eth-da-submitter', 'eth-da-submitter', config.signers?.l1CommitSender)
  if (identities?.feeOracle.backend === 'aws_kms') signer('fee-oracle', 'fee-oracle', config.signers?.l2GasOracleSender)
  for (const node of identities?.sequencers ?? []) if (node.signer.backend === 'aws_kms') signer(`sequencer-reth-${node.index}`, getSequencerRethResourceName(node.index), config.sequencerReth?.instances?.find((item: any) => item.index === node.index)?.signer)
  const proofFile = spec.preparation?.proofAws ? readOptionalProofAwsConfig(root) : undefined
  if (spec.preparation?.proofAws && !proofFile) throw new Error('Missing prepared proof resource references; run setup aws')
  const proof = proofFile?.config
  const bridge = spec.preparation?.bridge.production?.sequencerKms ? readPreparedSequencerKms(root, false) : undefined
  if (spec.preparation?.bridge.production?.sequencerKms && !bridge) throw new Error('Missing prepared Bridge signing identity; run setup aws')
  if (proof) bindings.push({apply(arn) {proof.serviceAccounts.proofCoordinator.roleArn = arn}, entry: 'proof-coordinator', serviceAccount: proof.serviceAccounts.proofCoordinator.name})
  if (proof || bridge) bindings.push({apply(arn) {
    if (proof) proof.serviceAccounts.withdrawalProcessor.roleArn = arn
    if (bridge) writeJson(localPath(root, '.data/bridge-sequencer-kms.json'), {...bridge, roleArn: arn})
  }, entry: 'withdrawal-processor', serviceAccount: proof?.serviceAccounts.withdrawalProcessor.name ?? bridge!.serviceAccount!})
  const dstack = dstackAwsIntent(spec)
  if (dstack) bindings.push({apply(arn) {
    const record = JSON.parse(fs.readFileSync(localPath(root, DSTACK_AWS_RECORD), 'utf8'))
    writeJson(localPath(root, DSTACK_AWS_RECORD), {...record, controllerRoleArn: arn})
  }, entry: 'dstack-controller', serviceAccount: dstack.serviceAccount})
  if (spec.infrastructure.aws?.roles?.externalSecrets) bindings.push({apply() {}, entry: 'external-secrets', serviceAccount: 'external-secrets'})
  // Complete reads before updating local bindings; a failed read leaves no partial role selection.
  const resolved = bindings.map(binding => {
    const arn = readExternalRole(aws, externalRoleArn(spec, binding.entry), region)
    if (mode !== 'pod-identity' || binding.entry === 'external-secrets') return {...binding, arn}
    const cluster = spec.infrastructure.aws!.eksClusterName!
    const namespace = spec.infrastructure.namespace ?? 'default'
    const list = readAwsResource(aws, ['eks', 'list-pod-identity-associations', '--cluster-name', cluster, '--namespace', namespace, '--service-account', binding.serviceAccount], region)
    const associationId = list.associations?.[0]?.associationId
    if (!associationId) throw new Error(`Missing external Pod Identity association for ${namespace}/${binding.serviceAccount}; apply the workload-access infrastructure stack first`)
    const {association} = readAwsResource(aws, ['eks', 'describe-pod-identity-association', '--cluster-name', cluster, '--association-id', associationId], region)
    if (association?.roleArn !== arn) throw new Error(`Pod Identity association for ${namespace}/${binding.serviceAccount} references a different role than infrastructure.aws.roles`)
    return {...binding, arn, associationId}
  })
  for (const binding of resolved) {binding.apply(binding.arn); log(`${binding.entry}: resolved external role`)}
  if (fs.existsSync(file)) privateWrite(file, toml.stringify(config))
  if (proofFile) {proofFile.config.workloadIdentity = mode; writeProofAwsConfig(proofFile.configPath, proofFile.config)}
  if (dstack) bindPreparedDstackAws(root, spec)
  writeJson(localPath(root, AWS_ROLES_RECORD), {account: spec.infrastructure.aws!.accountId, roles: resolved.map(({arn, entry, serviceAccount, ...metadata}) => ({...('associationId' in metadata ? {associationId: metadata.associationId} : {}), catalogEntry: entry, namespace: spec.infrastructure.namespace ?? 'default', roleArn: arn, serviceAccount})), schema: 'dogeos/aws-roles/v3', source: 'resource-metadata', workloadIdentity: mode})
}
