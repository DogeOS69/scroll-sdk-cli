/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic export mutations and Helm fixtures. */
import {address, opcodes as op, script} from 'bitcoinjs-lib'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {createECDH} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {RotateKeyIntent, RotationCluster} from '../../src/utils/rotation-cluster.js'

import {type BridgeScript, bridgeHash, parseBridgeScript} from '../../src/utils/bridge-rotation.js'
import {type RotateKeyStatus, type RotationExport, assertDeploymentIdentity, assertPredecessor, assertRoleSeparation, assertTransportKeys, parseLivenessOutpoint, validateRotationExport} from '../../src/utils/rotation-export.js'
import {BRIDGE_FUNDING_MARKER_HEX, assertIntentMatches, existingIntentReport, mergeRotationSigners, onlineCheck, registerRotation, sendRotation} from '../../src/utils/rotation-operations.js'
import {WP_VALUES_FILE, parseLastPolls} from '../../src/utils/tso-signer-polls.js'

// The governance portal's export goldens (dogeos-gov-portal #125, vectors/rotation-export/).
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../fixtures/rotation-export', name), 'utf8'))
const GOLDEN = fixture('mainnet-example.json')
const EXACT_GRACE = fixture('mainnet-example-exact-grace.json')
const golden = (): any => structuredClone(GOLDEN)
const key = () => {const ec = createECDH('secp256k1'); ec.generateKeys(); return ec.getPublicKey('hex', 'compressed')}


function status(rotation: RotationExport, change: Partial<RotateKeyStatus> = {}): RotateKeyStatus {
  return {
    active_intent: null, current_attestation: {pubkeys: rotation.current.signers.map(s => s.public_key), threshold: rotation.current.threshold}, current_key_hash: rotation.current.key_hash,
    deprecating: null, min_grace_wf_txs: 10, network: 'dogecoin', next_wf_tx_number: 40, protocol_instance_id: rotation.protocol_instance_id, registered_signer_pubkeys: [], ...change,
  }
}

const entry = (signer: {public_key: string; transport_pubkey: string}) => ({delivery: 'pull', network: 'dogecoin', publicKeyOverride: signer.public_key, roles: ['Attestation'], signatureMode: 'ecdsa', transportPubkey: signer.transport_pubkey})
const metrics = (entries: [string, number][]) => ['# HELP tso_core_signer_last_poll_timestamp_seconds x', '# TYPE tso_core_signer_last_poll_timestamp_seconds gauge',
  ...entries.map(([pubkey, at]) => `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="${pubkey}"} ${at}`), 'tso_core_other_metric 1'].join('\n')

