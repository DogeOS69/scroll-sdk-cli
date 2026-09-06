import { expect } from 'chai'

import type { AwsCliOptions } from '../../src/utils/aws-cli.js'

import { JsonOutputContext } from '../../src/utils/json-output.js'
import {
  ProofAwsProvisioner,
  applyProofAwsValues,
  assertNoUnmanagedPublicProofBucketGrant,
  buildProofArtifactStorePolicy,
  normalizeProofArtifactPublicEndpoint,
  normalizeProofBucketName,
  normalizeProofKeyPrefix,
  proofArtifactS3Endpoint,
  publicArtifactObjectResources,
  upsertProofArtifactPublicReadPolicy,
  upsertProofArtifactVpcEndpointReadPolicy,
} from '../../src/utils/proof-aws-provisioner.js'

const PROJECTION = {
  artifactRegion: 'us-west-2',
  bucket: 'dogeos-testnet-proof-artifacts',
  coordinatorRoleArn: 'arn:aws:iam::123456789012:role/dogeos-testnet-cluster-proof-coordinator',
  coordinatorServiceAccount: 'proof-coordinator',
  keyPrefix: 'proof-topology',
  secretName: 'scroll/proof-coordinator-secrets',
  secretRegion: 'us-west-2',
  withdrawalRoleArn: 'arn:aws:iam::123456789012:role/dogeos-testnet-cluster-wp-proof',
  withdrawalServiceAccount: 'withdrawal-processor',
}

