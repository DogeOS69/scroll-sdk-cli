/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic AWS responses. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {AWS_ACCESS_PLAN, AWS_ACCESS_RECORD, assertAwsAccessUpload, bindAwsAccessValues, bindPreparedAwsAccess, irsaTrust, planAwsAccess, prepareAwsAccess, secretReaderPolicy, validateAwsAccess} from '../../src/utils/aws-service-access.js'
import {buildProofAwsConfig, writeProofAwsConfig} from '../../src/utils/proof-aws-config.js'

const account = '000000000000'
const issuer = 'oidc.eks.us-east-1.amazonaws.com/id/FIXTURE'
function spec(): DeploymentSpec {
  return {infrastructure: {aws: {accountId: account, eksClusterName: 'fixture', region: 'us-east-1'}, bootnodeCount: 1, namespace: 'fixture', provider: 'aws', sequencerCount: 2}, metadata: {name: 'fixture'}, preparation: {awsAccess: {mode: 'managed'}}, signing: {}} as unknown as DeploymentSpec
}

function template(keys: string[]): string {return yaml.dump({externalSecrets: {env: {data: keys.map(key => ({remoteRef: {key, property: key.split('/').at(-1)}, secretKey: key.split('/').at(-1)})), provider: 'aws'}}})}
const templates = {
  Makefile: 'install-aws-access:',
  'values/fee-oracle-production.yaml': template(['fee-oracle-secret-env']),
  'values/l2-reth-sequencer-production.yaml': template(['l2-reth-sequencer-__INSTANCE_INDEX__-secret-env']),
  'values/proof-coordinator-production.yaml': template(['proof-work-token', 'prover-worker-master']),
  'values/withdrawal-processor-production.yaml': template(['proof-work-token', 'withdrawal-processor-secret-env']),
}
class FakeAws {
  buckets = new Map<string, any>()
  calls: string[][] = []
  failure?: string
  policies = new Map<string, any>()
  policyNames = new Map<string, string>()
  roles = new Map<string, any>()
  secrets = new Map<string, any>()
  json(args: string[]): any {
    this.calls.push(args)
    const op = args.slice(0, 2).join(' ')
    if (op === this.failure) throw new Error('AccessDenied PRIVATE_DETAIL_SHOULD_NOT_LEAK')
    const val = (flag: string) => args[args.indexOf(flag) + 1]
    switch (op) {
      case 'sts get-caller-identity': { return {Account: account, Arn: `arn:aws:iam::${account}:user/fixture`}
      }

      case 'eks describe-cluster': { return {cluster: {identity: {oidc: {issuer: `https://${issuer}`}}}}
      }

      case 'iam get-open-id-connect-provider': { return {ClientIDList: ['sts.amazonaws.com']}
      }

      case 'iam get-role': {
        if (!this.roles.has(val('--role-name'))) throw new Error('NoSuchEntity')
        return {Role: this.roles.get(val('--role-name'))}
      }

      case 'iam create-role': {
        const name = val('--role-name')
        const Role = {Arn: `arn:aws:iam::${account}:role/${name}`, Tags: JSON.parse(val('--tags')), Trust: JSON.parse(val('--assume-role-policy-document'))}
        this.roles.set(name, Role)
        return {Role}
      }

      case 'iam put-role-policy': { this.policies.set(val('--role-name'), JSON.parse(val('--policy-document'))); this.policyNames.set(val('--role-name'), val('--policy-name')); return {}
      }

      case 'iam list-role-policies': { return {PolicyNames: this.policyNames.has(val('--role-name')) ? [this.policyNames.get(val('--role-name'))] : []}
      }

      case 'iam get-role-policy': { return {PolicyDocument: this.policies.get(val('--role-name'))}
      }

      case 'iam list-attached-role-policies': { return {AttachedPolicies: []}
      }

      case 'iam update-assume-role-policy': { return {}
      }

      case 'secretsmanager describe-secret': case 'secretsmanager get-secret-value': {
        const found = this.secrets.get(val('--secret-id'))
        if (!found || op.endsWith('get-secret-value') && !found.SecretString) throw new Error('ResourceNotFoundException')
        return found
      }

      case 'secretsmanager create-secret': {
        const Name = val('--name')
        const secret = {ARN: `arn:aws:secretsmanager:us-east-1:${account}:secret:${Name}-ABCDEF`, Name}
        this.secrets.set(Name, secret)
        return secret
      }

      case 'secretsmanager put-secret-value': { this.secrets.get(val('--secret-id')).SecretString = val('--secret-string'); return {}
      }

      case 's3api head-bucket': {
        if (!this.buckets.has(val('--bucket'))) throw new Error('404 NotFound')
        return {}
      }

      case 's3api get-bucket-location': { return {LocationConstraint: null}
      }

      case 's3api get-bucket-encryption': { return {ServerSideEncryptionConfiguration: {Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}}]}}
      }

      case 's3api create-bucket': { this.buckets.set(val('--bucket'), {}); return {}
      }

      case 's3api get-bucket-versioning': { return {Status: this.buckets.get(val('--bucket')).versioning}
      }

      case 's3api put-bucket-versioning': { this.buckets.get(val('--bucket')).versioning = 'Enabled'; return {}
      }

      case 's3api get-public-access-block': { return {PublicAccessBlockConfiguration: this.buckets.get(val('--bucket'))?.block ?? {BlockPublicPolicy: false, RestrictPublicBuckets: false}}
      }

      case 's3control get-public-access-block': { return {PublicAccessBlockConfiguration: {BlockPublicPolicy: false, RestrictPublicBuckets: false}}
      }

      case 's3api put-public-access-block': { this.buckets.get(val('--bucket')).block = JSON.parse(val('--public-access-block-configuration')); return {}
      }

      case 's3api put-bucket-policy': { this.buckets.get(val('--bucket')).policy = JSON.parse(val('--policy')); return {}
      }

      default: { throw new Error(`Unexpected fake operation: ${op}`)
      }
    }
  }

  run(args: string[]): any {return this.json(args)}
  text(args: string[]): string {
    if (args[0] === 'sts') return account
    if (args[1] === 'get-bucket-policy') {
      const policy = this.buckets.get(args[args.indexOf('--bucket') + 1])?.policy
      if (!policy) throw new Error('NoSuchBucketPolicy')
      return JSON.stringify(policy)
    }

    return JSON.stringify(this.json(args))
  }
}
describe('per-service AWS access', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-access-'))
    for (const dir of ['.data', '.scrollsdk', 'values']) fs.mkdirSync(path.join(root, dir))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), toml.stringify({}))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const save = (input = spec()) => {
    const plan = planAwsAccess(input, templates)!
    fs.writeFileSync(path.join(root, AWS_ACCESS_PLAN), JSON.stringify(plan))
    return plan
  }

  it('plans distinct readers per service and Reth instance without wildcard secrets', () => {
    const plan = save()
    expect(Object.keys(plan.readers)).deep.equal(['fee-oracle', 'l2-reth-sequencer-0', 'l2-reth-sequencer-1', 'proof-coordinator', 'withdrawal-processor'])
    expect(plan.readers['withdrawal-processor'].secrets).not.include(`${plan.prefix}/prover-worker-master`)
    expect(plan.readers['proof-coordinator'].secrets).include(`${plan.prefix}/prover-worker-master`)
    expect(plan.readers['l2-reth-sequencer-0'].secrets[0]).not.equal(plan.readers['l2-reth-sequencer-1'].secrets[0])
  })
  it('keeps external mode read-only and validates managed bucket choices', () => {
    const input = spec(); input.preparation!.awsAccess!.mode = 'external'
    expect(planAwsAccess(input, {})).undefined
    prepareAwsAccess(root, input, new FakeAws())
    input.preparation!.awsAccess!.mode = 'managed'
    input.proofArtifacts = {s3: {bucket: 'fixture-proof', keyPrefix: 'proof'}}
    expect(() => validateAwsAccess(input)).throw('proofAws.action: create')
  })
  it('uses exact ARN resources, a namespace-specific trust and KMS decrypt only through Secrets Manager', () => {
    const arn = `arn:aws:secretsmanager:us-east-1:${account}:secret:fixture-ABCDEF`
    const policy = secretReaderPolicy([arn], 'us-east-1', `arn:aws:kms:us-east-1:${account}:key/fixture`)
    expect(policy.Statement[0].Resource).deep.equal([arn])
    expect(policy.Statement[0].Action).not.include('secretsmanager:ListSecrets')
    expect(policy.Statement[1].Condition.StringEquals['kms:EncryptionContext:SecretARN']).deep.equal([arn])
    const trust = irsaTrust(issuer, account, 'fixture', 'aws-reader-fee-oracle')
    expect(trust.Statement[0].Condition.StringEquals[`${issuer}:sub`]).equal('system:serviceaccount:fixture:aws-reader-fee-oracle')
  })
  it('creates empty containers and scoped roles, then resumes without creating more resources', () => {
    save(); const aws = new FakeAws()
    prepareAwsAccess(root, spec(), aws)
    expect([...aws.secrets.values()].every(secret => secret.SecretString === undefined)).true
    const creates = aws.calls.filter(args => args[1].startsWith('create-')).length
    prepareAwsAccess(root, spec(), aws)
    expect(aws.calls.filter(args => args[1].startsWith('create-')).length).equal(creates)
    for (const policy of aws.policies.values()) expect(JSON.stringify(policy)).not.include('s3:').not.include('kms:Sign').not.include('ec2:')
    expect(fs.existsSync(path.join(root, AWS_ACCESS_RECORD))).true
  })
  it('refuses an existing role owned by someone else and redacts provider errors', () => {
    const plan = save(); const aws = new FakeAws()
    aws.roles.set(plan.readers['fee-oracle'].roleName, {Tags: []})
    expect(() => prepareAwsAccess(root, spec(), aws)).throw('ownership')
    aws.failure = 'sts get-caller-identity'
    try {prepareAwsAccess(root, spec(), aws); expect.fail('expected failure')} catch (error) {expect(String(error)).include('failed').not.include('PRIVATE_DETAIL')}
  })
  it('splits proof tokens preserving existing values across retries and leaves the source intact', () => {
    const plan = save(); const aws = new FakeAws()
    const secretName = 'fixture/legacy-proof'
    writeProofAwsConfig(path.join(root, '.data/proof-aws.json'), buildProofAwsConfig({coordinatorServiceAccount: 'proof-coordinator', identity: {artifactRegion: 'us-east-1', awsRegion: 'us-east-1', deploymentAlias: 'fixture', eksCluster: 'fixture', namespace: 'fixture'}, keyPrefix: 'proof', provisioned: {artifactReadTransport: {publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com', publicReadMode: 'existing-public-s3', publicStatus: 'operator-managed-unverified'}, bucket: 'fixture-proof', bucketCreated: false, coordinatorRoleArn: `arn:aws:iam::${account}:role/coordinator`, secretAction: 'reused', secretName, withdrawalRoleArn: `arn:aws:iam::${account}:role/withdrawal`}, withdrawalServiceAccount: 'withdrawal-processor'}))
    const source = JSON.stringify({'proof-work-token': 'NONFUNCTIONAL_WORK_FIXTURE', 'prover-worker-master': 'NONFUNCTIONAL_MASTER_FIXTURE'})
    aws.secrets.set(secretName, {SecretString: source})
    prepareAwsAccess(root, spec(), aws)
    expect(JSON.parse(aws.secrets.get(`${plan.prefix}/proof-work-token`).SecretString)).deep.equal({'proof-work-token': 'NONFUNCTIONAL_WORK_FIXTURE'})
    const writes = aws.calls.filter(args => args[1] === 'put-secret-value').length
    prepareAwsAccess(root, spec(), aws)
    expect(aws.calls.filter(args => args[1] === 'put-secret-value').length).equal(writes)
    expect(aws.secrets.get(secretName).SecretString).equal(source)
    const readerPolicy = aws.policies.get(plan.readers['withdrawal-processor'].roleName)
    expect(JSON.stringify(readerPolicy)).not.include('prover-worker-master').not.include('legacy-proof')
  })
  it('gives a locally signed DA service a separate S3 identity and only its sidecar prefixes', () => {
    const input = spec()
    input.ethereumDa = {blobArchive: {s3: {bucket: 'fixture-da', enabled: true, keyPrefix: 'blobs', region: 'us-east-1'}}} as any
    input.proofArtifacts = {s3: {bucket: 'fixture-proof', keyPrefix: 'proof', region: 'us-east-1'}}
    input.preparation!.proofAws = {action: 'create', publicReadMode: 'existing-public-s3'}
    input.preparation!.archive = {action: 'configure', publicRead: true}
    save(input)
    const aws = new FakeAws()
    aws.buckets.set('fixture-da', {}); aws.buckets.set('fixture-proof', {})
    prepareAwsAccess(root, input, aws)
    const runtime = JSON.parse(fs.readFileSync(path.join(root, AWS_ACCESS_RECORD), 'utf8')).runtime['eth-da-submitter']
    const policy = aws.policies.get(runtime.roleArn.split('/').at(-1))
    expect(policy.Statement[0].Action).deep.equal(['s3:GetObject', 's3:PutObject'])
    expect(policy.Statement[0].Resource).equal('arn:aws:s3:::fixture-da/blobs/*')
    expect(policy.Statement[1].Resource).deep.equal(['arn:aws:s3:::fixture-proof/proof/scroll-chunk-segmentation-sidecars/*', 'arn:aws:s3:::fixture-proof/proof/scroll-chunk-segmentation-sidecars-by-height/*'])
    expect(JSON.stringify(policy)).not.include('kms:').not.include('s3:Delete').not.include('s3:List')
    prepareAwsAccess(root, input, aws)
    fs.writeFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'serviceAccount: {}')
    bindPreparedAwsAccess(root)
    const rendered = yaml.load(fs.readFileSync(path.join(root, 'values/eth-da-submitter-production.yaml'), 'utf8')) as any
    expect(rendered.serviceAccount.annotations['eks.amazonaws.com/role-arn']).equal(runtime.roleArn)
  })
  it('creates a snapshot bucket and limits its upload identity to the selected prefix', () => {
    const input = spec()
    input.snapshots = {s3: {bucket: 'fixture-snapshots', keyPrefix: 'chain', region: 'us-east-1'}}
    input.preparation!.awsAccess!.snapshot = {action: 'create', publicRead: true}
    save(input); const aws = new FakeAws()
    prepareAwsAccess(root, input, aws)
    expect(aws.buckets.get('fixture-snapshots').versioning).equal('Enabled')
    const record = JSON.parse(fs.readFileSync(path.join(root, AWS_ACCESS_RECORD), 'utf8'))
    const policy = aws.policies.get(record.runtime['snapshot-writer'].roleArn.split('/').at(-1))
    expect(policy.Statement[0].Resource).equal('arn:aws:s3:::fixture-snapshots/chain/*')
    expect(policy.Statement[0].Action).include('s3:AbortMultipartUpload').not.include('s3:DeleteObject')
    prepareAwsAccess(root, input, aws)
    expect(aws.calls.filter(args => args[1] === 'create-bucket')).length(1)
    bindPreparedAwsAccess(root)
    const rendered = yaml.load(fs.readFileSync(path.join(root, 'values/aws-access-production.yaml'), 'utf8')) as any
    expect(rendered.serviceAccounts.some((sa: any) => sa.name === 'snapshot-writer')).true
  })
  it('renders prepared identities, rejects an unrelated Secret and protects upload destination', () => {
    const plan = save(); prepareAwsAccess(root, spec(), new FakeAws())
    const values = yaml.load(templates['values/withdrawal-processor-production.yaml']) as any
    fs.writeFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), yaml.dump(values))
    bindPreparedAwsAccess(root)
    const rendered = yaml.load(fs.readFileSync(path.join(root, 'values/withdrawal-processor-production.yaml'), 'utf8')) as any
    expect(rendered.externalSecrets.env.serviceAccount).equal(plan.readers['withdrawal-processor'].serviceAccount)
    expect(rendered.externalSecrets.env.data[0].remoteRef.key).equal(`${plan.prefix}/proof-work-token`)
    const record = JSON.parse(fs.readFileSync(path.join(root, AWS_ACCESS_RECORD), 'utf8'))
    values.externalSecrets.env.data.push({remoteRef: {key: 'other-service-password'}})
    expect(() => bindAwsAccessValues(values, 'withdrawal-processor', record)).throw('outside')
    expect(() => assertAwsAccessUpload(root, 'another-deployment', plan.region)).throw('destination')
    expect(() => assertAwsAccessUpload(root, plan.prefix, plan.region)).not.throw()
  })
})
