import {expect} from 'chai'

import {getRequiredManagedSignerAddress} from '../../src/utils/signer-roles.js'

describe('managed signer address resolution', () => {
  const address = '0x809cb1378Cb2775816dD14d1a3754a536b066889'

  it('uses the deployment account address for a local signer', () => {
    const config = {
      accounts: {L1_COMMIT_SENDER_ADDR: address},
      signers: {
        l1CommitSender: {
          backend: 'local',
          role: 'L1_COMMIT_SENDER',
          service: 'eth-da-submitter',
        },
      },
    }

    expect(getRequiredManagedSignerAddress(config, 'l1CommitSender')).to.equal(address)
  })

  it('returns one authority when the KMS and deployment addresses agree', () => {
    const config = {
      accounts: {L1_COMMIT_SENDER_ADDR: address.toLowerCase()},
      signers: {
        l1CommitSender: {
          backend: 'aws_kms',
          expectedAddress: address,
          role: 'L1_COMMIT_SENDER',
          service: 'eth-da-submitter',
        },
      },
    }

    expect(getRequiredManagedSignerAddress(config, 'l1CommitSender')).to.equal(address)
  })

  it('rejects drift between the eth-da-submitter signer and downstream allowlist authority', () => {
    const config = {
      accounts: {L1_COMMIT_SENDER_ADDR: address},
      signers: {
        l1CommitSender: {
          backend: 'aws_kms',
          expectedAddress: '0x1111111111111111111111111111111111111111',
          role: 'L1_COMMIT_SENDER',
          service: 'eth-da-submitter',
        },
      },
    }

    expect(() => getRequiredManagedSignerAddress(config, 'l1CommitSender'))
      .to.throw('does not match signers.l1CommitSender.expectedAddress')
  })

  it('rejects a missing or malformed deployment account address', () => {
    const config = {
      accounts: {L1_COMMIT_SENDER_ADDR: 'not-an-address'},
      signers: {
        l1CommitSender: {
          backend: 'local',
          role: 'L1_COMMIT_SENDER',
          service: 'eth-da-submitter',
        },
      },
    }

    expect(() => getRequiredManagedSignerAddress(config, 'l1CommitSender'))
      .to.throw('accounts.L1_COMMIT_SENDER_ADDR must be a 20-byte')
  })
})
