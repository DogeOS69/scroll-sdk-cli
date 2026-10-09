/* eslint-disable @typescript-eslint/no-explicit-any -- AWS and command fixtures. */
import * as toml from '@iarna/toml'
import {Config} from '@oclif/core'
import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import {generateKeyPairSync} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import BridgeInit from '../../src/commands/setup/bridge-init.js'
import SetupGenSecrets from '../../src/commands/setup/gen-secrets.js'
import PrepCharts from '../../src/commands/setup/prep-charts.js'
import {generateAllConfigs, normalizeDeploymentSpec} from '../../src/utils/deployment-spec-generator.js'
import {prepareProductionWallets, publicKeyAddress} from '../../src/utils/preparation-funding.js'
import {AwaitingInput} from '../../src/utils/preparation-io.js'
import {preparationSteps, validatePreparation} from '../../src/utils/preparation-plan.js'
import {prepareSequencerKms, productionSequencer} from '../../src/utils/preparation-sequencer-kms.js'
import {buildProofAwsConfig, writeProofAwsConfig} from '../../src/utils/proof-aws-config.js'
import {generateValuesFiles} from '../../src/utils/values-generator.js'
import {mergeWithdrawalManagedDeploymentBlock} from '../../src/utils/withdrawal-config.js'
import {reconcileWithdrawalSignerValues, withdrawalSequencerKms} from '../../src/utils/withdrawal-signers.js'

