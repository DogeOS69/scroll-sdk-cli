import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { DogeConfig } from '../../src/types/doge-config.js'

import { JsonOutputContext } from '../../src/utils/json-output.js'
import { setupManagedSigner } from '../../src/utils/managed-signer-setup.js'

describe('managed signer setup', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-signer-setup-'))
    process.chdir(tempDir)
    fs.mkdirSync('.data', { recursive: true })
    fs.writeFileSync('config.toml', '[accounts]\nOWNER_ADDR = "0x0000000000000000000000000000000000000001"\n')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { force: true, recursive: true })
  })

  function baseDogeConfig(): DogeConfig {
    return {
      network: 'testnet',
      wallet: { path: '.data/doge-wallet-testnet.json' },
    }
  }

  it('writes eth-da-submitter local signer settings to doge-config', async () => {
    const dogeConfigPath = path.join(tempDir, '.data', 'doge-config.toml')
    const dogeConfig = baseDogeConfig()

    const result = await setupManagedSigner({
      dogeConfig,
      dogeConfigPath,
      flags: { 'signer-backend': 'local' },
      hasFlag: () => false,
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: true,
      signerKey: 'l1CommitSender',
    })

    const parsed = toml.parse(fs.readFileSync(dogeConfigPath, 'utf8')) as any
    expect(result.signerConfig.backend).to.equal('local')
    expect(parsed.signers.l1CommitSender.backend).to.equal('local')
    expect(parsed.accounts.L1_COMMIT_SENDER_ADDR).to.match(/^0x[\dA-Fa-f]{40}$/)
    expect(parsed.accounts.L1_COMMIT_SENDER_PRIVATE_KEY).to.match(/^0x[\dA-Fa-f]{64}$/)
    expect(parsed.accounts.L1_COMMIT_SENDER_ADDR).to.equal(result.address)
  })

  it('syncs fee-oracle local signer address to config.toml accounts.L2_GAS_ORACLE_SENDER_ADDR', async () => {
    const dogeConfigPath = path.join(tempDir, '.data', 'doge-config.toml')
    const dogeConfig = baseDogeConfig()

    const result = await setupManagedSigner({
      dogeConfig,
      dogeConfigPath,
      flags: { 'signer-backend': 'local' },
      hasFlag: () => false,
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: true,
      signerKey: 'l2GasOracleSender',
    })

    const dogeParsed = toml.parse(fs.readFileSync(dogeConfigPath, 'utf8')) as any
    const configParsed = toml.parse(fs.readFileSync('config.toml', 'utf8')) as any

    expect(result.updatedConfigToml).to.equal(true)
    expect(dogeParsed.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(result.address)
    expect(dogeParsed.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY).to.match(/^0x[\dA-Fa-f]{64}$/)
    expect(configParsed.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(result.address)
  })
})
