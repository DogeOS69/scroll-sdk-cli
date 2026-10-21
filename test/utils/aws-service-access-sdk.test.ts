/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic integration spec and Helm values. */
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {Wallet} from 'ethers'
import * as yaml from 'js-yaml'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {bindPreparedAwsAccess} from '../../src/utils/aws-service-access.js'
import {createPreparationPlan} from '../../src/utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'
import {createSdkFixture} from '../helpers/sdk-templates.js'

// AWS_ACCESS_TEST_SDK optionally exercises the real companion checkout as well.
describe('AWS access bootstrap integration', () => {
  it('inventories generated Secret aliases and binds the committed SDK output without cloud calls', async function () {
    this.timeout(60_000)
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-access-sdk-'))
    try {
      let sdk = process.env.AWS_ACCESS_TEST_SDK
      if (!sdk) {
        sdk = path.join(temp, 'sdk'); fs.mkdirSync(sdk); createSdkFixture(sdk)
        fs.writeFileSync(path.join(sdk, 'examples/values/dogecoin-production.yaml'), yaml.dump({externalSecrets: {'dogecoin-secret-env': {data: [{remoteRef: {key: 'legacy-example/rpc-credentials', property: 'DOGECOIN_RPC_PASSWORD'}, secretKey: 'password'}], provider: 'aws'}}}))
        execFileSync('git', ['-C', sdk, 'add', 'examples/values/dogecoin-production.yaml'])
        execFileSync('git', ['-C', sdk, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture with legacy example alias'], {stdio: 'pipe'})
      }

      const spec: any = yaml.load(fs.readFileSync('test/fixtures/deployment-spec/minimal.yaml', 'utf8').replaceAll('$ENV:OWNER_ADDRESS', Wallet.createRandom().address).replaceAll(/\$ENV:[A-Z_a-z]\w*/g, 'NONFUNCTIONAL_TEST_PLACEHOLDER'))
      spec.metadata.name = 'fixture'
      spec.infrastructure = {aws: {accountId: '000000000000', eksClusterName: 'fixture', region: 'us-east-1'}, bootnodeCount: 1, namespace: 'fixture', provider: 'aws', sequencerCount: 2}
      spec.contracts.feeVaultDogeRecipientAddress = new bitcore.PrivateKey(null, bitcore.Networks.testnet).toAddress().toString()
      spec.bridge.confirmationsRequired = 2
      spec.images = {services: Object.fromEntries(['l2Rpc', 'l2Sequencer', 'l2Bootnode'].map(key => [key, {tag: 'fixture-release'}]))}
      spec.identities = {bootnodes: [{index: 0, nodekey: {action: 'create'}}], ethDaSubmitter: {action: 'create', backend: 'local'}, feeOracle: {action: 'create', backend: 'local'}, sequencers: [0, 1].map(index => ({index, nodekey: {action: 'create'}, signer: {action: 'create', backend: 'local'}}))}
      spec.proofTopology = {active: {artifactStore: {kind: 'local_fs'}, profile: 'withdrawal_mock_prover', realScroll: {}, workerLaunch: 'local_cpu'}, compiler: {identityFilePath: '.data/compiler.json', image: {digest: `sha256:${'a'.repeat(64)}`, repository: 'example.invalid/compiler'}}, deployment: {proverPublicUrl: 'https://proof.example.invalid'}, enforcement: 'observe', generation: 'mock', mode: 'disabled', observeRealProofDeadlineMs: 1000}
      spec.preparation = {bridge: {image: `dogeos69/bridge-genesis-tools@sha256:${'b'.repeat(64)}`, mode: 'helper'}, proofMaterials: {mode: 'existing'}}
      spec.attestationSigners = Array.from({length: 3}, (_, index) => ({attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: `partner-${index}`, transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}))
      spec.bridge.initialAttestationKeyset = {signerIds: spec.attestationSigners.map((signer: any) => signer.name), threshold: 2}
      const input = path.join(temp, 'intent.yaml'); const out = path.join(temp, 'deployment')
      fs.writeFileSync(input, yaml.dump(spec))
      const plan = await createPreparationPlan({output: out, sdkDirectory: sdk, spec: input, staged: true})
      const frozen = JSON.parse(fs.readFileSync(path.join(out, '.scrollsdk/intent.json'), 'utf8'))
      await new CommandPreparationRunner().run(plan.steps.find(step => step.id === 'bootstrap')!, frozen, out, plan)
      const access = JSON.parse(fs.readFileSync(path.join(out, '.scrollsdk/aws-service-access.json'), 'utf8'))
      const record = {...access, account: '000000000000', reader: {...access.reader, roleArn: `arn:aws:iam::000000000000:role/${access.reader.roleName}`} , runtime: {}}
      fs.writeFileSync(path.join(out, '.data/aws-service-access.json'), JSON.stringify(record))
      bindPreparedAwsAccess(out)
      expect(frozen.preparation.awsAccess.mode).equal('managed')
      expect(plan.steps.find(step => step.id === 'aws-access')!.stage).equal('aws')
      expect(access.serviceSecrets.dogecoin).deep.equal([`${access.prefix}/dogecoin-secret-env`])
      const values = yaml.load(fs.readFileSync(path.join(out, 'values/dogecoin-production.yaml'), 'utf8')) as any
      expect(values.externalSecrets['dogecoin-secret-env'].serviceAccount).equal('external-secrets')
      expect(values.externalSecrets['dogecoin-secret-env'].data[0].remoteRef.key).equal(`${access.prefix}/dogecoin-secret-env`)
      const reader = yaml.load(fs.readFileSync(path.join(out, 'manifests/aws-secret-reader.yaml'), 'utf8')) as any
      expect(reader.metadata.name).equal('external-secrets')
      expect(reader.metadata.annotations['eks.amazonaws.com/role-arn']).equal(record.reader.roleArn)
      expect(fs.existsSync(path.join(out, 'values/aws-access-production.yaml'))).false
    } finally {fs.rmSync(temp, {force: true, recursive: true})}
  })
})
