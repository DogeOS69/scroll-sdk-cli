import {expect} from 'chai'

import {JsonOutputContext} from '../../src/utils/json-output.js'
import {PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK, assertPrivateArtifactBucket, assertPrivateArtifactPolicy} from '../../src/utils/private-artifact-access.js'
import {ProofAwsProvisioner, proofArtifactPolicySid, upsertProofArtifactPublicReadPolicy} from '../../src/utils/proof-aws-provisioner.js'

describe('private artifact access boundary', () => {
  for (const existingPublic of [false, true]) {
    it(`provisions and reads back private access with existing public grant = ${existingPublic}`, () => {
      let policy = {Statement: existingPublic ? [{Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: 'arn:aws:s3:::proof-bucket/deployment/proofs/*', Sid: proofArtifactPolicySid('public', 'proof-bucket', 'deployment')}] : []}
      let block = {}
      const writes: string[][] = []
      const aws = {
        json(args: string[]) {
          if (args[1].startsWith('put-') || args[1].startsWith('create-') || args[1].startsWith('update-')) writes.push(args)
          return args[1] === 'get-public-access-block' ? {PublicAccessBlockConfiguration: block} : {}
        },
        run(args: string[]) {
          if (args[1] !== 'head-bucket') writes.push(args)
          if (args[1] === 'put-bucket-policy') policy = JSON.parse(args[args.indexOf('--policy') + 1])
          if (args[1] === 'put-public-access-block') block = JSON.parse(args[args.indexOf('--public-access-block-configuration') + 1])
          return ''
        },
        text(args: string[]) {
          if (args[0] === 'sts') return '123456789012'
          if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/TEST'
          if (args[1] === 'get-bucket-policy') return JSON.stringify(policy)
          throw new Error('Unexpected AWS read')
        },
      }
      const result = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws).provision(
        {awsRegion: 'us-east-1', deploymentAlias: 'test', eksCluster: 'cluster', namespace: 'default'},
        {artifactRead: {publicReadMode: 'private-s3'}, bucket: 'proof-bucket', coordinatorRole: {description: 'pc', roleName: 'pc', serviceAccount: 'pc'}, keyPrefix: 'deployment', secretName: 'proof-secret', withdrawalRole: {description: 'wp', roleName: 'wp', serviceAccount: 'wp'}},
      )
      expect(result.artifactReadTransport.publicReadMode).to.equal('private-s3')
      expect(block).to.deep.equal(PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK)
      expect(policy.Statement.every(statement => statement.Effect === 'Deny')).to.equal(true)
      expect(writes.filter(args => args[1] === 'put-role-policy')).to.have.length(2)
      expect(writes.findIndex(args => args[1] === 'put-public-access-block')).to.be.lessThan(writes.findIndex(args => args[1] === 'put-bucket-policy'))
    })
  }

  const grant = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: 'arn:aws:s3:::proof-bucket/proofs/*', Sid: 'OperatorPublicRead'}
  for (const statement of [
    grant,
    {...grant, Action: 's3:PutObject'},
    {...grant, Action: 's3:*', Condition: {StringEquals: {'aws:SourceVpce': 'vpce-0123'}}},
    {...grant, Principal: {AWS: ['*']}},
    {...grant, Principal: {AWS: 'arn:aws:iam::*:root'}},
    {...grant, Condition: {Bool: {'aws:SecureTransport': true}}},
    {...grant, Condition: {StringEquals: {'aws:SourceVpce': 'vpce-*'}}},
    {...grant, NotPrincipal: {AWS: 'arn:aws:iam::123456789012:root'}, Principal: undefined},
    {...grant, Condition: {StringEquals: {'AWS:SourceArn': 'arn:aws:cloudfront::123456789012:distribution/EXAMPLE'}}, Principal: {Service: 'cloudfront.amazonaws.com'}},
  ]) {
    it(`rejects unverified external delivery ${JSON.stringify(statement)}`, () => {
      expect(() => assertPrivateArtifactPolicy({Statement: [statement]})).to.throw('public or unverified external delivery')
    })
  }

  it('permits a fixed VPC endpoint read and authenticated IAM read, preserving denies', () => {
    expect(() => assertPrivateArtifactPolicy({Statement: [
      {...grant, Condition: {StringEquals: {'aws:SourceVpce': 'vpce-0123'}}},
      {...grant, Principal: {AWS: 'arn:aws:iam::123456789012:role/proof-reader'}},
      {...grant, Effect: 'Deny'},
    ]})).not.to.throw()
  })

  it('removes only the selected exact legacy grant and refuses to block a sibling deployment silently', () => {
    const legacy = {...grant, Resource: 'arn:aws:s3:::proof-bucket/deployment/proofs/*', Sid: proofArtifactPolicySid('public', 'proof-bucket', 'deployment')}
    const sibling = {...grant, Resource: 'arn:aws:s3:::proof-bucket/other/proofs/*'}
    const migrated = upsertProofArtifactPublicReadPolicy({Statement: [legacy]}, 'proof-bucket', 'deployment', false)
    expect(migrated.Statement).to.deep.equal([])
    const shared = upsertProofArtifactPublicReadPolicy({Statement: [legacy, sibling]}, 'proof-bucket', 'deployment', false)
    expect(shared.Statement).to.deep.equal([sibling])
    expect(() => assertPrivateArtifactPolicy(shared)).to.throw('operator-owned grant')
  })

  for (const key of Object.keys(PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK)) {
    it(`rejects reuse/readback with ${key} disabled`, () => {
      const aws = {json: () => ({PublicAccessBlockConfiguration: {...PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK, [key]: false}}), text: () => JSON.stringify({Statement: []})}
      expect(() => assertPrivateArtifactBucket(aws, 'proof-bucket', 'us-east-1')).to.throw('all four')
    })
  }

  it('does not trust blocked public policy remaining in a reused bucket', () => {
    const aws = {json: () => ({PublicAccessBlockConfiguration: PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK}), text: () => JSON.stringify({Statement: [grant]})}
    expect(() => assertPrivateArtifactBucket(aws, 'proof-bucket', 'us-east-1')).to.throw('public or unverified')
  })

  it('accepts a private bucket without a policy and propagates denied policy reads', () => {
    const aws = {json: () => ({PublicAccessBlockConfiguration: PRIVATE_ARTIFACT_PUBLIC_ACCESS_BLOCK}), text() {throw new Error('NoSuchBucketPolicy')}}
    expect(() => assertPrivateArtifactBucket(aws, 'proof-bucket', 'us-east-1')).not.to.throw()
    expect(() => assertPrivateArtifactBucket({...aws, text() {throw new Error('AccessDenied')}}, 'proof-bucket', 'us-east-1')).to.throw('AccessDenied')
  })
})