describe('production Bridge sequencer KMS', () => {
  let root: string
  let spec: DeploymentSpec
  let calls: string[][]
  let publicDer: string
  let keyExists: boolean
  let aliasExists: boolean
  let failPolicy: boolean
  let originalFeeKey: string | undefined
  const account = '123456789012'
  const region = 'us-west-2'
  const keyArn = `arn:aws:kms:${region}:${account}:key/disposable-fixture`
  const issuer = `oidc.eks.${region}.amazonaws.com/id/FIXTURE`
  const feeKey = () => new bitcore.PrivateKey(undefined, bitcore.Networks.testnet)
  const metadata = () => ({Arn: keyArn, KeySpec: 'ECC_SECG_P256K1', KeyState: 'Enabled', KeyUsage: 'SIGN_VERIFY'})
  function response(args: string[]): any {
    calls.push(args)
    switch (args[1]) {
      case 'get-caller-identity': { return {Account: account}
      }

      case 'describe-key': {
        if (!keyExists || args[3].startsWith('alias/') && !aliasExists) throw new Error('NotFoundException')
        return {KeyMetadata: metadata()}
      }

      case 'create-key': { keyExists = true; return {KeyMetadata: metadata()}
      }

      case 'create-alias': { aliasExists = true; return {}
      }

      case 'get-public-key': { return {KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY', PublicKey: publicDer, SigningAlgorithms: ['ECDSA_SHA_256']}
      }

      case 'describe-cluster': { return {cluster: {identity: {oidc: {issuer: `https://${issuer}`}}}}
      }

      case 'get-open-id-connect-provider': { return {}
      }

      case 'get-role': { return {Role: {Arn: `arn:aws:iam::${account}:role/${args[3]}`, AssumeRolePolicyDocument: {Statement: [{Action: 'sts:AssumeRoleWithWebIdentity', Condition: {StringEquals: {[`${issuer}:aud`]: 'sts.amazonaws.com', [`${issuer}:sub`]: 'system:serviceaccount:test:withdrawal-processor'}}, Effect: 'Allow', Principal: {Federated: `arn:aws:iam::${account}:oidc-provider/${issuer}`}}]}}}
      }

      case 'put-role-policy': { if (failPolicy) throw new Error('Injected policy failure'); return {}
      }

      case 'simulate-principal-policy': { return {EvaluationResults: ['kms:GetPublicKey', 'kms:Sign'].map(EvalActionName => ({EvalActionName, EvalDecision: 'allowed', EvalResourceName: keyArn}))}
      }

      default: { throw new Error(`Unexpected AWS operation ${args[1]}`)
      }
    }
  }

  const runner = () => ({json: response}) as any
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-kms-test-'))
    calls = []; keyExists = false; aliasExists = false; failPolicy = false
    publicDer = generateKeyPairSync('ec', {namedCurve: 'secp256k1'}).publicKey.export({format: 'der', type: 'spki'}).toString('base64')
    originalFeeKey = process.env.DOGECOIN_FEE_WALLET_KEY
    const fee = feeKey()
    process.env.DOGECOIN_FEE_WALLET_KEY = fee.toWIF()
    const publicKey = fee.toPublicKey().toString()
    spec = {attestationSigners: [{attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: 'partner-a', transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}], bridge: {confirmationsRequired: 6, teePubkey: publicKey, thresholds: {attestation: 1, recovery: 2}, timelock: 100_000}, dogecoin: {network: 'testnet'}, images: {services: {withdrawalProcessor: {tag: 'v0.3.0-beta.6-kms'}}}, infrastructure: {aws: {accountId: account, eksClusterName: 'cluster', region}, namespace: 'test', provider: 'aws'}, metadata: {name: 'test'}, preparation: {bridge: {image: `dogeos69/bridge-genesis-tools@sha256:${'a'.repeat(64)}`, mode: 'production', production: {ethereumAnchor: {blockTag: 'finalized'}, recoveryPublicKeys: [publicKey, feeKey().toPublicKey().toString()], sequencerKms: {action: 'create'}}}, proofMaterials: {mode: 'existing'}}} as DeploymentSpec
  })
  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
    if (originalFeeKey === undefined) delete process.env.DOGECOIN_FEE_WALLET_KEY
    else process.env.DOGECOIN_FEE_WALLET_KEY = originalFeeKey
  })

  it('plans creation without a sequencer private key, public key or AWS call', () => {
    validatePreparation(spec)
    const steps = preparationSteps(spec)
    expect(steps.find(s => s.id === 'bridge-sequencer-kms')?.effect).to.equal('cloud')
    expect(steps.findIndex(s => s.id === 'bridge-sequencer-kms')).to.be.lessThan(steps.findIndex(s => s.id === 'production-wallets'))
    expect(calls).to.have.length(0)
    const policy = spec.preparation!.bridge.production!
    policy.sequencerKeyEnv = 'UNUSED_KEY'
    expect(() => validatePreparation(spec)).to.throw('replaces')
    delete policy.sequencerKeyEnv
    spec.images!.services!.withdrawalProcessor!.tag = 'v0.3.0-beta.6'
    expect(() => validatePreparation(spec)).to.throw('KMS-enabled image')
  })

  it('creates once, pins the immutable ARN/public key and resumes after an IAM failure', () => {
    failPolicy = true
    expect(() => prepareSequencerKms(root, spec, runner())).to.throw('Injected')
    expect(() => productionSequencer(root, spec)).to.throw('incomplete')
    failPolicy = false
    prepareSequencerKms(root, spec, runner())
    const first = productionSequencer(root, spec)
    expect(first.kms?.key_id).to.equal(keyArn)
    expect(first.publicKey).to.match(/^(02|03)[\da-f]{64}$/)
    prepareSequencerKms(root, spec, runner())
    expect(productionSequencer(root, spec)).to.deep.equal(first)
    expect(calls.filter(args => args[1] === 'create-key')).to.have.length(1)
    expect(calls.filter(args => args[1] === 'create-alias')).to.have.length(1)
    expect(JSON.stringify(fs.readFileSync(path.join(root, '.data/bridge-sequencer-kms.json'), 'utf8'))).not.to.include('privateKey')
  })

  it('reuses an existing key and role without AWS writes and rejects a changed public identity', () => {
    keyExists = true
    spec.preparation!.bridge.production!.sequencerKms = {action: 'reuse', keyId: keyArn, roleArn: `arn:aws:iam::${account}:role/existing-wp`}
    validatePreparation(spec)
    prepareSequencerKms(root, spec, runner())
    expect(calls.some(args => /^(create|put|update|delete)/.test(args[1]))).to.equal(false)
    expect(preparationSteps(spec).find(s => s.id === 'bridge-sequencer-kms')?.effect).to.equal('read')
    publicDer = generateKeyPairSync('ec', {namedCurve: 'secp256k1'}).publicKey.export({format: 'der', type: 'spki'}).toString('base64')
    expect(() => prepareSequencerKms(root, spec, runner())).to.throw('identity changed')
  })

  it('creates a dedicated IRSA role when no proof workload role exists', () => {
    prepareSequencerKms(root, spec, {json(args: string[]) {
      if (args[1] === 'get-role') throw new Error('NoSuchEntity')
      if (args[1] === 'create-role') {
        calls.push(args)
        return {Role: {Arn: `arn:aws:iam::${account}:role/${args[3]}`, AssumeRolePolicyDocument: JSON.parse(args[5])}}
      }

      return response(args)
    }} as any)
    const created = calls.find(args => args[1] === 'create-role')!
    const trust = JSON.parse(created[5]).Statement[0]
    expect(trust.Condition.StringEquals[`${issuer}:sub`]).to.equal('system:serviceaccount:test:withdrawal-processor')
    expect(productionSequencer(root, spec).roleArn).to.equal(`arn:aws:iam::${account}:role/${created[3]}`)
  })

  it('adds KMS permission to the proof workload role without changing its S3 policies or trust', () => {
    const withdrawalRoleArn = `arn:aws:iam::${account}:role/existing-wp-proof`
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), buildProofAwsConfig({coordinatorServiceAccount: 'proof-coordinator', identity: {awsRegion: region, deploymentAlias: 'test', eksCluster: 'cluster', namespace: 'test'}, keyPrefix: 'proofs', provisioned: {artifactReadTransport: {publicEndpointUrl: `https://s3.${region}.amazonaws.com`, publicReadMode: 'existing-public-s3', publicStatus: 'operator-managed-unverified'}, bucket: 'fixture-proof-bucket', bucketCreated: false, coordinatorRoleArn: `arn:aws:iam::${account}:role/proof`, secretAction: 'reused', secretName: 'fixture-proof', withdrawalRoleArn}, withdrawalServiceAccount: 'withdrawal-processor'}))
    prepareSequencerKms(root, spec, runner())
    expect(productionSequencer(root, spec).roleArn).to.equal(withdrawalRoleArn)
    const grant = calls.find(args => args[1] === 'put-role-policy')!
    expect(grant[3]).to.equal('existing-wp-proof')
    expect(grant[5]).to.equal('dogeos-bridge-sequencer-kms')
    expect(JSON.parse(grant[7]).Statement[0]).to.deep.equal({Action: ['kms:GetPublicKey', 'kms:Sign'], Effect: 'Allow', Resource: keyArn})
    expect(calls.some(args => args[1] === 'update-assume-role-policy')).to.equal(false)
  })

  it('rejects wrong AWS accounts, workload trust and denied signing access', () => {
    keyExists = true
    spec.preparation!.bridge.production!.sequencerKms = {action: 'reuse', keyId: keyArn, roleArn: `arn:aws:iam::${account}:role/existing-wp`}
    for (const [operation, replacement, message] of [
      ['get-caller-identity', {Account: '999999999999'}, 'AWS account differs'],
      ['get-role', {Role: {Arn: `arn:aws:iam::${account}:role/existing-wp`, AssumeRolePolicyDocument: {Statement: []}}}, 'does not trust'],
      ['simulate-principal-policy', {EvaluationResults: []}, 'must allow'],
    ] as const) {
      expect(() => prepareSequencerKms(root, spec, {json: (args: string[]) => args[1] === operation ? replacement : response(args)} as any)).to.throw(message)
      expect(() => productionSequencer(root, spec)).to.throw()
    }

    expect(calls.some(args => /^(create|put|update|delete)/.test(args[1]))).to.equal(false)
  })

  it('requests funding to the KMS public-key address without a sequencer WIF', async () => {
    const fee = feeKey()
    process.env.DOGECOIN_FEE_WALLET_KEY = fee.toWIF()
    prepareSequencerKms(root, spec, runner())
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), 'fee_wallet_target_amount=100000000\n')
    let waiting: unknown
    try {await prepareProductionWallets(root, spec, async method => {
      if (method === 'getblockchaininfo') return {chain: 'test'}
      if (method === 'getblockcount') return 1000
      throw new Error(`Unexpected RPC ${method}`)
    })} catch (error) {waiting = error}

    expect(waiting).to.be.instanceOf(AwaitingInput)
    expect((waiting as AwaitingInput).details.fundingRequests?.[0].address).to.equal(publicKeyAddress(productionSequencer(root, spec).publicKey, 'testnet'))
    expect((waiting as AwaitingInput).details.fundingRequests?.[0].amountSats).to.equal(42_069_000)

    const requests = (waiting as AwaitingInput).details.fundingRequests!
    const transaction = new Transaction()
    transaction.addInput(Buffer.alloc(32, 1), 0)
    for (const request of requests) transaction.addOutput(Buffer.from(bitcore.Script.fromAddress(request.address).toHex(), 'hex'), BigInt(request.amountSats))
    const txid = transaction.getId()
    fs.writeFileSync(path.join(root, '.scrollsdk/inputs/bridge-funding.json'), JSON.stringify({feeWallet: {txid, vout: 1}, sequencer: {txid, vout: 0}}))
    fs.writeFileSync(path.join(root, '.data/setup_defaults.toml'), toml.stringify({attestation_pubkeys: [feeKey().toPublicKey().toString()], attestation_threshold: 1, fee_wallet_target_amount: 100_000_000}))
    await prepareProductionWallets(root, spec, async (method, params) => {
      switch (method) {
        case 'getblockchaininfo': { return {chain: 'test'}
        }

        case 'getblockcount': { return 1000
        }

        case 'getrawtransaction': { return {blockhash: 'a'.repeat(64), hex: transaction.toHex()}
        }

        case 'gettxout': {
          const output = transaction.outs[params[1] as number]
          return {confirmations: 6, scriptPubKey: {hex: Buffer.from(output.script).toString('hex')}, value: Number(output.value) / 100_000_000}
        }

        case 'getblockheader': { return {confirmations: 6, height: 900}
        }

        case 'getblockhash': { return 'a'.repeat(64)
        }

        default: { throw new Error(`Unexpected RPC ${method}`)
        }
      }
    })
    const outputPath = path.join(root, '.data/output-withdrawal-processor.toml')
    const output = toml.parse(fs.readFileSync(outputPath, 'utf8'))
    expect(output.sequencer_signer_kms).to.deep.equal(productionSequencer(root, spec).kms)
    expect(output).not.to.have.property('sequencer_signer_key')
    expect(output.fee_signer_key).to.equal('$ENV:DOGECOIN_FEE_WALLET_KEY')

    const secretPath = path.join(root, '.data/withdrawal-processor-secret.env')
    fs.writeFileSync(secretPath, 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY=NONFUNCTIONAL_OLD_KEY\nKEEP=NONFUNCTIONAL\n')
    const command = Object.create(BridgeInit.prototype) as any
    command.jsonCtx = {info() {}}
    command.materializeWithdrawalProcessorSecrets({withdrawalProcessorSecretPath: secretPath, withdrawalProcessorTomlPath: outputPath})
    const secret = fs.readFileSync(secretPath, 'utf8')
    expect(secret).to.include('KEEP=NONFUNCTIONAL')
    expect(secret).to.include('DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY=')
    expect(secret).not.to.include('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY')
  })

  it('renders native KMS config and removes stale WIF/environment/ExternalSecret references', () => {
    prepareSequencerKms(root, spec, runner())
    const kms = productionSequencer(root, spec).kms!
    const config = {sequencer_signer_kms: kms}
    const values: any = {env: [{name: 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY', value: 'NONFUNCTIONAL'}, {name: 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KMS__KEY_ID', value: 'stale'}], externalSecrets: {wp: {data: [{secretKey: 'DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY'}, {secretKey: 'DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY'}]}}}
    expect(reconcileWithdrawalSignerValues(values, config)).to.equal(true)
    expect(values.env).to.have.length(0)
    expect(values.externalSecrets.wp.data).to.deep.equal([{secretKey: 'DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY'}])
    const rendered = mergeWithdrawalManagedDeploymentBlock('sequencer_signer_key="NONFUNCTIONAL"\n', {sequencer_signer_kms: kms}, {deletePaths: [['sequencer_signer_key']]})
    expect(toml.parse(rendered).sequencer_signer_kms).to.deep.equal(kms)
    expect(toml.parse(rendered)).not.to.have.property('sequencer_signer_key')
    expect(() => withdrawalSequencerKms({...config, sequencer_signer_key: 'NONFUNCTIONAL'})).to.throw('mutually exclusive')
  })

  it('generates only the fee-wallet WIF secret for KMS sequencing', () => {
    prepareSequencerKms(root, spec, runner())
    fs.writeFileSync(path.join(root, '.data/output-withdrawal-processor.toml'), toml.stringify({fee_signer_key: 'NONFUNCTIONAL_FEE_WIF', sequencer_signer_kms: productionSequencer(root, spec).kms!}))
    const command = Object.create(SetupGenSecrets.prototype) as any
    command.dogeConfig = {dogecoinClusterRpc: {password: 'NONFUNCTIONAL_PASSWORD', username: 'NONFUNCTIONAL_USER'}}
    const previous = process.cwd()
    try {
      process.chdir(root)
      const generated = command.generateEnvContent('withdrawal-processor', {})['withdrawal-processor-secret.env']
      expect(generated).to.include('DOGEOS_WITHDRAWAL_FEE_SIGNER_KEY')
      expect(generated).not.to.include('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY')
      expect(generated).not.to.include('KMS__')
    } finally {process.chdir(previous)}
  })

  it('keeps native KMS configuration and IRSA through repeated chart preparation', async () => {
    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const minimal = normalizeDeploymentSpec(yaml.load(fs.readFileSync(path.join(cliRoot, 'src/config/deployment-spec.minimal.yaml'), 'utf8')
      .replaceAll('$ENV:OWNER_ADDRESS', '0x0000000000000000000000000000000000000001')
      .replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER')) as DeploymentSpec)
    spec = {...minimal, ...spec, bridge: {...minimal.bridge, ...spec.bridge}, dogecoin: {...minimal.dogecoin, ...spec.dogecoin}}
    spec.bridge.initialAttestationKeyset = {signerIds: ['partner-a'], threshold: 1}
    prepareSequencerKms(root, spec, runner())
    const sequencer = productionSequencer(root, spec)
    const configs = generateAllConfigs(spec)
    const main = toml.parse(configs['config.toml']) as any
    const doge = toml.parse(configs['doge-config.toml']) as any
    doge.signers = main.signers
    doge.accounts = {L1_COMMIT_SENDER_ADDR: '0x0000000000000000000000000000000000000001'}
    doge.defaults.dogecoinIndexerStartHeight = 100
    const valuesDir = path.join(root, 'values')
    const nativeFile = path.join(root, 'withdrawal-processor/WithdrawalProcessor.toml')
    fs.mkdirSync(valuesDir)
    fs.mkdirSync(path.dirname(nativeFile))
    fs.writeFileSync(nativeFile, 'sequencer_signer_key="NONFUNCTIONAL_OLD_KEY"\n[operator_tuning]\nkeep=true\n')
    const valuesFile = path.join(valuesDir, 'withdrawal-processor-production.yaml')
    const generated = generateValuesFiles(spec)['withdrawal-processor-production.yaml']
    expect(generated).not.to.include('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY')
    delete spec.images
    expect((yaml.load(generateValuesFiles(spec)['withdrawal-processor-production.yaml']) as any).image.tag).to.equal('v0.3.0-beta.6-kms')
    fs.writeFileSync(valuesFile, generated)
    const command: any = new PrepCharts([], await Config.load({root: cliRoot}))
    Object.assign(command, {
      bridgeConfig: {redeem_script_hex: '51'}, configData: {...main, ethereumDa: doge.ethereumDa},
      contractsConfig: {L2_DOGEOS_MESSENGER_PROXY_ADDR: '0x0000000000000000000000000000000000000001', L2_MESSAGE_QUEUE_ADDR: '0x0000000000000000000000000000000000000002'},
      dogeConfig: doge, flags: {}, jsonCtx: {addWarning() {}, info() {}, logSuccess() {}},
      jsonMode: true, log() {}, nonInteractive: true,
      withdrawalProcessorConfig: {genesis_sequencer_tx_hex: '01000000', network_str: 'testnet', sequencer_signer_kms: sequencer.kms},
    })
    const previous = process.cwd()
    try {
      process.chdir(root)
      await command.processProductionYaml(valuesDir)
      const native = toml.parse(fs.readFileSync(nativeFile, 'utf8'))
      const values = yaml.load(fs.readFileSync(valuesFile, 'utf8')) as any
      expect(native.sequencer_signer_kms).to.deep.equal(sequencer.kms)
      expect(native).not.to.have.property('sequencer_signer_key')
      expect(native.operator_tuning).to.deep.equal({keep: true})
      expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).to.equal(sequencer.roleArn)
      expect(values.serviceAccount.name).to.equal(sequencer.serviceAccount)
      expect(fs.readFileSync(valuesFile, 'utf8')).not.to.include('DOGEOS_WITHDRAWAL_SEQUENCER_SIGNER_KEY')
      const first = [fs.readFileSync(nativeFile, 'utf8'), fs.readFileSync(valuesFile, 'utf8')]
      await command.processProductionYaml(valuesDir)
      expect([fs.readFileSync(nativeFile, 'utf8'), fs.readFileSync(valuesFile, 'utf8')]).to.deep.equal(first)
    } finally {process.chdir(previous)}
  })
})