describe('bridge rotation export validation', () => {
  it('accepts the portal goldens, bare and exact-grace', () => {
    const rotation = validateRotationExport(golden())
    expect(rotation.wp_rotate_key_request.idempotency_key).to.equal(`${GOLDEN.protocol_instance_id.slice(2)}-DGP-0012-rev2`)
    expect(validateRotationExport(EXACT_GRACE).allowlist_entry).to.equal(`${GOLDEN.target.key_hash}:20160`)
    const graceMismatch = structuredClone(EXACT_GRACE)
    graceMismatch.allowlist_entry = `${GOLDEN.target.key_hash}:20161`
    expect(() => validateRotationExport(graceMismatch)).to.throw('allowlist_entry')
  })

  const mutations: [string, (value: any) => void, string][] = [
    ['schema', v => {v.schema = 'dogeos/rotation-export/v2'}, 'schema'],
    ['network', v => {v.network = 'dogecoin'}, 'network'],
    ['protocol id', v => {v.protocol_instance_id = v.protocol_instance_id.slice(2)}, 'protocol_instance_id'],
    ['current key hash', v => {v.current.key_hash = v.target.key_hash}, 'HASH160'],
    ['target script', v => {v.target.redeem_script_hex = v.current.redeem_script_hex}, 'HASH160'],
    ['target signer order', v => {v.target.signers.reverse()}, 'attestation keys'],
    ['target signer missing', v => {v.target.signers.pop()}, 'attestation keys'],
    ['threshold', v => {v.target.threshold = 2}, 'threshold'],
    ['transport encoding', v => {v.target.signers[0].transport_pubkey = `04${'11'.repeat(32)}`}, 'transport key'],
    ['transport key off the curve', v => {v.target.signers[0].transport_pubkey = `03${'03'.repeat(32)}`}, 'not a valid secp256k1 point'],
    ['transport key equal to its public key', v => {v.target.signers[1].transport_pubkey = v.target.signers[1].public_key}, "is a signer's public key"],
    ['transport key equal to another signer public key', v => {v.target.signers[1].transport_pubkey = v.current.signers[0].public_key}, "is a signer's public key"],
    ['transport key shared by two public keys', v => {v.target.signers[0].transport_pubkey = v.current.signers[0].transport_pubkey}, 'same transport key'],
    ['p2sh address', v => {v.target.p2sh_address = GOLDEN.bridge_json.p2sh_address.replace('A', 'B')}, 'p2sh_address'],
    ['grace null with a stated request grace', v => {v.grace_wf_txs = null}, 'grace_wf_txs'],
    ['request grace null with a stated grace', v => {v.wp_rotate_key_request.grace_wf_txs = null}, 'grace_wf_txs'],
    ['grace over ceiling', v => {v.grace_wf_txs = 260_001; v.wp_rotate_key_request.grace_wf_txs = 260_001}, 'grace_wf_txs'],
    ['allowlist for another hash', v => {v.allowlist_entry = v.current.key_hash}, 'allowlist_entry'],
    ['allowlist grace mismatch', v => {v.allowlist_entry = `${v.target.key_hash}:20161`}, 'allowlist_entry'],
    ['0x idempotency key', v => {v.wp_rotate_key_request.idempotency_key = `0x${v.wp_rotate_key_request.idempotency_key}`}, 'idempotency_key'],
    ['request hash', v => {v.wp_rotate_key_request.new_key_hash = v.current.key_hash}, 'new_key_hash'],
    ['request script', v => {v.wp_rotate_key_request.new_bridge_redeem_script_hex = v.current.redeem_script_hex}, 'script'],
    ['request grace', v => {v.wp_rotate_key_request.grace_wf_txs = 20_161}, 'grace'],
  ]
  for (const [name, mutate, message] of mutations) {
    it(`rejects a changed ${name}`, () => {
      const value = golden()
      mutate(value)
      expect(() => validateRotationExport(value)).to.throw(message)
    })
  }
})

function nullGrace() {
  const value = golden()
  value.grace_wf_txs = null
  value.wp_rotate_key_request.grace_wf_txs = null
  return value
}

describe('bridge rotation export: null grace, regtest and kept signers', () => {
  it('accepts a null grace only with a bare entry, and keeps null in the WP request', () => {
    const rotation = validateRotationExport(nullGrace())
    expect(rotation.grace_wf_txs).to.equal(null)
    expect(rotation.wp_rotate_key_request.grace_wf_txs).to.equal(null)
    const exact = nullGrace()
    exact.allowlist_entry = EXACT_GRACE.allowlist_entry
    expect(() => validateRotationExport(exact)).to.throw('allowlist_entry')
    const zero = structuredClone(EXACT_GRACE)
    zero.grace_wf_txs = 0
    zero.wp_rotate_key_request.grace_wf_txs = 0
    zero.allowlist_entry = `${zero.target.key_hash}:0`
    expect(() => validateRotationExport(zero)).to.throw('at least 1')
  })

  it('matches a stored intent from a null-grace request whatever grace the WP resolved', () => {
    const rotation = validateRotationExport(nullGrace())
    const intent = (change: Partial<RotateKeyIntent['payload']>): RotateKeyIntent => ({activation_wf_tx_number: null, deprecation_wf_tx_number: null, job_status: null,
      payload: {grace_wf_txs: 10, liveness_outpoint: {txid: `0x${'1f'.repeat(32)}`, vout: 1}, new_bridge_redeem_script_hex: rotation.target.redeem_script_hex, new_key_hash: rotation.target.key_hash, ...change}, signed_txid: null, status: 'pending'})
    assertIntentMatches(rotation, intent({}))
    assertIntentMatches(rotation, intent({grace_wf_txs: 20_160}))
    expect(() => assertIntentMatches(rotation, intent({new_key_hash: rotation.current.key_hash}))).to.throw('different rotation')
    expect(() => assertIntentMatches(rotation, intent({new_bridge_redeem_script_hex: rotation.current.redeem_script_hex}))).to.throw('different rotation')
  })

  it('accepts a regtest export, with the testnet P2SH version, against a regtest WP', () => {
    const value = golden()
    value.network = 'regtest'
    value.target.p2sh_address = address.toBase58Check(Buffer.from(value.target.key_hash.slice(2), 'hex'), 196)
    const rotation = validateRotationExport(value)
    assertDeploymentIdentity(rotation, status(rotation, {network: 'regtest'}))
    expect(() => assertDeploymentIdentity(rotation, status(rotation, {network: 'dogecoin'}))).to.throw('network')
    expect(() => validateRotationExport({...value, target: {...value.target, p2sh_address: GOLDEN.target.p2sh_address}})).to.throw('p2sh_address')
  })

  it('lets a signer kept in both sets carry the same transport key, but not a different one', () => {
    const kept = GOLDEN.current.signers[0]
    assertTransportKeys([...GOLDEN.current.signers, ...GOLDEN.target.signers, kept])
    expect(() => assertTransportKeys([...GOLDEN.current.signers, ...GOLDEN.target.signers, {...kept, transport_pubkey: GOLDEN.target.signers[0].transport_pubkey}])).to.throw('same transport key')
    expect(() => assertTransportKeys([...GOLDEN.current.signers, ...GOLDEN.target.signers, {...kept, transport_pubkey: key()}])).to.throw('different transport key in the other set')
  })
})

