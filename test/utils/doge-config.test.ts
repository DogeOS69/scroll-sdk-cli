/* eslint-disable @typescript-eslint/no-explicit-any -- TOML parsing returns dynamic structure */
import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { DogeConfig } from '../../src/types/doge-config.js'

import { dogeConfigToToml, loadDogeConfigWithSelection } from '../../src/utils/doge-config.js'

function writeDogeConfig(content = 'network = "testnet"\n[wallet]\npath = ".data/doge-wallet-testnet.json"\n'): void {
  fs.writeFileSync('.data/doge-config.toml', content)
}

describe('doge-config utilities', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-config-test-'))
    process.chdir(tempDir)
    fs.mkdirSync('.data', { recursive: true })
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { force: true, recursive: true })
  })

  it('loads Dogecoin network from doge-config.toml', async () => {
    writeDogeConfig()

    const { config } = await loadDogeConfigWithSelection()

    expect(config.network).to.equal('testnet')
    expect(config.wallet.path).to.equal('.data/doge-wallet-testnet.json')
  })

  it('requires doge-config network', async () => {
    writeDogeConfig('[wallet]\npath = ".data/doge-wallet-testnet.json"\n')

    try {
      await loadDogeConfigWithSelection()
      expect.fail('expected loadDogeConfigWithSelection to throw')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.include("is missing 'network'")
    }
  })

  it('serializes doge-config with top-level network and without duplicated local signer network fields', () => {
    const content = dogeConfigToToml({
      localSigners: {
        network: 'testnet',
        signers: [{ index: 0, port: 4000 }],
      } as any,
      network: 'testnet',
      wallet: { path: '.data/doge-wallet-testnet.json' },
    } as DogeConfig)
    const parsed = toml.parse(content) as any

    expect(parsed.network).to.equal('testnet')
    expect(parsed.localSigners).not.to.have.property('network')
    expect(parsed.wallet.path).to.equal('.data/doge-wallet-testnet.json')
  })
})
