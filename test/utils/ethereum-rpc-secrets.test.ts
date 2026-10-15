import * as toml from '@iarna/toml'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {BridgeInitCommand} from '../../src/commands/setup/bridge-init.js'
import SetupGenSecrets from '../../src/commands/setup/gen-secrets.js'
import {ETHEREUM_RPC_KEYS, ethereumRpcSecretLines, ethereumRpcSecretName, proofCoordinatorRpcKeys, readEthereumRpcSecretStore, reconcileEthereumRpcSecrets, resolveEthereumRpc, sanitizeEthereumRpcToml} from '../../src/utils/ethereum-rpc-secrets.js'

describe('Ethereum provider Secret projection', () => {
  const fake = 'https://provider.example.invalid/v1/FAKE_API_KEY_FOR_TESTS'
  for (const [service, fields] of Object.entries(ETHEREUM_RPC_KEYS)) {
    it(`removes stale plaintext and idempotently binds ${service}`, () => {
      const keys = Object.keys(fields)
      const values: any = {
        configMaps: {env: {data: Object.fromEntries(keys.map(key => [key, fake]))}},
        env: keys.map(name => ({name, value: fake})),
      }
      expect(reconcileEthereumRpcSecrets(values, service, {awsRegion: 'us-west-2', prefix: 'operator', provider: 'aws'})).eq(true)
      expect(JSON.stringify(values)).not.contains(fake)
      const name = ethereumRpcSecretName(service)
      expect(values.externalSecrets[name].data.map((entry: any) => entry.secretKey)).deep.eq(keys)
      expect(values.externalSecrets[name].data.every((entry: any) => entry.remoteRef.key === `operator/${name}`)).eq(true)
      expect(reconcileEthereumRpcSecrets(values, service, {awsRegion: 'us-west-2', prefix: 'operator', provider: 'aws'})).eq(false)
    })
  }

  it('reconciles a copied template destination without changing proof-owned Secrets', () => {
    const name = ethereumRpcSecretName('proof-coordinator')
    const proofOwned = {data: [{remoteRef: {key: 'proof-owned/token', property: 'token'}, secretKey: 'token'}], provider: 'aws'}
    const values: any = {externalSecrets: {[name]: {data: [{remoteRef: {key: 'old/shared', property: 'stale'}, secretKey: 'stale'}], provider: 'aws', secretRegion: 'us-west-2'}, 'proof-token': structuredClone(proofOwned)}}
    reconcileEthereumRpcSecrets(values, 'proof-coordinator', {awsRegion: 'us-east-1', prefix: 'dogeos/cluster/namespace/name', provider: 'aws'})
    expect(values.externalSecrets[name].secretRegion).eq('us-east-1')
    expect(values.externalSecrets[name].data.filter((entry: any) => entry.secretKey !== 'stale').every((entry: any) => entry.remoteRef.key === `dogeos/cluster/namespace/name/${name}`)).eq(true)
    expect(values.externalSecrets['proof-token']).deep.eq(proofOwned)
    reconcileEthereumRpcSecrets(values, 'proof-coordinator', {gcpProject: 'fake-project', prefix: 'fake-project', provider: 'gcp'})
    expect(values.externalSecrets[name].provider).eq('gcpsm')
    expect(values.externalSecrets[name].projectID).eq('fake-project')
    expect(values.externalSecrets[name]).not.have.property('secretRegion')
  })
  it('exports independent fee-market credentials and does not share them with balance monitoring', () => {
    const config: any = {ethereumDa: {beaconRpcUrl: 'https://beacon.example.invalid/FAKE_BEACON_KEY', submitterRpcUrl: fake}, feeOracle: {ethereumRpcUrl: 'https://mainnet.example.invalid/FAKE_FEE_KEY'}}
    expect(ethereumRpcSecretLines('fee-oracle', config)).contains('FAKE_FEE_KEY').not.contains(fake)
    expect(ethereumRpcSecretLines('scroll-monitor', config)).contains(fake).not.contains('FAKE_FEE_KEY')
    expect(ethereumRpcSecretLines('l1-interface', config)).contains('FAKE_BEACON_KEY')
  })
  it('retains endpoint-only Secret files for KMS signers without exporting signing keys', () => {
    const command: any = Object.create(SetupGenSecrets.prototype)
    command.dogeConfig = {ethereumDa: {submitterRpcUrl: fake}, feeOracle: {ethereumRpcUrl: fake}, signers: {l1CommitSender: {backend: 'aws_kms'}, l2GasOracleSender: {backend: 'aws_kms'}}}
    for (const service of ['eth-da-submitter', 'fee-oracle']) {
      const files = command.generateEnvContent(service, {})
      const content = files[`${service}-secret.env`]
      expect(content).contains(fake).not.contains('PRIVATE_KEY')
    }
  })

  it('resolves the env value only at private export or local execution and redacts malformed input', () => {
    process.env.ETHEREUM_RPC_TEST_INPUT = fake
    try {
      expect(resolveEthereumRpc('$ENV:ETHEREUM_RPC_TEST_INPUT', 'execution')).eq(fake)
      expect(() => resolveEthereumRpc('file:///FAKE_SECRET', 'execution')).throws('value omitted')
    } finally {delete process.env.ETHEREUM_RPC_TEST_INPUT}

    expect(() => resolveEthereumRpc('$ENV:ETHEREUM_RPC_TEST_INPUT', 'execution')).throws('Set ETHEREUM_RPC_TEST_INPUT')
  })
  it('sanitizes all native compiler input tables without changing non-RPC policy', () => {
    const source = toml.stringify({ethereum: {chain_id: 1, rpc_url: fake}, ethereum_da: {blob_source: {beacon_node: {url: fake}, timeout_ms: 1234}, l1_rpc_url: fake}, materializer: {bridge: {ethereum_da: {l1_rpc_url: fake}}, scroll_batch: {subprocess: {ethereum_da: {l1_rpc_url: fake}}}}})
    const sanitized = sanitizeEthereumRpcToml(source)
    expect(sanitized).not.contains(fake)
    const value: any = toml.parse(sanitized)
    expect(value.ethereum.chain_id).eq(1)
    expect(value.ethereum_da.blob_source.timeout_ms).eq(1234)
    expect(sanitizeEthereumRpcToml(sanitized)).eq(sanitized)
  })
  it('projects only existing proof materializers and removes stale real keys in mock mode', () => {
    const source = '[materializer.bridge.ethereum_da]\nl1_rpc_url="http://ethereum-rpc.invalid"\n'
    const selected = proofCoordinatorRpcKeys(source)
    expect(selected).deep.eq(['DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__ETHEREUM_DA__L1_RPC_URL'])
    const values: any = {}
    reconcileEthereumRpcSecrets(values, 'proof-coordinator', {prefix: 'test/cluster/namespace', provider: 'aws'})
    reconcileEthereumRpcSecrets(values, 'proof-coordinator', undefined, selected)
    expect(values.externalSecrets['proof-coordinator-rpc-env'].data.map((entry: any) => entry.secretKey)).deep.eq(selected)
    expect(ethereumRpcSecretLines('proof-coordinator', {network: 'testnet', wallet: {} } as any, selected)).not.contains('BEACON')
    const empty = proofCoordinatorRpcKeys('[materializer.scroll_batch]\nbackend="dev_sentinel"\n')
    reconcileEthereumRpcSecrets(values, 'proof-coordinator', undefined, empty)
    expect(values.envFrom).deep.eq([])
    expect(values.externalSecrets).not.have.property('proof-coordinator-rpc-env')
  })
  it('exports refreshed Dogecoin credentials for existing coordinator materializers without embedding them in values', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-dogecoin-'))
    const previous = process.cwd()
    const source = '[materializer.bridge.dogecoin_rpc]\nurl="http://dogecoin:22555"\nnetwork="testnet"\nuser="FAKE_OLD_USER"\npass="FAKE_OLD_PASSWORD"\n'
    try {
      const sanitized = sanitizeEthereumRpcToml(source)
      expect(sanitized).not.contains('FAKE_OLD_')
      const config: any = toml.parse(sanitized)
      expect(config.materializer.bridge.dogecoin_rpc.url).eq('http://dogecoin:22555')
      expect(config.materializer.bridge.dogecoin_rpc.network).eq('testnet')
      fs.mkdirSync(path.join(root, 'proof-coordinator'))
      fs.writeFileSync(path.join(root, 'proof-coordinator/ProofCoordinator.toml'), sanitized)
      process.chdir(root)
      const command: any = Object.create(SetupGenSecrets.prototype)
      command.dogeConfig = {dogecoinClusterRpc: {password: 'FAKE_NEW_PASSWORD', username: 'FAKE_NEW_USER'}}
      const env = command.generateEnvContent('proof-coordinator', {})['proof-coordinator-rpc.env']
      expect(env).contains('DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__DOGECOIN_RPC__PASS="FAKE_NEW_PASSWORD"')
      expect(env).contains('DOGEOS_PROOF_COORDINATOR_MATERIALIZER__BRIDGE__DOGECOIN_RPC__USER="FAKE_NEW_USER"')
      expect(env).not.contains('FAKE_OLD_').not.contains('ETHEREUM_DA')
      const keys = proofCoordinatorRpcKeys(sanitized)
      const values: any = {}
      reconcileEthereumRpcSecrets(values, 'proof-coordinator', {prefix: 'test/cluster/default', provider: 'aws'}, keys)
      expect(values.envFrom).deep.eq([{secretRef: {name: 'proof-coordinator-rpc-env'}}])
      expect(values.externalSecrets['proof-coordinator-rpc-env'].data.map((item: any) => item.remoteRef.property)).deep.eq(keys)
      expect(JSON.stringify(values)).not.contains('FAKE_NEW_').not.contains('FAKE_OLD_')
      command.dogeConfig.dogecoinClusterRpc.password = 'FAKE_ROTATED_PASSWORD'
      expect(command.generateEnvContent('proof-coordinator', {})['proof-coordinator-rpc.env']).contains('FAKE_ROTATED_PASSWORD').not.contains('FAKE_NEW_PASSWORD')
      delete command.dogeConfig.dogecoinClusterRpc.password
      expect(() => command.generateEnvContent('proof-coordinator', {})).throws('Dogecoin cluster RPC password is required (value omitted)')
    } finally {process.chdir(previous); fs.rmSync(root, {force: true, recursive: true})}
  })

  it('loads only referenced RPC inputs from the saved deployment environment file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-env-'))
    const previous = process.cwd()
    const saved = process.env.ETHEREUM_RPC_TEST_INPUT
    delete process.env.ETHEREUM_RPC_TEST_INPUT
    try {
      fs.mkdirSync(path.join(root, '.scrollsdk'))
      fs.writeFileSync(path.join(root, 'private.env'), `ETHEREUM_RPC_TEST_INPUT=${fake}\nUNRELATED_TEST_SECRET=unused\n`)
      fs.writeFileSync(path.join(root, '.scrollsdk/plan.json'), JSON.stringify({envFile: path.join(root, 'private.env')}))
      process.chdir(root)
      expect(resolveEthereumRpc('$ENV:ETHEREUM_RPC_TEST_INPUT', 'execution')).eq(fake)
      expect(process.env.UNRELATED_TEST_SECRET).to.be.undefined
    } finally {
      process.chdir(previous)
      if (saved === undefined) delete process.env.ETHEREUM_RPC_TEST_INPUT
      else process.env.ETHEREUM_RPC_TEST_INPUT = saved
      fs.rmSync(root, {force: true, recursive: true})
    }
  })

  it('retains the persisted local store on a later standalone reconciliation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-store-'))
    try {
      fs.mkdirSync(path.join(root, '.data'))
      fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[ethereumRpcSecretStore]\nprovider="kubernetes"\nprefix="unused"\n')
      const values: any = {}
      reconcileEthereumRpcSecrets(values, 'fee-oracle', {prefix: 'unused', provider: 'kubernetes'})
      reconcileEthereumRpcSecrets(values, 'fee-oracle', readEthereumRpcSecretStore(root))
      expect(values.externalSecrets).to.be.undefined
    } finally {fs.rmSync(root, {force: true, recursive: true})}
  })

  it('preserves an explicitly operator-owned balance Secret and its L2 settings', () => {
    const values: any = {balanceMonitoring: {ethereum: {ethDaSubmitter: {rpcUrl: ''}, feeOracle: {rpcUrl: ''}}, exporter: {envFromSecret: 'operator-rpc'}}}
    expect(reconcileEthereumRpcSecrets(values, 'scroll-monitor')).eq(false)
    expect(values.balanceMonitoring.exporter.envFromSecret).eq('operator-rpc')
    expect(values.externalSecrets).to.be.undefined
  })

  it('archives an unused coordinator RPC file instead of republishing stale keys', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-retired-'))
    const previous = process.cwd()
    try {
      fs.mkdirSync(path.join(root, 'secrets'))
      fs.writeFileSync(path.join(root, 'config.toml'), '')
      fs.writeFileSync(path.join(root, 'secrets/proof-coordinator-rpc.env'), 'STALE_FAKE_RPC=unused')
      const command: any = Object.create(SetupGenSecrets.prototype)
      Object.assign(command, {dogeConfig: {}, generateEnvContent: () => ({}), generateRethEnvFiles: () => ({}), jsonCtx: {info() {}}})
      process.chdir(root)
      await command.createEnvFiles()
      expect(fs.existsSync(path.join(root, 'secrets/proof-coordinator-rpc.env'))).eq(false)
      expect(fs.readdirSync(path.join(root, 'secrets/.retired-ethereum-rpc'))).length(1)
    } finally {process.chdir(previous); fs.rmSync(root, {force: true, recursive: true})}
  })

  it('passes an in-cluster Ethereum probe endpoint over stdin, never Pod arguments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-probe-'))
    const previousPath = process.env.PATH
    const previousCapture = process.env.RPC_TEST_CAPTURE
    try {
      fs.writeFileSync(path.join(root, 'kubectl'), `#!/usr/bin/env python3
import sys,os,json,pathlib
r=pathlib.Path(os.environ["RPC_TEST_CAPTURE"])
(r/"args.json").write_text(json.dumps(sys.argv[1:]))
(r/"stdin").write_text(sys.stdin.read())
print('{"jsonrpc":"2.0","result":"0x123"}')
`, {mode: 0o700})
      process.env.PATH = `${root}:${previousPath}`
      process.env.RPC_TEST_CAPTURE = root
      const command: any = Object.create(BridgeInitCommand.prototype)
      command.jsonCtx = {info() {}}
      command.kubeContext = 'fake-test-context'
      expect(command.queryEthereumDaRpcViaClusterPod(fake)).contains('0x123')
      expect(fs.readFileSync(path.join(root, 'args.json'), 'utf8')).not.contains(fake).not.contains('ETH_RPC_URL=')
      expect(fs.readFileSync(path.join(root, 'stdin'), 'utf8')).contains(fake)
    } finally {
      process.env.PATH = previousPath
      if (previousCapture === undefined) delete process.env.RPC_TEST_CAPTURE
      else process.env.RPC_TEST_CAPTURE = previousCapture
      fs.rmSync(root, {force: true, recursive: true})
    }
  })

  it('keeps local Kubernetes Secret mode free of external provider references', () => {
    const values: any = {}
    reconcileEthereumRpcSecrets(values, 'fee-oracle', {prefix: 'unused', provider: 'kubernetes'})
    expect(values.externalSecrets).to.be.undefined
    expect(values.envFrom).deep.eq([{secretRef: {name: 'fee-oracle-secret-env'}}])
  })
})
