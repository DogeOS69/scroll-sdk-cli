import {expect} from 'chai'

import {appendArtifactPublicRead, applyArtifactAccess, checkArtifactWriter, planArtifactAccess} from '../../src/utils/artifact-access.js'

const store = {bucket: 'test-artifacts', forcePathStyle: false, keyPrefix: 'instances/new', region: 'us-east-1'}
const roleArn = 'arn:aws:iam::123456789012:role/archive-writer'
const oldStatement = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: 'arn:aws:s3:::test-artifacts/instances/old/*', Sid: 'OldInstance'}

function fixture() {
  let bucket = {Statement: [oldStatement], Version: '2012-10-17'} as Record<string, unknown>
  let inline: unknown
  let deny = false
  let block = false
  const writes: string[][] = []
  const aws = {
    json(args: string[]): any {
      if (args[1] === 'get-public-access-block') return {PublicAccessBlockConfiguration: {BlockPublicPolicy: block, RestrictPublicBuckets: false}}
      if (args[1] === 'get-role') return {Role: {Arn: roleArn}}
      if (args[1] === 'get-role-policy') {
        if (!inline) throw new Error('NoSuchEntity')
        return {PolicyDocument: inline}
      }

      if (args[1] === 'simulate-principal-policy') return {EvaluationResults: args.slice(args.indexOf('--action-names') + 1, args.indexOf('--resource-arns')).map(action => ({EvalActionName: action, EvalDecision: deny ? 'explicitDeny' : 'allowed', EvalResourceName: args[args.indexOf('--resource-arns') + 1]}))}
      throw new Error(`Unexpected AWS read: ${args[1]}`)
    },
    run(args: string[]): string {
      if (args[1] === 'head-bucket') return ''
      writes.push(args)
      if (args[1] === 'put-bucket-policy') bucket = JSON.parse(args[args.indexOf('--policy') + 1])
      else if (args[1] === 'put-role-policy') inline = JSON.parse(args[args.indexOf('--policy-document') + 1])
      else throw new Error(`Unexpected AWS mutation: ${args[1]}`)
      return ''
    },
    text(args: string[]): string {
      if (args[0] === 'sts') return '123456789012'
      if (args[1] === 'get-bucket-policy') return JSON.stringify(bucket)
      throw new Error(`Unexpected AWS text read: ${args[1]}`)
    },
  }
  return {aws, get block() {return block}, set block(value: boolean) {block = value}, get bucket() {return bucket}, get deny() {return deny}, set deny(value: boolean) {deny = value}, get inline() {return inline}, writes}
}

describe('artifact prefix access reconciliation', () => {
  it('plans without writes, preserves old statements, applies and becomes idempotent', () => {
    const f = fixture()
    const options = {publicRead: true, writerRoleArn: roleArn}
    const plan = planArtifactAccess(f.aws, store, options)
    expect(f.writes).to.deep.equal([])
    applyArtifactAccess(f.aws, plan)
    expect(f.writes).to.have.length(2)
    expect((f.bucket.Statement as unknown[])[0]).to.deep.equal(oldStatement)
    const publicGrant = (f.bucket.Statement as any[])[1]
    expect(publicGrant.Action).to.equal('s3:GetObject')
    expect(publicGrant.Resource).to.include('arn:aws:s3:::test-artifacts/instances/new/witnesses/*')
    expect(publicGrant.Resource).to.include('arn:aws:s3:::test-artifacts/instances/new/signer-policy-evidence/*')
    expect(publicGrant.Resource.some((value: string) => value.includes('segmentation'))).to.equal(false)
    expect(JSON.stringify(f.inline)).not.to.include('DeleteObject')
    const again = planArtifactAccess(f.aws, store, options)
    expect(again.bucketPolicy?.changed).to.equal(false)
    expect(again.writerPolicy?.changed).to.equal(false)
    applyArtifactAccess(f.aws, again)
    expect(f.writes).to.have.length(2)
    checkArtifactWriter(f.aws, again)
  })

  it('fails on policy drift before either mutation', () => {
    const f = fixture()
    const plan = planArtifactAccess(f.aws, store, {publicRead: true, writerRoleArn: roleArn})
    ;(f.bucket.Statement as unknown[]).push({Effect: 'Deny', Sid: 'ConcurrentEdit'})
    expect(() => applyArtifactAccess(f.aws, plan)).to.throw('changed after planning')
    expect(f.writes).to.have.length(0)
  })

  it('does not disable account/bucket public access protection', () => {
    const f = fixture()
    f.block = true
    expect(() => planArtifactAccess(f.aws, store, {publicRead: true})).to.throw('Public Access Block')
    expect(f.writes).to.have.length(0)
  })

  it('refuses renamed/foreign roles and changed same-name inline policies', () => {
    const f = fixture()
    expect(() => planArtifactAccess(f.aws, store, {writerRoleArn: roleArn.replace('123456789012', '000000000000')})).to.throw('does not match')
    const plan = planArtifactAccess(f.aws, store, {writerRoleArn: roleArn})
    applyArtifactAccess(f.aws, plan)
    ;(f.inline as any).Statement[0].Action.push('s3:DeleteObject')
    expect(() => planArtifactAccess(f.aws, store, {writerRoleArn: roleArn})).to.throw('differs')
  })

  it('fails IAM checks on an explicit denial and does not repair unrelated policies', () => {
    const f = fixture()
    const plan = planArtifactAccess(f.aws, store, {writerRoleArn: roleArn})
    f.deny = true
    expect(() => checkArtifactWriter(f.aws, plan)).to.throw('did not allow')
    expect(f.writes).to.have.length(0)
  })

  it('validates prefixes and never rewrites a conflicting owned Sid', () => {
    expect(() => appendArtifactPublicRead({}, store.bucket, 'instances/*')).to.throw('wildcards')
    const policy = appendArtifactPublicRead({}, store.bucket, store.keyPrefix)
    ;(policy.Statement as any[])[0].Effect = 'Deny'
    expect(() => appendArtifactPublicRead(policy, store.bucket, store.keyPrefix)).to.throw('differs')
  })
})
