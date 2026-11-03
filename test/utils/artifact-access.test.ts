import {expect} from 'chai'

import {
  ARCHIVE_POLICY_SIDS,
  type ArtifactAccessPlan,
  archivePolicySids,
  buildArchiveBucketPolicy,
  buildArchiveWriterPolicy,
  checkArtifactAccess,
  planArtifactAccess,
} from '../../src/utils/artifact-access.js'
import {checkExistingRetention, retentionLifecycleRule} from '../../src/utils/bucket-retention.js'

const da = {bucket: 'dogeos-da-archive', forcePathStyle: false, keyPrefix: 'mainnet/batches', region: 'us-east-1'}
const proof = {bucket: 'dogeos-proof-artifacts', forcePathStyle: false, keyPrefix: 'mainnet/proofs', region: 'us-east-1'}
const roleArn = 'arn:aws:iam::123456789012:role/eth-da-submitter'
const operatorStatement = {Action: 's3:GetObject', Effect: 'Allow', Principal: {AWS: 'arn:aws:iam::999999999999:root'}, Resource: 'arn:aws:s3:::dogeos-da-archive/mainnet/batches/*', Sid: 'PartnerRead'}

function fixture() {
  let bucket = {Statement: [operatorStatement], Version: '2012-10-17'} as Record<string, unknown>
  let versioning: string | undefined
  let inline: unknown
  let deny = false
  let block = false
  let bucketBlock: Record<string, boolean> | undefined
  let lifecycle: Record<string, unknown> | undefined
  // S3 Gateway endpoints by id; vpce-0abc is a usable us-east-1 endpoint.
  const endpoints: Record<string, unknown> = {
    'vpce-0abc': {ServiceName: 'com.amazonaws.us-east-1.s3', State: 'available', VpcEndpointType: 'Gateway'},
    'vpce-0bbb': {ServiceName: 'com.amazonaws.us-west-2.s3', State: 'available', VpcEndpointType: 'Gateway'},
  }
  const writes: string[][] = []
  const aws = {
    json(args: string[]): any {
      if (args[1] === 'list-role-policies') return {PolicyNames: inline ? ['eth-da-submitter-s3-archive'] : []}
      if (args[1] === 'list-attached-role-policies') return {AttachedPolicies: []}
      if (args[1] === 'get-public-access-block') return {PublicAccessBlockConfiguration: structuredClone(args[0] === 's3api' && bucketBlock ? bucketBlock : {BlockPublicPolicy: block, RestrictPublicBuckets: false})}
      if (args[1] === 'get-bucket-versioning') return versioning ? {Status: versioning} : {}
      if (args[1] === 'get-bucket-lifecycle-configuration') {
        if (!lifecycle) throw new Error('An error occurred (NoSuchLifecycleConfiguration)')
        return structuredClone(lifecycle)
      }

      if (args[1] === 'get-role') return {Role: {Arn: roleArn}}
      if (args[1] === 'describe-vpc-endpoints') {
        const endpoint = endpoints[args[args.indexOf('--vpc-endpoint-ids') + 1]]
        return {VpcEndpoints: endpoint ? [endpoint] : []}
      }

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
      throw new Error(`Unexpected AWS mutation: ${args[1]}`)
    },
    text(args: string[]): string {
      if (args[0] === 'sts') return '123456789012'
      if (args[1] === 'get-bucket-policy') return JSON.stringify(bucket)
      throw new Error(`Unexpected AWS text read: ${args[1]}`)
    },
  }
  return {aws, get block() {return block}, set block(value: boolean) {block = value}, get bucket() {return bucket}, set bucket(value: Record<string, unknown>) {bucket = value}, get bucketBlock() {return bucketBlock}, set bucketBlock(value: Record<string, boolean> | undefined) {bucketBlock = value}, get deny() {return deny}, set deny(value: boolean) {deny = value}, get inline() {return inline}, set inline(value: unknown) {inline = value}, get lifecycle() {return lifecycle}, set lifecycle(value: Record<string, unknown> | undefined) {lifecycle = value}, get versioning() {return versioning}, set versioning(value: string | undefined) {versioning = value}, writes}
}

