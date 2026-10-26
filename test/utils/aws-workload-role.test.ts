/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic IAM responses; no cloud calls. */
import {expect} from 'chai'

import {specRoleGuardrails} from '../../src/utils/aws-iam-guardrails.js'
import {RoleTakeoverRequired, type WorkloadRoleRequest, ensureWorkloadRole, irsaTrustPolicy, trustAdmitsOnly, validateRoleGuardrails, workloadRoleTags} from '../../src/utils/aws-workload-role.js'

const context = {account: '000000000000', issuerHostPath: 'oidc.eks.us-east-1.amazonaws.com/id/FIXTURE'}
const policy = (resource: string) => ({Statement: [{Action: ['kms:GetPublicKey', 'kms:Sign'], Effect: 'Allow', Resource: resource}], Version: '2012-10-17'})
const request = (overrides: Partial<WorkloadRoleRequest> = {}): WorkloadRoleRequest => ({
  catalogEntry: 'withdrawal-processor',
  cluster: 'fixture-cluster',
  deployment: 'fixture',
  namespace: 'fixture',
  policies: {'dogeos-bridge-sequencer-kms': policy('arn:aws:kms:us-east-1:000000000000:key/fixture'), 'proof-artifact-store': {Statement: []}},
  roleName: 'dogeos-fixture-fixture-cluster-wp-proof',
  serviceAccount: 'withdrawal-processor',
  ...overrides,
})

class FakeIam {
  calls: string[][] = []
  inline: string[] = []
  managed: string[] = []
  role: any
  json(args: string[]): any {
    this.calls.push(args)
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    switch (args[1]) {
      case 'create-role': {
        const path = args.includes('--path') ? value('--path') : '/'
        this.role = {Arn: `arn:aws:iam::000000000000:role${path}${value('--role-name')}`, AssumeRolePolicyDocument: JSON.parse(value('--assume-role-policy-document')), Path: path, Tags: JSON.parse(value('--tags'))}
        return {Role: this.role}
      }

      case 'delete-role-policy': {this.inline = this.inline.filter(name => name !== value('--policy-name')); return {}}
      case 'detach-role-policy': {this.managed = this.managed.filter(arn => arn !== value('--policy-arn')); return {}}
      case 'get-role': {
        if (!this.role) throw new Error('An error occurred (NoSuchEntity) when calling the GetRole operation')
        return {Role: this.role}
      }

      case 'list-attached-role-policies': {return {AttachedPolicies: this.managed.map(PolicyArn => ({PolicyArn}))}}
      case 'list-role-policies': {return {PolicyNames: this.inline}}
      case 'put-role-permissions-boundary': {this.role.PermissionsBoundary = {PermissionsBoundaryArn: value('--permissions-boundary')}; return {}}
      case 'tag-role': {this.role.Tags = JSON.parse(value('--tags')); return {}}
      case 'update-assume-role-policy': {this.role.AssumeRolePolicyDocument = JSON.parse(value('--policy-document')); return {}}
      case 'put-role-policy': {if (!this.inline.includes(value('--policy-name'))) this.inline.push(value('--policy-name')); return {}}
      default: {throw new Error(`unexpected ${args.join(' ')}`)}
    }
  }

  operations(): string[] {return this.calls.map(args => args[1])}
}

const legacyRole = (overrides: any = {}) => ({Arn: 'arn:aws:iam::000000000000:role/dogeos-fixture-fixture-cluster-wp-proof', AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(irsaTrustPolicy(context, 'fixture', 'withdrawal-processor'))), Path: '/', ...overrides})

