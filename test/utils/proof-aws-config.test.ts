import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildProofAwsConfig,
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
      awsRegion: 'us-east-1',
      eksCluster: 'dogeos-testnet',
      namespace: 'proof',
      networkAlias: 'testnet',
    },
    keyPrefix: 'proof-topology',
    provisioned: {
      artifactReadTransport: {
        publicEndpointUrl: 'https://objects.example.com',
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
})