/** The bridge script layout `parseBridgeScript` reads. */
function compileBridge(parsed: BridgeScript): string {
  const small = (value: number) => op.OP_1 + value - 1
  const multisig = (set: {keys: string[]; threshold: number}) => [small(set.threshold), ...set.keys.map(k => Buffer.from(k, 'hex')), small(set.keys.length), op.OP_CHECKMULTISIGVERIFY]
  return Buffer.from(script.compile([Buffer.from(parsed.namespace, 'hex'), op.OP_DROP, op.OP_IF, ...multisig(parsed.attestation), Buffer.from(parsed.tee, 'hex'), op.OP_CHECKSIGVERIFY, op.OP_ELSE,
    script.number.encode(parsed.timelock), op.OP_CHECKLOCKTIMEVERIFY, op.OP_DROP, ...multisig(parsed.recovery), op.OP_ENDIF, op.OP_1])).toString('hex')
}

/** The golden export with another target script, every derived field recomputed. */
function withTargetScript(change: (parsed: BridgeScript) => void): any {
  const value = golden()
  const parsed = parseBridgeScript(value.target.redeem_script_hex)
  change(parsed)
  const hex = compileBridge(parsed)
  const keyHash = bridgeHash(hex)
  value.target = {...value.target, key_hash: keyHash, p2sh_address: address.toBase58Check(Buffer.from(keyHash.slice(2), 'hex'), 22), redeem_script_hex: hex}
  value.allowlist_entry = keyHash
  value.wp_rotate_key_request = {...value.wp_rotate_key_request, new_bridge_redeem_script_hex: hex, new_key_hash: keyHash}
  return value
}

describe('bridge rotation export role separation', () => {
  const current = parseBridgeScript(GOLDEN.current.redeem_script_hex)

  it('rebuilds the golden target script byte for byte', () => {
    expect(withTargetScript(() => {}).target.redeem_script_hex).to.equal(GOLDEN.target.redeem_script_hex)
    validateRotationExport(withTargetScript(() => {}))
  })

  it('rejects an export where a current key holds another role in the target script', () => {
    const attestor = current.attestation.keys[0]
    expect(() => validateRotationExport(withTargetScript(parsed => {parsed.recovery.keys[0] = attestor}))).to.throw(`key ${attestor} holds more than one role across the current and target scripts (attestation, recovery)`)
    expect(() => validateRotationExport(withTargetScript(parsed => {parsed.tee = attestor}))).to.throw('(attestation, TEE)')
    expect(() => validateRotationExport(withTargetScript(parsed => {parsed.tee = key(); parsed.recovery.keys[0] = current.tee}))).to.throw('(TEE, recovery)')
  })

  it('allows a key to keep its role in both scripts, and rejects two roles within one script', () => {
    const kept = compileBridge({...current, attestation: {keys: [current.attestation.keys[0], key()], threshold: 2}})
    assertRoleSeparation(GOLDEN.current.redeem_script_hex, kept)
    const target = parseBridgeScript(GOLDEN.target.redeem_script_hex)
    const tee = compileBridge({...target, attestation: {keys: [current.tee, key()], threshold: 1}, tee: key()})
    expect(() => assertRoleSeparation(GOLDEN.current.redeem_script_hex, tee)).to.throw('(attestation, TEE)')
    const both = compileBridge({...target, recovery: {keys: [target.attestation.keys[0], key()], threshold: 1}})
    expect(() => assertRoleSeparation(both, GOLDEN.target.redeem_script_hex)).to.throw('(attestation, recovery)')
  })
})

