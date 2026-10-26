/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic Helm values. */
import {expect} from 'chai'

import {awsWorkloadIdentity, bindAwsServiceAccount} from '../../src/utils/aws-workload-identity.js'
import {applyProofAwsValues} from '../../src/utils/proof-aws-provisioner.js'

describe('AWS workload identity projection', () => {
  it('removes a stale IRSA binding while preserving unrelated annotations and pins the association name', () => {
    const values: any = {serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'old-role', 'example.invalid/owner': 'operator'}, create: false, name: 'old-name'}}
    bindAwsServiceAccount(values, 'fee-oracle', 'external-role', 'pod-identity')
    expect(values.serviceAccount).deep.eq({annotations: {'example.invalid/owner': 'operator'}, create: true, name: 'fee-oracle'})
    const once = JSON.stringify(values)
    bindAwsServiceAccount(values, 'fee-oracle', 'external-role', 'pod-identity')
    expect(JSON.stringify(values)).eq(once)
  })
  it('retains explicit IRSA and rejects invalid identity modes', () => {
    const values: any = {}
    bindAwsServiceAccount(values, 'fee-oracle', 'external-role')
    expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).eq('external-role')
    expect(awsWorkloadIdentity({infrastructure: {aws: {}}} as any)).eq('irsa')
    expect(() => awsWorkloadIdentity({infrastructure: {aws: {workloadIdentity: 'typo'}}} as any)).throw('workloadIdentity')
  })
  it('projects Pod Identity into both proof consumers without changing the ESO reader', () => {
    const coordinator: any = {externalSecrets: {serviceAccount: 'external-secrets'}, serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'old'}}}
    const withdrawal: any = {serviceAccount: {annotations: {'eks.amazonaws.com/role-arn': 'old'}}}
    applyProofAwsValues(coordinator, withdrawal, {
      artifactRegion: 'us-east-1', bucket: 'fixture-artifacts', coordinatorRoleArn: 'fixture-role', coordinatorServiceAccount: 'proof-coordinator', keyPrefix: 'fixture/proofs', secretName: 'fixture/proof-token', secretRegion: 'us-east-2', withdrawalRoleArn: 'fixture-wp-role', withdrawalServiceAccount: 'withdrawal-processor', workloadIdentity: 'pod-identity',
    })
    expect(coordinator.serviceAccount.annotations).not.have.property('eks.amazonaws.com/role-arn')
    expect(withdrawal.serviceAccount.annotations).not.have.property('eks.amazonaws.com/role-arn')
    expect(withdrawal.withdrawalProof.s3AuthMode).eq('ambient')
    expect(coordinator.externalSecrets.serviceAccount).eq('external-secrets')
  })
})
