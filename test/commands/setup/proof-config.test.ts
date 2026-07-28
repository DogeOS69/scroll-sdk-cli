import * as toml from '@iarna/toml'
import { runCommand } from '@oclif/test'
import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  DEFAULT_PROOF_ARTIFACT_MANIFEST,
  DEFAULT_PROOF_COORDINATOR_CONFIG,
  DEFAULT_PROOF_PROGRAM_MANIFESTS,
  DEFAULT_STATEMENT_NAMESPACE_CONFIG,
  resolveProofDeploymentPaths,
} from '../../../src/commands/setup/proof-config.js'
import { validateProofDeploymentContract } from '../../../src/utils/proof-deployment-contract.js'

describe('setup proof-config path convention', () => {
  it('uses the deployment Makefile proof-artifacts layout', () => {
    expect(DEFAULT_PROOF_ARTIFACT_MANIFEST).to.equal('proof-artifacts/release.json')
    expect(DEFAULT_PROOF_COORDINATOR_CONFIG).to.equal('proof-coordinator/ProofCoordinator.toml')
    expect(DEFAULT_STATEMENT_NAMESPACE_CONFIG).to.equal('proof-artifacts/manifests/statement-namespace.json')
    expect(DEFAULT_PROOF_PROGRAM_MANIFESTS).to.deep.equal([
      'proof-artifacts/manifests/scroll-chunk.json',
      'proof-artifacts/manifests/scroll-batch.json',
      'proof-artifacts/manifests/bridge-transition.json',
    ])
  })

  it('derives every proof path from one deployment root', () => {
    const layout = resolveProofDeploymentPaths({ deploymentDir: '/srv/dogeos/testnet' })
    expect(layout.valuesDir).to.equal('/srv/dogeos/testnet/values')
    expect(layout.coordinatorConfig).to.equal('/srv/dogeos/testnet/proof-coordinator/ProofCoordinator.toml')
    expect(layout.withdrawalConfig).to.equal('/srv/dogeos/testnet/withdrawal-processor/WithdrawalProcessor.toml')
    expect(layout.dogeConfig).to.equal('/srv/dogeos/testnet/.data/doge-config.toml')
    expect(layout.statementNamespace).to.equal('/srv/dogeos/testnet/proof-artifacts/manifests/statement-namespace.json')
    expect(layout.programManifests).to.deep.equal([
      '/srv/dogeos/testnet/proof-artifacts/manifests/scroll-chunk.json',
      '/srv/dogeos/testnet/proof-artifacts/manifests/scroll-batch.json',
      '/srv/dogeos/testnet/proof-artifacts/manifests/bridge-transition.json',
    ])
    expect(layout.workerBundleDir).to.equal('/srv/dogeos/testnet/prover-worker-mock/docker-compose')
  })

  it('generates and validates a proof-disabled deployment without proof artifacts', async () => {
    const originalCwd = process.cwd()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-config-disabled-'))
    try {
      process.chdir(root)
      fs.mkdirSync('.data', { recursive: true })
      fs.mkdirSync('values', { recursive: true })
      fs.mkdirSync('withdrawal-processor', { recursive: true })
      fs.writeFileSync('.data/doge-config.toml', toml.stringify({
        network: 'testnet',
        proofSystem: {
          artifactReadBaseUrl: 'https://stale.example/proofs',
          provingMode: 'mock',
        },
        wallet: { path: '.data/wallet.json' },
      } as toml.JsonMap))
      fs.writeFileSync('values/withdrawal-processor-production.yaml', yaml.dump({
        configMaps: {
          config: { enabled: true },
          'proof-manifests': { data: { 'stale.json': '{}\n' }, enabled: true },
        },
        env: [
          { name: 'DOGEOS_WITHDRAWAL_PROOF_SYSTEM__MODE', value: 'dev_dummy' },
          { name: 'DOGEOS_WITHDRAWAL_PROOF_WORK_API__ENABLED', value: 'true' },
        ],
        service: { main: { ports: { 'proof-work': { port: 9090 } } } },
        withdrawalProof: { enabled: true, provingMode: 'mock' },
      }))
      fs.writeFileSync('values/tso-service-production.yaml', yaml.dump({ env: [] }))
      fs.writeFileSync('withdrawal-processor/WithdrawalProcessor.toml', `[proof_system]\nmode = "dev_dummy"\nrequire_scroll_execution = true\nrequire_bridge_state = true\n\n[proof_work_api]\nenabled = true\n`)

      const { stderr, stdout } = await runCommand([
        'setup', 'proof-config', '--deployment-dir', root, '--mode', 'disabled', '--json',
      ])
      expect(stdout, stderr).not.to.equal('')
      const output = JSON.parse(stdout)
      expect(output.success).to.equal(true)
      expect(output.data.mode).to.equal('disabled')

      const config = toml.parse(fs.readFileSync('.data/doge-config.toml', 'utf8')) as any
      expect(config.proofSystem.mode).to.equal('disabled')
      expect(config.proofSystem.provingMode).to.equal(undefined)
      expect(config.proofSystem.artifactReadBaseUrl).to.equal(undefined)
      const contract = JSON.parse(fs.readFileSync('.data/proof-deployment.json', 'utf8'))
      expect(contract.mode).to.equal('disabled')
      expect(contract.components.proofCoordinator.enabled).to.equal(false)
      expect(contract.worker).to.deep.equal({ enabled: false, kind: 'none' })

      const values = yaml.load(fs.readFileSync('values/withdrawal-processor-production.yaml', 'utf8')) as any
      expect(values.withdrawalProof.enabled).to.equal(false)
      expect(values.withdrawalProof.mode).to.equal('disabled')
      expect(values.withdrawalProof.provingMode).to.equal(undefined)
      expect(values.configMaps['proof-manifests']).to.equal(undefined)
      expect(values.service.main.ports['proof-work']).to.equal(undefined)
      const native = toml.parse(fs.readFileSync('withdrawal-processor/WithdrawalProcessor.toml', 'utf8')) as any
      expect(native.proof_system.mode).to.equal('disabled')
      expect(native.proof_work_api).to.equal(undefined)
      expect(values.env.some((item: any) => item.name.startsWith('DOGEOS_WITHDRAWAL_PROOF_WORK_API__'))).to.equal(false)

      expect(validateProofDeploymentContract(root).mode).to.equal('disabled')
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(root, { force: true, recursive: true })
    }
  })
})
