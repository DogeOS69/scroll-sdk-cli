/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect generated native config and Helm values. */
import * as toml from '@iarna/toml'
import {Config} from '@oclif/core'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {execFileSync, spawnSync} from 'node:child_process'
import {createECDH} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'
import type {DogeConfig} from '../../src/types/doge-config.js'

import PrepCharts, {applyConfigMapEnvValues, buildEthDaSubmitterPrepEnv} from '../../src/commands/setup/prep-charts.js'
import {ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA} from '../../src/utils/attestation-signer-descriptor.js'
import {generateAllConfigs, normalizeDeploymentSpec, validateDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {dogeConfigToToml} from '../../src/utils/doge-config.js'
import {resolveDogecoinKubernetesEndpoints} from '../../src/utils/kubernetes-endpoints.js'
import {resolveProofIntent} from '../../src/utils/proof-intent.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fixture(): DeploymentSpec {
  const text = fs.readFileSync(path.join(cliRoot, 'src/config/deployment-spec.minimal.yaml'), 'utf8')
    .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
    .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')
  const spec = normalizeDeploymentSpec(yaml.load(text) as DeploymentSpec)
  spec.infrastructure = {bootnodeCount: 1, provider: 'local', sequencerCount: 1}
  spec.bridge.seedString = 'NONFUNCTIONAL_TEST_SEED'
  return spec
}

function parseValues(spec: DeploymentSpec, service: string): any {
  return yaml.load(generateValuesFiles(spec)[`${service}-production.yaml`])
}

