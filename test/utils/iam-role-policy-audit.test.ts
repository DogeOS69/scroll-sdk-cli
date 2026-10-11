import {expect} from 'chai'

import {assertPolicyWithinScope, auditRolePolicies} from '../../src/utils/iam-role-policy-audit.js'
import {buildProofArtifactStorePolicy} from '../../src/utils/proof-aws-provisioner.js'
const allowed = buildProofArtifactStorePolicy('proof-bucket', 'deployment')
const grant = (Action: string | string[], Resource = 'arn:aws:s3:::proof-bucket/deployment/*') => ({Statement: [{Action, Effect: 'Allow', Resource}]})
describe('workload IAM upper-bound audit', () => {
  it('allows scoped object grants and preserves unrelated KMS grants and denies', () => {
    assertPolicyWithinScope(grant(['s3:GetObject', 's3:PutObject']), allowed, 'role')
    assertPolicyWithinScope(grant('s3:GetObject', 'arn:aws:s3:::proof-bucket/deployment/proofs/*'), allowed, 'role')
    assertPolicyWithinScope(grant('kms:Sign', 'arn:aws:kms:example:key/id'), allowed, 'role')
    assertPolicyWithinScope({Statement: [{Action: '*', Effect: 'Deny', Resource: '*'}]}, allowed, 'role')
  })
  for (const policy of [grant('*', '*'), grant('s3:*'), grant('s3:DeleteObject'), grant('s3:ListBucket', 'arn:aws:s3:::proof-bucket'), grant('s3:GetObject', 'arn:aws:s3:::proof-bucket/*'), grant('s3:GetObject', 'arn:aws:s3:::other/deployment/*'), {Statement: [{Effect: 'Allow', NotAction: 'iam:*', Resource: '*'}]}]) it('rejects grants exceeding workload scope', () => {
    expect(() => assertPolicyWithinScope(policy, allowed, 'role/policy')).to.throw('role/policy: extra or unprovable')
  })
  it('checks attached managed policy default versions and fails on broad grants', () => {
    const calls: string[][] = []
    const aws = {json(args: string[]) {
      calls.push(args)
      if (args[1] === 'list-role-policies') return {PolicyNames: ['owned']}
      if (args[1] === 'list-attached-role-policies') return {AttachedPolicies: [{PolicyArn: 'arn:example'}]}
      if (args[1] === 'get-policy') return {Policy: {DefaultVersionId: 'v3'}}
      if (args[1] === 'get-policy-version') return {PolicyVersion: {Document: encodeURIComponent(JSON.stringify(grant('s3:*', '*')))}}
      throw new Error('unexpected mutation or read')
    }}
    expect(() => auditRolePolicies(aws, 'role', allowed, ['owned'])).to.throw('extra or unprovable')
    expect(calls.at(-1)).to.include('v3')
  })
  it('does not skip an unavailable inventory', () => {
    expect(() => auditRolePolicies({json() {return {}}}, 'role', allowed)).to.throw('Unable to inventory')
  })
  it('requires prefix conditions for coordinator listing', () => {
    const pc = buildProofArtifactStorePolicy('proof-bucket', 'deployment', {deleteObjects: true, listObjects: true})
    assertPolicyWithinScope(pc, pc, 'coordinator')
    expect(() => assertPolicyWithinScope(grant('s3:ListBucket', 'arn:aws:s3:::proof-bucket'), pc, 'coordinator')).to.throw('extra or unprovable')
  })
})
