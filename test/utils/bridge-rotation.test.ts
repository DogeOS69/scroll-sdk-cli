/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic dynamic TOML/Helm fixtures. */
import {expect} from 'chai'
import {createECDH} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {type RotationChainState, assertRotationAdmission, assertRotationSpecUnchanged, bridgeHash, createRotationProposal, encodeBridgeScript, parseBridgeScript, proposalDigest, validateRotationEnvelope} from '../../src/utils/bridge-rotation.js'
import {rotationPayload, submitFrozenRotation} from '../../src/utils/bridge-rotation-execution.js'
import {assertRotationReceipts, assertStageUnchanged, enableRotationRoute, loadRotationPlan, mergeRotationRegistrations, rotationJson, saveRotationPlan} from '../../src/utils/bridge-rotation-files.js'
import {rotationStatus} from '../../src/utils/bridge-rotation-status.js'

const key = () => {const ec = createECDH('secp256k1'); ec.generateKeys(); return ec.getPublicKey('hex', 'compressed')}
function fixture() {
  const old = {attestation: {keys: [key(), key(), key()], threshold: 2}, namespace: '11'.repeat(20), recovery: {keys: [key(), key(), key()], threshold: 2}, tee: key(), timelock: 600_000}
  const hex = encodeBridgeScript(old)
  const state: RotationChainState = {confirmedAnchorHeight: 990, currentKeyHash: bridgeHash(hex), liveTipHeight: 1000, minGraceWfTxs: 100, network: 'testnet', protocolContextSha256: '22'.repeat(32), redeemScriptHex: hex, wfTxNumber: 50}
  const spec = {attestation: {signers: ['a-next', 'b-next', 'd'].map(name => ({attestationPubkey: key(), name, transportPubkey: key()}))}, name: 'rotation-2'}
  return {old, spec, state}
}

