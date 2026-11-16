import {Transaction} from 'bitcoinjs-lib'
import bitcore from 'bitcore-lib-doge'
import {expect} from 'chai'
import {ECDH, createHash} from 'node:crypto'

import {
  CUBESIGNER_REQUEST_CONTRACT_SEQUENCING_CONSENT_V5,
  CUBESIGNER_REQUEST_CONTRACT_V3,
  SEQUENCING_REDEEM_BYTES,
  assertDedicatedProposerKey,
  cubesignerRequestContract,
  sequencerSeedKind,
  sequencingAddress,
  sequencingRedeemScript,
  sequencingScriptPubkey,
  usesSequencingTwoOfTwo,
} from '../../src/utils/sequencing-two-of-two.js'

// secp256k1 generator multiples G, 2G and 3G: public test vectors, not deployment keys.
const TEE = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PROPOSER = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const OTHER = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const UNCOMPRESSED = ECDH.convertKey(OTHER, 'secp256k1', 'hex', 'hex', 'uncompressed') as string

describe('sequencing 2-of-2', () => {
  it('builds OP_2 <tee> <proposer> OP_2 OP_CHECKMULTISIG with the TEE key first', () => {
    const redeem = sequencingRedeemScript(TEE.toUpperCase(), PROPOSER)
    expect(redeem).to.equal(`5221${TEE}21${PROPOSER}52ae`)
    expect(redeem.length / 2).to.equal(SEQUENCING_REDEEM_BYTES)
    expect(sequencingRedeemScript(PROPOSER, TEE)).not.to.equal(redeem)
  })

  it('derives the P2SH output script and its address per network', () => {
    const redeem = Buffer.from(sequencingRedeemScript(TEE, PROPOSER), 'hex')
    const hash = createHash('ripemd160').update(createHash('sha256').update(redeem).digest()).digest('hex')
    expect(sequencingScriptPubkey(TEE, PROPOSER)).to.equal(`a914${hash}87`)
    for (const network of ['mainnet', 'testnet', 'regtest']) {
      expect(bitcore.Script.fromAddress(sequencingAddress(TEE, PROPOSER, network)).toHex()).to.equal(`a914${hash}87`)
    }

    expect(sequencingAddress(TEE, PROPOSER, 'mainnet')).not.to.equal(sequencingAddress(TEE, PROPOSER, 'testnet'))
  })

  it('rejects uncompressed, invalid and equal keys', () => {
    expect(() => sequencingRedeemScript(TEE, UNCOMPRESSED)).to.throw('compressed')
    expect(() => sequencingRedeemScript(TEE, `02${'ff'.repeat(32)}`)).to.throw('not a valid')
    expect(() => sequencingRedeemScript(undefined, PROPOSER)).to.throw('TEE public key')
    expect(() => sequencingRedeemScript(TEE, TEE)).to.throw('must differ')
  })

  it('requires a dedicated proposer key, whatever encoding the other roles use', () => {
    expect(() => assertDedicatedProposerKey(PROPOSER, {attestation: [OTHER], recovery: [UNCOMPRESSED], tee: TEE})).not.to.throw()
    expect(() => assertDedicatedProposerKey(TEE, {tee: TEE})).to.throw('TEE key')
    expect(() => assertDedicatedProposerKey(OTHER, {attestation: [UNCOMPRESSED], tee: TEE})).to.throw('attestation key')
    expect(() => assertDedicatedProposerKey(OTHER, {recovery: [TEE, `0x${OTHER}`], tee: TEE})).to.throw('recovery key')
    expect(() => assertDedicatedProposerKey(PROPOSER, {feeWallet: PROPOSER})).to.throw('fee wallet key')
  })

  it('selects the request contract from where output 0 sits', () => {
    expect(usesSequencingTwoOfTwo('two-of-two', false)).to.equal(true)
    expect(usesSequencingTwoOfTwo('p2pkh', true)).to.equal(true)
    expect(usesSequencingTwoOfTwo('p2pkh', false)).to.equal(false)
    expect(cubesignerRequestContract(true)).to.equal(CUBESIGNER_REQUEST_CONTRACT_SEQUENCING_CONSENT_V5)
    expect(cubesignerRequestContract(false)).to.equal(CUBESIGNER_REQUEST_CONTRACT_V3)
    expect(CUBESIGNER_REQUEST_CONTRACT_SEQUENCING_CONSENT_V5).to.match(/-explain-sequencing-consent-v5$/)
  })

  it('classifies the genesis sequencer seed by its output script', () => {
    const transaction = new Transaction()
    transaction.addInput(Buffer.alloc(32, 1), 0)
    transaction.addOutput(Buffer.from(sequencingScriptPubkey(TEE, PROPOSER), 'hex'), 42_069_000n)
    transaction.addOutput(Buffer.from(bitcore.Script.fromAddress(new bitcore.PublicKey(PROPOSER).toAddress(bitcore.Networks.testnet).toString()).toHex(), 'hex'), 42_069_000n)
    transaction.addOutput(Buffer.from('6a00', 'hex'), 0n)
    expect(sequencerSeedKind(transaction.toHex(), 0)).to.equal('two-of-two')
    expect(sequencerSeedKind(transaction.toHex(), 1)).to.equal('p2pkh')
    expect(sequencerSeedKind(transaction.toHex(), 2)).to.equal('other')
    expect(() => sequencerSeedKind(transaction.toHex(), 3)).to.throw('no output 3')
  })
})
