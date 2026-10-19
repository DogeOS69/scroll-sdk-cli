/* eslint-disable @typescript-eslint/no-explicit-any -- Validate provider and pinned Core evidence at runtime. */
import {createPublicKey, verify} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export const GOVERNANCE_CORE_REVISION = '7bf8fcefb34bfeb1fd835193b1b8500cd0f48549'
export const GOVERNANCE_INPUT = '.scrollsdk/inputs/cubesigner-policy/governance.json'
export const POLICY_EDIT_SCOPES = ['manage:policy:update:owner', 'manage:policy:update:name', 'manage:policy:update:acl', 'manage:policy:update:metadata', 'manage:policy:update:editPolicy']
export class PolicyValidationError extends Error {}
export function requirePolicy(value: unknown, message: string): asserts value {
  if (!value) throw new PolicyValidationError(message)
}

export function pinnedEvidence(root: string, ref: any): any {
  requirePolicy(ref && typeof ref.path === 'string' && /^(sha256:)?[\da-f]{64}$/.test(ref.sha256), 'Evidence requires a path and SHA-256')
  const file = proofRegularFile(path.resolve(root, ref.path), 16 * 1024 * 1024)
  requirePolicy(proofFileHash(file) === ref.sha256.replace(/^sha256:/, ''), 'Evidence checksum mismatch')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const same = (a: unknown, b: unknown, label: string) => requirePolicy(isDeepStrictEqual(a, b), `${label} mismatch`)
const set = (a: unknown, b: unknown, label: string) => {
  requirePolicy(Array.isArray(a) && Array.isArray(b), `${label} must be arrays`)
  same([...a].sort(), [...b].sort(), label)
}

/** Verify fresh provider-signed Full role evidence, including the nested key, never just the role. */
export function verifyRoleAttestation(jwt: string, jwks: any, now = Date.now() / 1000): any {
  const parts = jwt.split('.')
  requirePolicy(parts.length === 3 && parts.every(part => /^[\w-]+$/.test(part)), 'Malformed attestation')
  const [header, payload, signature] = parts
  const h = JSON.parse(Buffer.from(header, 'base64url').toString())
  requirePolicy(h.alg === 'ES256' && h.crit === undefined && (h.kid === undefined || typeof h.kid === 'string'), 'Unsupported attestation header')
  const keys = Array.isArray(jwks?.keys) ? jwks.keys.filter((key: any) => h.kid === undefined || key.kid === h.kid) : []
  requirePolicy(keys.length === 1, 'Ambiguous attestation signing key')
  const key = keys[0]
  requirePolicy(key.kty === 'EC' && key.crv === 'P-256' && (!key.alg || key.alg === 'ES256') && (!key.use || key.use === 'sig'), 'Invalid attestation signing key')
  const sig = Buffer.from(signature, 'base64url')
  requirePolicy(sig.length === 64 && verify('sha256', Buffer.from(`${header}.${payload}`), {dsaEncoding: 'ieee-p1363', key: createPublicKey({format: 'jwk', key})}, sig), 'Invalid attestation signature')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  requirePolicy(Number.isFinite(claims.exp) && claims.exp > now && Number.isFinite(claims.iat) && claims.iat <= now && now - claims.iat <= 300 && claims.exp > claims.iat
    && (claims.nbf === undefined || Number.isFinite(claims.nbf) && claims.nbf <= now), 'Attestation expired or invalid time claims')
  requirePolicy(claims.query?.verbosity === 'Full', 'Full role attestation required')
  return claims
}

function editPolicy(actual: any, config: any, policy = false): void {
  const mfa = actual?.mfa
  requirePolicy(mfa, 'Object is not Council-sealed')
  same(mfa.count, config.approval.count, 'Council quorum')
  set(mfa.allowed_approvers, config.approval.approvers, 'Council members')
  set(mfa.allowed_mfa_types, config.approval.allowed_mfa_types, 'Council MFA methods')
  same(mfa.num_auth_factors ?? 1, config.approval.num_auth_factors, 'Council factors')
  same(mfa.lifetime, config.approval.lifetime_seconds, 'Council lifetime')
  requirePolicy((mfa.time_delay === null || mfa.time_delay === undefined) && (mfa.restricted_operations === null || mfa.restricted_operations === undefined) && ((mfa.request_comparer === null || mfa.request_comparer === undefined) || mfa.request_comparer === 'Eq') && (actual.time_lock_until === null || actual.time_lock_until === undefined), 'Unexpected Council restrictions/delay/comparison')
  if (policy) {set(actual.applies_to_scopes?.AllOf, POLICY_EDIT_SCOPES, 'Policy edit scopes')}
  else {requirePolicy((actual.applies_to_scopes === null || actual.applies_to_scopes === undefined) || actual.applies_to_scopes === 'All', 'Narrowed role/key edit policy')}
}

/** Exact Core config/state adapter; no voting, policy changes or approval fabrication. */
export function verifyGovernanceEvidence(options: {claims: any; environment: string; expectedPolicy: unknown[]; handoff: any; key: any; now?: number; organization: string; policy: any; role: any; root: string}) {
  const {claims, expectedPolicy, handoff, key, organization, policy, role, root} = options
  requirePolicy(handoff.schema === 'scrollsdk/cubesigner-governance-handoff/v1' && handoff.coreRevision === GOVERNANCE_CORE_REVISION, 'Unsupported governance tool revision/contract')
  const config = pinnedEvidence(root, handoff.config)
  const state = pinnedEvidence(root, handoff.state)
  same(config.org_id, organization, 'Governance organization')
  same(handoff.environment, options.environment, 'Governance environment')
  same(state.key_id, key.key_id, 'Governance key')
  same(state.role_id, role.role_id, 'Governance role')
  same(state.policy_id, policy.policy_id, 'Governance policy')
  const {approval} = config
  requirePolicy(approval && Array.isArray(approval.approvers) && Number.isInteger(approval.count) && approval.count > 0 && approval.count <= approval.approvers.length
    && new Set(approval.approvers).size === approval.approvers.length && Number.isInteger(approval.num_auth_factors) && approval.num_auth_factors > 0
    && Number.isInteger(approval.lifetime_seconds) && approval.lifetime_seconds >= 300
    && Array.isArray(approval.allowed_mfa_types) && approval.allowed_mfa_types.length > 0 && approval.allowed_mfa_types.every((type: string) => ['Fido', 'Totp'].includes(type)), 'Invalid reviewed Council policy')
  const others = new Set([config.key_owner, ...(config.operators ?? []), ...(config.policy_publishers ?? []), ...(config.key_proposers ?? [])])
  requirePolicy(approval.approvers.every((user: string) => !others.has(user)), 'Council approver conflicts with operational authority')
  same(key.owner, config.key_owner, 'Key owner')
  same(key.key_type, config.key.type, 'Key type')
  same(policy.owner, config.key_owner, 'Policy owner')
  same(policy.name, config.policy.name, 'Policy name')
  same(role.name, config.role.name, 'Role name')
  editPolicy(key.edit_policy, config)
  editPolicy(role.edit_policy, config)
  editPolicy(policy.edit_policy, config, true)
  const expectedAcl = [
    ...((config.policy_publishers ?? []).length > 0 ? [{actions: ['read:*', 'update:rules'], subjects: config.policy_publishers}] : []),
    {actions: ['read:*', 'attach'], subjects: [config.key_owner]},
    ...((config.key_proposers ?? []).length > 0 ? [{actions: ['attach'], subjects: config.key_proposers}] : []),
    {actions: ['sign'], subjects: [role.role_id]},
  ]
  const acl = (value: any) => (value ?? []).map((entry: any) => ({actions: [...entry.actions].sort(), subjects: [...entry.subjects].sort()})).sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  same(acl(policy.acl), acl(expectedAcl), 'Policy ACL')
  same(acl(key.acl), acl((config.key_proposers ?? []).length > 0 ? [{actions: ['manage:key:update:policy'], subjects: config.key_proposers}] : []), 'Key ACL')
  if (config.key.metadata !== undefined) same(key.metadata, config.key.metadata, 'Key metadata')
  if (config.policy.metadata !== undefined) same(policy.metadata, config.policy.metadata, 'Policy metadata')
  same(claims.role_info?.role_id, role.role_id, 'Attested role')
  same(claims.role_info?.enabled, true, 'Attested role enabled')
  editPolicy(claims.role_info?.edit_policy, config)
  set(claims.role_users, config.operators, 'Attested role users')
  requirePolicy(Array.isArray(claims.role_keys) && claims.role_keys.length === 1, 'Attestation must contain exactly the selected key')
  const entry = claims.role_keys[0]
  same(entry.role_id, role.role_id, 'Attested key role')
  same(entry.key_id, key.key_id, 'Attested key id')
  const nested = entry.key_info
  for (const field of ['key_id', 'key_type', 'owner', 'enabled', 'material_id', 'public_key', 'acl', 'metadata']) same(nested?.[field], key[field], `Attested key ${field}`)
  same(nested?.policy, expectedPolicy, 'Attested key policy')
  editPolicy(nested?.edit_policy, config)
  same(handoff.request, {body: {policy: expectedPolicy}, method: 'PATCH', path: `/v0/org/${organization}/keys/${key.key_id}`}, 'Exact attachment request')
  const events = pinnedEvidence(root, handoff.operations)
  requirePolicy(Array.isArray(events), 'Core operation evidence must be an array')
  const matching = events.filter((event: any) => event.operation === 'keyUpdate' && event.target === key.key_id && isDeepStrictEqual(event.body, handoff.request.body)
    && event.object_ids?.org_id === organization && event.object_ids?.key_id === key.key_id && event.object_ids?.role_id === role.role_id && event.object_ids?.policy_id === policy.policy_id)
  const executed = [...matching].reverse().find((event: any) => event.outcome?.status === 'applied')
  requirePolicy(executed && Number.isFinite(Date.parse(executed.timestamp)) && Date.parse(executed.timestamp) <= Date.now(), 'Attachment execution evidence pending; approval alone does not execute')
  let approvals = 'not-required-initial-provisioning'
  if (handoff.kind === 'sealed-upgrade') {
    const proposal = [...matching].reverse().find((event: any) => event.outcome?.status === 'needs-approval' && Date.parse(event.timestamp) <= Date.parse(executed.timestamp))
    requirePolicy(proposal?.outcome?.ids?.length, 'Exact attachment proposal evidence missing')
    const snapshots = (handoff.approvals ?? []).map((ref: any) => pinnedEvidence(root, ref))
    const requiredIds = new Set<string>(proposal.outcome.ids)
    for (const snapshot of snapshots) for (const id of snapshot.related_ids ?? []) requiredIds.add(id)
    for (const id of requiredIds) {
      const snapshotsForId = snapshots.filter((item: any) => item.id === id)
      requirePolicy(snapshotsForId.length === 1, 'Missing or duplicate approval evidence')
      const snapshot = snapshotsForId[0]
      same(snapshot.request, handoff.request, 'Approval request')
      const at = Date.parse(executed.timestamp) / 1000
      requirePolicy(snapshot.expires_at > at && (!snapshot.not_valid_until || snapshot.not_valid_until <= at), 'Approval expired or not valid at execution')
      const {status} = snapshot
      same(status?.count, approval.count, 'Approval quorum')
      set(status?.allowed_approvers, approval.approvers, 'Approval Council')
      set(status?.allowed_mfa_types, approval.allowed_mfa_types, 'Approval MFA methods')
      same(status?.num_auth_factors, approval.num_auth_factors, 'Approval factors')
      requirePolicy(!status.request_comparer || status.request_comparer === 'Eq', 'Approval request comparison is not exact')
      const approved = Object.entries(status.approved_by ?? {}).filter(([user, factors]) => approval.approvers.includes(user)
        && Object.entries(factors as Record<string, any>).filter(([type, info]) => approval.allowed_mfa_types.includes(type) && Number.isFinite(info?.timestamp) && info.timestamp <= at && info.timestamp >= Math.floor(Date.parse(proposal.timestamp) / 1000)).length >= approval.num_auth_factors)
      requirePolicy(approved.length >= approval.count, 'Council approvals pending, incomplete or rejected')
    }

    approvals = 'complete-at-execution'
  } else {
    requirePolicy(handoff.kind === 'initial-provisioning', 'Choose initial-provisioning or sealed-upgrade')
    const initial = pinnedEvidence(root, handoff.provisioning)
    requirePolicy(initial.schema === 'scrollsdk/cubesigner-initial-provisioning/v1' && initial.keyId === key.key_id && initial.unregisteredAndUnfunded === true
      && initial.sealedBeforeBridgeRegistration === true, 'Reviewed seal-last provisioning evidence missing')
  }

  return {approvals, attachment: 'executed', checks: ['Council edit policies', 'owner/type/ACL', 'fresh signed Full role and nested key', 'exact executed request'], governance: 'verified', uncovered: ['organization export/history controls', 'live signing and denial']}
}
