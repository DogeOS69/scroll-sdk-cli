import * as toml from '@iarna/toml'
import {expect} from 'chai'
import {ethers} from 'ethers'
import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import {Server, createServer} from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'

import {contracts} from '../../../src/data/contracts.js'
import {preinstalledContracts} from '../../../src/data/preinstalled-contracts.js'

const execFileAsync = promisify(execFile)
const cli = path.resolve('bin/run.js')
const owner = '0x0000000000000000000000000000000000000001'
const addresses = Object.fromEntries(contracts.filter(contract => !contract.address).map((contract, index) => [contract.name, `0x${(index + 100).toString(16).padStart(40, '0')}`]))
const genesisAddresses = {
  BLOCK_HASH_HISTORY_ADDR: '0x0000f90827f1c53a10cb7a02335b175320002935',
  L2_NATIVE_DOGE_TOKEN_ADDR: '0x530000000000000000000000000000000000d09e',
}
const fixedAddress = (name: string) => preinstalledContracts.find(contract => contract.name === name)!.address!.toLowerCase()
const word = (value: bigint | string) => ethers.zeroPadValue(typeof value === 'bigint' ? ethers.toBeHex(value) : value, 32)
type RpcCall = {id: number} & (
  {method: 'eth_call'; params: [{data: string; to: string}]} |
  {method: 'eth_chainId' | 'eth_getCode' | 'eth_getStorageAt'; params: string[]}
)

