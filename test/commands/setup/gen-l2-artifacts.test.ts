import {expect} from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import sinon from 'sinon'

import SetupGenL2Artifacts, {resolveGenesisImageTag} from '../../../src/commands/setup/gen-l2-artifacts.js'
import {CONTRACTS_DOCKER_DEFAULT_TAG, DOCKER_TAGS_URL} from '../../../src/constants/docker.js'
import {CliExitError, JsonOutputContext} from '../../../src/utils/json-output.js'

describe('gen-l2-artifacts explicit image selection', () => {
  afterEach(() => sinon.restore())

  it('uses the default only when no tag was supplied', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch')
    expect(await resolveGenesisImageTag()).to.equal(`gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`)
    expect(fetchStub.called).to.equal(false)
  })

  it('checks the exact release without depending on a paginated tag listing', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', {status: 200}))
    for (const supplied of ['v0.3.0-beta.3e', 'gen-configs-v0.3.0-beta.3e']) {
      expect(await resolveGenesisImageTag(supplied)).to.equal('gen-configs-v0.3.0-beta.3e')
    }

    expect(fetchStub.alwaysCalledWithExactly(`${DOCKER_TAGS_URL}/gen-configs-v0.3.0-beta.3e`)).to.equal(true)
    expect(await resolveGenesisImageTag('0.3.0')).to.equal('gen-configs-v0.3.0')
  })

  for (const status of [404, 429, 500]) {
    it(`rejects HTTP ${status} without silently substituting an older image`, async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', {status}))
      let error: unknown
      try {
        await resolveGenesisImageTag('v0.3.0-beta.3e')
      } catch (error_) {
        error = error_
      }

      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.include(`HTTP ${status}`)
      expect((error as Error).message).to.include('refusing to substitute')
      expect(fetchStub.calledOnce).to.equal(true)
    })
  }
})

function prepareCommand(nonInteractive = true) {
  const command = Object.create(SetupGenL2Artifacts.prototype)
  command.parse = async () => ({flags: {
    'configs-dir': 'values',
    'l1-plonk-verifier-addr': 'obsolete-input',
    'non-interactive': nonInteractive,
    'skip-l1-plonk-verifier-update': true,
  }})
  // Isolate the other prompts and external effects, keeping preflight real.
  for (const method of ['updateDeploymentSalt', 'updateL1FeeVaultAddr',
    'updateL2BridgeFeeRecipientAddr', 'updateBaseFeePerGas', 'processYamlFiles']) {
    sinon.stub(command, method).resolves()
  }

  for (const method of ['info', 'logSuccess', 'addWarning'] as const) {
    sinon.stub(JsonOutputContext.prototype, method)
  }

  const docker = sinon.stub(command, 'runDockerCommand').resolves()
  return {command, docker}
}

describe('gen-l2-artifacts without legacy deployment inputs', () => {
  let originalCwd: string
  let tempDir: string
  const runtimeAddress = '0x62154f72A4381dF73904667F20834aeD34e97dcB'

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-l2-artifacts-'))
    process.chdir(tempDir)
  })

  afterEach(() => {
    sinon.restore()
    process.chdir(originalCwd)
    fs.rmSync(tempDir, {force: true, recursive: true})
  })


  for (const scenario of [
    {config: '', doge: undefined, name: 'no sequencer or doge-config'},
    {config: '', doge: '[sequencerReth]\ninstances = []\n', name: 'Reth instances not yet configured'},
    {config: '', doge: `[[sequencerReth.instances]]\nindex = 0\n[sequencerReth.instances.signer]\naddress = "${runtimeAddress}"\n`, name: 'a Reth signer without a legacy address'},
    {config: '[sequencer]\nL2GETH_SIGNER_ADDRESS = "unused"\n', doge: undefined, name: 'an unused malformed legacy address'},
  ]) {
    it(`reaches generation with ${scenario.name} without synchronizing a signer`, async () => {
      fs.writeFileSync('config.toml', scenario.config)
      if (scenario.doge !== undefined) {
        fs.mkdirSync('.data')
        fs.writeFileSync('.data/doge-config.toml', scenario.doge)
      }

      const {command, docker} = prepareCommand()
      await command.run()
      expect(docker.calledOnceWithExactly(`gen-configs-${CONTRACTS_DOCKER_DEFAULT_TAG}`)).to.equal(true)
      expect(fs.readFileSync('config.toml', 'utf8')).to.equal(scenario.config)
      expect(fs.existsSync('config.public.toml')).to.equal(false)
      if (scenario.doge !== undefined) {
        expect(fs.readFileSync('.data/doge-config.toml', 'utf8')).to.equal(scenario.doge)
      }
    })
  }

  it('does not prompt for or write a verifier address in interactive mode', async () => {
    fs.writeFileSync('config.toml', '')
    const {command, docker} = prepareCommand(false)
    await command.run()
    expect(docker.calledOnce).to.equal(true)
    expect(fs.readFileSync('config.toml', 'utf8')).to.equal('')
  })

  it('still rejects a missing config before starting Docker', async () => {
    const {command, docker} = prepareCommand()
    sinon.stub(command, 'resolveConfigEnvRefsInPlace')
    sinon.stub(command, 'validateContractsPlaceholder')
    sinon.stub(process.stderr, 'write').returns(true)
    let error: unknown
    try {
      await command.run()
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(CliExitError)
    expect((error as CliExitError).code).to.equal('E602_CONFIG_NOT_FOUND')
    expect(docker.called).to.equal(false)
  })

  it('retains the independent legacy contracts placeholder validation', async () => {
    fs.writeFileSync('config.toml', '[contracts]\nLEGACY_COMMIT_SENDER_PLACEHOLDER = true\n')
    fs.mkdirSync('.data')
    fs.writeFileSync('.data/doge-config.toml', 'network = "mainnet"\n')
    const {command, docker} = prepareCommand()
    sinon.stub(process.stderr, 'write').returns(true)
    let error: unknown
    try {
      await command.run()
    } catch (error_) {
      error = error_
    }

    expect(error).to.be.instanceOf(CliExitError)
    expect((error as Error).message).to.include('Failed to validate contracts placeholder')
    expect((error as Error).message).to.include('restricted')
    expect(docker.called).to.equal(false)
  })
})
