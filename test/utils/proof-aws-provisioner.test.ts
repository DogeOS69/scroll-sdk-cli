import { expect } from 'chai'

import { applyProofAwsValues } from '../../src/utils/proof-aws-provisioner.js'

const PROJECTION = {
  bucket: 'dogeos-testnet-proof-artifacts',
  coordinatorRoleArn: 'arn:aws:iam::123456789012:role/dogeos-testnet-cluster-proof-coordinator',
  coordinatorServiceAccount: 'proof-coordinator',
  keyPrefix: 'proof-topology',
  region: 'us-west-2',
  secretName: 'scroll/proof-coordinator-secrets',
  withdrawalRoleArn: 'arn:aws:iam::123456789012:role/dogeos-testnet-cluster-wp-proof',
  withdrawalServiceAccount: 'withdrawal-processor',
}

describe('proof-aws-provisioner values projection', () => {
  it('projects bucket, roles, auth mode, and token mappings into fresh values', () => {
    const coordinator: Record<string, any> = {
      env: [{ name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET', value: '<TODO>' }],
    }
    const withdrawal: Record<string, any> = {}

    applyProofAwsValues(coordinator, withdrawal, PROJECTION)

    const env = Object.fromEntries(coordinator.env.map((item: any) => [item.name, item.value]))
    expect(env.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET).to.equal('dogeos-testnet-proof-artifacts')
    expect(env.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION).to.equal('us-west-2')
    expect(env.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__KEY_PREFIX).to.equal('proof-topology')
    expect(coordinator.serviceAccount).to.deep.equal({
      annotations: { 'eks.amazonaws.com/role-arn': PROJECTION.coordinatorRoleArn },
      create: true,
      name: 'proof-coordinator',
    })
    expect(coordinator.externalSecrets.secrets.data.map((item: any) => item.secretKey))
      .to.deep.equal(['proof-work-token', 'prover-worker-token'])
    expect(coordinator.externalSecrets.secrets.data[0].remoteRef).to.deep.equal({
      key: 'scroll/proof-coordinator-secrets',
      property: 'proof-work-token',
    })

    expect(withdrawal.withdrawalProof.s3AuthMode).to.equal('irsa')
    expect(withdrawal.serviceAccount.name).to.equal('withdrawal-processor')
    expect(withdrawal.serviceAccount.annotations['eks.amazonaws.com/role-arn']).to.equal(PROJECTION.withdrawalRoleArn)
  })

  it('preserves an existing token mapping and unrelated values', () => {
    const coordinator: Record<string, any> = {
      externalSecrets: {
        custom: {
          data: [
            { remoteRef: { key: 'ops/custom', property: 'proof-work-token' }, secretKey: 'proof-work-token' },
            { remoteRef: { key: 'ops/custom', property: 'prover-worker-token' }, secretKey: 'prover-worker-token' },
          ],
          provider: 'vault',
        },
      },
      serviceAccount: { annotations: { 'custom/annotation': 'kept' } },
    }
    const withdrawal: Record<string, any> = { withdrawalProof: { enabled: true } }

    applyProofAwsValues(coordinator, withdrawal, PROJECTION)

    expect(coordinator.externalSecrets.secrets).to.equal(undefined)
    expect(coordinator.externalSecrets.custom.provider).to.equal('vault')
    expect(coordinator.serviceAccount.annotations['custom/annotation']).to.equal('kept')
    expect(coordinator.serviceAccount.annotations['eks.amazonaws.com/role-arn']).to.equal(PROJECTION.coordinatorRoleArn)
    expect(withdrawal.withdrawalProof.enabled).to.equal(true)
    expect(withdrawal.withdrawalProof.s3AuthMode).to.equal('irsa')
  })

  it('replaces a stale valueFrom on managed env entries', () => {
    const coordinator: Record<string, any> = {
      env: [{
        name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION',
        valueFrom: { secretKeyRef: { key: 'region', name: 'legacy' } },
      }],
    }

    applyProofAwsValues(coordinator, {}, PROJECTION)
    const entry = coordinator.env.find((item: any) => item.name === 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__REGION')
    expect(entry.value).to.equal('us-west-2')
    expect(entry.valueFrom).to.equal(undefined)
  })
})
