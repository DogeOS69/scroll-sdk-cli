import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {productionFeeWallet} from '../../src/utils/preparation-fee-wallet.js'
import {AwaitingInput} from '../../src/utils/preparation-io.js'
import {preparationSteps, validatePreparation} from '../../src/utils/preparation-plan.js'

describe('production fee wallet from the conventional environment variable', () => {
  let root: string
  let original: string | undefined
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-wallet-test-'))
    original = process.env.DOGECOIN_FEE_WALLET_KEY
    delete process.env.DOGECOIN_FEE_WALLET_KEY
  })
  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
    if (original === undefined) delete process.env.DOGECOIN_FEE_WALLET_KEY
    else process.env.DOGECOIN_FEE_WALLET_KEY = original
  })

  for (const network of ['mainnet', 'testnet', 'regtest'] as const) {
    it(`derives and pins the ${network} funding identity without storing private material`, () => {
      const selected = network === 'mainnet' ? bitcore.Networks.livenet : network === 'testnet' ? bitcore.Networks.testnet : bitcore.Networks.regtest
      const key = new bitcore.PrivateKey(undefined, selected)
      process.env.DOGECOIN_FEE_WALLET_KEY = key.toWIF()
      const spec = {dogecoin: {network}} as DeploymentSpec
      const identity = productionFeeWallet(root, spec)
      expect(identity.publicKey).to.equal(key.toPublicKey().toString())
      expect(identity.address).to.equal(key.toPublicKey().toAddress(selected).toString())
      expect(productionFeeWallet(root, spec)).to.deep.equal(identity)
      const saved = fs.readFileSync(path.join(root, '.data/bridge-fee-wallet.json'), 'utf8')
      expect(Object.keys(JSON.parse(saved))).to.have.members(['address', 'network', 'publicKey', 'schema'])
      expect(saved).not.to.include(key.toWIF())
      expect(saved).not.to.include(key.toString())
      process.env.DOGECOIN_FEE_WALLET_KEY = new bitcore.PrivateKey(undefined, selected).toWIF()
      expect(() => productionFeeWallet(root, spec)).to.throw('identity differs')
      expect(fs.readFileSync(path.join(root, '.data/bridge-fee-wallet.json'), 'utf8')).to.equal(saved)
    })
  }

  it('waits for valid compressed WIF for the selected network without exposing rejected input', () => {
    const spec = {dogecoin: {network: 'testnet'}} as DeploymentSpec
    const mainnet = new bitcore.PrivateKey(undefined, bitcore.Networks.livenet)
    const uncompressed = Reflect.construct(bitcore.PrivateKey, [{bn: mainnet.toString(), compressed: false, network: 'testnet'}]) as bitcore.PrivateKey
    for (const invalid of [undefined, 'REPLACE_WITH_DOGECOIN_FEE_WALLET_WIF', mainnet.toWIF(), mainnet.toString(), uncompressed.toWIF()]) {
      if (invalid === undefined) delete process.env.DOGECOIN_FEE_WALLET_KEY
      else process.env.DOGECOIN_FEE_WALLET_KEY = invalid
      let failure: unknown
      try {productionFeeWallet(root, spec)} catch (error) {failure = error}
      expect(failure).to.be.instanceOf(AwaitingInput)
      expect((failure as Error).message).to.include('deployment.env')
      if (invalid) expect((failure as Error).message).not.to.include(invalid)
      expect(fs.existsSync(path.join(root, '.data/bridge-fee-wallet.json'))).to.equal(false)
    }
  })

  it('plans without the fee key and rejects redundant spec inputs instead of retaining compatibility', () => {
    const publicKey = new bitcore.PrivateKey().toPublicKey().toString()
    const spec = {attestationSigners: [{attestationPubkey: new bitcore.PrivateKey().toPublicKey().toString(), name: 'partner-a', transportPubkey: new bitcore.PrivateKey().toPublicKey().toString()}], bridge: {confirmationsRequired: 6, teePubkey: publicKey, thresholds: {attestation: 1, recovery: 1}, timelock: 100_000}, dogecoin: {network: 'testnet'}, infrastructure: {aws: {eksClusterName: 'fixture', region: 'us-west-2'}, provider: 'aws'}, preparation: {bridge: {image: `dogeos69/bridge-genesis-tools@sha256:${'a'.repeat(64)}`, mode: 'production', production: {ethereumAnchor: {blockTag: 'finalized'}, recoveryPublicKeys: [publicKey], sequencerKms: {action: 'create'}}}, proofMaterials: {mode: 'existing'}}} as DeploymentSpec
    validatePreparation(spec)
    const steps = preparationSteps(spec)
    const feeIndex = steps.findIndex(step => step.id === 'bridge-fee-wallet')
    expect(feeIndex).to.be.greaterThan(-1)
    expect(steps[feeIndex].effect).to.equal('local')
    expect(feeIndex).to.be.lessThan(steps.findIndex(step => step.id === 'bridge-sequencer-kms'))
    for (const field of ['feeWalletPublicKey', 'feeWalletKeyEnv']) {
      const invalid = structuredClone(spec)
      Object.assign(invalid.preparation!.bridge.production!, {[field]: 'NONFUNCTIONAL'})
      expect(() => validatePreparation(invalid)).to.throw('Remove feeWalletPublicKey and feeWalletKeyEnv')
    }
  })
})
