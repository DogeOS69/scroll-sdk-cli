import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {WP_VALUES_FILE, isFreshPoll, liveSignerAcceptance, parseLastPolls, registeredAttestationKeys, signerLiveness} from '../../src/utils/tso-signer-polls.js'

const key = (byte: string) => `02${byte.repeat(32)}`
const metrics = (entries: [string, number][]) => ['# HELP tso_core_signer_last_poll_timestamp_seconds x', '# TYPE tso_core_signer_last_poll_timestamp_seconds gauge',
  ...entries.map(([pubkey, at]) => `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="${pubkey}"} ${at}`), 'tso_core_other 1'].join('\n')

describe('TSO signer poll liveness', () => {
  const now = 1_800_000_000

  it('accepts polls within the last 60 s and up to 5 s of clock skew', () => {
    expect([now - 60, now, now + 5].map(at => isFreshPoll(at, now))).to.deep.equal([true, true, true])
    expect([now - 61, now + 6, undefined, Number.NaN].map(at => isFreshPoll(at, now))).to.deep.equal([false, false, false, false])
    expect(parseLastPolls(metrics([[key('AA'), now]])).get(key('aa'))).to.equal(now)
  })

  it('requires every registered key to be in the TSO metrics with a fresh poll', () => {
    const keys = [key('11'), key('22')]
    expect(signerLiveness(keys, metrics([[keys[0], now], [keys[1], now - 10]]), now).passed).to.equal(true)
    const missing = signerLiveness(keys, metrics([[keys[0], now]]), now)
    expect(missing.passed).to.equal(false)
    expect(missing.signers[1]).to.deep.equal({fresh: false, lastPoll: null, publicKey: keys[1]})
    expect(signerLiveness(keys, metrics([[keys[0], now], [keys[1], now - 61]]), now).passed).to.equal(false)
    expect(signerLiveness(keys, metrics([[keys[0], now], [keys[1], now + 6]]), now).passed).to.equal(false)
  })

  it('accepts an enforcing deployment only when every registered Attestation signer polls (proof-config-check --live)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tso-signer-live-'))
    try {
      fs.mkdirSync(path.join(root, 'values'))
      const keys = [key('11'), key('22')]
      fs.writeFileSync(path.join(root, WP_VALUES_FILE), yaml.dump({tsoSigners: [{publicKeyOverride: key('99'), roles: ['Correctness']}, ...keys.map(publicKeyOverride => ({publicKeyOverride, roles: ['Attestation']}))]}))
      const targets: unknown[] = []
      const check = (entries: [string, number][], change: {context?: string; enforcement?: string} = {}) => liveSignerAcceptance({context: 'ctx', deploymentDir: root, enforcement: 'enforce', namespace: 'ns', now: () => now * 1000, async readMetrics(target) {targets.push(target); return metrics(entries)}, ...change})
      const failure = async (entries: [string, number][], change = {}) => {try {await check(entries, change); return ''} catch (error) {return (error as Error).message}}
      expect((await check(keys.map(publicKey => [publicKey, now]))).passed).to.equal(true)
      expect(targets).to.deep.equal([{context: 'ctx', namespace: 'ns'}])
      expect(await failure([[keys[0], now]])).to.include('Not accepted').and.include(keys[1])
      expect(await failure([[keys[0], now], [keys[1], now - 61]])).to.include(keys[1])
      expect(await failure(keys.map(publicKey => [publicKey, now]), {enforcement: 'observe'})).to.include('enforcing deployments')
      expect(await failure(keys.map(publicKey => [publicKey, now]), {context: undefined})).to.include('--kube-context')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('reads the Attestation keys of the WP tsoSigners and rejects an empty or malformed registry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tso-signer-polls-'))
    try {
      fs.mkdirSync(path.join(root, 'values'))
      const write = (tsoSigners?: unknown) => fs.writeFileSync(path.join(root, WP_VALUES_FILE), yaml.dump({tsoSigners}))
      write([{publicKeyOverride: key('99'), roles: ['Correctness']}, {publicKeyOverride: key('AB'), roles: ['Attestation']}])
      expect(registeredAttestationKeys(root)).to.deep.equal([key('ab')])
      write([{publicKeyOverride: key('99'), roles: ['Correctness']}])
      expect(() => registeredAttestationKeys(root)).to.throw('registers no Attestation signers')
      write([{publicKeyOverride: 'not-a-key', roles: ['Attestation']}])
      expect(() => registeredAttestationKeys(root)).to.throw('no compressed publicKeyOverride')
      write([{publicKeyOverride: key('AB'), roles: ['Attestation']}, {publicKeyOverride: key('CD'), roles: 'Attestation'}])
      expect(() => registeredAttestationKeys(root)).to.throw('has no roles list')
      write()
      expect(() => registeredAttestationKeys(root)).to.throw('has no tsoSigners list')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