/** Stands in for the infrastructure owner applying a reviewed plan; the CLI never writes. */
function applyPlanned(f: ReturnType<typeof fixture>, plan: ArtifactAccessPlan): void {
  if (plan.publicAccessBlock) f.bucketBlock = structuredClone(plan.publicAccessBlock.after) as Record<string, boolean>
  if (plan.versioning.changed) f.versioning = 'Enabled'
  if (plan.lifecycle.changed) f.lifecycle = structuredClone(plan.lifecycle.after)
  if (plan.bucketPolicy.changed) f.bucket = structuredClone(plan.bucketPolicy.after)
  if (plan.writerPolicy?.changed) f.inline = structuredClone(plan.writerPolicy.after)
}

function sids(policy: Record<string, unknown>): string[] {
  return (policy.Statement as Array<{Sid: string}>).map(statement => statement.Sid)
}

describe('DA archive and snapshot bucket access', () => {
  for (const kind of ['da', 'snapshot'] as const) {
    it(`preserves other deployments when configuring and disabling ${kind} reads`, () => {
      const a = {...da, keyPrefix: 'deployments/one'}
      const b = {...da, keyPrefix: 'deployments/two'}
      const f = fixture()
      applyPlanned(f, planArtifactAccess(f.aws, kind, a, {publicRead: true, vpcEndpointId: 'vpce-0abc'}))
      const first = structuredClone(f.bucket.Statement as Array<Record<string, unknown>>)
      applyPlanned(f, planArtifactAccess(f.aws, kind, b, {publicRead: true, vpcEndpointId: 'vpce-0abc'}))
      applyPlanned(f, planArtifactAccess(f.aws, kind, b, {publicRead: false}))
      for (const statement of first) expect(f.bucket.Statement).to.deep.include(statement)
      expect(sids(f.bucket)).to.include(archivePolicySids(kind, a.bucket, a.keyPrefix).publicRead)
      expect(sids(f.bucket)).not.to.include(archivePolicySids(kind, b.bucket, b.keyPrefix).publicRead)
      checkArtifactAccess(f.aws, planArtifactAccess(f.aws, kind, a, {publicRead: true}))
      checkArtifactAccess(f.aws, planArtifactAccess(f.aws, kind, b, {publicRead: false}))
    })
  }

  it('migrates only canonical legacy grants for this prefix', () => {
    const legacy = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: `arn:aws:s3:::${da.bucket}/${da.keyPrefix}/*`, Sid: ARCHIVE_POLICY_SIDS.da.publicRead}
    const adopted = buildArchiveBucketPolicy({Statement: [legacy]}, 'da', da.bucket, da.keyPrefix, {})
    expect(sids(adopted)).not.to.include(legacy.Sid)
    expect(adopted.Statement).to.deep.include({...legacy, Sid: archivePolicySids('da', da.bucket, da.keyPrefix).publicRead})
    const sibling = buildArchiveBucketPolicy({Statement: [legacy]}, 'da', da.bucket, 'deployments/other', {publicRead: true})
    expect(sibling.Statement).to.deep.include(legacy)
    const f = fixture()
    ;(f.bucket.Statement as unknown[]).push({...legacy, Resource: `arn:aws:s3:::${da.bucket}/*`})
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0abc'})).to.throw('outside the CLI-managed statements')
  })

  it('checks IAM permission for the height-ordered discovery copy as well as the primary sidecar', () => {
    const f = fixture()
    const options = {publicRead: true, sidecarStore: proof, writerRoleArn: roleArn}
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, options))
    const {json} = f.aws
    f.aws.json = (args: string[]) => {
      const result = json(args)
      if (args[1] === 'simulate-principal-policy' && args.some(arg => arg.includes('/scroll-chunk-segmentation-sidecars-by-height/'))) {
        for (const row of result.EvaluationResults) row.EvalDecision = 'implicitDeny'
      }

      return result
    }

    expect(() => checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, options))).to.throw('scroll-chunk-segmentation-sidecars-by-height/')
  })

  it('plans versioning, VPC-endpoint and public reads and the writer grant without writes, then checks the applied state', () => {
    const f = fixture()
    const options = {publicRead: true, sidecarStore: proof, vpcEndpointId: 'vpce-0abc', writerRoleArn: roleArn}
    const plan = planArtifactAccess(f.aws, 'da', da, options)
    expect(f.writes).to.deep.equal([])
    expect(plan.versioning.changed).to.equal(true)
    applyPlanned(f, plan)
    expect(sids(f.bucket)).to.deep.equal(['PartnerRead', 'ScrollSdkDenyInsecureTransport', archivePolicySids('da', da.bucket, da.keyPrefix).publicRead, archivePolicySids('da', da.bucket, da.keyPrefix).vpceRead])
    expect(JSON.stringify(f.inline)).not.to.include('DeleteObject')
    expect(JSON.stringify(f.inline)).not.to.include('ListBucket')
    const again = planArtifactAccess(f.aws, 'da', da, options)
    expect([again.bucketPolicy.changed, again.versioning.changed, again.lifecycle.changed, again.writerPolicy?.changed]).to.deep.equal([false, false, false, false])
    checkArtifactAccess(f.aws, again)
  })

  it('kill switch removes only the public statement and keeps VPC-endpoint reads', () => {
    const f = fixture()
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, {publicRead: true, vpcEndpointId: 'vpce-0abc'}))
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, {publicRead: false}))
    expect(sids(f.bucket)).to.deep.equal(['PartnerRead', 'ScrollSdkDenyInsecureTransport', archivePolicySids('da', da.bucket, da.keyPrefix).vpceRead])
    // Omitting both flags leaves the owned statements as they are.
    expect(planArtifactAccess(f.aws, 'da', da, {}).bucketPolicy.changed).to.equal(false)
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, {publicRead: true}))
    expect(sids(f.bucket)).to.include(archivePolicySids('da', da.bucket, da.keyPrefix).publicRead)
  })

  it('does not disable account/bucket public access protection', () => {
    const f = fixture()
    f.block = true
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: true})).to.throw('Public Access Block')
    // Removing public read needs no public-policy permission.
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0abc'})).not.to.throw()
    expect(f.writes).to.have.length(0)
  })

  it('plans explicit bucket policy permission without writes and preserves blocked ACLs', () => {
    const f = fixture()
    f.bucketBlock = {BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true}
    const options = {allowBucketPublicPolicy: true, publicRead: true}
    const plan = planArtifactAccess(f.aws, 'da', da, options)
    expect(f.writes).to.have.length(0)
    expect(() => checkArtifactAccess(f.aws, plan)).to.throw('Public Access Block differs')
    applyPlanned(f, plan)
    expect(f.bucketBlock).to.deep.equal({BlockPublicAcls: true, BlockPublicPolicy: false, IgnorePublicAcls: true, RestrictPublicBuckets: false})
    expect(planArtifactAccess(f.aws, 'da', da, options).publicAccessBlock).to.equal(undefined)
    checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, options))
  })

  it('retains account protection and rejects bucket-wide exposure of unrelated prefixes', () => {
    const f = fixture()
    f.block = true
    expect(() => planArtifactAccess(f.aws, 'da', da, {allowBucketPublicPolicy: true, publicRead: true})).to.throw('account Public Access Block')
    f.block = false
    f.bucketBlock = {BlockPublicPolicy: true, RestrictPublicBuckets: true}
    ;(f.bucket.Statement as unknown[]).push({Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: `arn:aws:s3:::${da.bucket}/unrelated/*`, Sid: 'UnrelatedPublicGrant'})
    expect(() => planArtifactAccess(f.aws, 'da', da, {allowBucketPublicPolicy: true, publicRead: true})).to.throw('unrelated anonymous grants')
    expect(f.writes).to.have.length(0)
  })

  it('requires explicit public-read intent to allow bucket public policies', () => {
    const f = fixture()
    expect(() => planArtifactAccess(f.aws, 'da', da, {allowBucketPublicPolicy: true})).to.throw('requires explicit public read')
    expect(f.writes).to.have.length(0)
  })

  it('rejects negated grants when bucket public policies are allowed', () => {
    const f = fixture()
    f.bucketBlock = {BlockPublicPolicy: true, RestrictPublicBuckets: true}
    const options = {allowBucketPublicPolicy: true, publicRead: true}
    ;(f.bucket.Statement as unknown[]).push({Action: 's3:GetObject', Effect: 'Allow', NotPrincipal: {AWS: roleArn}, Resource: '*', Sid: 'NegatedGrant'})
    expect(() => planArtifactAccess(f.aws, 'da', da, options)).to.throw('negated allow statements')
    expect(f.writes).to.have.length(0)
  })

  it('refuses renamed/foreign roles and malformed endpoint ids', () => {
    const f = fixture()
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: true, sidecarStore: proof, writerRoleArn: roleArn.replace('123456789012', '000000000000')})).to.throw('does not match')
    expect(() => planArtifactAccess(f.aws, 'da', da, {vpcEndpointId: 'not-an-endpoint'})).to.throw('vpce-')
  })

  it('fails IAM checks on an explicit denial', () => {
    const f = fixture()
    const options = {publicRead: true, sidecarStore: proof, vpcEndpointId: 'vpce-0abc', writerRoleArn: roleArn}
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, options))
    const writes = f.writes.length
    f.deny = true
    expect(() => checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, options))).to.throw('did not allow')
    expect(f.writes).to.have.length(writes)
  })

  it('check fails when the managed writer policy is broader or stale, before simulating', () => {
    const f = fixture()
    const options = {publicRead: true, sidecarStore: proof, vpcEndpointId: 'vpce-0abc', writerRoleArn: roleArn}
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, options))
    // The old setup eth-da-submitter grant: Get/Put on the whole bucket.
    f.inline = {Statement: [{Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: 'arn:aws:s3:::dogeos-da-archive/*'}], Version: '2012-10-17'}
    expect(() => checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, options))).to.throw('differs from the managed policy')
    // The managed policy plus a DeleteObject grant.
    const extra = buildArchiveWriterPolicy('da', da, proof) as any
    extra.Statement[0].Action.push('s3:DeleteObject')
    f.inline = extra
    expect(() => checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, options))).to.throw('differs from the managed policy')
  })

  it('refuses a posture that an unmanaged anonymous grant defeats, without deleting it', () => {
    const legacy = {Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: ['arn:aws:s3:::dogeos-da-archive/mainnet/batches/0x*'], Sid: 'ScrollSdkArtifactRead0123456789abcdef01234567'}
    const publicWrite = {Action: 's3:*', Effect: 'Allow', Principal: {AWS: '*'}, Resource: 'arn:aws:s3:::dogeos-da-archive/*', Sid: 'OpenBucket'}
    for (const [statement, message] of [[legacy, 'legacy setup artifact-access grant'], [publicWrite, 'OpenBucket']] as const) {
      const f = fixture()
      ;(f.bucket.Statement as unknown[]).push(statement)
      for (const publicRead of [false, true]) {
        expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead, vpcEndpointId: 'vpce-0abc'})).to.throw(message)
      }

      expect(f.writes).to.have.length(0)
      expect(f.bucket.Statement).to.deep.include(statement)
    }

    // Grants on a sibling prefix or restricted to the VPC endpoint do not overlap the posture.
    const f = fixture()
    ;(f.bucket.Statement as unknown[]).push(
      {...legacy, Resource: 'arn:aws:s3:::dogeos-da-archive/rehearsal/*', Sid: 'SiblingRead'},
      {...legacy, Condition: {StringEquals: {'aws:SourceVpce': 'vpce-0abc'}}, Sid: 'OperatorVpceRead'},
    )
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0abc'})).not.to.throw()
  })

  it('trusts preserved owned statements only in their canonical shape', () => {
    const vpceSid = archivePolicySids('da', da.bucket, da.keyPrefix).vpceRead
    const resource = 'arn:aws:s3:::dogeos-da-archive/mainnet/batches/*'
    // 1. Public read on, endpoint omitted: an owned-Sid anonymous write with no
    //    endpoint condition must not be carried forward.
    const f1 = fixture()
    applyPlanned(f1, planArtifactAccess(f1.aws, 'da', da, {publicRead: true}))
    ;(f1.bucket.Statement as unknown[]).push({Action: 's3:PutObject', Effect: 'Allow', Principal: '*', Resource: resource, Sid: vpceSid})
    const writes = f1.writes.length
    expect(() => planArtifactAccess(f1.aws, 'da', da, {publicRead: true})).to.throw(`${vpceSid} is not the canonical CLI statement`)
    // 2. Public read off, endpoint omitted: a PutObject-only statement on the
    //    right prefix and a usable endpoint is not a read path.
    const f2 = fixture()
    ;(f2.bucket.Statement as unknown[]).push({Action: 's3:PutObject', Condition: {StringEquals: {'aws:SourceVpce': 'vpce-0abc'}}, Effect: 'Allow', Principal: '*', Resource: resource, Sid: vpceSid})
    expect(() => planArtifactAccess(f2.aws, 'da', da, {publicRead: false})).to.throw('--vpc-endpoint-id')
    // A tampered public-read statement is rejected the same way.
    const f3 = fixture()
    ;(f3.bucket.Statement as unknown[]).push({Action: 's3:*', Effect: 'Allow', Principal: '*', Resource: resource, Sid: archivePolicySids('da', da.bucket, da.keyPrefix).publicRead})
    expect(() => planArtifactAccess(f3.aws, 'da', da, {vpcEndpointId: 'vpce-0abc'})).to.throw('--public-read or --no-public-read')
    expect(f1.writes).to.have.length(writes)
    expect(f2.writes).to.have.length(0)
    // Passing the option explicitly reconciles the statement to canonical.
    applyPlanned(f2, planArtifactAccess(f2.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0abc'}))
    checkArtifactAccess(f2.aws, planArtifactAccess(f2.aws, 'da', da, {publicRead: false}))
  })

  it('refuses to turn public read off without a usable same-region VPC endpoint read path', () => {
    const f = fixture()
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, {publicRead: true}))
    const writes = f.writes.length
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false})).to.throw('would lose read access')
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0bbb'})).to.throw('not an available us-east-1 S3 Gateway endpoint')
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0ccc'})).to.throw('not an available')
    expect(f.writes).to.have.length(writes)
    // A recorded, usable endpoint statement is enough on later runs and checks.
    applyPlanned(f, planArtifactAccess(f.aws, 'da', da, {publicRead: false, vpcEndpointId: 'vpce-0abc'}))
    checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, {publicRead: false}))
  })

  it('scopes writers: DA blobs plus the proof sidecar namespace; snapshot deploy role put-only', () => {
    expect(buildArchiveWriterPolicy('da', da, proof)).to.deep.equal({
      Statement: [
        {Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: 'arn:aws:s3:::dogeos-da-archive/mainnet/batches/*', Sid: 'DaArchivePut'},
        {Action: ['s3:GetObject', 's3:PutObject'], Effect: 'Allow', Resource: ['arn:aws:s3:::dogeos-proof-artifacts/mainnet/proofs/scroll-chunk-segmentation-sidecars/*', 'arn:aws:s3:::dogeos-proof-artifacts/mainnet/proofs/scroll-chunk-segmentation-sidecars-by-height/*'], Sid: 'SegmentationSidecarPut'},
      ],
      Version: '2012-10-17',
    })
    // Without a proof store (proof disabled) the DA writer only gets the archive.
    expect((buildArchiveWriterPolicy('da', da).Statement as unknown[])).to.have.length(1)
    expect(buildArchiveWriterPolicy('snapshot', {bucket: 'dogeos-snapshots', keyPrefix: 'mainnet/history'})).to.deep.equal({
      Statement: [{Action: 's3:PutObject', Effect: 'Allow', Resource: 'arn:aws:s3:::dogeos-snapshots/mainnet/history/*', Sid: 'SnapshotPut'}],
      Version: '2012-10-17',
    })
  })

  it('keeps snapshot public read off unless requested', () => {
    const policy = buildArchiveBucketPolicy({}, 'snapshot', 'dogeos-snapshots', 'mainnet/history', {vpcEndpointId: 'vpce-0abc'})
    expect(sids(policy)).to.deep.equal(['ScrollSdkDenyInsecureTransport', archivePolicySids('snapshot', 'dogeos-snapshots', 'mainnet/history').vpceRead])
  })

  it('owns one abort-only DA retention rule per prefix, preserving other rules and the minimum-size default', () => {
    const f = fixture()
    const sibling = {Expiration: {Days: 30}, Filter: {Prefix: 'deployments/other/'}, ID: 'SiblingExpiry', Status: 'Enabled'}
    const disabled = {Expiration: {Days: 1}, Filter: {}, ID: 'DisabledWholeBucket', Status: 'Disabled'}
    f.lifecycle = {Rules: [sibling, disabled], TransitionDefaultMinimumObjectSize: 'varies_by_storage_class'}
    const plan = planArtifactAccess(f.aws, 'da', da, {publicRead: true, vpcEndpointId: 'vpce-0abc'})
    expect(plan.lifecycle.changed).to.equal(true)
    expect(plan.lifecycle.after).to.deep.equal({Rules: [sibling, disabled, retentionLifecycleRule('da', da.bucket, da.keyPrefix)], TransitionDefaultMinimumObjectSize: 'varies_by_storage_class'})
    applyPlanned(f, plan)
    expect(retentionLifecycleRule('da', da.bucket, da.keyPrefix)).to.deep.include({AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7}, Filter: {Prefix: 'mainnet/batches/'}})
    checkArtifactAccess(f.aws, planArtifactAccess(f.aws, 'da', da, {publicRead: true}))
    const snapshot = planArtifactAccess(fixture().aws, 'snapshot', da, {publicRead: true, vpcEndpointId: 'vpce-0abc'}).lifecycle
    expect(snapshot.after.Rules).to.deep.equal([retentionLifecycleRule('snapshot', da.bucket, da.keyPrefix)])
    expect(retentionLifecycleRule('snapshot', da.bucket, da.keyPrefix).ID).not.to.equal(retentionLifecycleRule('da', da.bucket, da.keyPrefix).ID)
  })

  for (const [name, rule] of Object.entries({
    'archive transition': {Filter: {Prefix: 'mainnet/'}, ID: 'Archive', Status: 'Enabled', Transitions: [{Days: 30, StorageClass: 'GLACIER'}]},
    'noncurrent deletion': {Filter: {And: {Prefix: 'mainnet/batches/', Tags: [{Key: 'a', Value: 'b'}]}}, ID: 'Noncurrent', NoncurrentVersionExpiration: {NoncurrentDays: 7}, Status: 'Enabled'},
    'whole-bucket expiry': {Expiration: {Days: 365}, Filter: {}, ID: 'Expire', Status: 'Enabled'},
  })) it(`refuses an overlapping ${name} rule before any write`, () => {
    const f = fixture()
    f.lifecycle = {Rules: [rule]}
    expect(() => planArtifactAccess(f.aws, 'da', da, {publicRead: true, vpcEndpointId: 'vpce-0abc'})).to.throw(`lifecycle rule ${rule.ID}`)
    expect(() => checkExistingRetention(f.aws, 'da', da)).to.throw('must be retained')
    expect(f.writes).to.deep.equal([])
  })

  it('accepts directly readable transitions and plans no lifecycle change when it is already correct', () => {
    const f = fixture()
    const tiering = {Filter: {Prefix: ''}, ID: 'Tiering', Status: 'Enabled', Transitions: [{Days: 30, StorageClass: 'INTELLIGENT_TIERING'}]}
    f.lifecycle = {Rules: [tiering, retentionLifecycleRule('da', da.bucket, da.keyPrefix)]}
    expect(() => checkExistingRetention(f.aws, 'da', da)).not.to.throw()
    expect(planArtifactAccess(f.aws, 'da', da, {publicRead: true, vpcEndpointId: 'vpce-0abc'}).lifecycle.changed).to.equal(false)
    expect(f.writes).to.deep.equal([])
  })

})