describe('attestation rotation proposals', () => {
  it('isolates explicit rotation directories and reads historical status without the editable spec', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-directories-'))
    try {
      const first = fixture(); const second = fixture()
      for (const [name, f] of [['first', first], ['second', second]] as const) {
        const envelope = createRotationProposal(f.spec, f.state)
        const dir = saveRotationPlan(root, envelope, name)
        rotationJson(path.join(dir, 'rotation-spec.yaml'), f.spec)
        expect(loadRotationPlan(root, 'rotation-spec.yaml', name).envelope.sha256).eq(envelope.sha256)
      }

      fs.unlinkSync(path.join(root, 'first', 'rotation-spec.yaml'))
      expect(loadRotationPlan(root, 'rotation-spec.yaml', 'first', false).envelope.proposal.current.keyHash).eq(first.state.currentKeyHash)
      expect(() => loadRotationPlan(root, 'rotation-spec.yaml', 'first')).throw()
      expect(loadRotationPlan(root, 'rotation-spec.yaml', 'second').envelope.proposal.current.keyHash).eq(second.state.currentKeyHash)
      expect(() => saveRotationPlan(root, createRotationProposal(second.spec, second.state), 'first')).throw('different frozen proposal')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
  it('preserves namespace, TEE and ordered recovery while replacing all attestation keys', () => {
    const {old, spec, state} = fixture(); const envelope = createRotationProposal(spec, state)
    const next = parseBridgeScript(envelope.proposal.target.redeemScriptHex)
    expect(next.recovery).deep.eq(old.recovery); expect(next.tee).eq(old.tee); expect(next.namespace).eq(old.namespace)
    expect(next.attestation.threshold).eq(2); expect(next.attestation.keys).deep.eq(spec.attestation.signers.map(s => s.attestationPubkey).sort())
    expect(validateRotationEnvelope(envelope)).deep.eq(envelope.proposal)
  })
  it('rejects any shared key, duplicate identity, manual TEE override and script/hash mismatch', () => {
    const {old, spec, state} = fixture()
    expect(() => createRotationProposal({...spec, teePubkey: key()}, state)).throw('unsupported')
    expect(() => createRotationProposal(spec, {...state, currentKeyHash: '0x' + '00'.repeat(20)})).throw('binding')
    spec.attestation.signers[0].attestationPubkey = old.attestation.keys[0]
    expect(() => createRotationProposal(spec, state)).throw('disjoint')
    spec.attestation.signers[0].attestationPubkey = key(); spec.attestation.signers[1].name = spec.attestation.signers[0].name
    expect(() => createRotationProposal(spec, state)).throw('unique')
  })
  it('requires explicit timelock refresh and freezes exact approved script as the tip advances', () => {
    const {spec, state} = fixture(); state.liveTipHeight = 500_000
    expect(() => createRotationProposal(spec, state)).throw('refresh')
    const e = createRotationProposal({...spec, timelock: {policy: 'refresh'}}, state)
    expect(e.proposal.timelock.newHeight).eq(769_200)
    assertRotationAdmission(e, {...state, liveTipHeight: 509_999, wfTxNumber: 80})
    expect(() => assertRotationAdmission(e, {...state, liveTipHeight: 510_001})).throw('Frozen timelock')
    expect(() => assertRotationAdmission(e, {...state, deprecating: {deprecationWfTxNumber: 100, keyHash: '0x' + '33'.repeat(20)}})).throw('overlap')
  })
  it('rejects tampered target content even with a recomputed checksum', () => {
    const {spec, state} = fixture(); const e = createRotationProposal(spec, state)
    e.proposal.target.address = 'wrong'; e.sha256 = proposalDigest(e.proposal)
    expect(() => validateRotationEnvelope(e)).throw('does not match')
  })
  it('makes registry staging idempotent, preserves old members and rejects identity collisions', () => {
    const {old, spec, state} = fixture(); const p = createRotationProposal(spec, state).proposal
    const external = old.attestation.keys.map((publicKey, i) => ({id: `old-${i}`, publicKey, transportPubkey: key()}))
    const config: any = {attestationSigner: {external, mode: 'external'}}
    const values: any = {configMaps: {config: {data: {'WithdrawalProcessor.toml': 'rotate_key_v2 = false\n'}}}, tsoSigners: [...external.map(s => ({delivery: 'pull', network: 'testnet', publicKeyOverride: s.publicKey, roles: ['Attestation'], transportPubkey: s.transportPubkey})), {delivery: 'push', roles: ['Correctness']}]}
    mergeRotationRegistrations(config, values, p); mergeRotationRegistrations(config, values, p)
    expect(config.attestationSigner.external).length(6); expect(values.tsoSigners).length(7)
    expect(values.configMaps.config.data['WithdrawalProcessor.toml']).contains('rotate_key_v2 = true')
    values.tsoSigners.shift()
    expect(() => mergeRotationRegistrations(config, values, p)).throw('missing or mismatched')
    values.tsoSigners.unshift({delivery: 'pull', network: 'testnet', publicKeyOverride: external[0].publicKey, roles: ['Attestation'], transportPubkey: external[0].transportPubkey})
    p.target.signers[0].name = 'old-0'
    expect(() => mergeRotationRegistrations(config, values, p)).throw('conflicts')
  })
  it('preserves native compiler markers and comments when enabling the rotation route', () => {
    const source = '# base\nrotate_key_v2 = false # deliberate\n# BEGIN scrollsdk managed deployment configuration\n[proof_system]\nmode = "production"\n# END scrollsdk managed deployment configuration\n'
    expect(enableRotationRoute(source)).eq(source.replace('rotate_key_v2 = false', 'rotate_key_v2 = true'))
    expect(enableRotationRoute(enableRotationRoute(source))).eq(enableRotationRoute(source))
  })
  it('rejects changed intent even when its name still points at a valid frozen proposal', () => {
    const {spec, state} = fixture(); const e = createRotationProposal(spec, state)
    assertRotationSpecUnchanged(spec, e)
    const changed = structuredClone(spec); changed.attestation.signers[0].attestationPubkey = key()
    expect(() => assertRotationSpecUnchanged(changed, e)).throw('differs from the frozen')
    expect(() => assertRotationAdmission(e, {...state, currentKeyHash: '0x' + '55'.repeat(20)})).throw('Current deployment or bridge changed')
  })
  it('blocks apply after failed staging and after staged-file drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-stage-'))
    try {
      const file = 'runtime.toml'; fs.writeFileSync(path.join(root, file), 'setting = true\n')
      const receipt = {files: {[file]: proposalDigest('setting = true\n')}, proposalSha256: '66'.repeat(32), status: 'prepared'}
      rotationJson(path.join(root, 'stage.json'), receipt)
      expect(() => assertStageUnchanged(root, root, receipt.proposalSha256)).throw('stage successfully')
      receipt.status = 'applied'; rotationJson(path.join(root, 'stage.json'), receipt)
      assertStageUnchanged(root, root, receipt.proposalSha256)
      fs.writeFileSync(path.join(root, file), 'setting = false\n')
      expect(() => assertStageUnchanged(root, root, receipt.proposalSha256)).throw('configuration changed')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
  it('requires every current approval and every new readiness, bound to exact proposal', () => {
    const {old, spec, state} = fixture(); const e = createRotationProposal(spec, state)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-receipts-'))
    try {
      const dir = saveRotationPlan(root, e); fs.mkdirSync(path.join(dir, 'receipts'))
      const approvedAt = new Date().toISOString()
      old.attestation.keys.forEach((signerAttestationPubkey, i) => rotationJson(path.join(dir, 'receipts', `old-${i}.json`), {approvedAt, proposalSha256: e.sha256, schema: 'dogeos/rotation-approval/v1', signerAttestationPubkey, targetKeyHash: e.proposal.target.keyHash}))
      expect(() => assertRotationReceipts(dir, e)).throw('readiness')
      spec.attestation.signers.forEach((s, i) => rotationJson(path.join(dir, 'receipts', `new-${i}.json`), {advanceL1: true, advanceL2: true, checkedAt: approvedAt, proposalSha256: e.sha256, schema: 'dogeos/rotation-readiness/v1', signerAttestationPubkey: s.attestationPubkey, transportPubkey: s.transportPubkey, tsoConnected: true}))
      assertRotationReceipts(dir, e)
      const receiptFile = path.join(dir, 'receipts', 'old-0.json')
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'))
      rotationJson(receiptFile, {...receipt, proposalSha256: '77'.repeat(32)})
      expect(() => assertRotationReceipts(dir, e)).throw('every current')
      rotationJson(receiptFile, receipt)
      fs.unlinkSync(path.join(dir, 'receipts', 'old-2.json'))
      expect(() => assertRotationReceipts(dir, e)).throw('every current')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
  it('journals before network IO and reuses identical payload after timeout and proof gate 503', async () => {
    const {spec, state} = fixture(); const e = createRotationProposal(spec, state)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-submit-')); const payloads: unknown[] = []
    try {
      const failed = await submitFrozenRotation(dir, e, async p => {expect(fs.existsSync(path.join(dir, 'submission.json'))).eq(true); payloads.push(p); throw new Error('simulated timeout')})
      expect(failed.disposition).eq('ambiguous')
      const gate = await submitFrozenRotation(dir, e, async p => {payloads.push(p); return {body: {error: 'blocked on proof readiness'}, status: 503}})
      expect(gate.disposition).eq('ambiguous')
      const accepted = await submitFrozenRotation(dir, e, async p => {payloads.push(p); return {body: {status: 'pending'}, status: 202}})
      expect(accepted.attempts).eq(3); expect(payloads[0]).deep.eq(payloads[1]); expect(payloads[1]).deep.eq(payloads[2])
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'submission.json'), 'utf8')).payload).deep.eq(rotationPayload(e))
    } finally {fs.rmSync(dir, {force: true, recursive: true})}
  })
  it('does not claim signer handoff solely from a successor replay state', () => {
    const {spec, state} = fixture(); const e = createRotationProposal(spec, state)
    const p = e.proposal
    const status = rotationStatus(e, {...state, currentKeyHash: p.target.keyHash, wfTxNumber: 52}, {activationWfTxNumber: 51, graceWfTxs: p.graceWfTxs, intentId: 'test', redeemScriptHex: p.target.redeemScriptHex, status: 'completed', targetKeyHash: p.target.keyHash})
    expect(status.acceptance.rotationWorkflowComplete).eq(false); expect(status.acceptance.newSignerSignatures).eq('manual_verification_required'); expect(status.outcome).eq('activated'); expect(status.subsequentWfObserved).eq(true); expect(status.signerHandoff).contains('independently verify')
  })
})
