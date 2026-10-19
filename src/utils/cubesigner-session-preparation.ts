/* eslint-disable @typescript-eslint/no-explicit-any -- Reviewed provider contracts are validated at this boundary. */
import * as toml from '@iarna/toml'
import fs from 'node:fs'
import path from 'node:path'

import type {ActivationClient} from './cubesigner-activation-client.js'

import {validateRuntimeSession} from './cubesigner-activation.js'
import {GOVERNANCE_INPUT, pinnedEvidence, requirePolicy} from './cubesigner-governance.js'
import {resolveCubesignerPolicy} from './cubesigner-policy-receipts.js'
import {digest, localPath, privateWrite, writeJson} from './preparation-io.js'
import {proofRegularFile} from './proof-software-release.js'

/** Role authorization can precede attachment approval. Never attach, vote, or rotate on retry. */
export async function prepareRuntimeSession(options: {client: ActivationClient; create: (role: string, purpose: string, lifetimes: {auth: number; grace: number; refresh: number; session: number}) => Promise<unknown>; directory: string}) {
  const root = fs.realpathSync(options.directory)
  const {client} = options
  const config: any = toml.parse(fs.readFileSync(proofRegularFile(path.join(root, '.data/doge-config.toml')), 'utf8'))
  const keys = (config.cubesigner?.roles ?? []).flatMap((role: any) => role.keys.map((key: any) => ({keyId: key.key_id, materialId: key.material_id, roleId: role.role_id})))
  requirePolicy(keys.length === 1 && config.cubesigner?.mode === 'production_verifier_key_policy', 'Select one production key and role before preparing credentials')
  resolveCubesignerPolicy({deploymentDir: root, keys, network: config.network, scope: 'preparation', selection: config.cubesigner})
  const selection = config.cubesigner.expectedPolicy ?? config.cubesigner.policyReceipts
  requirePolicy(client.environment === selection.environment && client.organization === selection.organization, 'Session environment/organization mismatch')
  const key = keys[0]
  const handoff = JSON.parse(fs.readFileSync(proofRegularFile(localPath(root, GOVERNANCE_INPUT)), 'utf8'))
  const reviewed = pinnedEvidence(root, handoff.config)
  const state = pinnedEvidence(root, handoff.state)
  requirePolicy(reviewed.org_id === client.organization && handoff.environment === client.environment && state.role_id === key.roleId && state.key_id === key.keyId, 'Reviewed runtime identity mismatch')
  requirePolicy(Number.isSafeInteger(handoff.runtimeSession?.session) && handoff.runtimeSession.session >= 300, 'Review a bounded session lifetime before creation')
  const remoteKey: any = await client.key(key.roleId, key.keyId)
  const role: any = await client.role(key.roleId)
  requirePolicy(role.role_id === key.roleId && role.enabled === true && remoteKey.key_id === key.keyId && remoteKey.material_id === key.materialId && remoteKey.enabled === true, 'Selected role/key authorization is unavailable')
  const file = localPath(root, 'secrets/cubesigner-signer-session.json')
  const journal = localPath(root, '.scrollsdk/cubesigner-session-creation.json')
  const sessions = await client.sessions(key.roleId)
  if (fs.existsSync(file)) {
    validateRuntimeSession(root, client, key, handoff, sessions)
    return {nextCommand: 'scrollsdk setup upload-secrets --dir .', status: 'existing-session-reused'}
  }

  requirePolicy(!fs.existsSync(journal), 'Interrupted creation: recover the private seed or explicitly revoke the recorded session and archive the journal; no duplicate was created')
  const purpose = `scrollsdk-signer-${digest(`${root}:${key.roleId}`).slice(0, 20)}`
  requirePolicy(!sessions.some(session => session.purpose === purpose), 'Existing instance session: recover its private seed or explicitly revoke it; no duplicate was created')
  writeJson(journal, {checkedAt: new Date().toISOString(), purpose, roleId: key.roleId, status: 'creating'})
  const session = await options.create(key.roleId, purpose, {auth: 300, grace: 30, refresh: 86_400, session: handoff.runtimeSession.session})
  privateWrite(file, JSON.stringify(session))
  privateWrite(localPath(root, 'secrets/cubesigner-signer.env'), `DOGEOS_CUBESIGNER_SIGNER_CS_KEY_ID="${key.keyId}"\n`)
  validateRuntimeSession(root, client, key, handoff, await client.sessions(key.roleId))
  writeJson(journal, {checkedAt: new Date().toISOString(), purpose, roleId: key.roleId, status: 'prepared'})
  return {instruction: 'Upload is separate. Activation remains pending; existing active caches require explicit operator-controlled rotation. No pod was restarted.', nextCommand: 'scrollsdk setup upload-secrets --dir .', status: 'session-prepared'}
}
