/* eslint-disable @typescript-eslint/no-explicit-any -- Helm/config fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import PrepCharts from '../../src/commands/setup/prep-charts.js'
import {rotationProtocolOpeningId} from '../../src/utils/bridge-rotation-runtime.js'
import {FRONTEND_COMMAND, frontendDepositEnv, mergeFrontendConfigDocuments, readFrontendDepositIdentity, reconcileFrontendConfig, reconcileFrontendProduction} from '../../src/utils/frontend-deposit-config.js'
import {syntheticMockProofIdentities} from '../../src/utils/proof-materials.js'

const hex = (n: string, size = 32) => `0x${n.repeat(size)}`
const context = {
  genesis: {
    genesis_batch_hash: hex('a1'), genesis_bridge_key_hash: hex('33', 20),
    genesis_sequencer_outpoint: {txid: hex('22'), vout: 0}, genesis_state_root: hex('a2'),
    initial_confirmed_block_hash: hex('44'), initial_confirmed_block_number: 100,
    initial_ethereum_block_hash: hex('55'), initial_system_signer: hex('a3', 20), initial_tx_index: 200,
  },
  protocol: {dogecoin_chain_id: 111_111, eth_chain_id: 31_337, l2_chain_id: 534_352, protocol_version: 2},
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('frontend dynamic deposit configuration', () => {
  let root: string
  let receipt: any
  const genesisHash = hex('66')
  const receiptFile = '.data/proof-materials-v1.json'
  const writeReceipt = () => fs.writeFileSync(path.join(root, receiptFile), JSON.stringify(receipt))
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-deposit-config-'))
    fs.mkdirSync(path.join(root, '.data'))
    const artifact = (name: string, text: string) => {
      const file = `.data/${name}`
      fs.writeFileSync(path.join(root, file), text)
      return {path: file, sha256: sha(text), sizeBytes: Buffer.byteLength(text)}
    }

    const ctx = JSON.stringify(context)
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), ctx)
    const identities = syntheticMockProofIdentities()
    receipt = {
      bridge: {
        artifacts: {
          appConfig: artifact('app.toml', '# fixture'), appExe: artifact('app.vmexe', 'fake executable'),
          l2RangeAppConfig: artifact('range.toml', '# fixture'), l2RangeAppExe: artifact('range.vmexe', 'fake range'),
          nativeManifest: artifact('bridge-artifact-manifest.json', JSON.stringify({genesis_state_hash: genesisHash})),
        },
        genesisSequencerOutpointIndex: 0, genesisStateHash: genesisHash, identity: identities.bridge,
        protocolContextPath: '.data/protocol_context.json', protocolContextSha256: sha(ctx),
      }, generatedAt: '2026-10-10T00:00:00Z',
      images: {topologyCompiler: {digest: `sha256:${'b'.repeat(64)}`, repository: 'example.invalid/compiler'}}, schema: 'scrollsdk/proof-materials/v1',
      schemaVersion: 1,
      software: {identities, identitySource: 'real_identity_probe'},
    }
    writeReceipt()
  })
  afterEach(() => {sinon.restore(); fs.rmSync(root, {force: true, recursive: true})})

  it('uses protocol identity and the bound protocol genesis hash, not the EVM state root', () => {
    const identity = readFrontendDepositIdentity(root, {l2ChainId: 534_352, required: true})!
    expect(identity).to.deep.equal({genesisStateHash: genesisHash, protocolId: `0x${rotationProtocolOpeningId(context)}`})
    expect(identity.genesisStateHash).not.eq(context.genesis.genesis_state_root)
    const values: any = {scrollConfig: 'REACT_APP_DOGE_BRIDGE_ADDRESS = "old-address"\nREACT_APP_MOAT_ADDRESS = "keep"\n'}
    reconcileFrontendConfig(values, frontendDepositEnv(identity))
    const parsed = toml.parse(values.scrollConfig)
    expect(parsed).not.to.have.property('REACT_APP_DOGE_BRIDGE_ADDRESS')
    expect(parsed.REACT_APP_MOAT_ADDRESS).eq('keep')
    expect(parsed.REACT_APP_DOGEOS_GENESIS_STATE_HASH).eq(genesisHash)
    const before = values.scrollConfig
    reconcileFrontendConfig(values, frontendDepositEnv(identity))
    expect(values.scrollConfig).eq(before)
  })

  it('clears stale identities before materials are available and refuses required final generation', () => {
    fs.unlinkSync(path.join(root, receiptFile))
    expect(readFrontendDepositIdentity(root)).to.be.undefined
    expect(() => readFrontendDepositIdentity(root, {required: true})).to.throw('requires prepared Bridge')
    expect(() => readFrontendDepositIdentity(root, {materialsReceipt: 'missing.json'})).to.throw('receipt is missing')
    const values: any = {scrollConfig: `REACT_APP_DOGEOS_PROTOCOL_ID = "${hex('aa')}"\n`}
    reconcileFrontendConfig(values, frontendDepositEnv())
    expect(toml.parse(values.scrollConfig).REACT_APP_DOGEOS_PROTOCOL_ID).eq('')
  })

  it('rejects changed context, artifacts, mismatched manifest hash, sidecar and L2 network', () => {
    expect(() => readFrontendDepositIdentity(root, {l2ChainId: 1})).to.throw('chain ID differs')
    expect(() => readFrontendDepositIdentity(root, {dogecoinChainId: 1})).to.throw('Dogecoin chain ID differs')
    const sidecar = path.join(root, '.data/protocol_context.protocol_id')
    fs.writeFileSync(sidecar, hex('aa'))
    expect(() => readFrontendDepositIdentity(root)).to.throw('sidecar differs')
    fs.unlinkSync(sidecar)
    receipt.bridge.genesisStateHash = hex('aa'); writeReceipt()
    expect(() => readFrontendDepositIdentity(root)).to.throw('differs from the Bridge manifest')
    receipt.bridge.genesisStateHash = genesisHash; writeReceipt()
    fs.appendFileSync(path.join(root, '.data/protocol_context.json'), '\n')
    expect(() => readFrontendDepositIdentity(root)).to.throw('context changed')
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), JSON.stringify(context))
    fs.appendFileSync(path.join(root, '.data/bridge-artifact-manifest.json'), ' ')
    expect(() => readFrontendDepositIdentity(root)).to.throw('content drift')
  })

  it('accepts a bound preparation snapshot only when it matches the active context', () => {
    const copy = '.data/prepared-protocol-context.json'
    fs.copyFileSync(path.join(root, '.data/protocol_context.json'), path.join(root, copy))
    receipt.bridge.protocolContextPath = copy
    writeReceipt()
    expect(readFrontendDepositIdentity(root)?.genesisStateHash).eq(genesisHash)
    fs.appendFileSync(path.join(root, '.data/protocol_context.json'), '\n')
    expect(() => readFrontendDepositIdentity(root)).to.throw('bound to a different protocol context')
  })

  it('normalizes old CLI ConfigMap payloads without creating two frontend ConfigMaps', () => {
    const values = mergeFrontendConfigDocuments(
      {scrollConfig: 'REACT_APP_MOAT_ADDRESS = "template"\n'},
      {configMaps: {'frontend-config': {data: {'frontend-config': 'REACT_APP_ROLLUP = Operator Chain\nREACT_APP_MOAT_ADDRESS = "deployed"\nREACT_APP_DOGE_BRIDGE_ADDRESS = old\n'}, enabled: true}}},
      {scrollConfig: 'REACT_APP_CHAIN_ID_L2 = "534352"\n'},
    )
    expect(values).not.to.have.property('configMaps')
    expect(toml.parse(values.scrollConfig as string)).to.deep.equal({REACT_APP_CHAIN_ID_L2: '534352', REACT_APP_MOAT_ADDRESS: 'deployed', REACT_APP_ROLLUP: 'Operator Chain'})
  })

  it('wires an internal upstream and preserves reviewed overrides without logging runtime values', () => {
    const values: any = {command: ['/bin/bash', '-cx', 'awk /app/conf/frontend-config']}
    reconcileFrontendProduction(values)
    expect(values.env.L1_INTERFACE_UPSTREAM).eq('l1-interface:9090')
    expect(values.command).to.deep.equal(FRONTEND_COMMAND)
    expect(values.command.join('\n')).not.to.contain('cat /usr/share')
    values.env.L1_INTERFACE_UPSTREAM = 'private-proxy.namespace.svc:9090'
    reconcileFrontendProduction(values)
    expect(values.env.L1_INTERFACE_UPSTREAM).eq('private-proxy.namespace.svc:9090')
    values.env.L1_INTERFACE_UPSTREAM = 'https://user:FAKE@example.invalid'
    expect(() => reconcileFrontendProduction(values)).to.throw('internal host:port')
  })

  it('runs the generated config loader with quoted values, spaces and blank disabled identities', () => {
    const file = path.join(root, 'frontend-config')
    fs.writeFileSync(file, toml.stringify({EMPTY: '', HASH: genesisHash, NAME: 'DogeOS Devnet'}))
    const command = FRONTEND_COMMAND[2].replace('/app/conf/frontend-config', file).replaceAll('/usr/share/nginx/html/.env', path.join(root, '.env')).replace('exec /usr/local/bin/entrypoint.sh', 'printf "%s|%s|%s" "$NAME" "$EMPTY" "$HASH"')
    expect(execFileSync('/bin/sh', ['-ec', command], {encoding: 'utf8'})).eq(`DogeOS Devnet||${genesisHash}`)
  })

  it('prep-charts writes the same identity for template and old generated payloads without network access', async () => {
    fs.mkdirSync(path.join(root, 'values'))
    const file = path.join(root, 'values/frontends-config.yaml')
    const oldCwd = process.cwd()
    const command: any = new PrepCharts([], {} as any)
    command.nonInteractive = true
    command.flags = {}
    command.proofIntent = {intent: {generation: 'real'}}
    command.configData = {general: {CHAIN_ID_L2: 534_352}, ingress: {FRONTEND_HOST: 'portal.example.invalid'}}
    command.dogeConfig = {network: 'testnet'}
    command.jsonCtx = {addWarning() {}, info() {}, logSuccess() {}}
    sinon.stub(command, 'log')
    try {
      process.chdir(root)
      for (const data of [{scrollConfig: 'REACT_APP_DOGE_BRIDGE_ADDRESS = "old"\n'}, {configMaps: {'frontend-config': {data: {'frontend-config': 'REACT_APP_DOGE_BRIDGE_ADDRESS = old\n'}}}}]) {
        fs.writeFileSync(file, yaml.dump(data))
        await command.processConfigYaml(path.join(root, 'values'))
        const values = yaml.load(fs.readFileSync(file, 'utf8')) as any
        expect(values).not.to.have.property('configMaps')
        const config = toml.parse(values.scrollConfig)
        expect(config.REACT_APP_DOGEOS_GENESIS_STATE_HASH).eq(genesisHash)
        expect(config).not.to.have.property('REACT_APP_DOGE_BRIDGE_ADDRESS')
      }
    } finally {process.chdir(oldCwd)}
  })
})
