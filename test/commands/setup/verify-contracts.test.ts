/* eslint-disable @typescript-eslint/no-explicit-any -- Docker and private legacy runner test doubles. */
import {expect} from 'chai'
import Docker from 'dockerode'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import ContractsVerification from '../../../src/commands/setup/verify-contracts.js'
import {PREINSTALLS_CHECK_IMAGE} from '../../../src/utils/preinstalls-image-check.js'
import {preparePreinstallsVerification, runPreinstallsVerification} from '../../../src/utils/preinstalls-source-verification.js'

describe('setup verify-contracts preinstalls source verification', () => {
  let directory: string
  let pull: sinon.SinonStub
  let create: sinon.SinonStub
  let legacy: sinon.SinonStub
  let container: any
  const write = (url = 'https://explorer.example', type = 'blockscout', key = '') => {
    fs.writeFileSync(path.join(directory, 'config.toml'), `[contracts.verification]\nVERIFIER_TYPE_L2 = ${JSON.stringify(type)}\nEXPLORER_URI_L2 = ${JSON.stringify(url)}\nEXPLORER_API_KEY_L2 = ${JSON.stringify(key)}\n`)
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-contracts-test-'))
    write()
    container = {
      logs: sinon.stub().resolves(Buffer.from('verification started\n')),
      remove: sinon.stub().resolves(),
      start: sinon.stub().resolves(),
      wait: sinon.stub().resolves({StatusCode: 0}),
    }
    pull = sinon.stub(Docker.prototype, 'pull').resolves({} as any)
    create = sinon.stub(Docker.prototype, 'createContainer').resolves(container)
    sinon.stub(Object.getPrototypeOf(new Docker().modem), 'followProgress').callsFake((_stream: any, done: any) => done(null, []))
    legacy = sinon.stub(ContractsVerification.prototype as any, 'runDockerCommand').resolves()
  })

  afterEach(() => {
    sinon.restore()
    fs.rmSync(directory, {force: true, recursive: true})
  })

  it('preserves the no-flag legacy path without requiring preinstalls config', async () => {
    fs.rmSync(path.join(directory, 'config.toml'))
    await ContractsVerification.run(['--config-dir', directory])
    expect(legacy.calledOnce).to.equal(true)
    expect(legacy.firstCall.args[1]).to.equal(directory)
    expect(pull.called).to.equal(false)
  })

  for (const [url, expected] of [
    ['https://explorer.example', 'https://explorer.example/api'],
    ['https://explorer.example/', 'https://explorer.example/api'],
    ['https://explorer.example/api', 'https://explorer.example/api'],
    ['https://explorer.example/api/', 'https://explorer.example/api'],
    ['https://explorer.example/proxy/chain/', 'https://explorer.example/proxy/chain/api'],
    ['https://explorer.example/proxy/chain/api/', 'https://explorer.example/proxy/chain/api'],
  ]) {
    it(`normalizes ${url} to the Blockscout API root`, () => {
      write(url)
      expect(preparePreinstallsVerification(directory).apiUrl).to.equal(expected)
    })
  }

  it('runs both verifiers in order with explicit entrypoint and one URL argument', async () => {
    write('https://explorer.example/proxy/with space/$(printf injected)\'"&/api/')
    await ContractsVerification.run(['--preinstalls', '--config-dir', directory])
    expect(legacy.calledOnce).to.equal(true)
    expect(legacy.calledBefore(create)).to.equal(true)
    expect(pull.firstCall.args).to.deep.equal([PREINSTALLS_CHECK_IMAGE])
    const options = create.firstCall.args[0]
    expect(options.Entrypoint).to.deep.equal(['bash', '/app/lib/verify-blockscout.sh'])
    expect(options.Cmd).to.deep.equal([preparePreinstallsVerification(directory).apiUrl])
    expect(options.Cmd[0]).to.include('$(printf%20injected)')
    expect(options).not.to.have.property('Env')
    expect(options.HostConfig).to.deep.equal({NetworkMode: 'host'})
    expect(container.start.calledOnce).to.equal(true)
    expect(container.remove.firstCall.args).to.deep.equal([{force: true}])
  })

  it('only runs preinstalls with the independently selected image', async () => {
    await ContractsVerification.run(['--preinstalls-only', '--config-dir', directory, '--preinstalls-image', 'example.invalid/preinstalls:fixture'])
    expect(legacy.called).to.equal(false)
    expect(pull.firstCall.args).to.deep.equal(['example.invalid/preinstalls:fixture'])
    expect(create.firstCall.args[0].Image).to.equal('example.invalid/preinstalls:fixture')
  })

  it('does not start preinstalls when the preceding contracts verifier fails', async () => {
    legacy.rejects(new Error('contracts verifier failed'))
    let failure: unknown
    try { await ContractsVerification.run(['--preinstalls', '--config-dir', directory]) } catch (error) { failure = error }
    expect(String(failure)).to.include('contracts verifier failed')
    expect(pull.called).to.equal(false)
    expect(create.called).to.equal(false)
  })

  for (const args of [
    ['--preinstalls', '--preinstalls-only'],
    ['--preinstalls-image', 'example.invalid/preinstalls:fixture'],
    ['--preinstalls-only', '--image-tag', 'verify-fixture'],
  ]) {
    it(`rejects conflicting or unused flags: ${args.join(' ')}`, async () => {
      let failure: unknown
      try { await ContractsVerification.run([...args, '--config-dir', directory]) } catch (error) { failure = error }
      expect(failure).to.be.instanceOf(Error)
      expect(legacy.called).to.equal(false)
      expect(pull.called).to.equal(false)
    })
  }

  for (const [url, type, key] of [
    ['https://explorer.example/api', 'etherscan', ''],
    ['https://explorer.example/api', 'blockscout', 'FAKE_KEY_NOT_A_CREDENTIAL'],
    ['https://user:FAKE_PASSWORD@explorer.example/api', 'blockscout', ''],
    ['https://explorer.example/api?apikey=FAKE_KEY', 'blockscout', ''],
    ['https://explorer.example/#fragment', 'blockscout', ''],
    ['file:///tmp/fixture', 'blockscout', ''],
    ['https://explorer.example/api/v2', 'blockscout', ''],
    ['$ENV:EXPLORER_URL', 'blockscout', ''],
  ]) {
    it(`rejects unsupported endpoint configuration before either verifier runs (${type}, ${url})`, async () => {
      write(url, type, key)
      let failure: unknown
      try { await ContractsVerification.run(['--preinstalls', '--config-dir', directory]) } catch (error) { failure = error }
      expect(failure).to.be.instanceOf(Error)
      expect(String(failure)).not.to.include('FAKE_')
      expect(legacy.called).to.equal(false)
      expect(pull.called).to.equal(false)
    })
  }

  it('sanitizes malformed TOML errors before Docker runs', async () => {
    fs.writeFileSync(path.join(directory, 'config.toml'), 'private_key = "FAKE_SECRET_WITHOUT_CLOSING_QUOTE')
    let failure: unknown
    try { await ContractsVerification.run(['--preinstalls', '--config-dir', directory]) } catch (error) { failure = error }
    expect(String(failure)).to.include('Cannot read or parse config.toml')
    expect(String(failure)).not.to.include('FAKE_SECRET')
    expect(legacy.called).to.equal(false)
    expect(pull.called).to.equal(false)
  })

  it('fails missing config preflight before either verifier starts', async () => {
    fs.rmSync(path.join(directory, 'config.toml'))
    let failure: unknown
    try { await ContractsVerification.run(['--preinstalls', '--config-dir', directory]) } catch (error) { failure = error }
    expect(String(failure)).to.include('Cannot read or parse config.toml')
    expect(legacy.called).to.equal(false)
    expect(pull.called).to.equal(false)
  })

  it('returns failure and cleans up after a nonzero verifier exit', async () => {
    container.wait.resolves({StatusCode: 17})
    let failure: unknown
    try { await runPreinstallsVerification(preparePreinstallsVerification(directory), () => {}) } catch (error) { failure = error }
    expect(String(failure)).to.include('status code 17')
    expect(container.remove.calledOnce).to.equal(true)
  })

  it('makes the command fail on verifier errors and hides Docker request details', async () => {
    container.start.rejects(new Error('FAKE_PRIVATE_DOCKER_REQUEST'))
    let failure: unknown
    try { await ContractsVerification.run(['--preinstalls-only', '--config-dir', directory]) } catch (error) { failure = error }
    expect(String(failure)).to.include('Preinstalls verification failed')
    expect(String(failure)).not.to.include('FAKE_PRIVATE')
    expect(container.remove.calledOnce).to.equal(true)
  })

  it('preserves the verifier exit code at the command boundary', async () => {
    container.wait.resolves({StatusCode: 17})
    let failure: any
    try { await ContractsVerification.run(['--preinstalls-only', '--config-dir', directory]) } catch (error) { failure = error }
    expect(failure.oclif.exit).to.equal(17)
    expect(failure.message).to.include('status code 17')
    expect(container.remove.calledOnce).to.equal(true)
  })

  it('reports asynchronous submissions without claiming final explorer verification', async () => {
    const messages: string[] = []
    await runPreinstallsVerification(preparePreinstallsVerification(directory), message => messages.push(message))
    expect(messages.join('\n')).to.include('Check Blockscout for final verification results')
  })
})
