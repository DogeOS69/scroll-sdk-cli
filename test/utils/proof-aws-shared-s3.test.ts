import {expect} from 'chai'

import {JsonOutputContext} from '../../src/utils/json-output.js'
import {
  ProofAwsProvisioner,
  publicArtifactObjectResources,
  upsertSharedProofArtifactPublicReadPolicy,
} from '../../src/utils/proof-aws-provisioner.js'

const legacy = {
  Action: 's3:GetObject', Effect: 'Allow', Principal: '*',
  Resource: 'arn:aws:s3:::proof-bucket/old/*', Sid: 'ScrollSdkProofArtifactPublicRead',
}
const guard = {Action: 's3:DeleteObject', Effect: 'Deny', Principal: '*', Resource: '*', Sid: 'OperatorGuard'}
const original = {Statement: [legacy, guard], Version: '2012-10-17'}
const identity = {awsRegion: 'us-east-1', deploymentAlias: 'new', eksCluster: 'cluster', namespace: 'default'}
const input = {
  artifactRead: {publicReadMode: 'shared-s3' as const}, bucket: 'proof-bucket', coordinatorRole: {description: 'coordinator', roleName: 'coordinator', serviceAccount: 'proof-coordinator'},
  keyPrefix: 'instances/new',
  secretName: 'scroll/new/proof',
  withdrawalRole: {description: 'withdrawal', roleName: 'withdrawal', serviceAccount: 'withdrawal-processor'},
}

function fixture(options: {blocked?: string; failure?: string; missing?: boolean; race?: boolean} = {}) {
  const calls: string[][] = []
  let policy = original
  let reads = 0
  const aws = {
    json(args: string[]) {
      calls.push(args)
      if (args[1] === 'get-public-access-block') {
        if (options.failure) throw new Error(options.failure)
        return {PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, BlockPublicPolicy: options.blocked === `${args[0]}:policy`,
          IgnorePublicAcls: true, RestrictPublicBuckets: options.blocked === `${args[0]}:restrict`,
        }}
      }

      return {}
    },
    run(args: string[]) {
      calls.push(args)
      if (args[1] === 'head-bucket' && options.missing) throw new Error('404 Not Found')
      if (args[1] === 'put-bucket-policy') policy = JSON.parse(args[args.indexOf('--policy') + 1])
      return ''
    },
    text(args: string[]) {
      calls.push(args)
      if (args[0] === 'sts') return '123456789012'
      if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE'
      if (args[1] === 'get-bucket-policy') {
        reads++
        return JSON.stringify(options.race && reads > 1 ? {...policy, Id: 'concurrent-edit'} : policy)
      }

      throw new Error(`unexpected AWS read ${args.join(' ')}`)
    },
  }
  return {calls, policy: () => policy, provisioner: new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)}
}