describe('test contracts (L2 and preinstalls)', () => {
  let dir: string
  let server: Server
  let rpcUrl: string
  let calls: RpcCall[]
  let absent: Set<string>
  let storage: Map<string, bigint>
  let getterResults: Map<string, null | string>
  let dockerExitCode: number
  let dockerOutput: string
  let dockerPath: string

  const run = (flags: string[] = []) => execFileAsync(process.execPath, [cli, 'test', 'contracts', ...flags], {
    cwd: dir,
    env: {...process.env, MOCK_DOCKER_EXIT: String(dockerExitCode), MOCK_DOCKER_OUTPUT: dockerOutput, PATH: dockerPath},
    timeout: 30_000,
  })
  const expectFailure = async () => {
    try {
      await run()
    } catch (error) {
      const failure = error as {code: number; stderr: string; stdout: string}
      expect(failure.code).to.equal(1)
      expect(failure.stdout).not.to.include('All required L2 contract and preinstall checks passed.')
      return failure.stdout + failure.stderr
    }

    throw new Error('Expected a nonzero exit status')
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-l2-contracts-'))
    dockerExitCode = 0
    dockerOutput = '[ok] image runtime codehash verification'
    dockerPath = path.join(dir, 'bin')
    fs.mkdirSync(dockerPath)
    fs.writeFileSync(path.join(dockerPath, 'docker'), `#!${process.execPath}
      const fs = require('node:fs');
      fs.writeFileSync('docker-call.json', JSON.stringify({args: process.argv.slice(2), rpc: process.env.SCROLLSDK_CHECK_RPC_URL}));
      console.log(process.env.MOCK_DOCKER_OUTPUT);
      process.exit(Number(process.env.MOCK_DOCKER_EXIT));
    `, {mode: 0o700})
    calls = []
    absent = new Set(preinstalledContracts.filter(contract => contract.optional).map(contract => contract.address!.toLowerCase()))
    storage = new Map([
      [addresses.L2_DOGEOS_MESSENGER_PROXY_ADDR, 1n],
      [addresses.L2_MOAT_PROXY_ADDR, 2n ** 160n + BigInt(owner)],
      [addresses.L2_SYSTEM_CONFIG_PROXY_ADDR, 1n],
    ])
    getterResults = new Map([
      [`${addresses.L1_GAS_PRICE_ORACLE_ADDR}:${ethers.id('whitelist()').slice(0, 10)}`, addresses.L2_WHITELIST_ADDR],
      [`${addresses.L2_MESSAGE_QUEUE_ADDR}:${ethers.id('messenger()').slice(0, 10)}`, addresses.L2_DOGEOS_MESSENGER_PROXY_ADDR],
      [`${addresses.L2_TX_FEE_VAULT_ADDR}:${ethers.id('messenger()').slice(0, 10)}`, addresses.L2_FEE_VAULT_MOAT_ADAPTER_ADDR],
    ])
    const reply = (call: RpcCall) => {
      calls.push(call)
      let result: string | undefined
      switch (call.method) {
        case 'eth_chainId': {result = '0x539'; break}
        case 'eth_getCode': {result = absent.has(call.params[0]) ? '0x' : '0x6000'; break}
        case 'eth_getStorageAt': {result = word(storage.get(call.params[0]) ?? 0n); break}
        case 'eth_call': {
          const {data, to} = call.params[0]
          const key = `${to}:${data}`
          const value = getterResults.has(key) ? getterResults.get(key) : data === ethers.id('owner()').slice(0, 10) ? owner : null
          if (value) result = word(value)
          break
        }
      }

      return result === undefined
        ? {error: {code: -32_000, message: 'Test RPC call reverted'}, id: call.id, jsonrpc: '2.0'}
        : {id: call.id, jsonrpc: '2.0', result}
    }

    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => {body += chunk})
      request.on('end', () => {
        const payload = JSON.parse(body)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(Array.isArray(payload) ? payload.map((call: RpcCall) => reply(call)) : reply(payload)))
      })
    })
    await new Promise<void>(resolve => {server.listen(0, '127.0.0.1', resolve)})
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test RPC address')
    rpcUrl = `http://127.0.0.1:${address.port}`
    fs.writeFileSync(path.join(dir, 'config-contracts.toml'), toml.stringify(addresses))
    fs.writeFileSync(path.join(dir, 'config.toml'), toml.stringify({accounts: {OWNER_ADDR: owner}, frontend: {EXTERNAL_RPC_URI_L2: rpcUrl}}))
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve())})
    fs.rmSync(dir, {force: true, recursive: true})
  })

  for (const pod of [false, true]) {
    for (const legacyL1 of [false, true]) {
      it(`checks only current L2 contracts (${pod ? 'pod' : 'external'}, L1 config ${legacyL1 ? 'present' : 'absent'})`, async () => {
        fs.writeFileSync(path.join(dir, 'config.toml'), toml.stringify({
          accounts: {OWNER_ADDR: owner},
          frontend: {
            ...(!pod && {EXTERNAL_RPC_URI_L2: rpcUrl}),
            ...(legacyL1 && {EXTERNAL_RPC_URI_L1: 'http://127.0.0.1:1'}),
          },
          general: {
            ...(pod && {L2_RPC_ENDPOINT: rpcUrl}),
            ...(legacyL1 && {L1_RPC_ENDPOINT: 'http://127.0.0.1:1'}),
          },
        }))
        if (legacyL1) {
          fs.writeFileSync(path.join(dir, 'config-contracts.toml'), toml.stringify({
            ...addresses,
            BLOCK_HASH_HISTORY_ADDR: 'unused-genesis-override',
            L1_SCROLL_CHAIN_PROXY_ADDR: 'unused-l1-address',
            L2_BASCULE_MOCK_VERIFIER_ADDR: 'unused-retired-address',
            L2_ETH_GATEWAY_PROXY_ADDR: 'unused-retired-address',
            L2_GATEWAY_ROUTER_PROXY_ADDR: 'unused-retired-address',
            L2_NATIVE_DOGE_TOKEN_ADDR: 'unused-genesis-override',
            L2_WETH_GATEWAY_PROXY_ADDR: 'unused-retired-address',
            Permit2: 'unused-override',
          }))
        }

        const {stderr, stdout} = await run(pod ? ['--pod'] : [])
        expect(stdout).to.include('37 passed, 0 failed, 7 optional absent.')
        expect(stdout).to.include('=== dogeos-preinstalls image verification ===')
          .and.to.include('[ok] Preinstalls image verification passed.')
        const dockerCall = JSON.parse(fs.readFileSync(path.join(dir, 'docker-call.json'), 'utf8'))
        expect(dockerCall.rpc).to.equal(rpcUrl)
        expect(dockerCall.args).to.deep.equal([
          'run', '--rm', '--network', 'host', '--entrypoint', 'bash', '--env', 'SCROLLSDK_CHECK_RPC_URL',
          'dogeos69/preinstalls:v0.2.2', '-c', 'exec bash /app/lib/verify.sh "$SCROLLSDK_CHECK_RPC_URL"',
        ])
        const coreStart = stdout.indexOf('=== scroll-contracts (16 contracts) ===')
        const preinstallsStart = stdout.indexOf('=== dogeos-preinstalls (28 contracts) ===')
        expect(coreStart).to.be.greaterThan(-1)
        expect(preinstallsStart).to.be.greaterThan(coreStart)
        const coreOutput = stdout.slice(coreStart, preinstallsStart)
        const preinstallOutput = stdout.slice(preinstallsStart, stdout.indexOf('Overall:'))
        expect(coreOutput).to.include('[ok] L2_MOAT_PROXY_ADDR').and.to.include('16 passed, 0 failed, 0 optional absent.')
        expect(coreOutput).not.to.include('Multicall3')
        for (const [name, address] of Object.entries(genesisAddresses)) {
          expect(coreOutput).to.include(`[ok] ${name} (${address}): Deployed`)
          expect(calls.some(call => call.method === 'eth_call' && call.params[0].to === address)).to.equal(false)
        }

        expect(preinstallOutput).to.include('[ok] Multicall3').and.to.include('21 passed, 0 failed, 7 optional absent.')
        expect(preinstallOutput).not.to.include('L2_MOAT_PROXY_ADDR')
        expect(stdout).not.to.include('L1_SCROLL_CHAIN_PROXY_ADDR').and.not.to.include('GATEWAY').and.not.to.include('BASCULE')
        expect(stderr).not.to.include('JsonRpcProvider failed to detect network')
        expect(calls.filter(call => call.method === 'eth_getCode').map(call => call.params[0])).to.have.members([
          ...Object.values(addresses), ...Object.values(genesisAddresses), ...preinstalledContracts.map(contract => contract.address!.toLowerCase()),
        ])
        expect(calls.filter(call => call.method === 'eth_getStorageAt').map(call => call.params[0])).to.have.members([
          addresses.L2_DOGEOS_MESSENGER_PROXY_ADDR, addresses.L2_MOAT_PROXY_ADDR, addresses.L2_SYSTEM_CONFIG_PROXY_ADDR,
        ])
        expect(stdout).to.include('L1_GAS_PRICE_ORACLE_ADDR')
        // Shared preinstalls have no operator ownership or initialization checks.
        const preinstallAddresses = new Set(preinstalledContracts.map(contract => contract.address!.toLowerCase()))
        expect(calls.some(call => call.method === 'eth_call' && preinstallAddresses.has(call.params[0].to))).to.equal(false)
      })
    }
  }

  for (const [name, address] of Object.entries(genesisAddresses)) {
    it(`fails when the genesis predeploy ${name} is missing on chain`, async () => {
      absent.add(address)
      expect(await expectFailure()).to.include(`[failed] ${name}`).and.to.include('Contract not deployed')
        .and.to.include('15 passed, 1 failed, 0 optional absent.')
        .and.to.include('Overall: 36 passed, 1 failed, 7 optional absent.')
    })
  }

  it('fails when a required preinstall is missing', async () => {
    absent.add(fixedAddress('Multicall3'))
    expect(await expectFailure()).to.include('[failed] Multicall3').and.to.include('Contract not deployed')
  })

  it('accepts absent eip155 Safe contracts when their factory is deployed', async () => {
    absent.delete(fixedAddress('SafeSingletonFactory'))
    const {stdout} = await run()
    expect(stdout).to.include('38 passed, 0 failed, 6 optional absent.')
  })

  it('accepts a complete Safe eip155 deployment', async () => {
    absent.clear()
    const {stdout} = await run()
    expect(stdout).to.include('44 passed, 0 failed, 0 optional absent.')
  })

  it('does not mistake the Moat owner for its initialization flag', async () => {
    storage.set(addresses.L2_MOAT_PROXY_ADDR, BigInt(owner))
    expect(await expectFailure()).to.include('[failed] L2_MOAT_PROXY_ADDR').and.to.include('Contract not initialized')
  })

  it('checks the low initialization byte for SystemConfig instead of the entire slot', async () => {
    storage.set(addresses.L2_SYSTEM_CONFIG_PROXY_ADDR, 256n)
    expect(await expectFailure()).to.include('[failed] L2_SYSTEM_CONFIG_PROXY_ADDR').and.to.include('Contract not initialized')
  })

  it('checks queue, oracle and fee vault wiring', async () => {
    getterResults.set(`${addresses.L2_MESSAGE_QUEUE_ADDR}:${ethers.id('messenger()').slice(0, 10)}`, ethers.ZeroAddress)
    getterResults.set(`${addresses.L2_TX_FEE_VAULT_ADDR}:${ethers.id('messenger()').slice(0, 10)}`, addresses.L2_DOGEOS_MESSENGER_PROXY_ADDR)
    getterResults.set(`${addresses.L1_GAS_PRICE_ORACLE_ADDR}:${ethers.id('whitelist()').slice(0, 10)}`, ethers.ZeroAddress)
    expect(await expectFailure()).to.include('messenger() does not match L2_DOGEOS_MESSENGER_PROXY_ADDR')
      .and.to.include('messenger() does not match L2_FEE_VAULT_MOAT_ADAPTER_ADDR')
      .and.to.include('whitelist() does not match L2_WHITELIST_ADDR')
  })

  it('fails for incorrect or unreadable ownership instead of reporting success', async () => {
    getterResults.set(`${addresses.L2_PROXY_ADMIN_ADDR}:${ethers.id('owner()').slice(0, 10)}`, ethers.ZeroAddress)
    getterResults.set(`${addresses.L2_MOAT_PROXY_ADDR}:${ethers.id('owner()').slice(0, 10)}`, null)
    expect(await expectFailure()).to.include('Incorrect owner').and.to.include('Unable to check ownership')
  })

  it('fails for missing required core addresses', async () => {
    const partial = {...addresses}
    delete partial.L2_SYSTEM_CONFIG_PROXY_ADDR
    fs.writeFileSync(path.join(dir, 'config-contracts.toml'), toml.stringify(partial))
    expect(await expectFailure()).to.include('[failed] L2_SYSTEM_CONFIG_PROXY_ADDR').and.to.include('Missing or invalid contract address')
  })

  it('fails for core addresses with no deployed code', async () => {
    absent.add(addresses.L2_FEE_VAULT_MOAT_ADAPTER_ADDR)
    expect(await expectFailure()).to.include('[failed] L2_FEE_VAULT_MOAT_ADAPTER_ADDR').and.to.include('Contract not deployed')
      .and.to.include('15 passed, 1 failed, 0 optional absent.')
      .and.to.include('=== dogeos-preinstalls (28 contracts) ===')
      .and.to.include('21 passed, 0 failed, 7 optional absent.')
      .and.to.include('Overall: 36 passed, 1 failed, 7 optional absent.')
      .and.to.include('[ok] Preinstalls image verification passed.')
  })

  it('fails if CLI checks pass but the image verifier fails', async () => {
    dockerExitCode = 1
    dockerOutput = '[diff] Permit2: no expected codehash for chain id 221122'
    expect(await expectFailure()).to.include('37 passed, 0 failed, 7 optional absent.')
      .and.to.include('no expected codehash for chain id 221122')
      .and.to.include('[failed] Preinstalls image verification failed (exit 1).')
  })

  it('reports Docker failures instead of skipping image verification', async () => {
    dockerExitCode = 125
    dockerOutput = 'Cannot connect to the Docker daemon'
    expect(await expectFailure()).to.include('Cannot connect to the Docker daemon')
      .and.to.include('[failed] Preinstalls image verification failed (exit 125).')
  })

  it('fails clearly when Docker is not installed', async () => {
    fs.unlinkSync(path.join(dockerPath, 'docker'))
    expect(await expectFailure()).to.include('Check that Docker is installed and available.')
      .and.to.include('[failed] Preinstalls image verification failed (execution error).')
  })

  it('accepts an explicit preinstalls image', async () => {
    const image = 'example.invalid/preinstalls@sha256:' + 'a'.repeat(64)
    const {stdout} = await run(['--preinstalls-image', image])
    const dockerCall = JSON.parse(fs.readFileSync(path.join(dir, 'docker-call.json'), 'utf8'))
    expect(dockerCall.args).to.include(image)
    expect(stdout).to.include(`Image: ${image}`)
  })

  it('redacts RPC credentials from image output and keeps the URL out of Docker arguments', async () => {
    const endpoint = new URL(rpcUrl)
    endpoint.username = 'fake-rpc-user'
    endpoint.password = 'fake-rpc-password'
    endpoint.pathname = '/fake-private-path'
    endpoint.searchParams.set('key', 'fake-api-token')
    const secretRpc = endpoint.toString()
    fs.writeFileSync(path.join(dir, 'config.toml'), toml.stringify({accounts: {OWNER_ADDR: owner}, frontend: {EXTERNAL_RPC_URI_L2: secretRpc}}))
    dockerExitCode = 1
    dockerOutput = `RPC: ${secretRpc} (chain id 221122)\nrequestUrl: ${secretRpc}\npassword: fake-rpc-password\nkey: fake-api-token`
    const output = await expectFailure()
    for (const secret of [secretRpc, 'fake-rpc-user', 'fake-rpc-password', 'fake-private-path', 'fake-api-token']) {
      expect(output).not.to.include(secret)
    }

    const dockerCall = JSON.parse(fs.readFileSync(path.join(dir, 'docker-call.json'), 'utf8'))
    expect(dockerCall.rpc).to.equal(secretRpc)
    expect(JSON.stringify(dockerCall.args)).not.to.include(secretRpc)
    expect(output).to.include('[redacted]')
  })

  it('reports a missing L2 RPC without requiring an L1 RPC', async () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), toml.stringify({accounts: {OWNER_ADDR: owner}}))
    expect(await expectFailure()).to.include('Missing L2 RPC URL').and.not.to.include('L1_RPC_ENDPOINT')
    expect(calls).to.have.length(0)
  })
})
