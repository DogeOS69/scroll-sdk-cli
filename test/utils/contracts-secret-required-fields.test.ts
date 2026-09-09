import {expect} from 'chai'

import SetupGenSecrets from '../../src/commands/setup/gen-secrets.js'
import {CONTRACTS_PLACEHOLDER_ADDRESS, CONTRACTS_PLACEHOLDER_PRIVATE_KEY} from '../../src/utils/contracts-placeholder.js'

describe('contracts Secret required legacy configuration fields', () => {
  it('includes non-fee legacy fields while keeping both KMS private keys absent', () => {
    const command = Object.create(SetupGenSecrets.prototype)
    command.dogeConfig = {
      accounts: {L1_COMMIT_SENDER_ADDR: '0x809cb1378Cb2775816dD14d1a3754a536b066889'},
      network: 'testnet',
      signers: {
        l1CommitSender: {backend: 'aws_kms', expectedAddress: '0x809cb1378Cb2775816dD14d1a3754a536b066889'},
        l2GasOracleSender: {backend: 'aws_kms', expectedAddress: '0xbEEC0A88c46ad59AA82aA0208F914a1ba6b83e5c'},
      },
    }
    const config = {
      accounts: {
        DEPLOYER_PRIVATE_KEY: 'test-deployer',
        L1_COMMIT_SENDER_ADDR: CONTRACTS_PLACEHOLDER_ADDRESS,
        L1_COMMIT_SENDER_PRIVATE_KEY: CONTRACTS_PLACEHOLDER_PRIVATE_KEY,
        L1_FINALIZE_SENDER_PRIVATE_KEY: 'test-finalizer',
        L1_GAS_ORACLE_SENDER_PRIVATE_KEY: 'test-l1-oracle',
        L2_GAS_ORACLE_SENDER_PRIVATE_KEY: 'stale-local-fee-key',
      },
      contracts: {LEGACY_COMMIT_SENDER_PLACEHOLDER: true},
      coordinator: {COORDINATOR_JWT_SECRET_KEY: 'test-jwt'},
    }
    const files = command.generateEnvContent('contracts', config)
    expect(files['contracts-secret.env']).to.equal([
      'DEPLOYER_PRIVATE_KEY="test-deployer"',
      `L1_COMMIT_SENDER_PRIVATE_KEY="${CONTRACTS_PLACEHOLDER_PRIVATE_KEY}"`,
      'L1_FINALIZE_SENDER_PRIVATE_KEY="test-finalizer"',
      'L1_GAS_ORACLE_SENDER_PRIVATE_KEY="test-l1-oracle"',
      'COORDINATOR_JWT_SECRET_KEY="test-jwt"',
      '',
    ].join('\n'))
    expect(command.generateEnvContent('fee-oracle', config)).to.deep.equal({})
    expect(command.generateEnvContent('eth-da-submitter', config)).to.deep.equal({})
  })
})
