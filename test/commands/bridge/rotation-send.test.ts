import type {AddressInfo} from 'node:net'

import {Command} from '@oclif/core'
import {expect} from 'chai'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import sinon from 'sinon'

import RotationSend from '../../../src/commands/bridge/rotation/send.js'
import {ROTATE_KEY} from '../../../src/utils/rotation-cluster.js'
import {WP_VALUES_FILE} from '../../../src/utils/tso-signer-polls.js'

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const GOLDEN = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'test/fixtures/rotation-export/mainnet-example.json'), 'utf8'))
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
    deprecating: null, min_grace_wf_txs: 10, network: 'dogecoin', next_wf_tx_number: 40, protocol_instance_id: GOLDEN.protocol_instance_id, registered_signer_pubkeys: [],
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

  it('reports an existing intent with its stored outpoint, and refuses an intent response without one', async () => {
    const payload = {grace_wf_txs: GOLDEN.wp_rotate_key_request.grace_wf_txs, new_bridge_redeem_script_hex: GOLDEN.target.redeem_script_hex, new_key_hash: GOLDEN.target.key_hash}
    intent = {activation_wf_tx_number: 41, deprecation_wf_tx_number: 20_201, job_status: 'completed', payload: {...payload, liveness_outpoint: {txid: `0x${TXID}`, vout: 2}}, signed_txid: 'aa'.repeat(32), status: 'completed'}
    await run()
    expect(JSON.parse(logs[0]).livenessOutpoint).to.equal(`${TXID}:2`)
    expect(process.exitCode).to.equal(0)

    intent = {activation_wf_tx_number: null, deprecation_wf_tx_number: null, job_status: null, payload, signed_txid: null, status: 'pending'}
    let error: unknown
    try {await run('--liveness-outpoint', `${TXID}:2`)} catch (error_) {error = error_}
    expect((error as Error).message).to.contain('no valid payload.liveness_outpoint')
    expect(posts).to.deep.equal([])
  })
})
