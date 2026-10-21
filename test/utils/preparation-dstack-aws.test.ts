/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic AWS responses; no cloud calls. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {capacitySpec} from '../../src/utils/capacity-manager.js'
import {assertDeploymentSpecFields} from '../../src/utils/deployment-spec-fields.js'
import {generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {configureDstackCredentialRefs, newDstackCredentials} from '../../src/utils/dstack-credentials.js'
import {DSTACK_AWS_RECORD, dstackAwsIntent, dstackEligibleSubnets, dstackWorkerPolicy, prepareDstackAws, withPreparedDstackAws} from '../../src/utils/preparation-dstack-aws.js'
import {preparationSteps} from '../../src/utils/preparation-plan.js'
import {CommandPreparationRunner} from '../../src/utils/preparation-runner.js'

const roleArn = 'arn:aws:iam::000000000000:role/fixture-dstack'
const issuerPath = 'oidc.eks.us-east-1.amazonaws.com/id/FIXTURE'
function fixture(): DeploymentSpec {
  return {
    dstackController: {enabled: true, serviceAccount: {name: 'fixture-controller'}},
    infrastructure: {aws: {accountId: '000000000000', eksClusterName: 'fixture-cluster', region: 'us-east-1'}, namespace: 'fixture', provider: 'aws'},
    metadata: {name: 'fixture'},
    preparation: {bridge: {mode: 'helper'}, dstack: {aws: {action: 'create', awsProfile: 'fixture-profile', controllerRoleName: 'fixture-dstack', vpcIds: {'us-east-1': 'vpc-00000000000000000'}}, mode: 'import', providers: ['aws']}, proofMaterials: {mode: 'existing'}},
  } as unknown as DeploymentSpec
}

class FakeAws {
  account = '000000000000'
  calls: Array<{args: string[]; region?: string}> = []
  failure?: string
  role: any
  routes: any[] = [{DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-fixture', State: 'active'}]
  sub = 'system:serviceaccount:fixture:fixture-controller'
  subnets: any[] = [{State: 'available', SubnetId: 'subnet-fixture'}]
  existingRole(): void {
    this.role = {Arn: roleArn, AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({Statement: [{Action: ['sts:AssumeRoleWithWebIdentity'], Condition: {StringEquals: {[`${issuerPath}:aud`]: ['sts.amazonaws.com'], [`${issuerPath}:sub`]: this.sub}}, Effect: 'Allow', Principal: {Federated: `arn:aws:iam::000000000000:oidc-provider/${issuerPath}`}}]}))}
  }

  json(args: string[], options: {region?: string} = {}): any {
    this.calls.push({args, region: options.region})
    const operation = args.slice(0, 2).join(' ')
    if (operation === this.failure) throw new Error('AccessDenied CREDENTIAL_SHOULD_NOT_LEAK')
    switch (operation) {
      case 'sts get-caller-identity': { return {Account: this.account, Arn: `arn:aws:iam::${this.account}:user/fixture`}
      }

      case 'eks describe-cluster': { return {cluster: {identity: {oidc: {issuer: `https://${issuerPath}`}}}}
      }

      case 'iam get-open-id-connect-provider': { return {ClientIDList: ['sts.amazonaws.com']}
      }

      case 'ec2 describe-vpcs': { return {Vpcs: [{State: 'available', VpcId: args[3]}]}
      }

      case 'ec2 describe-subnets': { return {Subnets: this.subnets}
      }

      case 'ec2 describe-route-tables': { return {RouteTables: [{Associations: [{Main: true}], Routes: this.routes}]}
      }

      case 'iam get-role': {
        if (!this.role) throw new Error('NoSuchEntity')
        return {Role: this.role}
      }

      case 'iam create-role': {
        this.role = {Arn: roleArn, AssumeRolePolicyDocument: JSON.parse(args[args.indexOf('--assume-role-policy-document') + 1]), Tags: JSON.parse(args[args.indexOf('--tags') + 1])}
        return {Role: this.role}
      }

      case 'iam update-assume-role-policy': case 'iam put-role-policy': { return {}
 }

      case 'iam get-instance-profile': { return {InstanceProfile: {Arn: 'arn:aws:iam::000000000000:instance-profile/fixture-worker', Roles: [{Arn: 'arn:aws:iam::000000000000:role/fixture-worker', AssumeRolePolicyDocument: {Statement: [{Action: 'sts:AssumeRole', Effect: 'Allow', Principal: {Service: 'ec2.amazonaws.com'}}]}}]}}
      }

      default: { throw new Error(`Unexpected fake operation: ${operation}`)
      }
    }
  }
}

describe('dstack AWS preparation', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-aws-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[dstackController]\nenabled = true\n')
    fs.mkdirSync(path.join(root, '.scrollsdk'))
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))

  it('plans the explicit AWS step ahead of credential import with no AWS calls', () => {
    const spec = fixture()
    assertDeploymentSpecFields({preparation: spec.preparation})
    const steps = preparationSteps(spec, true)
    expect(steps.find(step => step.id === 'dstack-aws')).include({effect: 'cloud', stage: 'aws'})
    expect(steps.findIndex(step => step.id === 'dstack-aws')).lessThan(steps.findIndex(step => step.id === 'dstack'))
    spec.preparation!.dstack!.aws!.action = 'reuse'
    expect(preparationSteps(spec).find(step => step.id === 'dstack-aws')?.effect).equal('read')
    delete spec.preparation!.dstack!.aws!.action
    delete spec.preparation!.dstack!.aws!.awsProfile
    delete spec.preparation!.dstack!.aws!.controllerRoleName
    expect(dstackAwsIntent(spec)).undefined
    expect(preparationSteps(spec).some(step => step.id === 'dstack-aws')).false
  })

  it('creates a workload-bound role and passes its ARN through imported credentials, Helm values and capacity intent', async () => {
    const spec = fixture(); const aws = new FakeAws()
    prepareDstackAws(root, spec, aws)
    const record = JSON.parse(fs.readFileSync(path.join(root, DSTACK_AWS_RECORD), 'utf8'))
    expect(record.controllerRoleArn).equal(roleArn)
    expect(record.network[0].eligibleSubnets).deep.equal(['subnet-fixture'])
    expect(record).not.have.property('fingerprint')
    expect(fs.statSync(path.join(root, DSTACK_AWS_RECORD)).mode % 0o1000).equal(0o600)
    const calls: string[][] = []
    await new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)}).run({effect: 'local', id: 'dstack', retry: 'safe', title: 'Import'}, spec, root, {} as any)
    const backend = JSON.parse(fs.readFileSync(path.join(root, '.data/dstack/aws-backend.json'), 'utf8'))
    expect(backend).deep.equal({vpcIds: spec.preparation!.dstack!.aws!.vpcIds})
    expect(calls[0]).include('--aws-backend-config')
    const config = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
    const credentials = {...newDstackCredentials(), aws: backend, providers: ['aws' as const]}
    config.dstackController = configureDstackCredentialRefs(config.dstackController, credentials)
    expect(config.dstackController.defaultCredentialsEnabled).true
    expect(config.dstackController.serviceAccount).include({name: 'fixture-controller'})
    expect(config.dstackController.serviceAccount.annotations['eks.amazonaws.com/role-arn']).equal(roleArn)
    const values = yaml.load(generateDstackControllerValues(config.dstackController)!) as any
    expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).equal(roleArn)
    fs.writeFileSync(path.join(root, '.scrollsdk/intent.json'), JSON.stringify(spec))
    expect(capacitySpec(root).dstackController?.serviceAccount?.annotations?.['eks.amazonaws.com/role-arn']).equal(roleArn)
    expect(spec.dstackController?.serviceAccount?.annotations).undefined
  })

  it('uses the capacity-manager project for both dstack configuration and worker permissions', async () => {
    const spec = fixture(); const aws = new FakeAws()
    spec.capacityManager = {project: 'workers'} as any
    prepareDstackAws(root, spec, aws)
    const calls: string[][] = []
    await new CommandPreparationRunner(async (_root, _step, args) => {calls.push(args)}).run({effect: 'local', id: 'dstack', retry: 'safe', title: 'Import'}, spec, root, {} as any)
    const configured = calls[0][calls[0].indexOf('--project') + 1]
    expect(configured).equal('workers')
    const {policy} = JSON.parse(fs.readFileSync(path.join(root, DSTACK_AWS_RECORD), 'utf8'))
    expect(policy.Statement.find((statement: any) => statement.Sid === 'LaunchTaggedWorkers').Condition.StringEquals['aws:RequestTag/dstack_project']).equal(configured)
    expect(policy.Statement.find((statement: any) => statement.Sid === 'ManageOwnedWorkers').Condition.StringEquals['ec2:ResourceTag/dstack_project']).equal(configured)
  })

  it('retries an interrupted create without creating a second role', () => {
    const spec = fixture(); const aws = new FakeAws()
    aws.failure = 'iam put-role-policy'
    expect(() => prepareDstackAws(root, spec, aws)).throw('iam put-role-policy failed')
    expect(fs.existsSync(path.join(root, DSTACK_AWS_RECORD))).false
    aws.failure = undefined
    prepareDstackAws(root, spec, aws)
    expect(aws.calls.filter(call => call.args[1] === 'create-role')).length(1)
    expect(aws.calls.some(call => call.args[1] === 'update-assume-role-policy')).true
  })

  it('does not take over an existing unowned role', () => {
    const aws = new FakeAws(); aws.existingRole()
    expect(() => prepareDstackAws(root, fixture(), aws)).throw('ownership tags')
    expect(aws.calls.some(call => /^(create|put|update)-/.test(call.args[1]))).false
  })

  it('reuses an existing role with decoded semantic trust and performs only metadata reads', () => {
    const spec = fixture(); const aws = new FakeAws(); aws.existingRole()
    spec.preparation!.dstack!.aws!.action = 'reuse'
    prepareDstackAws(root, spec, aws)
    expect(aws.calls.every(call => /^(get|describe)-/.test(call.args[1]))).true
    // Reformatting JSON, including a trailing newline, has no effect.
    const file = path.join(root, DSTACK_AWS_RECORD)
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) + '\n\n')
    expect(withPreparedDstackAws(root, spec).dstackController?.defaultCredentialsEnabled).true
  })

  it('reports a missing role for reuse without suggesting a permission problem', () => {
    const spec = fixture(); const aws = new FakeAws()
    spec.preparation!.dstack!.aws!.action = 'reuse'
    expect(() => prepareDstackAws(root, spec, aws)).throw('fixture-dstack does not exist')
    expect(fs.existsSync(path.join(root, DSTACK_AWS_RECORD))).false
  })

  it('uses the caller partition for every EC2 resource', () => {
    const policy = dstackWorkerPolicy(['cn-north-1'], undefined, {account: '000000000000', network: [{eligibleSubnets: ['subnet-fixture'], region: 'cn-north-1', vpcId: 'vpc-fixture'}], partition: 'aws-cn', project: 'main', publicIps: true})
    const arns = policy.Statement.flatMap((statement: any) => [statement.Resource].flat()).filter((resource: string) => resource !== '*')
    expect(arns.length).greaterThan(0)
    expect(arns.every((resource: string) => resource.startsWith('arn:aws-cn:ec2:cn-north-1:'))).true
  })

  it('rejects a worker policy above the IAM inline size limit before creating the role', () => {
    const spec = fixture(); const aws = new FakeAws()
    spec.preparation!.dstack!.aws!.vpcIds = Object.fromEntries(['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1'].map(region => [region, 'vpc-0123456789abcdef0']))
    aws.subnets = Array.from({length: 20}, (_, index) => ({State: 'available', SubnetId: `subnet-0123456789abcd${String(index).padStart(3, '0')}`}))
    expect(() => prepareDstackAws(root, spec, aws)).throw('inline policy size limit')
    expect(aws.calls.some(call => call.args[0] === 'iam' && !/^(get|list)-/.test(call.args[1]))).false
    expect(fs.existsSync(path.join(root, DSTACK_AWS_RECORD))).false
  })

  it('rejects the wrong namespace trust before writing a binding', () => {
    const spec = fixture(); const aws = new FakeAws(); aws.sub = 'system:serviceaccount:another:fixture-controller'; aws.existingRole()
    spec.preparation!.dstack!.aws!.action = 'reuse'
    expect(() => prepareDstackAws(root, spec, aws)).throw('does not trust')
    expect(fs.existsSync(path.join(root, DSTACK_AWS_RECORD))).false
  })

  it('checks account, IAM read failures and missing egress before any mutation, without echoing AWS stderr', () => {
    const spec = fixture(); const aws = new FakeAws(); aws.account = '111111111111'
    expect(() => prepareDstackAws(root, spec, aws)).throw('account does not match')
    aws.account = '000000000000'; aws.failure = 'iam get-role'
    try {prepareDstackAws(root, spec, aws); expect.fail('must fail')} catch (error) {expect(String(error)).include('iam get-role failed').not.include('CREDENTIAL_SHOULD_NOT_LEAK')}
    aws.failure = undefined; aws.routes = []
    expect(() => prepareDstackAws(root, spec, aws)).throw('No dstack-compatible')
    expect(aws.calls.some(call => /^(create|put|update)-/.test(call.args[1]))).false
  })

  it('limits PassRole to the explicitly selected existing worker profile roles', () => {
    const spec = fixture(); const aws = new FakeAws()
    spec.preparation!.dstack!.aws!.iamInstanceProfile = 'fixture-worker'
    prepareDstackAws(root, spec, aws)
    const {args} = (aws.calls.find(call => call.args[1] === 'put-role-policy')!)
    const policy = JSON.parse(args[args.indexOf('--policy-document') + 1])
    const pass = policy.Statement.find((statement: any) => statement.Action === 'iam:PassRole')
    expect(pass.Resource).deep.equal(['arn:aws:iam::000000000000:role/fixture-worker'])
    expect(pass.Condition.StringEquals['iam:PassedToService']).equal('ec2.amazonaws.com')
    expect(dstackWorkerPolicy(['us-east-1']).Statement).length(8)
    const manage = policy.Statement.find((statement: any) => statement.Sid === 'ManageOwnedWorkers')
    expect(manage.Condition.StringEquals['ec2:ResourceTag/dstack_project']).equal('main')
    expect(manage.Resource).not.include('*')
    expect(policy.Statement.some((statement: any) => statement.Action === 'ec2:CreateTags' && !statement.Condition)).equal(false)
    expect(policy.Statement[0].Condition.StringEquals['aws:RequestedRegion']).deep.equal(['us-east-1'])
    expect(policy.Statement[0].Action).not.include('ec2:*').not.include('elasticloadbalancing:*')
  })

  it('selects explicit route tables over the main table and rejects blackhole routes', () => {
    const subnets = [{State: 'available', SubnetId: 'subnet-fixture'}]
    const tables = [{Associations: [{Main: true}], Routes: [{DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-fixture'}]}, {Associations: [{SubnetId: 'subnet-fixture'}], Routes: [{GatewayId: 'igw-fixture'}]}]
    expect(dstackEligibleSubnets(subnets, tables, false)).empty
    expect(dstackEligibleSubnets(subnets, tables, true)).deep.equal(['subnet-fixture'])
    expect(dstackEligibleSubnets(subnets, [{Associations: [{Main: true}], Routes: [{DestinationCidrBlock: '0.0.0.0/0', State: 'blackhole', TransitGatewayId: 'tgw-fixture'}]}], false)).empty
    expect(dstackEligibleSubnets(subnets, [{Associations: [{Main: true}], Routes: [{DestinationCidrBlock: '0.0.0.0/0', VpcPeeringConnectionId: 'pcx-fixture'}]}], false)).length(1)
  })

  it('checks every configured region and refuses a missing or differently bound local result', () => {
    const spec = fixture(); const aws = new FakeAws()
    expect(() => withPreparedDstackAws(root, spec)).throw('setup aws')
    spec.preparation!.dstack!.aws!.vpcIds['us-west-2'] = 'vpc-11111111111111111'
    prepareDstackAws(root, spec, aws)
    expect(aws.calls.filter(call => call.args[1] === 'describe-vpcs').map(call => call.region)).deep.equal(['us-east-1', 'us-west-2'])
    spec.infrastructure.namespace = 'another'
    expect(() => withPreparedDstackAws(root, spec)).throw('different EKS workload')
  })
})
