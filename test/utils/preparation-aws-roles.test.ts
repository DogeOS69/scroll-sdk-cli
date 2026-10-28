/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic IAM responses and deployment records; no cloud calls. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {irsaTrustPolicy} from '../../src/utils/aws-workload-role.js'
import {AWS_ROLES_RECORD, prepareAwsRoles} from '../../src/utils/preparation-aws-roles.js'
import {preparationSteps} from '../../src/utils/preparation-plan.js'
import {sequencerKmsIntentHash} from '../../src/utils/preparation-sequencer-kms.js'
import {buildProofAwsConfig, readProofAwsConfig, writeProofAwsConfig} from '../../src/utils/proof-aws-config.js'

const account = '000000000000'
const region = 'us-east-1'
const issuer = 'oidc.eks.us-east-1.amazonaws.com/id/FIXTURE'
const roleArn = (name: string) => `arn:aws:iam::${account}:role/${name}`
const keyArn = (name: string) => `arn:aws:kms:${region}:${account}:key/${name}`

function fixtureSpec(): DeploymentSpec {
  return {
    identities: {bootnodes: [], ethDaSubmitter: {action: 'reuse', backend: 'aws_kms', kms: {keyId: keyArn('existing')}}, feeOracle: {action: 'reuse', backend: 'aws_kms', kms: {keyId: keyArn('existing')}}, sequencers: [{index: 0, nodekey: {action: 'create'}, signer: {action: 'reuse', backend: 'aws_kms', kms: {keyId: keyArn('existing')}}}]},
    infrastructure: {aws: {accountId: account, eksClusterName: 'cluster', region, roles: {ethDaSubmitter: roleArn('external/da'), feeOracle: roleArn('external/fee'), proofCoordinator: roleArn('external/proof'), sequencers: {'0': roleArn('external/seq')}, withdrawalProcessor: roleArn('external/wp')}}, bootnodeCount: 0, namespace: 'fixture', provider: 'aws', sequencerCount: 1},
    metadata: {name: 'fixture'},
    preparation: {bridge: {mode: 'production', production: {sequencerKms: {action: 'reuse', keyId: keyArn('bridge')}}}, proofAws: {action: 'reuse', publicReadMode: 'existing-public-s3'}, proofMaterials: {mode: 'existing'}},
  } as unknown as DeploymentSpec
}

class FakeIam {
  account = account
  calls: string[][] = []
  denied = false
  inline = new Map<string, Map<string, any>>()
  roles = new Map<string, any>()
  json(args: string[]): any {
    this.calls.push(args)
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    const name = value('--role-name')
    switch (args[1]) {
      case 'simulate-principal-policy': {
        const actions = args.slice(args.indexOf('--action-names') + 1, args.indexOf('--resource-arns'))
        const resources = args.slice(args.indexOf('--resource-arns') + 1, args.indexOf('--context-entries'))
        return {EvaluationResults: actions.flatMap(EvalActionName => resources.map(EvalResourceName => ({EvalActionName, EvalDecision: this.denied ? 'implicitDeny' : 'allowed', EvalResourceName})))}
      }

      case 'create-role': {
        const role = {Arn: roleArn(name), AssumeRolePolicyDocument: JSON.parse(value('--assume-role-policy-document')), Path: '/', Tags: JSON.parse(value('--tags'))}
        this.roles.set(name, role)
        return {Role: role}
      }

      case 'delete-role-policy': {this.inline.get(name)?.delete(value('--policy-name')); return {}}
      case 'describe-cluster': {return {cluster: {identity: {oidc: {issuer: `https://${issuer}`}}}}}
      case 'get-caller-identity': {return {Account: this.account, Arn: `arn:aws:iam::${this.account}:user/fixture`}}
      case 'get-open-id-connect-provider': {return {ClientIDList: ['sts.amazonaws.com']}}
      case 'list-resource-tags': {return {Tags: []}}
      case 'get-key-policy': {return {Policy: {Statement: [{Action: 'kms:*', Effect: 'Allow', Principal: {AWS: `arn:aws:iam::${account}:root`}}]}}}
      case 'get-policy': {return {Policy: {Arn: value('--policy-arn')}}}
      case 'get-role': {
        if (!this.roles.has(name)) throw new Error('An error occurred (NoSuchEntity) when calling the GetRole operation')
        return {Role: this.roles.get(name)}
      }

      case 'list-attached-role-policies': {return {AttachedPolicies: []}}
      case 'list-role-policies': {return {PolicyNames: [...(this.inline.get(name)?.keys() ?? [])]}}
      case 'put-role-policy': {
        if (!this.inline.has(name)) this.inline.set(name, new Map())
        this.inline.get(name)!.set(value('--policy-name'), JSON.parse(value('--policy-document')))
        return {}
      }

      case 'tag-role': {this.roles.get(name).Tags = JSON.parse(value('--tags')); return {}}
      case 'update-assume-role-policy': {this.roles.get(name).AssumeRolePolicyDocument = JSON.parse(value('--policy-document')); return {}}
      default: {throw new Error(`Unexpected AWS operation ${args.join(' ')}`)}
    }
  }

