import fs from 'node:fs'
import path from 'node:path'

import type {RotationEnvelope} from './bridge-rotation.js'

import {validateRotationEnvelope} from './bridge-rotation.js'
import {equalFrozenPayload, readRotationJson, rotationJson} from './bridge-rotation-files.js'

export interface RotationPayload {grace_wf_txs: number; idempotency_key: string; new_bridge_redeem_script_hex: string; new_key_hash: string}
export interface RotationJournal {attempts: number; disposition: 'accepted' | 'ambiguous' | 'rejected'; lastHttpStatus?: number; payload: RotationPayload; proposalSha256: string; submissionStartedAt: string}
export function rotationPayload(envelope: RotationEnvelope): RotationPayload {
  const p = validateRotationEnvelope(envelope)
  return {grace_wf_txs: p.graceWfTxs, idempotency_key: `scrollsdk-rotation-${envelope.sha256}`, new_bridge_redeem_script_hex: p.target.redeemScriptHex, new_key_hash: p.target.keyHash}
}

/** Journal before network IO; an exception or 503 can still mean the WP owns a durable intent. */
export async function submitFrozenRotation(dir: string, envelope: RotationEnvelope, post: (payload: RotationPayload) => Promise<{body: unknown; status: number}>): Promise<RotationJournal> {
  const file = path.join(dir, 'submission.json')
  const payload = rotationPayload(envelope)
  const previous = fs.existsSync(file) ? readRotationJson<RotationJournal>(file) : undefined
  if (previous && (previous.proposalSha256 !== envelope.sha256 || !equalFrozenPayload(previous.payload, payload))) throw new Error('Durable journal differs from frozen proposal; refusing submission')
  const journal: RotationJournal = previous ?? {attempts: 0, disposition: 'ambiguous', payload, proposalSha256: envelope.sha256, submissionStartedAt: new Date().toISOString()}
  journal.attempts++
  journal.disposition = 'ambiguous'
  rotationJson(file, journal)
  try {
    const response = await post(payload)
    journal.lastHttpStatus = response.status
    journal.disposition = [200, 202].includes(response.status) ? 'accepted' : response.status >= 500 || [408, 409, 423, 425, 429].includes(response.status) ? 'ambiguous' : 'rejected'
    // Do not persist raw HTTP errors, signed PSBTs or callback tokens.
  } catch {journal.disposition = 'ambiguous'}

  rotationJson(file, journal)
  return journal
}
