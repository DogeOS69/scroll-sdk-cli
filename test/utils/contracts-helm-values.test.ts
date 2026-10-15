import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {PreparationPlan, PreparationStep} from '../../src/utils/preparation-plan.js'

import SetupGenL2Artifacts from '../../src/commands/setup/gen-l2-artifacts.js'
import {writeContractsHelmValues} from '../../src/utils/contracts-helm-values.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'

describe('contract Helm values from existing artifacts', () => {
  let root: string
  const publicConfig = '[general]\nCHAIN_ID_L2 = 221122\n'
  const contracts = 'L2_MOAT_PROXY_ADDR = "0x0000000000000000000000000000000000000001"\n'
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-helm-'))
    fs.writeFileSync(path.join(root, 'config.public.toml'), publicConfig)
    fs.writeFileSync(path.join(root, 'config-contracts.toml'), contracts)
    fs.writeFileSync(path.join(root, 'config.toml'), '[accounts]\nDEPLOYER_PRIVATE_KEY = "NONFUNCTIONAL_PRIVATE_INPUT"\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function check(directory = path.join(root, 'values')): void {
    for (const [filename, key, expected] of [
      ['scroll-common-config.yaml', 'scrollConfig', publicConfig],
      ['scroll-common-config-contracts.yaml', 'scrollConfigContracts', contracts],
    ]) {
      const file = path.join(directory, filename)
      expect(yaml.load(fs.readFileSync(file, 'utf8'))).to.deep.equal({[key]: expected})
      expect(fs.statSync(file).mode % 0o1000).to.equal(0o600)
    }
  }

  it('writes exact public TOML wrappers and safely replaces stale outputs on rerun', () => {
    writeContractsHelmValues(root)
    check()
    fs.writeFileSync(path.join(root, 'values/scroll-common-config.yaml'), 'stale: true\n')
    writeContractsHelmValues(root)
    check()
    expect(fs.readFileSync(path.join(root, 'config.toml'), 'utf8')).to.include('NONFUNCTIONAL_PRIVATE_INPUT')
  })

  it('validates both sources before replacing either existing wrapper and redacts parse errors', () => {
    writeContractsHelmValues(root)
    const file = path.join(root, 'config-contracts.toml')
    fs.writeFileSync(file, 'invalid = "NONFUNCTIONAL_PRIVATE_INPUT')
    expect(() => writeContractsHelmValues(root)).to.throw('Invalid config-contracts.toml (contents omitted)')
    check()
    fs.unlinkSync(file)
    expect(() => writeContractsHelmValues(root)).to.throw('Missing config-contracts.toml')
    check()
    fs.unlinkSync(path.join(root, 'config.public.toml'))
    expect(() => writeContractsHelmValues(root)).to.throw('Missing config.public.toml')
    check()
  })

  it('uses the same wrapper writer for the legacy generator with a custom values directory', async () => {
    const previous = process.cwd()
    try {
      process.chdir(root)
      // Exercise the real file-packaging method without running the genesis image.
      const command = Object.create(SetupGenL2Artifacts.prototype)
      command.jsonCtx = {log() {}}
      await command.processYamlFiles('custom-values')
      check(path.join(root, 'custom-values'))
    } finally {process.chdir(previous)}
  })

  it('packages the final render inputs without invoking genesis and propagates chart failures', async () => {
    const calls: string[][] = []
    const runner = new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)})
    const spec = {identities: {bootnodes: []}, preparation: {bridge: {image: 'example.invalid/bridge:offline', mode: 'helper'}, proofMaterials: {mode: 'existing'}}} as unknown as DeploymentSpec
    const step: PreparationStep = {effect: 'local', id: 'render-final', retry: 'safe', stage: 'render', title: 'Render'}
    // Minimal public fixture: render does not need bridge keys or a genesis producer.
    await runner.run(step, spec, root, {} as PreparationPlan)
    expect(calls.map(args => args[0])).to.deep.equal(['prep-charts'])
    expect(calls[0]).not.to.include('--proof-preparation')
    check()
    fs.rmSync(path.join(root, 'values'), {recursive: true})
    const failing = new CommandPreparationRunner(async () => {throw new Error('chart failure')})
    let error: unknown
    try {await failing.run(step, spec, root, {} as PreparationPlan)} catch (error_) {error = error_}
    expect(String(error)).to.include('chart failure')
    expect(fs.existsSync(path.join(root, 'values'))).to.equal(false)
  })
})