describe('CLI-owned workload IAM roles', () => {
  it('creates a role with guardrails, ownership tags and only the requested policies', () => {
    const aws = new FakeIam()
    const result = ensureWorkloadRole(aws, context, request(), {path: '/dogeos/', permissionsBoundaryArn: 'arn:aws:iam::000000000000:policy/fixture-boundary', roleNamePrefix: 'dogeos-', tags: {CostCenter: 'fixture'}})
    expect(result).to.deep.equal({arn: 'arn:aws:iam::000000000000:role/dogeos/dogeos-fixture-fixture-cluster-wp-proof', claimed: false, created: true})
    const create = aws.calls.find(args => args[1] === 'create-role')!
    expect(create).to.include.members(['--path', '/dogeos/', '--permissions-boundary', 'arn:aws:iam::000000000000:policy/fixture-boundary'])
    expect(Object.fromEntries(JSON.parse(create[create.indexOf('--tags') + 1]).map((tag: any) => [tag.Key, tag.Value]))).to.deep.equal({CatalogEntry: 'withdrawal-processor', Cluster: 'fixture-cluster', CostCenter: 'fixture', Deployment: 'fixture', ManagedBy: 'scrollsdk', Namespace: 'fixture', ServiceAccount: 'withdrawal-processor'})
    expect(aws.operations()).to.deep.equal(['get-role', 'create-role', 'put-role-policy', 'put-role-policy'])
  })

  it('takes over an untagged role only after approval and does not ask again on retry', () => {
    const aws = new FakeIam()
    aws.role = legacyRole()
    aws.inline = ['proof-artifact-store', 'operator-extra']
    aws.managed = ['arn:aws:iam::aws:policy/AmazonS3FullAccess']
    const messages: string[] = []
    const result = ensureWorkloadRole(aws, context, request(), {permissionsBoundaryArn: 'arn:aws:iam::000000000000:policy/fixture-boundary'}, message => messages.push(message), preview => {
      expect(preview.inlinePoliciesToDelete).to.deep.equal(['operator-extra'])
      expect(preview.managedPoliciesToDetach).to.deep.equal(aws.managed)
      expect(aws.operations().some(op => /^(put|delete|update|tag|detach)-/.test(op))).to.equal(false)
      return true
    })
    expect(result.claimed).to.equal(true)
    // The complete catalog policy set is written before unknown and managed policies are removed.
    expect(aws.inline).to.deep.equal(['proof-artifact-store', 'dogeos-bridge-sequencer-kms'])
    expect(aws.managed).to.deep.equal([])
    const operations = aws.operations()
    expect(operations.indexOf('put-role-policy')).to.be.lessThan(operations.indexOf('delete-role-policy'))
    expect(operations).to.include.members(['put-role-permissions-boundary', 'tag-role'])
    expect(messages.join('\n')).to.include('operator approved').and.include('operator-extra').and.include('AmazonS3FullAccess')
    expect(ensureWorkloadRole(aws, context, request(), {}, undefined, () => {throw new Error('must not ask again')}).claimed).to.equal(false)
  })

  it('rejects an unowned role with a different trust even if an earlier run used its name', () => {
    const aws = new FakeIam()
    aws.role = legacyRole({AssumeRolePolicyDocument: irsaTrustPolicy(context, 'old-namespace', 'withdrawal-processor')})
    expect(() => ensureWorkloadRole(aws, context, request())).to.throw(RoleTakeoverRequired)
    expect(aws.operations().every(op => /^(get|list)-/.test(op))).to.equal(true)
  })

  it('never modifies a role it cannot prove it owns', () => {
    const broad = irsaTrustPolicy(context, 'fixture', 'withdrawal-processor')
    broad.Statement.push({Action: 'sts:AssumeRole', Effect: 'Allow', Principal: {AWS: 'arn:aws:iam::000000000000:root'}} as any)
    for (const role of [legacyRole({AssumeRolePolicyDocument: broad}), legacyRole({AssumeRolePolicyDocument: irsaTrustPolicy(context, 'fixture', 'another-service')})]) {
      const aws = new FakeIam()
      aws.role = role
      expect(() => ensureWorkloadRole(aws, context, request())).to.throw(RoleTakeoverRequired)
      expect(aws.operations().every(op => /^(get|list)-/.test(op))).to.equal(true)
    }
  })

  it('accepts current ownership tags and rejects an immovable path or invalid prefix', () => {
    const aws = new FakeIam()
    aws.role = legacyRole({AssumeRolePolicyDocument: irsaTrustPolicy(context, 'other', 'other'), Tags: Object.entries(workloadRoleTags(request())).map(([Key, Value]) => ({Key, Value}))})
    expect(ensureWorkloadRole(aws, context, request()).claimed).to.equal(false)
    expect(() => ensureWorkloadRole(aws, context, request(), {path: '/dogeos/'})).to.throw('cannot move a role')
    expect(() => ensureWorkloadRole(new FakeIam(), context, request(), {roleNamePrefix: 'platform-'})).to.throw('roleNamePrefix')
  })

  for (const tags of [[], [{Key: 'ManagedBy', Value: 'Terraform'}]]) {
    it(`requires a decision even with matching trust (${JSON.stringify(tags)})`, () => {
      const aws = new FakeIam()
      aws.role = legacyRole({Tags: tags})
      expect(() => ensureWorkloadRole(aws, context, request())).to.throw(RoleTakeoverRequired)
      expect(() => ensureWorkloadRole(aws, context, request(), {}, undefined, () => false)).to.throw(RoleTakeoverRequired)
      expect(aws.operations().every(op => /^(get|list)-/.test(op))).to.equal(true)
      expect(ensureWorkloadRole(aws, context, request(), {}, undefined, () => true).claimed).to.equal(true)
    })
  }

  it('shows and can explicitly take over externally managed ownership and shared trust', () => {
    const aws = new FakeIam()
    aws.role = legacyRole({AssumeRolePolicyDocument: {Statement: []}, Tags: [{Key: 'ManagedBy', Value: 'Terraform'}, {Key: 'Deployment', Value: 'old-deployment'}]})
    expect(ensureWorkloadRole(aws, context, request(), {}, undefined, preview => {
      expect(preview.currentOwner.Deployment).to.equal('old-deployment')
      expect(preview.desiredOwner.ServiceAccount).to.equal('withdrawal-processor')
      expect(preview.currentTrust).to.deep.equal({Statement: []})
      return true
    }).claimed).to.equal(true)
    expect(aws.role.AssumeRolePolicyDocument).to.deep.equal(irsaTrustPolicy(context, 'fixture', 'withdrawal-processor'))
  })

  for (const extra of [{}, {Cluster: 'fixture-cluster', Deployment: 'fixture'}, {CatalogEntry: 'old', Namespace: 'old', ServiceAccount: 'old'}]) {
    it(`reconciles CLI-created roles without confirmation even with incomplete or outdated tags (${JSON.stringify(extra)})`, () => {
      const aws = new FakeIam()
      aws.role = legacyRole({AssumeRolePolicyDocument: {Statement: []}, Tags: Object.entries({ManagedBy: 'scrollsdk', ...extra}).map(([Key, Value]) => ({Key, Value}))})
      const result = ensureWorkloadRole(aws, context, request(), {}, undefined, () => {throw new Error('must not prompt')})
      expect(result.claimed).to.equal(false)
      expect(Object.fromEntries(aws.role.Tags.map(({Key, Value}: any) => [Key, Value]))).to.deep.equal(workloadRoleTags(request()))
      expect(aws.role.AssumeRolePolicyDocument).to.deep.equal(irsaTrustPolicy(context, 'fixture', 'withdrawal-processor'))
    })
  }

  for (const conflict of [{Deployment: 'other'}, {Cluster: 'other'}]) {
    it(`rejects a CLI-owned role belonging elsewhere without prompting (${JSON.stringify(conflict)})`, () => {
      const aws = new FakeIam()
      aws.role = legacyRole({Tags: Object.entries({ManagedBy: 'scrollsdk', ...conflict}).map(([Key, Value]) => ({Key, Value}))})
      expect(() => ensureWorkloadRole(aws, context, request(), {}, undefined, () => {throw new Error('must not prompt')})).to.throw('belongs to another deployment or cluster')
      expect(aws.operations()).to.deep.equal(['get-role'])
    })
  }

  it('compares trust strictly', () => {
    const trust = irsaTrustPolicy(context, 'fixture', 'withdrawal-processor')
    expect(trustAdmitsOnly(encodeURIComponent(JSON.stringify(trust)), trust)).to.equal(true)
    const like = structuredClone(trust)
    like.Statement[0].Condition = {StringLike: like.Statement[0].Condition.StringEquals}
    expect(trustAdmitsOnly(like, trust)).to.equal(false)
  })

  it('validates and forwards guardrails', () => {
    expect(() => validateRoleGuardrails({tags: {ManagedBy: 'x'}})).to.throw('ownership tag')
    expect(() => validateRoleGuardrails({path: 'dogeos'})).to.throw('awsIam.path')
    expect(() => validateRoleGuardrails({permissionsBoundaryArn: 'boundary'})).to.throw('permissionsBoundaryArn')
    expect(specRoleGuardrails({preparation: {awsIam: {path: '/dogeos/', tags: {CostCenter: 'a=b'}}}} as any)).to.deep.equal({path: '/dogeos/', tags: {CostCenter: 'a=b'}})
  })
})
