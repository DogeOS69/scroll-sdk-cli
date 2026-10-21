import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import PrepCharts from '../../src/commands/setup/prep-charts.js'
import {GenerationTransaction} from '../../src/utils/generation-transaction.js'
import {AwaitingInput, writeJson} from '../../src/utils/preparation-io.js'
import {POLICY_RECEIPTS_INPUT, importPreparationPolicyReceipts} from '../../src/utils/preparation-policy-receipts.js'
import {policyReceiptFixture} from '../helpers/cubesigner-policy-receipts.js'

describe('late preparation policy receipts', () => {
  let root: string
  let configPath: string
  let refs: ReturnType<typeof policyReceiptFixture>['selection']['policyReceipts']
  const read = () => toml.parse(fs.readFileSync(configPath, 'utf8'))
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-policy-receipts-'))
    refs = policyReceiptFixture(root).selection.policyReceipts
    fs.mkdirSync(path.join(root, '.data'))
    fs.copyFileSync(path.join(root, 'context.json'), path.join(root, '.data/protocol_context.json'))
    configPath = path.join(root, '.data/doge-config.toml')
    fs.writeFileSync(configPath, toml.stringify({cubesigner: {
      mode: 'production_verifier_key_policy', roles: [{keys: [{key_id: 'key-1', material_id: 'material-1'}], role_id: 'role-1'}],
    }, network: 'testnet'}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('waits with a populated context reference and resumes without changing intent', () => {
    const before = fs.readFileSync(configPath, 'utf8')
    expect(() => importPreparationPolicyReceipts(root)).to.throw(AwaitingInput)
    const input = path.join(root, POLICY_RECEIPTS_INPUT)
    const template = JSON.parse(fs.readFileSync(input, 'utf8'))
    expect(template.protocolContext).deep.eq({...refs.protocolContext, path: '.data/protocol_context.json'})
    expect(fs.readFileSync(configPath, 'utf8')).eq(before)
    expect(() => importPreparationPolicyReceipts(root)).to.throw(AwaitingInput)
    writeJson(input, refs)
    importPreparationPolicyReceipts(root)
    expect(read().cubesigner).deep.eq({...toml.parse(before).cubesigner as toml.JsonMap, policyReceipts: refs})
    const imported = fs.readFileSync(configPath, 'utf8')
    writeJson(input, {organization: 'different-org'})
    importPreparationPolicyReceipts(root)
    expect(fs.readFileSync(configPath, 'utf8')).eq(imported)
  })

  for (const fault of ['key', 'organization', 'context', 'wasm', 'digest', 'live-evidence', 'symlink']) {
    it(`rejects ${fault} mismatch without writing managed configuration`, () => {
      if (fault === 'key') fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('key-1', 'key-2'))
      if (fault === 'organization') refs.organization = 'other-org'
      if (fault === 'context') fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{}')
      if (fault === 'wasm') fs.appendFileSync(path.join(root, 'policy.wasm'), 'changed')
      if (fault === 'digest') refs.attachment.sha256 = `sha256:${'0'.repeat(64)}`
      if (fault === 'live-evidence') fs.rmSync(path.join(root, 'live.json'))
      if (fault === 'symlink') {
        fs.renameSync(path.join(root, 'release.json'), path.join(root, 'actual-release.json'))
        fs.symlinkSync('actual-release.json', path.join(root, 'release.json'))
      }

      const before = fs.readFileSync(configPath, 'utf8')
      writeJson(path.join(root, POLICY_RECEIPTS_INPUT), refs)
      expect(() => importPreparationPolicyReceipts(root)).to.throw()
      expect(fs.readFileSync(configPath, 'utf8')).eq(before)
    })
  }

  it('does not introduce a governance wait for transport-only, legacy or absent CubeSigner', () => {
    for (const cubesigner of [undefined, {}, {mode: 'transport_only'}] as Array<toml.JsonMap | undefined>) {
      fs.writeFileSync(configPath, toml.stringify({network: 'testnet', ...(cubesigner ? {cubesigner} : {})}))
      importPreparationPolicyReceipts(root)
      expect(fs.existsSync(path.join(root, POLICY_RECEIPTS_INPUT))).false
    }
  })

  it('imports verified production evidence on mainnet as well', () => {
    const config = read()
    config.network = 'mainnet'
    fs.writeFileSync(configPath, toml.stringify(config))
    writeJson(path.join(root, POLICY_RECEIPTS_INPUT), refs)
    importPreparationPolicyReceipts(root)
    expect((read().cubesigner as toml.JsonMap).policyReceipts).deep.eq(refs)
  })

  it('renders imported default-path evidence across staging and still rejects changed inputs', async () => {
    const inputs = path.join(root, '.scrollsdk/inputs/cubesigner-policy')
    fs.mkdirSync(inputs, {recursive: true})
    refs = policyReceiptFixture(inputs).selection.policyReceipts
    for (const ref of [refs.release, refs.attachment, refs.liveEvidence, refs.protocolContext]) {
      ref.path = `.scrollsdk/inputs/cubesigner-policy/${ref.path}`
    }

    writeJson(path.join(root, POLICY_RECEIPTS_INPUT), refs)
    importPreparationPolicyReceipts(root)
    fs.writeFileSync(path.join(root, '.scrollsdkignore'), '.scrollsdk/\n.data/contracts-build/\n')
    fs.mkdirSync(path.join(root, 'values'))
    const name = 'values/cubesigner-signer-production.yaml'
    fs.writeFileSync(path.join(root, name), yaml.dump({env: []}))
    const before = fs.readFileSync(configPath, 'utf8')
    const transaction = GenerationTransaction.begin(root)
    const cwd = process.cwd()
    try {
      expect(fs.existsSync(path.join(transaction.stagingRoot, refs.release.path))).false
      process.chdir(transaction.stagingRoot)
      // Execute the actual chart reconciliation, including both policy reads
      // and live-evidence ConfigMap projection, with the real generation clone.
      const command = Object.create(PrepCharts.prototype)
      Object.assign(command, {
        configMapping: {}, dogeConfig: read(), error(message: string) {throw new Error(message)}, flags: {'proof-preparation': true},
        getConfigValue() {},
        jsonCtx: {addWarning() {}, info() {}, logSuccess() {}}, jsonMode: true,
        log() {}, nonInteractive: true, policyInputRoot: root,
      })
      await command.processProductionYaml(path.join(transaction.stagingRoot, 'values'))
      const file = path.join(transaction.stagingRoot, name)
      const content = fs.readFileSync(file, 'utf8')
      const values = yaml.load(content) as {configMaps: Record<string, {data: Record<string, string>}>; env: Array<{name: string; value: string}>}
      expect(values.env.find(item => item.name === 'DOGEOS_CUBESIGNER_SIGNER_PRODUCTION_POLICY_IDENTIFIER')?.value).eq('dogeos_bridge/v2')
      expect(JSON.parse(values.configMaps['proof-policy-live-evidence'].data['live-evidence.json']).result).eq('passed')
      fs.appendFileSync(path.join(inputs, 'policy.wasm'), 'changed')
      let error: unknown
      try {await command.processProductionYaml(path.join(transaction.stagingRoot, 'values'))} catch (error_) {error = error_}
      expect(String(error), error instanceof Error ? error.stack : String(error)).include('digest mismatch')
      expect(fs.readFileSync(file, 'utf8')).eq(content)
      expect(fs.readFileSync(configPath, 'utf8')).eq(before)
    } finally {
      process.chdir(cwd)
      transaction.rollback()
    }
  })
})
