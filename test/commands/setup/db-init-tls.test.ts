/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise private command connections against a local PostgreSQL handshake. */
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {once} from 'node:events'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'

import SetupDbInit from '../../../src/commands/setup/db-init.js'

async function failure(promise: Promise<unknown>): Promise<any> {
  try {await promise} catch (error) {return error}
  throw new Error('Connection unexpectedly succeeded')
}

describe('setup db-init TLS', () => {
  let directory: string
  let command: any
  const servers: net.Server[] = []
  const sockets = new Set<net.Socket>()

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-init-tls-'))
    // Disposable keys stay outside the checkout and are removed after the suite.
    for (const [name, san] of [['valid', 'DNS:localhost,IP:127.0.0.1'], ['wrong-host', 'DNS:other.example.invalid']]) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=db-init-test', '-addext', `subjectAltName=${san}`,
        '-keyout', path.join(directory, `${name}.key`), '-out', path.join(directory, `${name}.pem`)], {stdio: 'ignore'})
    }
  })
  beforeEach(() => {command = Object.create(SetupDbInit.prototype)})
  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {server.close(() => resolve())})))
  })
  after(() => fs.rmSync(directory, {force: true, recursive: true}))

  const ca = (name = 'valid') => path.join(directory, `${name}.pem`)
  const configure = (admin = {}, flags = {}) => command.configureConnectionTls({db: {admin}}, flags)
  const connect = (port: number) => command.createConnection('127.0.0.1', String(port), 'test-user', 'FAKE_TEST_PASSWORD', 'postgres')

  async function server(mode: 'disable' | 'reject' | 'tls', name = 'valid') {
    let connections = 0
    let startups = 0
    const remember = (socket: net.Socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
    }

    const ready = (socket: net.Socket) => {
      startups++
      // AuthenticationOk + ReadyForQuery: enough for pg.Client.connect().
      socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'))
      socket.on('data', () => socket.end())
    }

    const instance = net.createServer(socket => {
      connections++
      remember(socket)
      socket.once('data', data => {
        if (mode === 'disable') {ready(socket); return}
        if (data.toString('hex') !== '0000000804d2162f') {socket.destroy(); return}
        if (mode === 'reject') {socket.end('N'); return}
        socket.write('S')
        const secure = new tls.TLSSocket(socket, {isServer: true, secureContext: tls.createSecureContext({
          cert: fs.readFileSync(ca(name)), key: fs.readFileSync(path.join(directory, `${name}.key`)),
        })})
        remember(secure)
        secure.once('data', () => ready(secure))
      })
    })
    servers.push(instance)
    instance.listen(0, '127.0.0.1')
    await once(instance, 'listening')
    return {connections: () => connections, port: (instance.address() as net.AddressInfo).port, startups: () => startups}
  }

  it('connects with a trusted certificate matching the requested IP', async () => {
    configure({SSL_CA: ca()})
    const endpoint = await server('tls')
    const client = await connect(endpoint.port)
    expect(endpoint.startups()).to.equal(1)
    await client.end()
  })

  it('rejects an untrusted certificate by default, without sending a startup message', async () => {
    configure()
    const endpoint = await server('tls')
    const error = await failure(connect(endpoint.port))
    expect(error.code).to.equal('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(endpoint.connections()).to.equal(1)
    expect(endpoint.startups()).to.equal(0)
  })

  it('rejects a trusted certificate for the wrong host, including IP connections', async () => {
    configure({SSL_CA: ca('wrong-host')})
    const endpoint = await server('tls', 'wrong-host')
    const error = await failure(connect(endpoint.port))
    expect(error.code).to.equal('ERR_TLS_CERT_ALTNAME_INVALID')
    expect(endpoint.startups()).to.equal(0)
  })

  it('does not retry in plaintext when the server refuses TLS', async () => {
    configure()
    const endpoint = await server('reject')
    expect((await failure(connect(endpoint.port))).message).to.include('does not support SSL')
    expect(endpoint.connections()).to.equal(1)
    expect(endpoint.startups()).to.equal(0)
  })

  it('allows plaintext only when explicitly selected', async () => {
    configure({SSL_MODE: 'disable'})
    const endpoint = await server('disable')
    const client = await connect(endpoint.port)
    expect(client.ssl).to.equal(false)
    await client.end()
  })

  it('lets CLI flags override config and reads a CA path from an environment reference', async () => {
    const previous = process.env.SCROLLSDK_TEST_DB_CA
    try {
      process.env.SCROLLSDK_TEST_DB_CA = ca()
      configure({SSL_CA: '$ENV:SCROLLSDK_TEST_DB_CA', SSL_MODE: 'disable'}, {'ssl-mode': 'verify-full'})
      const endpoint = await server('tls')
      const client = await connect(endpoint.port)
      await client.end()
      configure({SSL_CA: '/nonexistent'}, {'ssl-ca': ca()})
    } finally {
      if (previous === undefined) delete process.env.SCROLLSDK_TEST_DB_CA
      else process.env.SCROLLSDK_TEST_DB_CA = previous
    }
  })

  it('rejects unsupported modes, conflicting CA settings and unreadable CA files', () => {
    for (const mode of ['require', 'prefer', '', false]) expect(() => configure({SSL_MODE: mode})).to.throw('SSL_MODE')
    expect(() => configure({SSL_CA: ca(), SSL_MODE: 'disable'})).to.throw('cannot be used')
    expect(() => configure({SSL_CA: '/nonexistent'})).to.throw('Cannot read administrator SSL_CA')
    expect(() => configure({SSL_CA: ''})).to.throw('SSL_CA')
  })
})