function proofFixture(): DeploymentSpec {
  const spec = fixture()
  spec.metadata.name = 'custom-proof-deployment'
  spec.proofArtifacts = {s3: {bucket: 'audit-proofs', keyPrefix: 'proofs', region: 'us-west-2'}}
  spec.ethereumDa!.blobArchive = {s3: {bucket: 'audit-blobs', enabled: true, keyPrefix: 'blobs', publicBaseUrl: 'https://blobs.audit.invalid', region: 'us-west-2'}}
  spec.proofCoordinator = {
    artifactStore: {bucket: 'audit-proofs', keyPrefix: 'proofs', region: 'us-west-2'},
    s3AuthMode: 'ambient',
    secrets: {name: 'custom-proof-secret', proverWorkerTokenProperty: 'custom-worker-token'},
  }
  spec.proofTopology = {
    active: {
      artifactStore: {bucket: 'audit-proofs', kind: 's3_compatible', region: 'us-west-2'},
      profile: 'withdrawal_mock_prover',
      realScroll: {
        batchProgramCommitmentHashHex: 'a'.repeat(64), batchProgramCommitmentHex: 'b'.repeat(128), batchVerificationKeyHashHex: 'c'.repeat(64),
        bridgeAppCommitRawHex: 'd'.repeat(128), bridgeProgramCommitmentHashHex: 'e'.repeat(64), bridgeVerificationKeyHashHex: 'f'.repeat(64),
        chunkProgramCommitmentHashHex: 'a'.repeat(64), chunkProgramCommitmentHex: 'b'.repeat(128), chunkVerificationKeyHashHex: 'c'.repeat(64),
        l2RangeAggregationAppCommitRawHex: 'd'.repeat(128), l2RangeAggregationProgramCommitmentHashHex: 'e'.repeat(64), l2RangeAggregationVerificationKeyHashHex: 'f'.repeat(64),
        resourcesRoot: '.data/proof-materials',
      },
      workerLaunch: 'external',
    },
    compiler: {identityFilePath: '.data/proof-materials/identity.json', image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/compiler'}},
    deployment: {artifactKeyPrefix: 'proofs', proverPublicUrl: 'https://proof.audit.invalid'},
    enforcement: 'observe', generation: 'mock', mode: 'disabled', observeRealProofDeadlineMs: 1_800_000,
  }
  return spec
}

describe('spec intent through configuration and values projection', () => {
  for (const publicBaseUrl of [undefined, 'https://blob-gateway.example.invalid']) {
    it(`projects the ${publicBaseUrl ? 'explicit gateway' : 'derived AWS'} blob read URL consistently`, () => {
      const spec = proofFixture()
      spec.ethereumDa!.blobArchive!.s3!.publicBaseUrl = publicBaseUrl
      const expected = publicBaseUrl ?? 'https://audit-blobs.s3.us-west-2.amazonaws.com'
      expect(validateDeploymentSpec(spec).valid).to.equal(true)
      const config = toml.parse(generateAllConfigs(spec)['doge-config.toml']) as any
      expect(config.ethereumDa.blobArchive.s3.publicBaseUrl).to.equal(expected)
      const l1 = parseValues(spec, 'l1-interface')
      expect(l1.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL).to.equal(expected)
      expect(l1.configMaps.env.data.DOGEOS_L1_INTERFACE_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__KEY_PREFIX).to.equal('blobs')
      const wp = parseValues(spec, 'withdrawal-processor')
      expect(wp.env.find((entry: any) => entry.name === 'DOGEOS_WITHDRAWAL_ETHEREUM_DA__BLOB_SOURCE__AWS_S3__URL').value).to.equal(expected)
    })
  }

  it('retains proof intent after generating from an external custom-named spec and removing the source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-proof-handoff-'))
    try {
      const spec = proofFixture()
      const source = path.join(root, 'custom-intent.yaml')
      const deploymentDir = path.join(root, 'deployment')
      fs.writeFileSync(source, yaml.dump(spec))
      const original = resolveProofIntent({deploymentDir: root, required: true, specPath: source})!
      execFileSync(process.execPath, [path.join(cliRoot, 'bin/run.js'), 'setup', 'generate-from-spec', '--spec', source, '--output', deploymentDir, '--json'], {
        cwd: root, env: {OCLIF_TEST_ROOT: cliRoot, PATH: process.env.PATH}, stdio: 'pipe',
      })
      fs.unlinkSync(source)
      const configPath = path.join(deploymentDir, '.data/doge-config.toml')
      const dogeConfig = toml.parse(fs.readFileSync(configPath, 'utf8')) as unknown as DogeConfig
      // Existing setup commands save this same structure; ensure a save retains the handoff.
      fs.writeFileSync(configPath, dogeConfigToToml(dogeConfig))
      for (const options of [{deploymentDir}, {deploymentDir, dogeConfig}]) {
        const resolved = resolveProofIntent({...options, required: true})!
        expect(resolved.source.kind).to.equal('doge-config')
        for (const key of ['deploymentName', 'network', 'proofCoordinator', 'proofTopology', 'proverPublicUrl', 'intent'] as const) {
          expect(resolved[key], key).to.deep.equal(original[key])
        }
      }

      const stale = structuredClone(spec)
      stale.proofTopology!.mode = 'active'
      const conventional = path.join(deploymentDir, 'deployment-spec.yaml')
      fs.writeFileSync(conventional, yaml.dump(stale))
      expect(resolveProofIntent({deploymentDir, required: true})!.intent.mode).to.equal('disabled')
      expect(resolveProofIntent({deploymentDir, required: true, specPath: conventional})!.intent.mode).to.equal('active')
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('rejects a shared DA/proof bucket for each proof input, even with different prefixes', () => {
    expect(validateDeploymentSpec(proofFixture()).valid).to.equal(true)
    for (const mutate of [
      (spec: DeploymentSpec) => {spec.proofArtifacts!.s3!.bucket = 'audit-blobs'},
      (spec: DeploymentSpec) => {spec.proofTopology!.active!.artifactStore.bucket = 'audit-blobs'},
      (spec: DeploymentSpec) => {spec.proofCoordinator!.artifactStore.bucket = 'audit-blobs'},
    ]) {
      const spec = proofFixture()
      mutate(spec)
      expect(validateDeploymentSpec(spec).errors.some(error => error.message.includes('separate prefixes'))).to.equal(true)
    }
  })

  it('compares resolved bucket environment references without resolving unrelated credentials', () => {
    const previous = process.env.SPEC_AUDIT_PROOF_BUCKET
    try {
      process.env.SPEC_AUDIT_PROOF_BUCKET = 'audit-blobs'
      const spec = proofFixture()
      spec.proofArtifacts!.s3!.bucket = '$ENV:SPEC_AUDIT_PROOF_BUCKET'
      const {errors} = validateDeploymentSpec(spec)
      expect(errors.some(error => error.message.includes('separate prefixes'))).to.equal(true)
    } finally {
      if (previous === undefined) delete process.env.SPEC_AUDIT_PROOF_BUCKET
      else process.env.SPEC_AUDIT_PROOF_BUCKET = previous
    }
  })

  it('rejects archive CLI overrides that would reuse the proof bucket before saving', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-bucket-override-'))
    try {
      const configPath = path.join(root, 'doge-config.toml')
      const content = generateAllConfigs(proofFixture())['doge-config.toml']
      fs.writeFileSync(configPath, content)
      const result = spawnSync(process.execPath, [path.join(cliRoot, 'bin/run.js'), 'setup', 'eth-da-submitter', '--doge-config', configPath,
        '--archive-bucket', 'audit-proofs', '--no-create-archive-bucket', '-N', '--json'], {
        cwd: root, encoding: 'utf8', env: {OCLIF_TEST_ROOT: cliRoot, PATH: process.env.PATH},
      })
      expect(result.status).not.to.equal(0)
      expect(result.stdout + result.stderr).to.include('separate prefixes')
      expect(fs.readFileSync(configPath, 'utf8')).to.equal(content)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('uses beta.6 for core services while preserving explicit image choices', () => {
    const spec = fixture()
    for (const service of ['l1-interface', 'withdrawal-processor', 'tso-service', 'cubesigner-signer', 'fee-oracle', 'eth-da-submitter']) {
      expect(parseValues(spec, service).image.tag, service).to.equal('v0.3.0-beta.6')
    }

    spec.images = {services: {withdrawalProcessor: {tag: 'operator-selected'}}}
    expect(parseValues(spec, 'withdrawal-processor').image.tag).to.equal('operator-selected')
  })

  it('defaults to 30M gas and 2s blocks and accepts explicit genesis gas and fee overhead', () => {
    const spec = fixture()
    const config = toml.parse(generateAllConfigs(spec)['config.toml']) as any
    const {reth} = parseValues(spec, 'l2-reth-sequencer')
    expect(config.genesis.GAS_LIMIT).to.equal(30_000_000)
    expect(config.contracts.L2_BASE_FEE_OVERHEAD).to.equal('420000000000')
    expect(reth.builderGasLimit).to.equal('30000000')
    expect(reth.sequencer.blockTimeMs).to.equal('2000')
    expect(reth.sequencer.payloadBuildingDurationMs).to.equal('1400')
    spec.genesis.gasLimit = 40_000_000
    spec.contracts.l2BaseFeeOverheadWei = '0'
    const custom = toml.parse(generateAllConfigs(spec)['config.toml']) as any
    expect(custom.genesis.GAS_LIMIT).to.equal(40_000_000)
    expect(custom.contracts.L2_BASE_FEE_OVERHEAD).to.equal('0')
    expect(parseValues(spec, 'l2-reth-sequencer').reth.builderGasLimit).to.equal('40000000')
  })

  it('carries the fee-oracle write policy without forcing live on an explicit dry run', () => {
    const spec = fixture()
    for (const mode of ['live', 'dry_run'] as const) {
      if (mode === 'dry_run') spec.feeOracle = {contractWriteMode: mode}
      expect((toml.parse(generateAllConfigs(spec)['doge-config.toml']) as any).feeOracle.contractWriteMode).to.equal(mode)
      expect(parseValues(spec, 'fee-oracle').configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE).to.equal(mode)
    }
  })

  it('preserves custom Dogecoin discovery in both generation paths', () => {
    const spec = fixture()
    spec.dogecoin.kubernetes = {rpcPort: 29_999, serviceName: 'custom-doge.audit.svc', zmqRawBlockPort: 30_001}
    const doge = toml.parse(generateAllConfigs(spec)['doge-config.toml']) as any
    expect(doge.kubernetes).to.deep.equal(spec.dogecoin.kubernetes)
    expect(resolveDogecoinKubernetesEndpoints(doge).rpcUrl).to.equal('http://custom-doge.audit.svc:29999')
    expect(parseValues(spec, 'l1-interface').configMaps.env.data.DOGEOS_L1_INTERFACE_DOGECOIN_RPC__URL).to.equal('http://custom-doge.audit.svc:29999')
  })

  it('retains every explicit submitter runtime setting through prep, including zero values', () => {
    const spec = fixture()
    const runtime = {
      confirmationDepth: 0, confirmerPollIntervalMs: 11_111, fetchLimit: 7, finalizationDepth: 99,
      l2Confirmations: 0, l2RpcUrl: 'http://custom-l2.audit.invalid:8545',
      lifecycleDbPath: '/data/custom-lifecycle.sqlite', maxBlobBaseFeeWei: '123456',
      maxFeePerGasWei: '234567', minPriorityFeeWei: '0', submitterDbPath: '/data/custom-submit.sqlite',
    }
    Object.assign(spec.ethereumDa!, runtime)
    expect(validateDeploymentSpec(spec).valid).to.equal(true)
    const doge = toml.parse(generateAllConfigs(spec)['doge-config.toml']) as any
    expect(doge.ethereumDa).to.include(runtime)
    const explicit = parseValues(spec, 'eth-da-submitter').configMaps.env.data
    const prepared = buildEthDaSubmitterPrepEnv({ethereumRpcUrl: doge.ethereumDa.submitterRpcUrl, l2RpcUrl: 'http://fallback.invalid', runtime: doge.ethereumDa})
    for (const key of Object.keys(prepared).filter(key => key in explicit && prepared[key] !== undefined)) {
      expect(prepared[key], key).to.equal(explicit[key])
    }

    expect(prepared.DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL).to.equal(runtime.l2RpcUrl)
    const existing: any = {configMaps: {env: {data: {DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__FINALIZATION_DEPTH: '123'}}}}
    applyConfigMapEnvValues(existing, buildEthDaSubmitterPrepEnv({ethereumRpcUrl: 'https://eth.invalid', l2RpcUrl: 'http://l2.invalid'}))
    expect(existing.configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__FINALIZATION_DEPTH).to.equal('123')
  })

  it('applies the shared submitter DB fallback in both paths', () => {
    const spec = fixture()
    spec.ethereumDa!.submitterDbPath = '/data/shared.sqlite'
    const doge = toml.parse(generateAllConfigs(spec)['doge-config.toml']) as any
    const prepared = buildEthDaSubmitterPrepEnv({ethereumRpcUrl: '', l2RpcUrl: '', runtime: doge.ethereumDa})
    expect(prepared.DOGEOS_ETH_DA_SUBMITTER_STORE__LIFECYCLE_DB_PATH).to.equal('/data/shared.sqlite')
    expect(parseValues(spec, 'eth-da-submitter').configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_STORE__LIFECYCLE_DB_PATH).to.equal('/data/shared.sqlite')
  })

  it('keeps custom RPC, finality, write mode and genesis gas through repeated chart reconciliation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-prep-projection-'))
    try {
      const spec = fixture()
      spec.genesis.gasLimit = 40_000_000
      spec.feeOracle = {contractWriteMode: 'dry_run'}
      spec.ethereumDa!.l2RpcUrl = 'https://custom-l2.audit.invalid'
      spec.ethereumDa!.finalizationDepth = 99
      const configs = generateAllConfigs(spec)
      const main = toml.parse(configs['config.toml']) as any
      const doge = toml.parse(configs['doge-config.toml']) as any
      doge.signers = main.signers
      doge.accounts = {L1_COMMIT_SENDER_ADDR: '0x0000000000000000000000000000000000000001'}
      const values = generateValuesFiles(fixture())
      for (const name of ['eth-da-submitter', 'fee-oracle', 'l2-reth-rpc']) {
        fs.writeFileSync(path.join(root, `${name}-production.yaml`), values[`${name}-production.yaml`])
      }

      const command: any = new PrepCharts([], await Config.load({root: cliRoot}))
      Object.assign(command, {
        configData: {...main, ethereumDa: doge.ethereumDa},
        contractsConfig: {L1_GAS_PRICE_ORACLE_ADDR: '0x0000000000000000000000000000000000000001'},
        dogeConfig: doge, flags: {}, jsonCtx: {addWarning() {}, error(_code: string, message: string) {throw new Error(message)}, info() {}, logSuccess() {}},
        jsonMode: true, log() {}, nonInteractive: true,
      })
      await command.processProductionYaml(root)
      const read = (name: string): any => yaml.load(fs.readFileSync(path.join(root, `${name}-production.yaml`), 'utf8'))
      expect(read('eth-da-submitter').configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_L2__RPC_URL).to.equal(spec.ethereumDa!.l2RpcUrl)
      expect(read('eth-da-submitter').configMaps.env.data.DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__FINALIZATION_DEPTH).to.equal('99')
      expect(read('fee-oracle').configMaps.env.data.DOGEOS_FEE_ORACLE_ETHEREUM_DA__CONTRACT_WRITE_MODE).to.equal('dry_run')
      expect(read('l2-reth-rpc').reth.builderGasLimit).to.equal('40000000')
      const first = fs.readdirSync(root).map(file => fs.readFileSync(path.join(root, file), 'utf8'))
      await command.processProductionYaml(root)
      expect(fs.readdirSync(root).map(file => fs.readFileSync(path.join(root, file), 'utf8'))).to.deep.equal(first)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('rejects impossible, duplicate and empty initial signer selections', () => {
    for (const keyset of [
      {signerIds: ['partner-a'], threshold: 99},
      {signerIds: ['partner-a', 'partner-a'], threshold: 1},
      {signerIds: [], threshold: 1},
      {signerIds: ['partner-a'], threshold: 0},
    ]) {
      const spec = fixture()
      spec.bridge.initialAttestationKeyset = keyset
      expect(validateDeploymentSpec(spec).errors.some(error => error.path === 'bridge.initialAttestationKeyset')).to.equal(true)
    }
  })

  it('rejects invalid gas limit, fee overhead and write mode intent', () => {
    const spec = fixture()
    spec.genesis.gasLimit = 1
    spec.contracts.l2BaseFeeOverheadWei = '-1'
    spec.feeOracle = {contractWriteMode: 'unexpected' as any}
    const paths = validateDeploymentSpec(spec).errors.map(error => error.path)
    expect(paths).to.include.members(['genesis.gasLimit', 'contracts.l2BaseFeeOverheadWei', 'feeOracle.contractWriteMode'])
  })

  it('uses spec signer selection when the real CLI imports a larger descriptor directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-signer-import-'))
    const command = (...args: string[]) => execFileSync(process.execPath, [path.join(cliRoot, 'bin/run.js'), ...args], {cwd: root, env: {OCLIF_TEST_ROOT: cliRoot, PATH: process.env.PATH}, stdio: 'pipe'})
    try {
      const spec = fixture()
      spec.bridge.initialAttestationKeyset = {signerIds: ['partner-c', 'partner-a'], threshold: 1}
      fs.writeFileSync(path.join(root, 'intent.yaml'), yaml.dump(spec))
      command('setup', 'generate-from-spec', '--spec', 'intent.yaml', '--json')
      fs.mkdirSync(path.join(root, 'descriptors'))
      const publicKey = () => {const key = createECDH('secp256k1'); key.generateKeys(); return key.getPublicKey('hex', 'compressed')}
      for (const id of ['partner-a', 'partner-b', 'partner-c']) {
        fs.writeFileSync(path.join(root, 'descriptors', `${id}.json`), JSON.stringify({id, network: 'testnet', publicKey: publicKey(), schema: ATTESTATION_SIGNER_DESCRIPTOR_SCHEMA, transportPubkey: publicKey()}))
      }

      command('setup', 'attestation-signer', '--json')
      const config = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
      const defaults = toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8')) as any
      expect(config.attestationSigner.activeSignerIds).to.deep.equal(['partner-c', 'partner-a'])
      expect(config.attestationSigner.external).to.have.length(3)
      expect(config.attestationSigner.threshold).to.equal(1)
      expect(defaults.attestation_key_count).to.equal(2)
      expect(defaults.attestation_threshold).to.equal(1)
      command('setup', 'attestation-signer', '--json')
      expect(toml.parse(fs.readFileSync(path.join(root, '.data/setup_defaults.toml'), 'utf8'))).to.deep.equal(defaults)
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })
})
