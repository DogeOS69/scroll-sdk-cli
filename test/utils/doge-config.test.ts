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

  it('preserves compiler-backed proof topology as a doge-config section', () => {
    const content = dogeConfigToToml({
      network: 'testnet',
      proof_topology: {
        active: {
          artifactStore: {kind: 'local_fs'},
          profile: 'withdrawal_mock_prover',
          realScroll: {
            batchMaterializerBinaryPath: '.data/proof-materials/batch',
            batchProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
            batchProgramCommitmentHex: `0x${'2'.repeat(128)}`,
            batchVerificationKeyHashHex: `0x${'1'.repeat(64)}`,
            bridgeAppCommitRawHex: `0x${'2'.repeat(128)}`,
            bridgeProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
            bridgeVerificationKeyHashHex: `0x${'1'.repeat(64)}`,
            chunkMaterializerBinaryPath: '.data/proof-materials/chunk',
            chunkProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
            chunkProgramCommitmentHex: `0x${'2'.repeat(128)}`,
            chunkVerificationKeyHashHex: `0x${'1'.repeat(64)}`,
            l2RangeAggregationAppCommitRawHex: `0x${'2'.repeat(128)}`,
            l2RangeAggregationProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
            l2RangeAggregationVerificationKeyHashHex: `0x${'1'.repeat(64)}`,
            resourcesRoot: '.data/proof-materials',
          },
          workerLaunch: 'local_cpu',
        },
        compiler: {
          image: {
            digest: `sha256:${'a'.repeat(64)}`,
            repository: 'dogeos69/dogeos-proof-topology',
          },
        },
        deployment: {
          artifactKeyPrefix: 'proof-topology',
          mockWorkerImage: {digest: `sha256:${'b'.repeat(64)}`, repository: 'dogeos69/prover-worker-mock'},
          productionWorkerImage: {digest: `sha256:${'c'.repeat(64)}`, repository: 'dogeos69/prover-worker'},
        },
        enforcement: 'observe',
        generation: 'mock',
        mode: 'disabled',
      },
      wallet: {path: '.data/doge-wallet-testnet.json'},
    })
    const parsed = toml.parse(content) as any

    expect(parsed.proof_topology.mode).to.equal('disabled')
    expect(parsed.proof_topology.compiler.image.repository)
      .to.equal('dogeos69/dogeos-proof-topology')
  })
})
