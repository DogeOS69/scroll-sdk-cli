/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated Docker test double. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sinon from 'sinon'

import {checkRethStartup} from '../../src/utils/reth-startup-check.js'

describe('isolated Reth startup canary', () => {
  let root: string
  let container: any
  let docker: any
  let mock: any
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'reth-canary-'))
    fs.writeFileSync(path.join(root, 'genesis.json'), '{"config":{"chainId":31337}}')
    container = {inspect: sinon.stub().resolves({Image: 'sha256:fixture', State: {Running: true}}), logs: sinon.stub().resolves(Buffer.from('HTTP server started')), remove: sinon.stub().resolves(), start: sinon.stub().resolves()}
    mock = {id: 'fixture-network', logs: async () => Buffer.from('fixture-ready'), remove: sinon.stub().resolves(), async start() {}}
    docker = {createContainer: sinon.stub().resolves(container), getImage: () => ({inspect: async () => ({})}), modem: {followProgress: (_stream: unknown, callback: () => void) => callback()}, pull: sinon.stub().resolves({})}
    docker.createContainer.onFirstCall().resolves(mock)
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('checks startup against public genesis with no P2P network or persistent operator data', async () => {
    expect(await checkRethStartup('fixture:tag', path.join(root, 'genesis.json'), docker)).deep.eq({imageId: 'sha256:fixture', status: 'started'})
    expect(docker.createContainer.firstCall.args[0].HostConfig.NetworkMode).eq('none')
    expect(docker.createContainer.secondCall.args[0].HostConfig.NetworkMode).eq('container:fixture-network')
    const mount = docker.createContainer.secondCall.args[0].HostConfig.Binds[0]
    expect(mount).include('scrollsdk-reth-startup-').and.match(/genesis.json:\/probe-genesis.json:ro$/)
    expect(fs.existsSync(mount.split(':')[0])).false
    expect(container.remove.calledOnceWithExactly({force: true, v: true})).true
  })
  it('does not pass an image that opens HTTP and then crashes during chain initialization', async () => {
    container.inspect.onFirstCall().resolves({Image: 'sha256:fixture', State: {Running: true}})
    container.inspect.onSecondCall().resolves({State: {Running: false}})
    let error: unknown
    try {await checkRethStartup('fixture:tag', path.join(root, 'genesis.json'), docker)} catch (error_) {error = error_}
    expect(String(error)).include('exited before')
    expect(container.remove.calledOnce).true
  })

  it('fails on a chain startup crash and removes the temporary container', async () => {
    container.inspect.resolves({State: {Running: false}})
    let error: unknown
    try {await checkRethStartup('fixture:tag', path.join(root, 'genesis.json'), docker)} catch (error_) {error = error_}
    expect(String(error)).include('exited before')
    expect(container.remove.calledOnce).true
  })
})
