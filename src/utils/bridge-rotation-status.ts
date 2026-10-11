import type {RotationChainState, RotationEnvelope} from './bridge-rotation.js'

export interface RotationIntentObservation {
  activationWfTxNumber?: number; deprecationWfTxNumber?: number; graceWfTxs?: number; intentId: string; jobId?: string
  jobStatus?: string; redeemScriptHex?: string; signedTxid?: string
  status: string; targetKeyHash?: string; tsoTransactionId?: string
}
export function rotationStatus(envelope: RotationEnvelope, state: RotationChainState, intent: RotationIntentObservation | null) {
  const matches = state.protocolContextSha256 === envelope.proposal.deployment.protocolContextSha256 && state.network === envelope.proposal.network
  if (!matches) throw new Error('Runtime no longer matches this proposal deployment')
  if (intent && (intent.targetKeyHash !== envelope.proposal.target.keyHash || intent.graceWfTxs !== envelope.proposal.graceWfTxs || intent.redeemScriptHex !== envelope.proposal.target.redeemScriptHex)) throw new Error('Durable intent payload differs from proposal')
  const active = state.currentKeyHash === envelope.proposal.target.keyHash
  const successor = Boolean(active && intent?.activationWfTxNumber !== undefined && state.wfTxNumber > intent.activationWfTxNumber)
  return {
    acceptance: {newSignerSignatures: 'manual_verification_required', rotationWorkflowComplete: false},
    intent, oldSignerExit: 'Not automated. Verify overlap expiry, old bridge funds and in-flight requests before stopping old instances.', outcome: intent && ['failed_terminal', 'superseded'].includes(intent.status) ? 'failed' : active && intent?.status === 'completed' ? 'activated' : intent ? 'in_progress' : 'not_observed',
    proposalSha256: envelope.sha256, replayWfTxNumber: state.wfTxNumber,
    signerHandoff: successor ? 'A subsequent validated WF is visible; independently verify target signer request/decision records before declaring handoff complete.' : 'Awaiting a subsequent WF and target signer signature evidence.',
    subsequentWfObserved: successor,
    targetActive: active,
  }
}
