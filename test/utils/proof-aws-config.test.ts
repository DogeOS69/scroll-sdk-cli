import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildProofAwsConfig,
  defaultProofSecretName,
  proofAwsValuesProjection,
  readProofAwsConfig,
  writeProofAwsConfig,
} from '../../src/utils/proof-aws-config.js'
import { projectProofAwsConfig } from '../../src/utils/proof-kubernetes-reconciler.js'

const COORDINATOR_ROLE = 'arn:aws:iam::123456789012:role/testnet-proof-coordinator'
const WITHDRAWAL_ROLE = 'arn:aws:iam::123456789012:role/testnet-withdrawal-processor'

function fixture() {
  return buildProofAwsConfig({
    coordinatorServiceAccount: 'proof-coordinator',
    identity: {
      artifactRegion: 'us-east-1',
      awsRegion: 'us-east-1',
      deploymentAlias: 'dogeos-testnet-01',
      eksCluster: 'dogeos-testnet',
      namespace: 'proof',
    },
    keyPrefix: 'proof-topology',
    provisioned: {
      artifactReadTransport: {
        publicEndpointUrl: 'https://objects.example.com',
        publicReadMode: 'existing-gateway',
        publicStatus: 'operator-managed-unverified',
        vpcEndpoint: {
          created: false,
          routeTableIds: ['rtb-bbbbbbbb', 'rtb-aaaaaaaa'],
          status: 'configured-unverified',
          vpcEndpointId: 'vpce-abc123',
        },
      },
      bucket: 'dogeos-testnet-proof-artifacts',
      bucketCreated: false,
      coordinatorRoleArn: COORDINATOR_ROLE,
      secretAction: 'reused',
      secretName: 'scroll/proof-coordinator-secrets',
      withdrawalRoleArn: WITHDRAWAL_ROLE,
    },
    withdrawalServiceAccount: 'withdrawal-processor',
  })
}

