import type {AddressInfo} from 'node:net'

import {Command} from '@oclif/core'
import {expect} from 'chai'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import RotationOnline from '../../../src/commands/bridge/rotation/online.js'
import RotationSend from '../../../src/commands/bridge/rotation/send.js'
import {ROTATE_KEY} from '../../../src/utils/rotation-cluster.js'
import {WP_VALUES_FILE} from '../../../src/utils/tso-signer-polls.js'

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const GOLDEN = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'test/fixtures/rotation-export/mainnet-example.json'), 'utf8'))
const EXACT_CUTOFF = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'test/fixtures/rotation-export/mainnet-example-exact-cutoff.json'), 'utf8'))
// Not a palindrome, so a byte-order reversal would show.
const TXID = '0123456789abcdef'.repeat(4)

function reply(response: http.ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, {'content-type': 'application/json'})
  response.end(JSON.stringify(body))
}

describe('bridge rotation send command', () => {
  let directory: string
  let exportFile: string
  let server: http.Server
  let url: string
  let posts: {body: unknown; route: string}[]
  let intent: unknown
  let logs: string[]

  const signers = [...GOLDEN.current.signers, ...GOLDEN.target.signers] as {public_key: string}[]
  const status = {
    active_intent: null, current_attestation: {pubkeys: GOLDEN.current.signers.map((s: {public_key: string}) => s.public_key), threshold: GOLDEN.current.threshold}, current_key_hash: GOLDEN.current.key_hash,
    deprecating: null, min_grace_blocks: 10, network: 'mainnet', next_wf_tx_number: 40, protocol_instance_id: GOLDEN.protocol_instance_id, registered_signer_pubkeys: [],
  }

  function handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    let text = ''
    request.on('data', chunk => {text += chunk})
    request.on('end', () => {
      if (request.url === '/metrics') {
        response.end(signers.map(s => `tso_core_signer_last_poll_timestamp_seconds{signer_pubkey="${s.public_key}"} ${Math.floor(Date.now() / 1000)}`).join('\n'))
      } else if (request.url === `${ROTATE_KEY}/status`) {
        reply(response, 200, status)
      } else if (request.url?.startsWith(`${ROTATE_KEY}/intents/`)) {
        if (intent) reply(response, 200, intent)
        else reply(response, 404, {error: 'not found'})
      } else {
        posts.push({body: JSON.parse(text), route: String(request.url)})
        const echoed = JSON.parse(text).liveness_outpoint
        reply(response, 200, {liveness_outpoint: echoed, liveness_value_sats: 100_000_000, wf_unsigned_txid: 'ab'.repeat(32)})
      }
    })
  }

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-send-'))
    fs.mkdirSync(path.join(directory, path.dirname(WP_VALUES_FILE)))
    fs.writeFileSync(path.join(directory, WP_VALUES_FILE), 'tsoSigners: []\n')
    exportFile = path.join(directory, 'rotation-export.json')
    fs.writeFileSync(exportFile, JSON.stringify(GOLDEN))
    status.network = 'mainnet'
    status.protocol_instance_id = GOLDEN.protocol_instance_id
    status.min_grace_blocks = 10
    posts = []
    intent = null
    logs = []
    sinon.stub(Command.prototype, 'log').callsFake((message?: string) => {logs.push(String(message))})
    server = http.createServer(handle)
    await new Promise<void>(resolve => {server.listen(0, '127.0.0.1', resolve)})
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    sinon.restore()
    process.exitCode = undefined
    await new Promise(resolve => {server.close(resolve)})
    fs.rmSync(directory, {force: true, recursive: true})
  })

  const run = (...extra: string[]) => RotationSend.run([exportFile, '--dir', directory, '--context', 'test', '--wp-url', url, '--tso-url', url, ...extra], CLI_ROOT)

  it('checks online against mainnet WP status without posting', async () => {
    status.network = 'mainnet'
    await RotationOnline.run([exportFile, '--dir', directory, '--context', 'test', '--wp-url', url, '--tso-url', url], CLI_ROOT)
    expect(JSON.parse(logs[0]).passed).to.equal(true)
    expect(posts).to.deep.equal([])
  })

  for (const network of ['dogecoin', 'testnet', 'regtest', 'bitcoin']) {
    it(`rejects ${network} status in online, send and preview without posting`, async () => {
      status.network = network
      for (const command of [
        () => RotationOnline.run([exportFile, '--dir', directory, '--context', 'test', '--wp-url', url, '--tso-url', url], CLI_ROOT),
        () => run('--liveness-outpoint', `${TXID}:0`),
        () => run('--liveness-outpoint', `${TXID}:0`, '--preview'),
      ]) {
        let error: unknown
        try {await command()} catch (error_) {error = error_}
        expect((error as Error).message).to.contain('network')
      }

      expect(posts).to.deep.equal([])
    })
  }

  it('previews with the outpoint in display order and prints the echoed outpoint and value', async () => {
    await run('--liveness-outpoint', `${TXID}:0`, '--preview')
    expect(posts.map(p => p.route)).to.deep.equal([`${ROTATE_KEY}/build`])
    expect(posts[0].body).to.deep.include({idempotency_key: GOLDEN.wp_rotate_key_request.idempotency_key, liveness_outpoint: {txid: `0x${TXID}`, vout: 0}})
    const printed = JSON.parse(logs[0])
    expect(printed.liveness).to.deep.include({outpoint: `${TXID}:0`, valueSats: 100_000_000})
    expect(fs.existsSync(path.join(directory, 'rotation-export.preview.json'))).to.equal(true)
  })

  it('refuses a new intent without --liveness-outpoint and posts nothing', async () => {
    let error: unknown
    try {await run('--preview')} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('--liveness-outpoint').and.contain(GOLDEN.target.p2sh_address)
    expect(posts).to.deep.equal([])
  })

  it('exits 2 for a bound intent, and 1 with pinMismatch for a failed intent the export pins differently', async () => {
    const payload = {grace_blocks: EXACT_CUTOFF.wp_rotate_key_request.grace_blocks, liveness_outpoint: {txid: `0x${TXID}`, vout: 2}, new_bridge_redeem_script_hex: EXACT_CUTOFF.target.redeem_script_hex, new_key_hash: EXACT_CUTOFF.target.key_hash}
    intent = {activation_wf_tx_number: 41, deposit_cutoff_height: 20_201, job_status: 'running', payload, signed_txid: null, status: 'bound'}
    await run()
    expect(process.exitCode).to.equal(2)
    expect(JSON.parse(logs[0])).to.not.have.property('pinMismatch')

    fs.writeFileSync(exportFile, JSON.stringify(EXACT_CUTOFF))
    intent = {activation_wf_tx_number: 41, deposit_cutoff_height: EXACT_CUTOFF.deposit_cutoff_height + 1, job_status: 'failed', payload, signed_txid: null, status: 'failed_terminal'}
    logs = []
    await run()
    expect(process.exitCode).to.equal(1)
    expect(JSON.parse(logs[0]).pinMismatch).to.contain(`pins deposit cutoff height ${EXACT_CUTOFF.deposit_cutoff_height}`)
    expect(posts).to.deep.equal([])
  })

  it('reports an existing intent with its stored outpoint, and refuses an intent response without one', async () => {
    const payload = {grace_blocks: GOLDEN.wp_rotate_key_request.grace_blocks, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
    intent = {activation_wf_tx_number: 41, deposit_cutoff_height: 20_201, job_status: 'completed', payload: {...payload, liveness_outpoint: {txid: `0x${TXID}`, vout: 2}}, signed_txid: 'aa'.repeat(32), status: 'completed'}
    await run()
    expect(JSON.parse(logs[0]).livenessOutpoint).to.equal(`${TXID}:2`)
    expect(process.exitCode).to.equal(0)

    intent = {activation_wf_tx_number: null, deposit_cutoff_height: null, job_status: null, payload, signed_txid: null, status: 'pending'}
    let error: unknown
    try {await run('--liveness-outpoint', `${TXID}:2`)} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('no valid payload.liveness_outpoint')
    expect(posts).to.deep.equal([])
  })

  it('refuses a pinned export with no intent, or pinned to another height than the bound one, and posts nothing', async () => {
    fs.writeFileSync(exportFile, JSON.stringify(EXACT_CUTOFF))
    let error: unknown
    try {await run('--liveness-outpoint', `${TXID}:0`)} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('no intent exists yet')

    const payload = {grace_blocks: EXACT_CUTOFF.grace_blocks, liveness_outpoint: {txid: `0x${TXID}`, vout: 0}, new_bridge_redeem_script_hex: EXACT_CUTOFF.target.redeem_script_hex, new_key_hash: EXACT_CUTOFF.target.key_hash}
    intent = {activation_wf_tx_number: 41, deposit_cutoff_height: EXACT_CUTOFF.deposit_cutoff_height + 1, job_status: 'running', payload, signed_txid: null, status: 'bound'}
    error = undefined
    try {await run()} catch (error_) {error = error_}
    expect((error as Error).message).to.contain(`pins ${EXACT_CUTOFF.deposit_cutoff_height}`)
    expect(posts).to.deep.equal([])
  })

  it('refuses WP responses from before the deposit cutoff height', async () => {
    const payload = {grace_wf_txs: 20_160, liveness_outpoint: {txid: `0x${TXID}`, vout: 0}, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
    intent = {activation_wf_tx_number: 41, deprecation_wf_tx_number: 20_201, job_status: 'completed', payload, signed_txid: 'aa'.repeat(32), status: 'completed'}
    let error: unknown
    try {await run()} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('deploy a WP that reports the deposit cutoff height')

    intent = null
    ;(status as Record<string, unknown>).min_grace_blocks = undefined
    error = undefined
    try {await run('--liveness-outpoint', `${TXID}:0`)} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('deploy a WP that reports the deposit cutoff height')
    expect(posts).to.deep.equal([])
  })

  it('refuses each missing or inconsistent cutoff field of the WP intent', async () => {
    const payload = {grace_blocks: GOLDEN.grace_blocks, liveness_outpoint: {txid: `0x${TXID}`, vout: 0}, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
    const base = {activation_wf_tx_number: 41, deposit_cutoff_height: 20_201, job_status: 'running', payload, signed_txid: null, status: 'bound'}
    const cases: [Record<string, unknown>, string][] = [
      [{deposit_cutoff_height: undefined}, 'deploy a WP that reports the deposit cutoff height'],
      [{deposit_cutoff_height: '20201'}, 'outside the range core allows'],
      [{deposit_cutoff_height: -1}, 'outside the range core allows'],
      [{payload: {...payload, grace_blocks: 0}}, 'outside the range core allows'],
      [{payload: {...payload, grace_blocks: 260_001}}, 'outside the range core allows'],
      [{deposit_cutoff_height: 2 ** 32}, 'outside the range core allows'],
      [{deposit_cutoff_height: null}, 'bound but reports no deposit_cutoff_height'],
      [{status: 'retrying'}, 'upgrade the CLI'],
      [{payload: {...payload, new_key_hash: null}}, 'no payload.new_key_hash'],
    ]
    for (const [change, message] of cases) {
      intent = {...base, ...change}
      let error: unknown
      try {await run()} catch (error_) {error = error_}
      expect((error as Error).message, JSON.stringify(change)).to.contain(message)
    }

    expect(posts).to.deep.equal([])
  })

  it('accepts WP intents and status at the edges of the grace and height ranges', async () => {
    for (const [grace, height] of [[1, 0], [260_000, 4_294_967_295]]) {
      const edge = structuredClone(GOLDEN)
      edge.grace_blocks = grace
      edge.wp_rotate_key_request.grace_blocks = grace
      fs.writeFileSync(exportFile, JSON.stringify(edge))
      status.min_grace_blocks = grace
      const payload = {grace_blocks: grace, liveness_outpoint: {txid: `0x${TXID}`, vout: 2}, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
      intent = {activation_wf_tx_number: 41, deposit_cutoff_height: height, job_status: 'running', payload, signed_txid: null, status: 'bound'}
      logs = []
      await run()
      expect(process.exitCode, `grace ${grace}, height ${height}`).to.equal(2)
      expect(JSON.parse(logs[0]).intent.deposit_cutoff_height).to.equal(height)
    }

    expect(posts).to.deep.equal([])
  })

  it('refuses a WP status min_grace_blocks outside 1..260000', async () => {
    for (const bad of [0, 260_001, null, 1.5]) {
      ;(status as Record<string, unknown>).min_grace_blocks = bad
      let error: unknown
      try {await run('--liveness-outpoint', `${TXID}:0`)} catch (error_) {error = error_}
      expect((error as Error | undefined)?.message, String(bad)).to.contain('status min_grace_blocks is').and.contain('outside the range core allows')
    }

    expect(posts).to.deep.equal([])
  })

  it('accepts a WP status that reports a deprecating key with its cutoff height', async () => {
    // After a rotation the WP reports the old key for the whole grace window.
    ;(status as Record<string, unknown>).deprecating = {deposit_cutoff_height: 20_201, key_hash: GOLDEN.current.key_hash}
    const payload = {grace_blocks: GOLDEN.wp_rotate_key_request.grace_blocks, liveness_outpoint: {txid: `0x${TXID}`, vout: 2}, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
    intent = {activation_wf_tx_number: 41, deposit_cutoff_height: 20_201, job_status: 'completed', payload, signed_txid: 'aa'.repeat(32), status: 'completed'}
    try {await run()} finally {status.deprecating = null}
    expect(JSON.parse(logs[0]).intent.status).to.equal('completed')
    expect(process.exitCode).to.equal(0)
    expect(posts).to.deep.equal([])
  })

  it('refuses a WP status whose deprecating key has no valid deposit cutoff height', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{key_hash: GOLDEN.current.key_hash}, 'deprecating.deposit_cutoff_height is missing'],
      [{deposit_cutoff_height: -1, key_hash: GOLDEN.current.key_hash}, 'deprecating.deposit_cutoff_height is -1, outside the range'],
    ]
    for (const [deprecating, message] of cases) {
      ;(status as Record<string, unknown>).deprecating = deprecating
      let error: unknown
      try {await run('--liveness-outpoint', `${TXID}:0`)} catch (error_) {error = error_} finally {status.deprecating = null}
      expect((error as Error | undefined)?.message).to.contain(message)
    }

    expect(posts).to.deep.equal([])
  })
})
