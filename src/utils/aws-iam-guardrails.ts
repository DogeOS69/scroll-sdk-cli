import type {DeploymentSpec} from '../types/deployment-spec.js'

import {type RoleGuardrails, assertRoleNameAllowed, validateRoleGuardrails} from './aws-workload-role.js'
import {sanitizeName, truncateIamRoleName} from './kms-signer-provisioner.js'
import {MANAGED_SIGNER_ROLES} from './signer-roles.js'
import {resolveSpecIdentities} from './spec-identities.js'

export function specRoleGuardrails(spec: DeploymentSpec): RoleGuardrails {
  const guardrails = spec.preparation?.awsIam ?? {}
  validateRoleGuardrails(guardrails)
  return guardrails
}

/** Plan-time names of every signing role, derived as the signer provisioner derives them. */
export function plannedSignerRoleNames(spec: DeploymentSpec): string[] {
  const identities = resolveSpecIdentities(spec)
  if (!identities) return []
  const name = (kms: NonNullable<typeof identities.feeOracle.kms>, suffix: string) => truncateIamRoleName(`dogeos-${sanitizeName(kms.networkAlias!)}-${sanitizeName(kms.eksCluster!)}-${suffix}`)
  const services = [[identities.feeOracle, MANAGED_SIGNER_ROLES.l2GasOracleSender.roleSuffix], [identities.ethDaSubmitter, MANAGED_SIGNER_ROLES.l1CommitSender.roleSuffix]] as const
  return [
    ...services.flatMap(([signer, suffix]) => signer.backend === 'aws_kms' ? [name(signer.kms!, suffix)] : []),
    ...identities.sequencers.flatMap(node => node.signer.backend === 'aws_kms' ? [name(node.signer.kms!, `sequencer-reth-${node.index}-kms`)] : []),
  ]
}

/** Plan-time check of every derived workload role name; dstack checks its own in dstackAwsIntent. */
export function assertPlannedRoleNames(spec: DeploymentSpec): void {
  const guardrails = specRoleGuardrails(spec)
  const cluster = spec.infrastructure.aws?.eksClusterName
  if (!cluster) return
  const base = `dogeos-${sanitizeName(spec.metadata.name)}-${sanitizeName(cluster)}`
  const names = [
    ...(spec.preparation?.proofAws ? [`${base}-proof-coordinator`, `${base}-wp-proof`] : []),
    ...(spec.preparation?.bridge?.production?.sequencerKms && !spec.preparation.proofAws ? [`${base}-wp-kms`] : []),
  ].map(name => truncateIamRoleName(name))
  for (const name of [...names, ...plannedSignerRoleNames(spec)]) assertRoleNameAllowed(name, guardrails)
}