describe('bridge rotation deployment identity and predecessor checks', () => {
  const rotation = validateRotationExport(golden())
  it('maps a mainnet export to the WP dogecoin network', () => {
    assertDeploymentIdentity(rotation, status(rotation))
    expect(() => assertDeploymentIdentity(rotation, status(rotation, {network: 'mainnet'}))).to.throw('network')
    expect(() => assertDeploymentIdentity(rotation, status(rotation, {network: 'testnet'}))).to.throw('network')
    expect(() => assertDeploymentIdentity(rotation, status(rotation, {protocol_instance_id: `0x${'3b'.repeat(32)}`}))).to.throw('another deployment')
  })

  it('requires the live current key, threshold and attestation set, in any order', () => {
    assertPredecessor(rotation, status(rotation, {current_attestation: {pubkeys: rotation.current.signers.map(s => s.public_key).reverse(), threshold: 2}}))
    expect(() => assertPredecessor(rotation, status(rotation, {current_key_hash: rotation.target.key_hash}))).to.throw('stale or already applied')
    expect(() => assertPredecessor(rotation, status(rotation, {current_attestation: {pubkeys: rotation.current.signers.map(s => s.public_key), threshold: 3}}))).to.throw('threshold')
    expect(() => assertPredecessor(rotation, status(rotation, {current_attestation: {pubkeys: [key(), ...rotation.current.signers.slice(1).map(s => s.public_key)], threshold: 2}}))).to.throw('attestation set')
  })
})

