/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise dynamic YAML and the command's production-file pass. */
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import PrepCharts from '../../../src/commands/setup/prep-charts.js'
import {reconcileScrollMonitorBalances} from '../../../src/utils/scroll-monitor-values.js'

const ORACLE_ADDRESS = `0x${'11'.repeat(20)}`
const DA_ADDRESS = `0x${'22'.repeat(20)}`
const ROTATED_ADDRESS = `0x${'33'.repeat(20)}`

function inputs(): any {
  return {
    dogeConfig: {
      accounts: {L1_COMMIT_SENDER_ADDR: DA_ADDRESS, L2_GAS_ORACLE_SENDER_ADDR: ORACLE_ADDRESS},
      ethereumDa: {chainId: 1, submitterRpcUrl: 'https://ethereum.example/rpc?key=secret'},
      network: 'testnet',
      signers: {
        l1CommitSender: {backend: 'aws_kms', expectedAddress: DA_ADDRESS},
        l2GasOracleSender: {backend: 'local'},
      },
    },
    l2ChainId: 1234,
    l2RpcUrl: 'http://l2-rpc:8545',
  }
}

describe('setup prep-charts scroll-monitor balance generation', () => {
  it('uses each real signer on its transaction network and generates default thresholds', () => {
    const values: any = {}
    const changes = reconcileScrollMonitorBalances(values, inputs())
    expect(values.balanceMonitoring).to.deep.equal({
      enabled: true,
      ethereum: {
        ethDaSubmitter: {
          address: DA_ADDRESS, expectedChainId: '1', minimumEth: 0.1,
          rpcUrl: 'https://ethereum.example/rpc?key=secret',
        },
        feeOracle: {
          address: ORACLE_ADDRESS, expectedChainId: '1234', minimumEth: 5, rpcUrl: 'http://l2-rpc:8545',
        },
      },
      exporter: {enabled: true},
      feeWallet: {enabled: true, minimumDoge: 100},
    })
    expect(JSON.stringify(changes)).not.to.contain('key=secret')
    expect(reconcileScrollMonitorBalances(values, inputs())).to.deep.equal([])
  })

  it('refreshes rotated identities, endpoints and chains while preserving operator settings', () => {
    const values: any = {
      balanceMonitoring: {
        ethereum: {ethDaSubmitter: {minimumEth: 0}, feeOracle: {minimumEth: 8}},
        exporter: {resources: {limits: {memory: '128Mi'}}},
        feeWallet: {enabled: false, jobRegex: 'custom-wp', minimumDoge: 250},
      },
      grafana: {'grafana.ini': {smtp: {enabled: true}}},
      grafanaAlerting: {enabled: false},
    }
    const config = inputs()
    reconcileScrollMonitorBalances(values, config)
    config.dogeConfig.accounts.L1_COMMIT_SENDER_ADDR = ROTATED_ADDRESS
    config.dogeConfig.signers.l1CommitSender.expectedAddress = ROTATED_ADDRESS
    config.dogeConfig.ethereumDa = {chainId: '0xaa36a7', submitterRpcUrl: 'https://sepolia.example'}
    config.l2RpcUrl = 'http://l2-reth-rpc:8545'
    config.l2ChainId = '2345'
    reconcileScrollMonitorBalances(values, config)
    expect(values.balanceMonitoring.ethereum.ethDaSubmitter).to.deep.equal({
      address: ROTATED_ADDRESS, expectedChainId: '11155111', minimumEth: 0, rpcUrl: 'https://sepolia.example',
    })
    expect(values.balanceMonitoring.ethereum.feeOracle).to.deep.equal({
      address: ORACLE_ADDRESS, expectedChainId: '2345', minimumEth: 8, rpcUrl: 'http://l2-reth-rpc:8545',
    })
    expect(values.balanceMonitoring.feeWallet).to.deep.equal({enabled: false, jobRegex: 'custom-wp', minimumDoge: 250})
    expect(values.balanceMonitoring.exporter.resources.limits.memory).to.equal('128Mi')
    expect(values.grafana['grafana.ini'].smtp.enabled).to.equal(true)
    expect(values.grafanaAlerting.enabled).to.equal(false)
  })

  it('rejects an inconsistent KMS signer without partially mutating values', () => {
    const values = {balanceMonitoring: {ethereum: {feeOracle: {address: '<TODO>'}}}}
    const before = structuredClone(values)
    const config = inputs()
    config.dogeConfig.signers.l1CommitSender.expectedAddress = ROTATED_ADDRESS
    expect(() => reconcileScrollMonitorBalances(values, config)).to.throw('does not match')
    expect(values).to.deep.equal(before)
  })

  it('supports a KMS fee-oracle and a local DA submitter without private key material', () => {
    const config = inputs()
    config.dogeConfig.signers.l2GasOracleSender = {backend: 'aws_kms', expectedAddress: ORACLE_ADDRESS}
    config.dogeConfig.signers.l1CommitSender = {backend: 'local'}
    const values: any = {}
    reconcileScrollMonitorBalances(values, config)
    expect(values.balanceMonitoring.ethereum.feeOracle.address).to.equal(ORACLE_ADDRESS)
    expect(values.balanceMonitoring.ethereum.ethDaSubmitter.address).to.equal(DA_ADDRESS)
    expect(JSON.stringify(values)).not.to.match(/privatekey|kmskey/i)
  })

  it('keeps explicit Secret-owned RPC fields empty but pins public identities and chain IDs', () => {
    const values: any = {balanceMonitoring: {
      ethereum: {ethDaSubmitter: {rpcUrl: ''}, feeOracle: {rpcUrl: ''}},
      exporter: {envFromSecret: 'balance-rpc'},
    }}
    const config = inputs()
    delete config.dogeConfig.ethereumDa.submitterRpcUrl
    delete config.l2RpcUrl
    reconcileScrollMonitorBalances(values, config)
    expect(values.balanceMonitoring.ethereum.feeOracle.rpcUrl).to.equal('')
    expect(values.balanceMonitoring.ethereum.ethDaSubmitter.rpcUrl).to.equal('')
    expect(values.balanceMonitoring.ethereum.feeOracle.address).to.equal(ORACLE_ADDRESS)
    expect(values.balanceMonitoring.ethereum.ethDaSubmitter.expectedChainId).to.equal('1')
  })

  it('respects disabled monitoring and external exporters without requiring signer configuration', () => {
    const config = {...inputs(), dogeConfig: {}}
    const disabled = {balanceMonitoring: {enabled: false}}
    expect(reconcileScrollMonitorBalances(disabled, config)).to.deep.equal([])
    const external: any = {balanceMonitoring: {exporter: {enabled: false}}}
    reconcileScrollMonitorBalances(external, config)
    expect(external.balanceMonitoring.exporter.enabled).to.equal(false)
    expect(external.balanceMonitoring.ethereum.feeOracle).to.deep.equal({minimumEth: 5})
    expect(external.balanceMonitoring.ethereum.ethDaSubmitter).to.deep.equal({minimumEth: 0.1})
  })

  for (const badUrl of [undefined, '', '<TODO>', 'ws://l2-rpc:8546']) {
    it(`rejects invalid L2 RPC ${String(badUrl)} without serializing incomplete values`, () => {
      const values = {}
      expect(() => reconcileScrollMonitorBalances(values, {...inputs(), l2RpcUrl: badUrl}))
        .to.throw('general.L2_RPC_ENDPOINT')
      expect(values).to.deep.equal({})
    })
  }

  for (const badChain of [undefined, '', 0, -1, 'abc', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid Ethereum DA chain ID ${String(badChain)}`, () => {
      const config = inputs()
      config.dogeConfig.ethereumDa.chainId = badChain
      const values = {}
      expect(() => reconcileScrollMonitorBalances(values, config)).to.throw('ethereumDa.chainId')
      expect(values).to.deep.equal({})
    })
  }

  it('rejects malformed mappings and invalid thresholds', () => {
    expect(() => reconcileScrollMonitorBalances({balanceMonitoring: []}, inputs())).to.throw('YAML mapping')
    for (const minimumEth of [-1, '5', Number.NaN]) {
      expect(() => reconcileScrollMonitorBalances({balanceMonitoring: {
        ethereum: {feeOracle: {minimumEth}},
      }}, inputs())).to.throw('minimumEth must be a nonnegative number')
    }
  })

  for (const filename of ['scroll-monitor-production.yaml', 'scroll-monitor-production-0.yaml']) {
    it(`writes ${filename} through the command using canonical DA facts, then makes no changes`, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-monitor-'))
      try {
        const file = path.join(directory, filename)
        fs.writeFileSync(file, yaml.dump({balanceMonitoring: {
          ethereum: {ethDaSubmitter: {address: '<TODO>'}, feeOracle: {address: '<TODO>'}},
        }}))
        const config = inputs()
        const output: string[] = []
        const command: any = Object.create(PrepCharts.prototype)
        Object.assign(command, {
          configData: {
            // Root compatibility and stale DA values must never supply monitoring identities.
            accounts: {L1_COMMIT_SENDER_ADDR: ROTATED_ADDRESS},
            ethereumDa: {chainId: 999, submitterRpcUrl: 'http://wrong-chain:8545'},
            general: {CHAIN_ID_L2: config.l2ChainId, L2_RPC_ENDPOINT: config.l2RpcUrl},
          },
          dogeConfig: config.dogeConfig,
          jsonCtx: {info() {}, logSuccess() {}},
          jsonMode: false,
          log(message: string) { output.push(message) },
          nonInteractive: true,
        })
        expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 0, updated: 1})
        const first = fs.readFileSync(file, 'utf8')
        const generated = yaml.load(first) as any
        expect(generated.balanceMonitoring.ethereum.ethDaSubmitter.address).to.equal(DA_ADDRESS)
        expect(generated.balanceMonitoring.ethereum.ethDaSubmitter.expectedChainId).to.equal('1')
        expect(generated.balanceMonitoring.ethereum.ethDaSubmitter.rpcUrl).to.equal(config.dogeConfig.ethereumDa.submitterRpcUrl)
        expect(generated.balanceMonitoring.ethereum.feeOracle.rpcUrl).to.equal(config.l2RpcUrl)
        expect(output.join('\n')).not.to.contain('key=secret')
        expect(await command.processProductionYaml(directory)).to.deep.equal({skipped: 1, updated: 0})
        expect(fs.readFileSync(file, 'utf8')).to.equal(first)
      } finally {
        fs.rmSync(directory, {force: true, recursive: true})
      }
    })
  }
})
