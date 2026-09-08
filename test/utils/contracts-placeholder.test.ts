import {expect} from 'chai'
import {Wallet} from 'ethers'

import SetupGenSecrets from '../../src/commands/setup/gen-secrets.js'
import {CONTRACTS_PLACEHOLDER_ADDRESS, CONTRACTS_PLACEHOLDER_PRIVATE_KEY, assertNoPlaceholderFunding, getContractsPlaceholderKey} from '../../src/utils/contracts-placeholder.js'
import {getRequiredManagedSignerAddress} from '../../src/utils/signer-roles.js'

describe('contracts-only public commit-sender placeholder', () => {
  const actual = '0x809cb1378Cb2775816dD14d1a3754a536b066889'
  const doge = {
    accounts: {L1_COMMIT_SENDER_ADDR: actual},
    network: 'testnet',
    signers: {l1CommitSender: {backend: 'aws_kms', expectedAddress: actual}},
  }
  const config = {
    accounts: {L1_COMMIT_SENDER_ADDR: CONTRACTS_PLACEHOLDER_ADDRESS, L1_COMMIT_SENDER_PRIVATE_KEY: CONTRACTS_PLACEHOLDER_PRIVATE_KEY},
    contracts: {LEGACY_COMMIT_SENDER_PLACEHOLDER: true},
  }

  it('uses a matching public test vector, without mutating the real signer', () => {
    expect(new Wallet(CONTRACTS_PLACEHOLDER_PRIVATE_KEY).address).to.equal(CONTRACTS_PLACEHOLDER_ADDRESS)
    const before = JSON.stringify(doge)
    expect(getContractsPlaceholderKey(config, doge)).to.equal(CONTRACTS_PLACEHOLDER_PRIVATE_KEY)
    expect(getRequiredManagedSignerAddress(doge, 'l1CommitSender')).to.equal(actual)
    expect(JSON.stringify(doge)).to.equal(before)
  })

  it('requires explicit opt-in', () => {
    expect(getContractsPlaceholderKey({}, doge)).to.equal(undefined)
  })

  it('rejects mainnet and mismatching placeholder fields', () => {
    expect(() => getContractsPlaceholderKey(config, {...doge, network: 'mainnet'})).to.throw('restricted')
    expect(() => getContractsPlaceholderKey({...config, accounts: {...config.accounts, L1_COMMIT_SENDER_ADDR: actual}}, doge)).to.throw('pair')
  })

  it('rejects canonical address drift and placeholder runtime identity', () => {
    expect(() => getContractsPlaceholderKey(config, {...doge, accounts: {L1_COMMIT_SENDER_ADDR: CONTRACTS_PLACEHOLDER_ADDRESS}})).to.throw('does not match')
    const placeholderDoge = {...doge, accounts: config.accounts, signers: {l1CommitSender: {backend: 'local'}}}
    expect(() => getContractsPlaceholderKey(config, placeholderDoge)).to.throw('must not be')
  })

  it('only supplies the placeholder to the contracts Secret, never the KMS service', () => {
    const command = Object.create(SetupGenSecrets.prototype)
    command.dogeConfig = doge
    expect(command.getMappedConfigValue(config, 'L1_COMMIT_SENDER_PRIVATE_KEY', 'contracts')).to.equal(CONTRACTS_PLACEHOLDER_PRIVATE_KEY)
    expect(command.getMappedConfigValue(config, 'L1_COMMIT_SENDER_PRIVATE_KEY', 'eth-da-submitter')).to.equal(undefined)
    expect(command.getMappedConfigValue({}, 'L1_COMMIT_SENDER_PRIVATE_KEY', 'contracts')).to.equal(undefined)
  })

  it('blocks implicit/L1 account funding but preserves L2 and deployer funding', () => {
    expect(() => assertNoPlaceholderFunding(config)).to.throw('Refusing to fund')
    expect(() => assertNoPlaceholderFunding(config, '1')).to.throw('Refusing to fund')
    expect(() => assertNoPlaceholderFunding(config, '2')).not.to.throw()
    expect(() => assertNoPlaceholderFunding(config, '1', true)).not.to.throw()
    expect(() => assertNoPlaceholderFunding({}, '1')).not.to.throw()
  })
})
