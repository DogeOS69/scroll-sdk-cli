/* eslint-disable @typescript-eslint/no-explicit-any -- AWS CLI metadata and deployment TOML. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {AwsCliRunner} from './aws-cli.js'
import {readExternalRole} from './aws-resource-reader.js'
import {awsWorkloadIdentity, bindAwsServiceAccount} from './aws-workload-identity.js'
import {validateDstackAwsBackend} from './dstack-credentials.js'
import {externalRoleArn} from './external-aws-roles.js'
import {localPath, privateWrite, writeJson} from './preparation-io.js'
import {specKubernetesTarget} from './spec-kubernetes-target.js'

export const DSTACK_AWS_RECORD = '.data/dstack-aws.json'
const ROLE_ANNOTATION = 'eks.amazonaws.com/role-arn'

/**
 * Resolve public intent only: planning must never contact AWS. Importing the AWS
 * provider always prepares the externally managed controller role; render binds it.
 */
export function dstackAwsIntent(spec: DeploymentSpec): {namespace: string; roleName: string; serviceAccount: string} | undefined {
  const dstack = spec.preparation?.dstack
  if (dstack?.mode !== 'import' || !dstack.providers?.includes('aws')) {
    if (dstack?.aws?.awsProfile) throw new Error('Dstack awsProfile requires the imported AWS provider')
    return
  }

  const input = dstack.aws
  const controller = spec.dstackController
  if (!controller || controller.enabled === false || spec.infrastructure?.provider !== 'aws' || !spec.infrastructure.aws?.eksClusterName) throw new Error('The imported AWS dstack provider requires an enabled controller on an EKS cluster')
  validateDstackAwsBackend(input)
  if (controller.defaultCredentialsEnabled === false) throw new Error('Dstack AWS preparation requires default credentials; remove defaultCredentialsEnabled: false')
  const serviceAccount = controller.serviceAccount?.name ?? controller.fullnameOverride ?? 'dstack-controller'
  if (!/^[\da-z](?:[\d.a-z-]{0,251}[\da-z])?$/.test(serviceAccount)) throw new Error('Dstack ServiceAccount requires a Kubernetes resource name')
  // Render annotates the ServiceAccount with the external role, so Helm must own it.
  if (controller.serviceAccount?.create === false) throw new Error('The imported AWS dstack provider binds the selected external role through the chart ServiceAccount; remove dstackController.serviceAccount.create: false')
  const roleArn = externalRoleArn(spec, 'dstack-controller')
  const roleName = roleArn.split('/').at(-1)!
  const annotation = controller.serviceAccount?.annotations?.[ROLE_ANNOTATION]
  if (annotation !== undefined && annotation !== roleArn) throw new Error('dstackController ServiceAccount role differs from infrastructure.aws.roles.dstackController')
  return {namespace: specKubernetesTarget(spec).namespace, roleName, serviceAccount}
}

/** Resolve the externally supplied role; infrastructure templates own its permissions and network. */
export function prepareDstackAws(root: string, spec: DeploymentSpec, aws: Pick<AwsCliRunner, 'json'> = new AwsCliRunner(spec.preparation?.dstack?.aws?.awsProfile)): void {
  const intent = dstackAwsIntent(spec)
  if (!intent) return
  const infrastructure = spec.infrastructure.aws!
  const controllerRoleArn = readExternalRole(aws, externalRoleArn(spec, 'dstack-controller'), infrastructure.region)
  writeJson(localPath(root, DSTACK_AWS_RECORD), {account: infrastructure.accountId, cluster: infrastructure.eksClusterName, controllerRoleArn, namespace: intent.namespace, region: infrastructure.region, serviceAccount: intent.serviceAccount})
}

/** Read public outputs as JSON fields. No hashes or byte-level equality gates. */
export function withPreparedDstackAws(root: string, spec: DeploymentSpec): DeploymentSpec {
  const intent = dstackAwsIntent(spec)
  if (!intent) return spec
  let record: any
  try {record = JSON.parse(fs.readFileSync(localPath(root, DSTACK_AWS_RECORD), 'utf8'))} catch {throw new Error('Prepare dstack AWS resources with setup aws before rendering or preparing capacity-manager')}
  const infrastructure = spec.infrastructure.aws!
  if (record.cluster !== infrastructure.eksClusterName || record.region !== infrastructure.region || record.namespace !== intent.namespace || record.serviceAccount !== intent.serviceAccount || infrastructure.accountId && record.account !== infrastructure.accountId) throw new Error('Prepared dstack resources target a different EKS workload; run the AWS preparation for this deployment')
  if (record.controllerRoleArn !== externalRoleArn(spec, 'dstack-controller')) throw new Error('The dstack controller role is not bound; run setup aws so the aws-roles step prepares it')
  const controller = spec.dstackController!
  const configured = {...controller, awsWorkloadIdentity: awsWorkloadIdentity(spec), defaultCredentialsEnabled: true, serviceAccount: structuredClone(controller.serviceAccount)}
  bindAwsServiceAccount(configured, intent.serviceAccount, record.controllerRoleArn, configured.awsWorkloadIdentity)
  return {...spec, dstackController: configured}
}

export function bindPreparedDstackAws(root: string, spec: DeploymentSpec): void {
  if (!dstackAwsIntent(spec)) return
  const controller = withPreparedDstackAws(root, spec).dstackController!
  const file = localPath(root, '.data/doge-config.toml')
  const config = toml.parse(fs.readFileSync(file, 'utf8')) as any
  // Preserve credential references already added by dstack-config on a resumed step.
  config.dstackController = {...config.dstackController, awsWorkloadIdentity: controller.awsWorkloadIdentity, defaultCredentialsEnabled: true, serviceAccount: controller.serviceAccount}
  privateWrite(file, toml.stringify(config))
}