describe('proof AWS config source', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-aws-config-'))
  })

  afterEach(() => {
    fs.rmSync(root, {force: true, recursive: true})
  })

  it('derives a deployment-scoped default secret name', () => {
    expect(defaultProofSecretName('dogeos-testnet-01'))
      .to.equal('scroll/dogeos-testnet-01/proof-coordinator-secrets')
    expect(() => defaultProofSecretName('Partner A'))
      .to.throw('must already be normalized')
  })

  it('writes stable resource facts without operation timestamps or secret values', () => {
    const configPath = path.join(root, '.data/proof-aws.json')
    const first = writeProofAwsConfig(configPath, fixture())
    const before = fs.readFileSync(configPath, 'utf8')
    const second = writeProofAwsConfig(configPath, fixture())

    expect(first.changed).to.equal(true)
    expect(second.changed).to.equal(false)
    expect(fs.readFileSync(configPath, 'utf8')).to.equal(before)
    expect(before).not.to.include('generatedAt')
    expect(before).not.to.include('proof-work-token')
    expect(before).not.to.include('prover-worker-token')
    expect(readProofAwsConfig(root).config.artifactReadTransport.vpcEndpoint?.routeTableIds)
      .to.deep.equal(['rtb-aaaaaaaa', 'rtb-bbbbbbbb'])
  })

  it('rejects the superseded v2 network-alias contract instead of silently migrating it', () => {
    const configPath = path.join(root, '.data/proof-aws.json')
    const legacy = {
      ...fixture(),
      kubernetes: {
        eksCluster: 'dogeos-testnet',
        namespace: 'proof',
        networkAlias: 'testnet',
      },
      schema: 'dogeos/proof-aws/v2',
    }
    fs.mkdirSync(path.dirname(configPath), {recursive: true})
    fs.writeFileSync(configPath, `${JSON.stringify(legacy, undefined, 2)}\n`)

    expect(() => readProofAwsConfig(root)).to.throw(
      '.schema must be dogeos/proof-aws/v4',
    )
  })

  it('keeps artifact and EKS/secret regions independent', () => {
    const config = fixture()
    config.artifactStore.region = 'us-west-2'
    config.kubernetes.awsRegion = 'us-east-1'
    config.secret.region = 'us-east-1'
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), config)

    const loaded = readProofAwsConfig(root).config
    expect(loaded.artifactStore.region).to.equal('us-west-2')
    expect(loaded.kubernetes.awsRegion).to.equal('us-east-1')
    expect(loaded.secret.region).to.equal('us-east-1')
    expect(proofAwsValuesProjection(loaded)).to.include({
      artifactRegion: 'us-west-2',
      secretRegion: 'us-east-1',
    })
  })

  it('accepts an operator-managed public S3 transport with the regional endpoint', () => {
    const config = fixture()
    config.artifactReadTransport = {
      publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com',
      publicReadMode: 'existing-public-s3',
      publicStatus: 'operator-managed-unverified',
    }
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), config)

    expect(readProofAwsConfig(root).config.artifactReadTransport).to.deep.equal({
      publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com',
      publicReadMode: 'existing-public-s3',
      publicStatus: 'operator-managed-unverified',
    })
  })

  it('rejects a non-regional endpoint for an operator-managed public S3 transport', () => {
    const config = fixture()
    config.artifactReadTransport = {
      publicEndpointUrl: 'https://objects.example.com',
      publicReadMode: 'existing-public-s3',
      publicStatus: 'operator-managed-unverified',
    }

    expect(() => writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), config))
      .to.throw('must match artifactStore.region in S3 endpoint mode')
  })

  it('projects config into final values idempotently', () => {
    const valuesDir = path.join(root, 'values')
    fs.mkdirSync(valuesDir, {recursive: true})
    fs.writeFileSync(
      path.join(valuesDir, 'proof-coordinator-production.yaml'),
      yaml.dump({
        env: [{
          name: 'DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET',
          value: '<TODO>',
        }],
        serviceAccount: {annotations: {'operator.example/kept': 'true'}},
      }),
    )
    fs.writeFileSync(
      path.join(valuesDir, 'withdrawal-processor-production.yaml'),
      yaml.dump({withdrawalProof: {enabled: true}}),
    )
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), fixture())

    expect(projectProofAwsConfig(root, valuesDir)).to.equal(
      path.join(root, '.data/proof-aws.json'),
    )
    const coordinatorPath = path.join(valuesDir, 'proof-coordinator-production.yaml')
    const withdrawalPath = path.join(valuesDir, 'withdrawal-processor-production.yaml')
    const firstCoordinator = fs.readFileSync(coordinatorPath, 'utf8')
    const firstWithdrawal = fs.readFileSync(withdrawalPath, 'utf8')

    projectProofAwsConfig(root, valuesDir)
    expect(fs.readFileSync(coordinatorPath, 'utf8')).to.equal(firstCoordinator)
    expect(fs.readFileSync(withdrawalPath, 'utf8')).to.equal(firstWithdrawal)

    const coordinator = yaml.load(firstCoordinator) as any
    const withdrawal = yaml.load(firstWithdrawal) as any
    const env = Object.fromEntries(coordinator.env.map((item: any) => [item.name, item.value]))
    expect(env.DOGEOS_PROOF_COORDINATOR_ARTIFACT_STORE__BUCKET)
      .to.equal('dogeos-testnet-proof-artifacts')
    expect(coordinator.serviceAccount.annotations).to.deep.equal({
      'eks.amazonaws.com/role-arn': COORDINATOR_ROLE,
      'operator.example/kept': 'true',
    })
    expect(withdrawal.withdrawalProof).to.deep.include({
      enabled: true,
      s3AuthMode: 'irsa',
    })
    expect(proofAwsValuesProjection(readProofAwsConfig(root).config).secretName)
      .to.equal('scroll/proof-coordinator-secrets')
  })

  it('replaces stale generated AWS proof secret paths with the provisioned path', () => {
    const valuesDir = path.join(root, 'values')
    fs.mkdirSync(valuesDir, {recursive: true})
    const staleSecret = 'scroll/proof-coordinator-secrets'
    const deploymentSecret = 'scroll/dogeos-testnet-01/proof-coordinator-secrets'
    const proofMapping = (properties: string[]) => ({
      data: properties.map(property => ({
        remoteRef: {key: staleSecret, property},
        secretKey: property,
      })),
      provider: 'aws',
      secretRegion: 'us-west-2',
    })
    fs.writeFileSync(
      path.join(valuesDir, 'proof-coordinator-production.yaml'),
      yaml.dump({externalSecrets: {secrets: proofMapping(['proof-work-token', 'prover-worker-token'])}}),
    )
    fs.writeFileSync(
      path.join(valuesDir, 'withdrawal-processor-production.yaml'),
      yaml.dump({externalSecrets: {'proof-secrets': proofMapping(['proof-work-token'])}}),
    )
    const config = fixture()
    config.secret.name = deploymentSecret
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), config)

    projectProofAwsConfig(root, valuesDir)

    const coordinator = yaml.load(fs.readFileSync(
      path.join(valuesDir, 'proof-coordinator-production.yaml'),
      'utf8',
    )) as any
    const withdrawal = yaml.load(fs.readFileSync(
      path.join(valuesDir, 'withdrawal-processor-production.yaml'),
      'utf8',
    )) as any
    expect(coordinator.externalSecrets.secrets.data.map((item: any) => item.remoteRef.key))
      .to.deep.equal([deploymentSecret, deploymentSecret])
    expect(withdrawal.externalSecrets['proof-secrets'].data[0].remoteRef.key)
      .to.equal(deploymentSecret)
  })
})
