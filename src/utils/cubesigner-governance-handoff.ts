/* eslint-disable @typescript-eslint/no-explicit-any -- Adapts Core's reviewed JSON/JSONL contracts. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {GOVERNANCE_CORE_REVISION, GOVERNANCE_INPUT, requirePolicy} from './cubesigner-governance.js'
import {digest, localPath, writeJson} from './preparation-io.js'
import {proofFileHash, proofRegularFile} from './proof-software-release.js'

export function createGovernanceHandoff(options: {approval: string[]; config: string; directory: string; initialSealLastReviewed?: boolean; kind: string; operations: string; provisioning?: string; sessionLifetime: number; state: string}) {
  const root = fs.realpathSync(options.directory)
  const read = (name: string) => fs.readFileSync(proofRegularFile(path.resolve(root, name), 16 * 1024 * 1024), 'utf8')
  const config = JSON.parse(read(options.config))
  const state = JSON.parse(read(options.state))
  const deployment: any = toml.parse(read('.data/doge-config.toml'))
  const selection = deployment.cubesigner?.expectedPolicy ?? deployment.cubesigner?.policyReceipts
  requirePolicy(selection, 'Prepare the published expected policy first')
  const release = JSON.parse(read(selection.release.path))
  const [name, version] = release.policyIdentifier.split('/')
  const keys = (deployment.cubesigner.roles ?? []).flatMap((role: any) => role.keys.map((key: any) => ({key: key.key_id, role: role.role_id})))
  requirePolicy(keys.length === 1 && keys[0].key === state.key_id && keys[0].role === state.role_id && config.org_id === selection.organization && config.policy.name === name, 'Core state/config does not bind this deployment')
  requirePolicy(/^NamedPolicy#[\da-f-]{36}$/.test(state.policy_id), 'Concrete policy ID required')
  const request = {body: {policy: [{RequireRoleSession: [state.role_id]}, `${state.policy_id}/${version}`]}, method: 'PATCH', path: `/v0/org/${config.org_id}/keys/${state.key_id}`}
  const operations = read(options.operations).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  requirePolicy(Number.isSafeInteger(options.sessionLifetime) && options.sessionLifetime >= 300, 'Bounded session lifetime required')
  requirePolicy(options.kind !== 'initial-provisioning' || options.provisioning || options.initialSealLastReviewed, 'Initial provisioning needs reviewed seal-last evidence')
  const input = localPath(root, GOVERNANCE_INPUT)
  const configText = read(options.config)
  if (fs.existsSync(input)) {
    const previous = JSON.parse(fs.readFileSync(proofRegularFile(input), 'utf8'))
    requirePolicy(isDeepStrictEqual(previous.request, request) && previous.config.sha256 === `sha256:${digest(configText)}`
      && previous.kind === options.kind && previous.runtimeSession.session === options.sessionLifetime, 'Exact request or Council/session policy changed; review a new handoff explicitly')
  }

  const contents: Record<string, string> = {'config.json': configText, 'operations.json': JSON.stringify(operations), 'state.json': read(options.state)}
  const snapshots = options.approval.map(file => JSON.parse(read(file).split('\n').filter(line => !line.startsWith('RESULT:')).join('\n')))
  snapshots.forEach((snapshot, index) => {requirePolicy(isDeepStrictEqual(snapshot.request, request), 'Approval belongs to a different exact request'); contents[`approval-${index}.json`] = JSON.stringify(snapshot)})
  if (options.provisioning) contents['provisioning.json'] = read(options.provisioning)
  else if (options.kind === 'initial-provisioning' && options.initialSealLastReviewed) contents['provisioning.json'] = JSON.stringify({basis: 'explicit-operator-review-declaration', keyId: state.key_id, reviewedAt: new Date().toISOString(), schema: 'scrollsdk/cubesigner-initial-provisioning/v1', sealedBeforeBridgeRegistration: true, unregisteredAndUnfunded: true})
  const relative = `.scrollsdk/inputs/cubesigner-policy/governance-${digest(JSON.stringify(contents)).slice(0, 20)}`
  const directory = localPath(root, relative)
  fs.mkdirSync(directory, {mode: 0o700, recursive: true})
  const ref = (name: string) => ({path: `${relative}/${name}`, sha256: `sha256:${proofFileHash(path.join(directory, name))}`})
  for (const [name, text] of Object.entries(contents)) {
    const file = path.join(directory, name)
    if (fs.existsSync(file)) requirePolicy(fs.readFileSync(proofRegularFile(file), 'utf8') === text, 'Archived governance evidence changed')
    else fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600})
  }

  const outcomes = governanceOutcomes(operations, snapshots, request, state)
  writeJson(input, {approvals: options.approval.map((_, index) => ref(`approval-${index}.json`)), config: ref('config.json'), coreRevision: GOVERNANCE_CORE_REVISION, environment: selection.environment, kind: options.kind, operations: ref('operations.json'),
    outcomes, policyArtifactDigest: release.wasm.sha256, policyIdentifier: release.policyIdentifier, request, schema: 'scrollsdk/cubesigner-governance-handoff/v1',
    state: ref('state.json'), ...(contents['provisioning.json'] ? {provisioning: ref('provisioning.json')} : {}),
    runtimeSession: {auth: 300, refresh: 86_400, scope: 'sign:btc:psbt:doge', session: options.sessionLifetime}})
  return {actor: 'Council and authorized proposer', evidence: GOVERNANCE_INPUT, instruction: 'Approval does not execute. Use the pinned Core attach command with the identical config/state/version and every MFA ID, then refresh this handoff and verify activation. Do not republish or change genesis.', nextCommand: 'scrollsdk setup cubesigner-policy verify-activation --dir . --policy-only',
    outcomes,
    runbook: `https://github.com/DogeOS69/dogeos-core/blob/${GOVERNANCE_CORE_REVISION}/docs/runbooks/cubesigner-tee-key-operations.md`,
    status: 'handoff-archived-not-verified'}
}

function governanceOutcomes(operations: any[], snapshots: any[], request: any, state: any) {
  const matching = operations.filter(event => event.operation === 'keyUpdate' && event.target === state.key_id && isDeepStrictEqual(event.body, request.body))
  const proposal = [...matching].reverse().find(event => event.outcome?.status === 'needs-approval')
  const execution = [...matching].reverse().find(event => event.outcome?.status === 'applied')
  const ids = new Set<string>(proposal?.outcome?.ids ?? [])
  for (const snapshot of snapshots) for (const id of snapshot.related_ids ?? []) ids.add(id)
  const approvals = [...ids].map(id => {
    const snapshot = snapshots.find(item => item.id === id)
    if (!snapshot) return {actor: 'Council/proposer', id, next: 'Read this MFA ID with the pinned Core mfa command; a deleted rejected request cannot execute', status: 'unknown-or-rejected'}
    if (snapshot.expires_at <= Date.now() / 1000) return {actor: 'proposer', id, next: 'Read current attachment before proposing a replacement request', status: 'expired'}
    const {status} = snapshot
    const count = Object.values(status?.approved_by ?? {}).filter((factors: any) => Object.keys(factors).filter(type => status.allowed_mfa_types?.includes(type)).length >= status.num_auth_factors).length
    return {actor: 'Council', id, next: 'Review exact request; approval alone never executes', status: count >= status?.count ? 'threshold-recorded-execution-required' : 'pending-or-partial'}
  })
  return {approvals, attachmentExecution: execution ? 'recorded-not-verified' : 'pending', attachmentProposal: proposal ? 'recorded' : 'not-recorded', bindingReadback: 'not-verified',
    build: 'prepared', governance: 'not-verified', liveAcceptance: 'not-verified', version: 'published-readback-recorded'}
}