  // A role created by an earlier CLI: untagged, trusting exactly its ServiceAccount.
  legacy(name: string, namespace: string, serviceAccount: string): void {
    this.roles.set(name, {Arn: roleArn(name), AssumeRolePolicyDocument: irsaTrustPolicy({account, issuerHostPath: issuer}, namespace, serviceAccount), Path: '/'})
  }
}

describe('external workload role validation', () => {
  let root: string
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const config = () => toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-roles-'))
    fs.mkdirSync(path.join(root, '.data'))
    const signer = (service: string, extra: Record<string, unknown> = {}) => ({backend: 'aws_kms', eksCluster: 'cluster', kmsKeyArn: keyArn(service), kmsKeyId: `alias/${service}`, kmsRegion: region, namespace: 'fixture', networkAlias: 'fixture', role: service, service, ...extra})
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify({
      ethereumDa: {blobArchive: {s3: {bucket: 'fixture-da', enabled: true, keyPrefix: 'blobs', region}}},
      proofArtifacts: {s3: {bucket: 'fixture-proof', keyPrefix: 'proofs', region}},
      sequencerReth: {instances: [{index: 0, signer: {eksCluster: 'cluster', kmsKeyArn: keyArn('sequencer'), kmsRegion: region, mode: 'aws_kms', namespace: 'fixture', networkAlias: 'fixture', serviceAccountName: 'l2-reth-sequencer-0', serviceAccountRoleArn: roleArn('dogeos-fixture-cluster-sequencer-reth-0-kms')}}]},
      signers: {
        l1CommitSender: signer('eth-da-submitter', {serviceAccountName: 'eth-da-submitter', serviceAccountRoleArn: roleArn('dogeos-fixture-cluster-eth-da-submitter-kms')}),
        l2GasOracleSender: signer('fee-oracle', {serviceAccountName: 'fee-oracle', serviceAccountRoleArn: roleArn('dogeos-fixture-cluster-fee-oracle-kms')}),
      },
    } as any))
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), buildProofAwsConfig({coordinatorServiceAccount: 'proof-coordinator', identity: {awsRegion: region, deploymentAlias: 'fixture', eksCluster: 'cluster', namespace: 'fixture'}, keyPrefix: 'proofs', provisioned: {artifactReadTransport: {publicEndpointUrl: `https://s3.${region}.amazonaws.com`, publicReadMode: 'direct-s3', publicStatus: 'configured-unverified'}, bucket: 'fixture-proof', bucketCreated: false, coordinatorRoleArn: roleArn('dogeos-fixture-cluster-proof-coordinator'), secretAction: 'reused', secretName: 'fixture-proof', withdrawalRoleArn: roleArn('dogeos-fixture-cluster-wp-proof')}, withdrawalServiceAccount: 'withdrawal-processor'}))
    fs.writeFileSync(path.join(root, '.data/bridge-sequencer-kms.json'), JSON.stringify({intentHash: sequencerKmsIntentHash(fixtureSpec()), keyArn: keyArn('bridge'), publicKey: '02' + '1'.repeat(64), ready: true, region, roleArn: roleArn('dogeos-fixture-cluster-wp-proof'), schema: 'dogeos/bridge-sequencer-kms/v1', serviceAccount: 'withdrawal-processor'}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  function existing(spec = fixtureSpec()): FakeIam {
    const aws = new FakeIam()
    const refs = spec.infrastructure.aws!.roles!
    const arns = [refs.ethDaSubmitter, refs.feeOracle, refs.proofCoordinator, refs.withdrawalProcessor, ...Object.values(refs.sequencers ?? {}), refs.externalSecrets].filter(Boolean) as string[]
    for (const arn of arns) aws.roles.set(arn.split('/').at(-1)!, {Arn: arn})


    return aws
  }

  it('validates roles read-only and binds explicit path-containing ARNs idempotently', () => {
    const spec = fixtureSpec(); const aws = existing(spec)
    const before = JSON.stringify([...aws.roles])
    prepareAwsRoles(root, spec, aws, () => {})
    const saved = fs.readFileSync(path.join(root, AWS_ROLES_RECORD), 'utf8')
    prepareAwsRoles(root, spec, aws, () => {})
    expect(fs.readFileSync(path.join(root, AWS_ROLES_RECORD), 'utf8')).eq(saved)
    expect(JSON.stringify([...aws.roles])).eq(before)
    expect(config().signers.l2GasOracleSender.serviceAccountRoleArn).eq(roleArn('external/fee'))
    expect(read(AWS_ROLES_RECORD).schema).eq('dogeos/aws-roles/v3')
    expect(readProofAwsConfig(root).config.serviceAccounts.withdrawalProcessor.roleArn).eq(roleArn('external/wp'))
    expect(aws.calls.every(args => args[1].startsWith('get-'))).true
  })
  it('reads Pod Identity associations and fails before local writes for a different role', () => {
    const spec = fixtureSpec(); spec.infrastructure.aws!.workloadIdentity = 'pod-identity'
    const aws = existing(spec)
    const roles: Record<string, string> = {'eth-da-submitter': roleArn('external/da'), 'fee-oracle': roleArn('external/fee'), 'l2-reth-sequencer-0': roleArn('external/seq'), 'proof-coordinator': roleArn('external/proof'), 'withdrawal-processor': roleArn('external/wp')}
    let mismatch = false
    const reader = {json(args: string[]) {
      const value = (flag: string) => args[args.indexOf(flag) + 1]
      if (args[1] === 'list-pod-identity-associations') return {associations: [{associationId: value('--service-account')}]}
      if (args[1] === 'describe-pod-identity-association') return {association: {roleArn: mismatch ? roleArn('wrong') : roles[value('--association-id')]}}
      return aws.json(args)
    }}
    prepareAwsRoles(root, spec, reader, () => {})
    expect(config().awsWorkloadIdentity).eq('pod-identity')
    expect(read(AWS_ROLES_RECORD).roles.every((entry: any) => entry.associationId)).true
    const before = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    mismatch = true
    expect(() => prepareAwsRoles(root, spec, reader, () => {})).throw('different role')
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).eq(before)
  })
  it('reports resource read failures without partially binding local values', () => {
    const aws = existing(); aws.roles.delete('wp')
    const before = fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')
    expect(() => prepareAwsRoles(root, fixtureSpec(), aws, () => {})).throw('Cannot read AWS resource')
    expect(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')).eq(before)
  })
  it('validates a separately installed Secret reader using the generated deployment prefix', () => {
    const spec = fixtureSpec()
    spec.infrastructure.aws!.roles!.externalSecrets = roleArn('external/eso')
    const aws = existing(spec)
    prepareAwsRoles(root, spec, aws, () => {})
    const entry = read(AWS_ROLES_RECORD).roles.find((role: any) => role.catalogEntry === 'external-secrets')
    expect(entry).include({roleArn: roleArn('external/eso'), serviceAccount: 'external-secrets'})
    expect(aws.calls.every(args => args[1] === 'get-role')).true
  })

  it('keeps the role-binding step read-only', () => {
    expect(preparationSteps(fixtureSpec(), true).find(step => step.id === 'aws-roles')).include({effect: 'read', stage: 'aws'})
  })
})