describe('shared S3 proof prefix grants', () => {
  it('preserves legacy/operator grants, supports multiple instances and is idempotent', () => {
    const first = upsertSharedProofArtifactPublicReadPolicy(original, input.bucket, input.keyPrefix)
    expect(first.Statement.slice(0, 2)).to.deep.equal(original.Statement)
    expect(original.Statement).to.have.length(2)
    const grant = first.Statement[2]
    expect(grant.Resource).to.deep.equal(publicArtifactObjectResources(input.bucket, input.keyPrefix))
    expect(grant).to.include({Action: 's3:GetObject', Effect: 'Allow', Principal: '*'})
    expect(JSON.stringify(grant)).not.to.include('sidecars/')
    const second = upsertSharedProofArtifactPublicReadPolicy(first, input.bucket, 'instances/next')
    expect(second.Statement).to.have.length(4)
    expect(second.Statement.slice(0, 3)).to.deep.equal(first.Statement)
    expect(second.Statement[3].Sid).not.to.equal(grant.Sid)
    expect(upsertSharedProofArtifactPublicReadPolicy(second, input.bucket, input.keyPrefix)).to.deep.equal(second)
  })

  it('adds AdvanceL1 completeness access while preserving an older shared grant', () => {
    const previous = {
      Action: 's3:GetObject', Effect: 'Allow', Principal: '*',
      Resource: publicArtifactObjectResources(input.bucket, input.keyPrefix).filter(item => !item.includes('signer-policy-evidence')),
      Sid: 'ScrollSdkProofArtifactPublicReadPreviousRelease',
    }
    const policy = upsertSharedProofArtifactPublicReadPolicy({Statement: [previous]}, input.bucket, input.keyPrefix)
    expect(policy.Statement).to.have.length(2)
    expect(policy.Statement[0]).to.deep.equal(previous)
    expect(policy.Statement[1].Resource).to.include('arn:aws:s3:::proof-bucket/instances/new/signer-policy-evidence/*')
    expect(upsertSharedProofArtifactPublicReadPolicy(policy, input.bucket, input.keyPrefix)).to.deep.equal(policy)
  })

  it('refuses to overwrite a modified grant with the same Sid', () => {
    const policy = upsertSharedProofArtifactPublicReadPolicy(original, input.bucket, input.keyPrefix)
    policy.Statement[2].Condition = {StringEquals: {'aws:SourceVpce': 'vpce-1234'}}
    expect(() => upsertSharedProofArtifactPublicReadPolicy(policy, input.bucket, input.keyPrefix)).to.throw('refusing to replace')
  })

  it('supports a singleton Statement and rejects wildcard prefixes', () => {
    expect(upsertSharedProofArtifactPublicReadPolicy({Statement: legacy}, input.bucket, input.keyPrefix).Statement[0]).to.deep.equal(legacy)
    expect(() => upsertSharedProofArtifactPublicReadPolicy(original, input.bucket, 'instances/*')).to.throw('wildcards')
  })

  it('adds only one policy grant, preserves tokens and makes no bucket-wide or VPC writes on rerun', () => {
    const f = fixture()
    const result = f.provisioner.provision(identity, input)
    expect(result.artifactReadTransport).to.deep.equal({
      publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com', publicReadMode: 'shared-s3', publicStatus: 'configured-unverified',
    })
    expect(result.secretAction).to.equal('reused')
    f.provisioner.provision(identity, input)
    expect(f.calls.filter(args => args[1] === 'put-bucket-policy')).to.have.length(1)
    expect(f.policy().Statement.slice(0, 2)).to.deep.equal(original.Statement)
    expect(f.calls.some(args => ['create-bucket', 'delete-bucket-policy', 'modify-vpc-endpoint', 'put-bucket-encryption', 'put-public-access-block', 'put-secret-value'].includes(args[1]))).to.equal(false)
    expect(f.calls.find(args => args[1] === 'put-bucket-policy')).to.include('--expected-bucket-owner')
  })

  for (const blocked of ['s3api:policy', 's3api:restrict', 's3control:policy', 's3control:restrict']) {
    it(`fails closed before policy/IAM/secret changes when ${blocked} blocks public reads`, () => {
      const f = fixture({blocked})
      expect(() => f.provisioner.provision(identity, input)).to.throw('Public Access Block; settings were not changed')
      expect(f.calls.some(args => args[0] === 'iam' || args[0] === 'secretsmanager' || args[1].startsWith('put-'))).to.equal(false)
    })
  }

  it('fails on inability to inspect public access settings but accepts the explicit absent-config response', () => {
    expect(() => fixture({failure: 'AccessDenied'}).provisioner.provision(identity, input)).to.throw('AccessDenied')
    expect(() => fixture({failure: 'NoSuchPublicAccessBlockConfiguration'}).provisioner.provision(identity, input)).not.to.throw()
  })

  it('refuses bucket creation and VPC routing changes', () => {
    const f = fixture({missing: true})
    expect(() => f.provisioner.provision(identity, input)).to.throw('requires an existing accessible S3 bucket')
    expect(f.calls).to.have.length(1)
    const vpc = fixture()
    expect(() => vpc.provisioner.provision(identity, {...input, artifactRead: {...input.artifactRead, vpcEndpoint: {enabled: true}}})).to.throw('--skip-vpc-endpoint')
    expect(vpc.calls).to.have.length(0)
  })

  it('aborts if the policy changed before the write', () => {
    const f = fixture({race: true})
    expect(() => f.provisioner.provision(identity, input)).to.throw('changed during provisioning')
    expect(f.calls.some(args => args[1] === 'put-bucket-policy')).to.equal(false)
  })
})