describe('proof-aws-provisioner values projection', () => {
  it('configures only explicit same-VPC route tables and preserves policy while provisioning VPC endpoint read', () => {
    const calls: Array<{ args: string[]; kind: 'json' | 'run' | 'text'; options: AwsCliOptions }> = []
    const operatorStatement = {
      Action: 's3:ListBucket',
      Effect: 'Deny',
      Resource: 'arn:aws:s3:::proof-bucket',
      Sid: 'OperatorGuard',
    }
    const aws = {
      json(args: string[], options: AwsCliOptions = {}): any {
        calls.push({ args, kind: 'json', options })
        if (args[0] === 'ec2' && args[1] === 'describe-vpc-endpoints') {
          return {
            VpcEndpoints: [{
              RouteTableIds: ['rtb-aaaaaaaa'],
              ServiceName: 'com.amazonaws.us-east-1.s3',
              State: 'available',
              VpcEndpointType: 'Gateway',
              VpcId: 'vpc-11111111',
            }],
          }
        }

        if (args[0] === 'ec2' && args[1] === 'describe-route-tables') {
          return {
            RouteTables: [
              { RouteTableId: 'rtb-aaaaaaaa', VpcId: 'vpc-11111111' },
              { RouteTableId: 'rtb-bbbbbbbb', VpcId: 'vpc-11111111' },
            ],
          }
        }

        return {}
      },
      run(args: string[], options: AwsCliOptions = {}): string {
        calls.push({ args, kind: 'run', options })
        return ''
      },
      text(args: string[], options: AwsCliOptions = {}): string {
        calls.push({ args, kind: 'text', options })
        if (args[0] === 'sts') return '123456789012'
        if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE'
        if (args[0] === 's3api' && args[1] === 'get-bucket-policy') {
          return JSON.stringify({ Statement: [operatorStatement], Version: '2012-10-17' })
        }

        throw new Error(`unexpected text call: ${args.join(' ')}`)
      },
    }
    const provisioner = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)
    const result = provisioner.provision(
      { awsRegion: 'us-east-1', deploymentAlias: 'deployment-01', eksCluster: 'cluster', namespace: 'default' },
      {
        artifactRead: {
          publicEndpointUrl: 'https://objects.example.com',
          publicReadMode: 'existing-gateway',
          vpcEndpoint: {
            enabled: true,
            routeTableIds: ['rtb-aaaaaaaa', 'rtb-bbbbbbbb'],
            vpcEndpointId: 'vpce-abc123',
          },
        },
        bucket: 'proof-bucket',
        coordinatorRole: { description: 'coordinator', roleName: 'coordinator-role', serviceAccount: 'proof-coordinator' },
        keyPrefix: 'proof-topology',
        secretName: 'proof-secret',
        withdrawalRole: { description: 'withdrawal', roleName: 'withdrawal-role', serviceAccount: 'withdrawal-processor' },
      }
    )

    expect(result.artifactReadTransport).to.deep.equal({
      publicEndpointUrl: 'https://objects.example.com',
      publicReadMode: 'existing-gateway',
      publicStatus: 'operator-managed-unverified',
      vpcEndpoint: {
        created: false,
        routeTableIds: ['rtb-aaaaaaaa', 'rtb-bbbbbbbb'],
        status: 'configured-unverified',
        vpcEndpointId: 'vpce-abc123',
      },
    })
    const modify = calls.find(call => call.args[0] === 'ec2' && call.args[1] === 'modify-vpc-endpoint')
    expect(modify?.args).to.deep.equal([
      'ec2',
      'modify-vpc-endpoint',
      '--vpc-endpoint-id',
      'vpce-abc123',
      '--add-route-table-ids',
      'rtb-bbbbbbbb',
    ])

    const putBucketPolicy = calls.find(call => call.args[0] === 's3api' && call.args[1] === 'put-bucket-policy')
    const policy = JSON.parse(putBucketPolicy?.args[putBucketPolicy.args.indexOf('--policy') + 1] as string)
    expect(policy.Statement[0]).to.deep.equal(operatorStatement)
    expect(policy.Statement[1].Resource).to.equal('arn:aws:s3:::proof-bucket/proof-topology/*')
    expect(policy.Statement[1].Condition.StringEquals['aws:SourceVpce']).to.equal('vpce-abc123')

    const publicAccessBlock = calls.find(
      call => call.args[0] === 's3api' && call.args[1] === 'put-public-access-block',
    )
    expect(publicAccessBlock).to.equal(undefined)

    const rolePolicies = calls.filter(call => call.args[0] === 'iam' && call.args[1] === 'put-role-policy')
    expect(rolePolicies).to.have.length(2)
    for (const call of rolePolicies) {
      const policyDocument = JSON.parse(call.args[call.args.indexOf('--policy-document') + 1])
      expect(policyDocument.Statement[0].Resource).to.equal('arn:aws:s3:::proof-bucket/proof-topology/*')
      expect(policyDocument.Statement[1].Condition.StringLike['s3:prefix'])
        .to.deep.equal(['proof-topology', 'proof-topology/*'])
    }
  })

  it('does not mutate bucket policy or Public Access Block for an operator-managed external gateway', () => {
    const calls: Array<{args: string[]; kind: 'json' | 'run' | 'text'}> = []
    const aws = {
      json(args: string[]): any {
        calls.push({args, kind: 'json'})
        return {}
      },
      run(args: string[]): string {
        calls.push({args, kind: 'run'})
        return ''
      },
      text(args: string[]): string {
        calls.push({args, kind: 'text'})
        if (args[0] === 'sts') return '123456789012'
        if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE'
        throw new Error(`unexpected text call: ${args.join(' ')}`)
      },
    }
    const provisioner = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)
    provisioner.provision(
      {awsRegion: 'us-east-1', deploymentAlias: 'deployment-01', eksCluster: 'cluster', namespace: 'default'},
      {
        artifactRead: {
          publicEndpointUrl: 'https://objects.example.com',
          publicReadMode: 'existing-gateway',
        },
        bucket: 'proof-bucket',
        coordinatorRole: {description: 'coordinator', roleName: 'coordinator-role', serviceAccount: 'proof-coordinator'},
        keyPrefix: 'proof-topology',
        secretName: 'proof-secret',
        withdrawalRole: {description: 'withdrawal', roleName: 'withdrawal-role', serviceAccount: 'withdrawal-processor'},
      },
    )

    const bucketMutations = calls.filter(call =>
      call.args[0] === 's3api'
      && ['put-public-access-block', 'put-bucket-policy', 'delete-bucket-policy'].includes(call.args[1]),
    )
    expect(bucketMutations).to.deep.equal([])
  })

  it('discovers EKS route tables and creates the regional S3 gateway endpoint', () => {
    const calls: Array<{args: string[]; kind: 'json' | 'run' | 'text'}> = []
    const aws = {
      json(args: string[]): any {
        calls.push({args, kind: 'json'})
        if (args[0] === 'eks' && args[1] === 'describe-cluster') {
          return {
            cluster: {
              resourcesVpcConfig: {
                subnetIds: ['subnet-aaaaaaaa', 'subnet-bbbbbbbb'],
                vpcId: 'vpc-11111111',
              },
            },
          }
        }

        if (args[0] === 'ec2' && args[1] === 'describe-route-tables' && args.includes('--filters')) {
          return {
            RouteTables: [
              {
                Associations: [{SubnetId: 'subnet-aaaaaaaa'}],
                RouteTableId: 'rtb-aaaaaaaa',
                VpcId: 'vpc-11111111',
              },
              {
                Associations: [{Main: true}],
                RouteTableId: 'rtb-bbbbbbbb',
                VpcId: 'vpc-11111111',
              },
            ],
          }
        }

        if (args[0] === 'ec2' && args[1] === 'describe-vpc-endpoints' && args.includes('--filters')) {
          return {VpcEndpoints: []}
        }

        if (args[0] === 'ec2' && args[1] === 'create-vpc-endpoint') {
          return {VpcEndpoint: {VpcEndpointId: 'vpce-abc123'}}
        }

        if (args[0] === 'ec2' && args[1] === 'describe-vpc-endpoints') {
          return {
            VpcEndpoints: [{
              RouteTableIds: ['rtb-aaaaaaaa', 'rtb-bbbbbbbb'],
              ServiceName: 'com.amazonaws.us-east-1.s3',
              State: 'pending',
              VpcEndpointType: 'Gateway',
              VpcId: 'vpc-11111111',
            }],
          }
        }

        if (args[0] === 'ec2' && args[1] === 'describe-route-tables') {
          return {
            RouteTables: [
              {RouteTableId: 'rtb-aaaaaaaa', VpcId: 'vpc-11111111'},
              {RouteTableId: 'rtb-bbbbbbbb', VpcId: 'vpc-11111111'},
            ],
          }
        }

        return {}
      },
      run(args: string[]): string {
        calls.push({args, kind: 'run'})
        return ''
      },
      text(args: string[]): string {
        calls.push({args, kind: 'text'})
        if (args[0] === 'sts') return '123456789012'
        if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE'
        if (args[0] === 's3api' && args[1] === 'get-bucket-policy') {
          throw new Error('NoSuchBucketPolicy')
        }

        throw new Error(`unexpected text call: ${args.join(' ')}`)
      },
    }
    const provisioner = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)
    const result = provisioner.provision(
      {awsRegion: 'us-east-1', deploymentAlias: 'deployment-01', eksCluster: 'cluster', namespace: 'default'},
      {
        artifactRead: {
          publicEndpointUrl: 'https://objects.example.com/',
          publicReadMode: 'existing-gateway',
          vpcEndpoint: {enabled: true},
        },
        bucket: 'proof-bucket',
        coordinatorRole: {description: 'coordinator', roleName: 'coordinator-role', serviceAccount: 'proof-coordinator'},
        keyPrefix: 'proof-topology',
        secretName: 'proof-secret',
        withdrawalRole: {description: 'withdrawal', roleName: 'withdrawal-role', serviceAccount: 'withdrawal-processor'},
      },
    )

    expect(result.artifactReadTransport).to.deep.equal({
      publicEndpointUrl: 'https://objects.example.com',
      publicReadMode: 'existing-gateway',
      publicStatus: 'operator-managed-unverified',
      vpcEndpoint: {
        created: true,
        routeTableIds: ['rtb-aaaaaaaa', 'rtb-bbbbbbbb'],
        status: 'configured-unverified',
        vpcEndpointId: 'vpce-abc123',
      },
    })
    const create = calls.find(call => call.args[0] === 'ec2' && call.args[1] === 'create-vpc-endpoint')
    expect(create?.args).to.deep.equal([
      'ec2',
      'create-vpc-endpoint',
      '--vpc-id',
      'vpc-11111111',
      '--service-name',
      'com.amazonaws.us-east-1.s3',
      '--vpc-endpoint-type',
      'Gateway',
      '--route-table-ids',
      'rtb-aaaaaaaa',
      'rtb-bbbbbbbb',
    ])
  })

  it('accepts only credential-free HTTPS endpoint bases for public proof reads', () => {
    expect(normalizeProofArtifactPublicEndpoint('https://objects.example.com/'))
      .to.equal('https://objects.example.com')
    expect(normalizeProofArtifactPublicEndpoint('https://objects.example.com/proof-gateway/'))
      .to.equal('https://objects.example.com/proof-gateway')
    for (const invalid of [
      'http://objects.example.com',
      'https://user:secret@objects.example.com',
      'https://objects.example.com?token=secret',
    ]) {
      expect(() => normalizeProofArtifactPublicEndpoint(invalid)).to.throw('proof artifact public endpoint')
    }
  })

  it('derives and provisions a prefix-scoped direct S3 public read without public list or write', () => {
    const calls: Array<{args: string[]; kind: 'json' | 'run' | 'text'}> = []
    const operatorStatement = {
      Action: 's3:ListBucket',
      Effect: 'Deny',
      Resource: 'arn:aws:s3:::proof-bucket',
      Sid: 'OperatorGuard',
    }
    const aws = {
      json(args: string[]): any {
        calls.push({args, kind: 'json'})
        return {}
      },
      run(args: string[]): string {
        calls.push({args, kind: 'run'})
        return ''
      },
      text(args: string[]): string {
        calls.push({args, kind: 'text'})
        if (args[0] === 'sts') return '123456789012'
        if (args[0] === 'eks') return 'https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE'
        if (args[0] === 's3api' && args[1] === 'get-bucket-policy') {
          return JSON.stringify({Statement: [operatorStatement], Version: '2012-10-17'})
        }

        throw new Error(`unexpected text call: ${args.join(' ')}`)
      },
    }
    const provisioner = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)
    const result = provisioner.provision(
      {awsRegion: 'us-east-1', deploymentAlias: 'deployment-01', eksCluster: 'cluster', namespace: 'default'},
      {
        artifactRead: {publicReadMode: 'direct-s3'},
        bucket: 'proof-bucket',
        coordinatorRole: {description: 'coordinator', roleName: 'coordinator-role', serviceAccount: 'proof-coordinator'},
        keyPrefix: 'proof-topology',
        secretName: 'proof-secret',
        withdrawalRole: {description: 'withdrawal', roleName: 'withdrawal-role', serviceAccount: 'withdrawal-processor'},
      },
    )

    expect(result.artifactReadTransport).to.deep.equal({
      publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com',
      publicReadMode: 'direct-s3',
      publicStatus: 'configured-unverified',
    })
    const publicAccessBlock = calls.find(
      call => call.args[0] === 's3api' && call.args[1] === 'put-public-access-block',
    )
    expect(publicAccessBlock?.args).to.include(
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false',
    )
    const putBucketPolicy = calls.find(
      call => call.args[0] === 's3api' && call.args[1] === 'put-bucket-policy',
    )
    const policy = JSON.parse(putBucketPolicy?.args[putBucketPolicy.args.indexOf('--policy') + 1] as string)
    expect(policy.Statement).to.deep.equal([
      operatorStatement,
      {
        Action: 's3:GetObject',
        Effect: 'Allow',
        Principal: '*',
        Resource: publicArtifactObjectResources('proof-bucket', 'proof-topology'),
        Sid: 'ScrollSdkProofArtifactPublicRead',
      },
    ])
  })

  it('derives the regional direct S3 endpoint', () => {
    expect(proofArtifactS3Endpoint('ap-northeast-1'))
      .to.equal('https://s3.ap-northeast-1.amazonaws.com')
  })

  it('separates public external-consumer keys from the internal sidecar namespace', () => {
    const resources = publicArtifactObjectResources('proof-bucket', 'rehearsal/batches')
    expect(resources).to.deep.equal([
      'arn:aws:s3:::proof-bucket/rehearsal/batches/0x*',
      'arn:aws:s3:::proof-bucket/rehearsal/batches/input-specs/*',
      'arn:aws:s3:::proof-bucket/rehearsal/batches/prepared-bundles/*',
      'arn:aws:s3:::proof-bucket/rehearsal/batches/witnesses/*',
      'arn:aws:s3:::proof-bucket/rehearsal/batches/public-outputs/*',
      'arn:aws:s3:::proof-bucket/rehearsal/batches/proofs/*',
    ])
    expect(JSON.stringify(resources)).not.to.include('scroll-chunk-segmentation-sidecars')
  })

  it('rejects an EKS-region gateway endpoint for a cross-region artifact bucket', () => {
    const calls: Array<{args: string[]; options: AwsCliOptions}> = []
    const aws = {
      json(): any { return {} },
      run(args: string[], options: AwsCliOptions = {}): string {
        calls.push({args, options})
        return ''
      },
      text(): string { throw new Error('unexpected text call') },
    }
    const provisioner = new ProofAwsProvisioner(new JsonOutputContext('test', true), undefined, aws)
    expect(() => provisioner.provision(
      {
        artifactRegion: 'us-west-2',
        awsRegion: 'us-east-1',
        deploymentAlias: 'deployment-01',
        eksCluster: 'cluster',
        namespace: 'default',
      },
      {
        artifactRead: {
          publicReadMode: 'direct-s3',
          vpcEndpoint: {enabled: true},
        },
        bucket: 'proof-bucket',
        coordinatorRole: {description: 'coordinator', roleName: 'coordinator-role', serviceAccount: 'proof-coordinator'},
        keyPrefix: 'rehearsal/batches',
        secretName: 'proof-secret',
        withdrawalRole: {description: 'withdrawal', roleName: 'withdrawal-role', serviceAccount: 'withdrawal-processor'},
      },
    )).to.throw('cannot configure an us-east-1 S3 Gateway endpoint for artifact bucket region us-west-2')
    expect(calls).to.deep.equal([{
      args: ['s3api', 'head-bucket', '--bucket', 'proof-bucket'],
      options: {region: 'us-west-2'},
    }])
  })

  it('builds a key-prefix-scoped S3 role policy', () => {
    expect(buildProofArtifactStorePolicy('proof-bucket', 'proof-topology')).to.deep.equal({
      Statement: [
        {
          Action: ['s3:GetObject', 's3:PutObject'],
          Effect: 'Allow',
          Resource: 'arn:aws:s3:::proof-bucket/proof-topology/*',
        },
        {
          Action: ['s3:ListBucket'],
          Condition: {
            StringLike: {
              's3:prefix': ['proof-topology', 'proof-topology/*'],
            },
          },
          Effect: 'Allow',
          Resource: 'arn:aws:s3:::proof-bucket',
        },
      ],
      Version: '2012-10-17',
    })
  })

  it('accepts nested proof key prefixes and rejects unsafe path syntax', () => {
    expect(normalizeProofKeyPrefix('releases/v1')).to.equal('releases/v1')
    for (const invalid of ['', '/proof-topology', 'proof-topology/', 'proof//topology', 'proof/../topology', 'proof/*', 'proof topology', 'proof#topology']) {
      expect(() => normalizeProofKeyPrefix(invalid)).to.throw('proof artifact key prefix')
    }
  })

  it('validates S3 bucket names before contacting AWS', () => {
    expect(normalizeProofBucketName('proof-bucket')).to.equal('proof-bucket')
    for (const invalid of ['ab', '-proofs', 'Proofs', 'proofs..archive', `${'a'.repeat(64)}`]) {
      expect(() => normalizeProofBucketName(invalid)).to.throw('proof artifact S3 bucket')
    }
  })

  it('preserves operator bucket-policy statements while upserting prefix-scoped VPC endpoint read', () => {
    const existing = {
      Statement: [{ Action: 's3:ListBucket', Effect: 'Deny', Resource: 'arn:aws:s3:::proof-bucket', Sid: 'OperatorGuard' }],
      Version: '2012-10-17',
    }
    const updated = upsertProofArtifactVpcEndpointReadPolicy(
      existing,
      'proof-bucket',
      'proof-topology',
      'vpce-0123456789abcdef0'
    )

    expect(updated.Statement).to.deep.equal([
      existing.Statement[0],
      {
        Action: 's3:GetObject',
        Condition: { StringEquals: { 'aws:SourceVpce': 'vpce-0123456789abcdef0' } },
        Effect: 'Allow',
        Principal: '*',
        Resource: 'arn:aws:s3:::proof-bucket/proof-topology/*',
        Sid: 'ScrollSdkProofArtifactReadViaVpcEndpoint',
      },
    ])

    const rerun = upsertProofArtifactVpcEndpointReadPolicy(
      updated,
      'proof-bucket',
      'proof-topology',
      'vpce-fedcba98765432100'
    )
    expect(rerun.Statement).to.have.length(2)
    expect(rerun.Statement[1].Condition.StringEquals['aws:SourceVpce']).to.equal('vpce-fedcba98765432100')
  })

  it('migrates an equivalent legacy bucket-wide VPC endpoint read without retaining broad access', () => {
    const updated = upsertProofArtifactVpcEndpointReadPolicy(
      {
        Statement: [
          { Action: 's3:ListBucket', Effect: 'Deny', Resource: 'arn:aws:s3:::proof-bucket', Sid: 'OperatorGuard' },
          {
            Action: 's3:GetObject',
            Condition: { StringEquals: { 'aws:SourceVpce': 'vpce-0123456789abcdef0' } },
            Effect: 'Allow',
            Principal: '*',
            Resource: 'arn:aws:s3:::proof-bucket/*',
            Sid: 'WorkerAnonymousReadViaVpcEndpoint',
          },
        ],
        Version: '2012-10-17',
      },
      'proof-bucket',
      'proof-topology',
      'vpce-0123456789abcdef0'
    )

    expect(updated.Statement).to.have.length(2)
    expect(updated.Statement[0].Sid).to.equal('OperatorGuard')
    expect(updated.Statement[1].Sid).to.equal('ScrollSdkProofArtifactReadViaVpcEndpoint')
    expect(updated.Statement[1].Resource).to.equal('arn:aws:s3:::proof-bucket/proof-topology/*')
    expect(JSON.stringify(updated)).not.to.include('arn:aws:s3:::proof-bucket/*')
  })

  it('upserts and removes only the CLI-managed direct S3 public read statement', () => {
    const operatorStatement = {
      Action: 's3:ListBucket',
      Effect: 'Deny',
      Resource: 'arn:aws:s3:::proof-bucket',
      Sid: 'OperatorGuard',
    }
    const enabled = upsertProofArtifactPublicReadPolicy(
      {Statement: [operatorStatement], Version: '2012-10-17'},
      'proof-bucket',
      'proof-topology',
      true,
    )
    expect(enabled.Statement).to.deep.equal([
      operatorStatement,
      {
        Action: 's3:GetObject',
        Effect: 'Allow',
        Principal: '*',
        Resource: publicArtifactObjectResources('proof-bucket', 'proof-topology'),
        Sid: 'ScrollSdkProofArtifactPublicRead',
      },
    ])

    const rerun = upsertProofArtifactPublicReadPolicy(
      enabled,
      'proof-bucket',
      'proof-topology',
      true,
    )
    expect(rerun).to.deep.equal(enabled)

    const disabled = upsertProofArtifactPublicReadPolicy(
      enabled,
      'proof-bucket',
      'proof-topology',
      false,
    )
    expect(disabled.Statement).to.deep.equal([operatorStatement])
  })

  it('refuses to activate unrelated wildcard grants when disabling public-policy blocking', () => {
    expect(() => assertNoUnmanagedPublicProofBucketGrant({
      Statement: [{
        Action: 's3:GetObject',
        Effect: 'Allow',
        Principal: '*',
        Resource: 'arn:aws:s3:::proof-bucket/unrelated/*',
        Sid: 'UnrelatedPublicRead',
      }],
    })).to.throw('grants unmanaged public access')

    expect(() => assertNoUnmanagedPublicProofBucketGrant({
      Statement: [{
        Action: 's3:GetObject',
        Condition: {StringEquals: {'aws:SourceVpce': 'vpce-0123456789abcdef0'}},
        Effect: 'Allow',
        Principal: '*',
        Resource: 'arn:aws:s3:::proof-bucket/proof-topology/*',
      }],
    })).not.to.throw()
  })

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
    expect(coordinator.externalSecrets.secrets.secretRegion).to.equal('us-west-2')

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

  it('updates the secret path and region on existing AWS proof-token mappings', () => {
    const coordinator = {
      externalSecrets: {
        secrets: {
          data: [
            {
              remoteRef: { key: 'scroll/proof-coordinator-secrets', property: 'proof-work-token' },
              secretKey: 'proof-work-token',
            },
            {
              remoteRef: { key: 'scroll/proof-coordinator-secrets', property: 'prover-worker-token' },
              secretKey: 'prover-worker-token',
            },
          ],
          provider: 'aws',
          secretRegion: 'us-west-2',
          serviceAccount: 'external-secrets',
        },
      },
    }

    const withdrawal = {
      externalSecrets: {
        'proof-secrets': {
          data: [
            {
              remoteRef: { key: 'scroll/proof-coordinator-secrets', property: 'proof-work-token' },
              secretKey: 'proof-work-token',
            },
          ],
          provider: 'aws',
          secretRegion: 'us-west-2',
          serviceAccount: 'external-secrets',
        },
      },
    }

    applyProofAwsValues(coordinator, withdrawal, {
      ...PROJECTION,
      secretName: 'scroll/dev0829/proof-coordinator-secrets',
      secretRegion: 'us-east-1',
    })

    expect(coordinator.externalSecrets.secrets.secretRegion).to.equal('us-east-1')
    expect(withdrawal.externalSecrets['proof-secrets'].secretRegion).to.equal('us-east-1')
    expect(coordinator.externalSecrets.secrets.data.map((item: any) => item.remoteRef.key))
      .to.deep.equal([
        'scroll/dev0829/proof-coordinator-secrets',
        'scroll/dev0829/proof-coordinator-secrets',
      ])
    expect(withdrawal.externalSecrets['proof-secrets'].data[0].remoteRef.key)
      .to.equal('scroll/dev0829/proof-coordinator-secrets')
  })

  it('rebinds alternate AWS proof-token mappings to proof-aws authority', () => {
    const coordinator = {
      externalSecrets: {
        custom: {
          data: [
            {
              remoteRef: { key: 'ops/alternate-proof-secrets', property: 'proof-work-token' },
              secretKey: 'proof-work-token',
            },
            {
              remoteRef: { key: 'ops/alternate-proof-secrets', property: 'prover-worker-token' },
              secretKey: 'prover-worker-token',
            },
          ],
          provider: 'aws',
          secretRegion: 'ap-northeast-1',
        },
      },
    }
    const withdrawal = {
      externalSecrets: {
        'proof-secrets': {
          data: [{
            remoteRef: { key: 'ops/alternate-proof-secrets', property: 'proof-work-token' },
            secretKey: 'proof-work-token',
          }],
          provider: 'aws',
          secretRegion: 'ap-northeast-1',
        },
      },
    }

    applyProofAwsValues(coordinator, withdrawal, { ...PROJECTION, secretRegion: 'us-east-1' })

    expect(coordinator.externalSecrets.custom.secretRegion).to.equal('us-east-1')
    expect(withdrawal.externalSecrets['proof-secrets'].secretRegion).to.equal('us-east-1')
    expect(coordinator.externalSecrets.custom.data.map((item: any) => item.remoteRef.key))
      .to.deep.equal([
        'scroll/proof-coordinator-secrets',
        'scroll/proof-coordinator-secrets',
      ])
    expect(withdrawal.externalSecrets['proof-secrets'].data[0].remoteRef.key)
      .to.equal('scroll/proof-coordinator-secrets')
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