describe('bridge rotation register', () => {
  let root: string
  const correctness = {delivery: 'push', network: 'dogecoin', publicKeyOverride: key(), roles: ['Correctness'], signatureMode: 'ecdsa', uri: 'http://cubesigner-signer:3000'}
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-register-'))
    fs.mkdirSync(path.join(root, 'values'))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function setup(rotation: RotationExport, tsoSigners: unknown[]) {
    fs.writeFileSync(path.join(root, WP_VALUES_FILE), yaml.dump({image: {tag: 'x'}, tsoSigners}))
    const calls: string[][] = []
    const envs: Record<string, string>[] = []
    let registered: string[] = []
    const cluster = {context: 'ctx', deploymentDir: root, namespace: 'ns', async wpStatus() {return status(rotation, {registered_signer_pubkeys: registered})}} as unknown as RotationCluster
    const run = (command: string, args: string[], _cwd?: string, env: Record<string, string> = {}) => {
      calls.push([command, ...args])
      envs.push(env)
      if (command === 'make' && args[0] === '-s') return 'oci://chart/withdrawal-processor 0.1.25\n'
      // After rollout the WP reports what the TSO registered: every key in the values.
      if (command === 'kubectl') registered = (yaml.load(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')) as any).tsoSigners.map((s: any) => s.publicKeyOverride)
      return ''
    }

    return {calls, cluster, envs, run}
  }


  it('merges target keys, renders before writing, installs, and is a no-op on rerun', async () => {
    const rotation = validateRotationExport(golden())
    const {calls, cluster, envs, run} = setup(rotation, [correctness, ...rotation.current.signers.map(signer => entry(signer))])
    const result = await registerRotation({cluster, rotation, run, async sleep() {}})
    // Every tool call targets the checked context, even through an older Makefile without --kube-context.
    expect(envs).to.have.length(4)
    expect(envs.every(env => env.HELM_KUBECONTEXT === 'ctx')).to.equal(true)
    expect(calls[1]).to.include.members(['--kube-context', 'ctx'])
    expect(result).to.deep.equal({added: rotation.target.signers.map(s => s.public_key), installed: true, registered: true})
    expect(calls.map(call => call.slice(0, 2).join(' '))).to.deep.equal(['make -s', 'helm template', 'make install-withdrawal-processor', 'kubectl --context'])
    expect(calls[1]).to.include.members(['oci://chart/withdrawal-processor', '--version', '0.1.25', '--namespace', 'ns'])
    const written = yaml.load(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')) as any
    expect(written.tsoSigners).to.deep.equal([correctness, ...rotation.current.signers.map(signer => entry(signer)), ...rotation.target.signers.map(signer => entry(signer))])
    expect(written.image).to.deep.equal({tag: 'x'})
    const before = fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')
    calls.length = 0
    expect(await registerRotation({cluster, rotation, run, async sleep() {}})).to.deep.equal({added: [], installed: false, registered: true})
    expect(calls).to.deep.equal([])
    expect(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')).to.equal(before)
  })

  it('refuses a transport-key conflict, and a helm template failure, without writing anything', async () => {
    const rotation = validateRotationExport(golden())
    const conflicting = {...entry(rotation.target.signers[0]), transportPubkey: key()}
    const {calls, cluster, run} = setup(rotation, [correctness, ...rotation.current.signers.map(signer => entry(signer)), conflicting])
    const before = fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')
    let error: unknown
    try {await registerRotation({cluster, rotation, run})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('conflicts with an existing tsoSigners entry')
    expect(calls).to.deep.equal([])
    expect(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')).to.equal(before)
    // The same transport key on another public key is a conflict too.
    expect(() => mergeRotationSigners([{...entry(rotation.target.signers[0]), publicKeyOverride: key()}], rotation)).to.throw('conflicts')

    const clean = setup(rotation, [correctness, ...rotation.current.signers.map(signer => entry(signer))])
    const failing = (command: string, args: string[]) => {
      if (command === 'helm') throw new Error('chart fail guard')
      return clean.run(command, args)
    }

    const cleanBefore = fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')
    error = undefined
    try {await registerRotation({cluster: clean.cluster, rotation, run: failing})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('nothing was written')
    expect(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')).to.equal(cleanBefore)
    expect(clean.calls.some(call => call[0] === 'make' && call[1] === 'install-withdrawal-processor')).to.equal(false)
  })

  it('installs again on a rerun after a failed install, without rewriting values', async () => {
    const rotation = validateRotationExport(golden())
    const {calls, cluster, run} = setup(rotation, [correctness, ...rotation.current.signers.map(signer => entry(signer))])
    const failInstall = (command: string, args: string[]) => {
      if (command === 'make' && args[0] === 'install-withdrawal-processor') throw new Error('cluster unreachable')
      return run(command, args)
    }

    let error: unknown
    try {await registerRotation({cluster, rotation, run: failInstall})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('re-run register')
    const saved = fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')
    calls.length = 0
    expect(await registerRotation({cluster, rotation, run, async sleep() {}})).to.deep.equal({added: [], installed: true, registered: true})
    expect(calls.map(call => call.slice(0, 2).join(' '))).to.deep.equal(['make -s', 'helm template', 'make install-withdrawal-processor', 'kubectl --context'])
    expect(fs.readFileSync(path.join(root, WP_VALUES_FILE), 'utf8')).to.equal(saved)
  })

  it('treats an entry with another signature mode or an extra field as a conflict', () => {
    const rotation = validateRotationExport(golden())
    const signer = rotation.target.signers[0]
    for (const existing of [{...entry(signer), signatureMode: 'shadowfork_sentinel'}, {...entry(signer), uri: 'http://signer:3000'}, {...entry(signer), roles: ['Attestation', 'Correctness']}]) {
      expect(() => mergeRotationSigners([existing], rotation)).to.throw('conflicts')
    }

    expect(mergeRotationSigners([entry(signer)], rotation).added).to.not.include(signer.public_key)
  })

  it('refuses a stale predecessor before touching values', async () => {
    const rotation = validateRotationExport(golden())
    const {calls, cluster, run} = setup(rotation, [correctness])
    cluster.wpStatus = async () => status(rotation, {current_key_hash: rotation.target.key_hash})
    let error: unknown
    try {await registerRotation({cluster, rotation, run})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('stale or already applied')
    expect(calls).to.deep.equal([])
  })
})

describe('bridge rotation online check', () => {
  const rotation = validateRotationExport(golden())
  const now = 1_800_000_000
  const everyone = (at: number): [string, number][] => [...rotation.current.signers, ...rotation.target.signers].map(s => [s.public_key, at])
  const check = (entries: [string, number][], live = status(rotation)) => onlineCheck(rotation, live, parseLastPolls(metrics(entries)), now)

  it('passes when every target and at least M current keys polled within 60 s, allowing 5 s of skew', () => {
    expect(check(everyone(now - 60)).passed).to.equal(true)
    expect(check(everyone(now + 5)).passed).to.equal(true)
    // One current signer down still leaves M = 2 of 3.
    expect(check(everyone(now).filter(([pubkey]) => pubkey !== rotation.current.signers[0].public_key)).passed).to.equal(true)
  })

  it('fails on a missing, stale or future target poll, or fewer than M current polls', () => {
    expect(check(everyone(now).filter(([pubkey]) => pubkey !== rotation.target.signers[3].public_key)).passed).to.equal(false)
    expect(check(everyone(now - 61)).passed).to.equal(false)
    expect(check(everyone(now + 6)).passed).to.equal(false)
    const twoCurrentDown = everyone(now).filter(([pubkey]) => !rotation.current.signers.slice(0, 2).some(s => s.public_key === pubkey))
    const result = check(twoCurrentDown)
    expect(result.passed).to.equal(false)
    expect(result.current).to.deep.equal({fresh: 1, required: 2})
  })

  it('takes the current members and M from the live WP, not the export', () => {
    const other = [key(), key(), key()]
    const live = status(rotation, {current_attestation: {pubkeys: other, threshold: 3}})
    expect(check(everyone(now), live).passed).to.equal(false)
    expect(check([...everyone(now), ...other.map((pubkey): [string, number] => [pubkey, now])], live).passed).to.equal(true)
  })
})

describe('bridge rotation liveness outpoint', () => {
  it('parses <txid>:<vout> into the WP form, and rejects anything else', () => {
    expect(parseLivenessOutpoint(`${'AB'.repeat(32)}:3`)).to.deep.equal({txid: `0x${'ab'.repeat(32)}`, vout: 3})
    // Not a palindrome: the txid keeps dogecoin-cli's display order, which the WP's Txid32 parses.
    const display = '0123456789abcdef'.repeat(4)
    expect(parseLivenessOutpoint(`${display}:0`)).to.deep.equal({txid: `0x${display}`, vout: 0})
    expect(parseLivenessOutpoint(`0x${'ab'.repeat(32)}:4294967295`)).to.deep.equal({txid: `0x${'ab'.repeat(32)}`, vout: 4_294_967_295})
    for (const bad of ['ab'.repeat(32), `${'ab'.repeat(31)}:0`, `${'ab'.repeat(32)}:-1`, `${'ab'.repeat(32)}:4294967296`, `${'ab'.repeat(32)}:1.5`, `${'zz'.repeat(32)}:0`]) {
      expect(() => parseLivenessOutpoint(bad)).to.throw('--liveness-outpoint')
    }
  })
})

describe('bridge rotation send', () => {
  const rotation = validateRotationExport(golden())
  const OUTPOINT = parseLivenessOutpoint(`${'1f'.repeat(32)}:1`)
  const fresh = () => [...rotation.current.signers, ...rotation.target.signers].map(s => `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="${s.public_key}"} ${Math.floor(Date.now() / 1000)}`).join('\n')
  const stored = (change: Partial<RotateKeyIntent['payload']> = {}, state = 'completed'): RotateKeyIntent => ({
    activation_wf_tx_number: 41, deprecation_wf_tx_number: 20_201, job_status: 'completed',
    payload: {grace_wf_txs: 20_160, liveness_outpoint: OUTPOINT, new_bridge_redeem_script_hex: rotation.target.redeem_script_hex, new_key_hash: rotation.target.key_hash, ...change}, signed_txid: 'aa'.repeat(32), status: state,
  })

  function cluster(intent: RotateKeyIntent | null, post: (route: string) => Promise<{body: unknown; status: number}> = async () => ({body: {status: 'pending'}, status: 202})) {
    const posts: string[] = []
    const lookups: string[] = []
    const value = {
      async postWp(route: string, body: unknown) {posts.push(route); expect(body).to.deep.equal({...rotation.wp_rotate_key_request, liveness_outpoint: OUTPOINT}); return post(route)},
      async tsoMetrics() {return fresh()},
      async wpIntent(idempotencyKey: string) {lookups.push(idempotencyKey); return intent},
      async wpStatus() {return status(rotation)},
    } as unknown as RotationCluster
    return {cluster: value, lookups, posts}
  }

  it('only send without --preview calls /propose; --preview calls /build', async () => {
    const built = {liveness_outpoint: OUTPOINT, liveness_value_sats: 100_000_000, wf_unsigned_txid: 'ab'}
    const preview = cluster(null, async () => ({body: built, status: 200}))
    expect(await sendRotation({cluster: preview.cluster, livenessOutpoint: OUTPOINT, preview: true, rotation})).to.deep.equal({kind: 'preview', liveness: {outpoint: `${'1f'.repeat(32)}:1`, valueSats: 100_000_000}, response: built})
    expect(preview.posts).to.deep.equal(['/build'])
    const send = cluster(null)
    expect(await sendRotation({cluster: send.cluster, livenessOutpoint: OUTPOINT, preview: false, rotation})).to.deep.include({kind: 'proposed', status: 202})
    expect(send.posts).to.deep.equal(['/propose'])
    expect(send.lookups).to.deep.equal([rotation.wp_rotate_key_request.idempotency_key])
  })

  it('refuses a new intent without a liveness outpoint and says how to fund one', async () => {
    for (const preview of [false, true]) {
      const missing = cluster(null)
      missing.cluster.tsoMetrics = async () => {throw new Error('online check must not run')}
      let error: unknown
      try {await sendRotation({cluster: missing.cluster, preview, rotation})} catch (error_) {error = error_}
      expect((error as Error).message).to.contain('--liveness-outpoint').and.contain(rotation.target.p2sh_address).and.contain('at least 1 DOGE').and.contain(BRIDGE_FUNDING_MARKER_HEX)
      expect(missing.posts).to.deep.equal([])
    }

    expect(BRIDGE_FUNDING_MARKER_HEX).to.equal(`6a4901${'00'.repeat(72)}`)
  })

  it('refuses a preview whose response does not echo the liveness outpoint and its value', async () => {
    for (const body of [{wf_unsigned_txid: 'ab'}, {liveness_outpoint: {...OUTPOINT, vout: 2}, liveness_value_sats: 100_000_000}, {liveness_outpoint: OUTPOINT}]) {
      const ignoring = cluster(null, async () => ({body, status: 200}))
      let error: unknown
      try {await sendRotation({cluster: ignoring.cluster, livenessOutpoint: OUTPOINT, preview: true, rotation})} catch (error_) {error = error_}
      expect((error as Error).message).to.contain('does not echo the liveness outpoint')
    }
  })

  it('shows the WP reason when the preview rejects the liveness outpoint', async () => {
    const reason = `liveness_outpoint ${'1f'.repeat(32)}:1 is not locked to P2SH(new_key_hash)`
    const rejected = cluster(null, async () => ({body: {error: reason}, status: 422}))
    let error: unknown
    try {await sendRotation({cluster: rejected.cluster, livenessOutpoint: OUTPOINT, preview: true, rotation})} catch (error_) {error = error_}
    expect((error as Error).message).to.equal(`WP preview (/build) returned HTTP 422: ${reason}; nothing was stored`)
    const proposed = cluster(null, async () => ({body: {error: reason}, status: 422}))
    try {await sendRotation({cluster: proposed.cluster, livenessOutpoint: OUTPOINT, preview: false, rotation})} catch (error_) {error = error_}
    expect((error as Error).message).to.equal(`/propose was refused (HTTP 422: ${reason}); nothing was stored. Fix the cause, then re-run send`)
  })

  it('reports an existing intent without an outpoint, and refuses one stored with another outpoint', async () => {
    const existing = cluster(stored({liveness_outpoint: OUTPOINT}, 'pending'))
    expect(await sendRotation({cluster: existing.cluster, preview: false, rotation})).to.deep.include({exitCode: 2, kind: 'existing'})
    expect(await sendRotation({cluster: existing.cluster, livenessOutpoint: parseLivenessOutpoint(`${'1F'.repeat(32)}:1`), preview: false, rotation})).to.deep.include({kind: 'existing'})
    const mismatch = cluster(stored({liveness_outpoint: {...OUTPOINT, vout: 2}}, 'pending'))
    let error: unknown
    try {await sendRotation({cluster: mismatch.cluster, livenessOutpoint: OUTPOINT, preview: false, rotation})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('different rotation').and.contain(`stored liveness outpoint ${'1f'.repeat(32)}:2, requested ${'1f'.repeat(32)}:1`)

    expect(existing.posts).to.deep.equal([])
  })

  it('prints the stored liveness outpoint of an existing intent as <txid>:<vout>', () => {
    expect(existingIntentReport(rotation, stored({liveness_outpoint: {txid: `0x${'1F'.repeat(32)}`, vout: 1}}))).to.deep.include({idempotencyKey: rotation.wp_rotate_key_request.idempotency_key, livenessOutpoint: `${'1f'.repeat(32)}:1`})
  })

  it('reports an existing intent and never resubmits it, even with --preview', async () => {
    for (const [state, exitCode] of [['completed', 0], ['pending', 2], ['bound', 2], ['failed_terminal', 1], ['superseded', 1]] as const) {
      for (const preview of [false, true]) {
        const existing = cluster(stored({}, state))
        // Predecessor and online checks would fail after a completed rotation; they must not run.
        existing.cluster.wpStatus = async () => status(rotation, {current_key_hash: rotation.target.key_hash, deprecating: {deprecation_wf_tx_number: 20_201, key_hash: rotation.current.key_hash}})
        existing.cluster.tsoMetrics = async () => {throw new Error('online check must not run')}
        expect(await sendRotation({cluster: existing.cluster, preview, rotation})).to.deep.include({exitCode, kind: 'existing'})
        expect(existing.posts).to.deep.equal([])
      }
    }
  })

  it('treats a stored payload mismatch as an error', async () => {
    for (const change of [{grace_wf_txs: 20_161}, {new_key_hash: rotation.current.key_hash}, {new_bridge_redeem_script_hex: rotation.current.redeem_script_hex}]) {
      const mismatch = cluster(stored(change, 'pending'))
      let error: unknown
      try {await sendRotation({cluster: mismatch.cluster, preview: false, rotation})} catch (error_) {error = error_}
      expect((error as Error).message).to.contain('different rotation')
      expect(mismatch.posts).to.deep.equal([])
    }
  })

  it('says the submission may already be stored on any /propose HTTP failure', async () => {
    for (const post of [async () => {throw new Error('socket hang up')}, async () => ({body: {}, status: 503}), async () => ({body: {}, status: 500})]) {
      const failing = cluster(null, post)
      let error: unknown
      try {await sendRotation({cluster: failing.cluster, livenessOutpoint: OUTPOINT, preview: false, rotation})} catch (error_) {error = error_}
      expect((error as Error).message).to.contain('may already be stored')
    }
  })

  it('refuses a new intent while a rotation overlaps, an intent is active, or signers are offline', async () => {
    const cases: [Partial<RotateKeyStatus>, string][] = [
      [{deprecating: {deprecation_wf_tx_number: 50, key_hash: `0x${'11'.repeat(20)}`}}, 'grace window'],
      [{active_intent: {idempotency_key: 'other', status: 'pending'}}, 'active rotation intent'],
      [{current_key_hash: rotation.target.key_hash}, 'stale or already applied'],
    ]
    // Without an outpoint too: a blocked rotation is reported before the operator is asked to fund one.
    for (const [change, message] of cases) {
      for (const livenessOutpoint of [OUTPOINT, undefined]) {
        const blocked = cluster(null)
        blocked.cluster.wpStatus = async () => status(rotation, change)
        let error: unknown
        try {await sendRotation({cluster: blocked.cluster, livenessOutpoint, preview: false, rotation})} catch (error_) {error = error_}
        expect((error as Error).message).to.contain(message)
        expect(blocked.posts).to.deep.equal([])
      }
    }

    const offline = cluster(null)
    offline.cluster.tsoMetrics = async () => ''
    let error: unknown
    try {await sendRotation({cluster: offline.cluster, livenessOutpoint: OUTPOINT, preview: true, rotation})} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('Online check failed')
    expect(offline.posts).to.deep.equal([])
  })
})
