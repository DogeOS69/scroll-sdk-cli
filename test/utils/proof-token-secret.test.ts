import {expect} from 'chai'

import {assertAwsReadOnly} from '../../src/utils/aws-cli.js'
import {ensureProofTokenSecret} from '../../src/utils/proof-token-secret.js'

// `null` is a Secret created by the template without a value; `undefined` is no Secret.
function fakeSecret(existing?: Record<string, string> | null | string) {
  const writes: Array<{args: string[]; secret: Record<string, string>}> = []
  const messages: string[] = []
  const aws = {
    json(args: string[], options: {contentWrite?: 'object' | 'secret-value'} = {}) {
      assertAwsReadOnly(args, options.contentWrite)
      if (args[1] === 'describe-secret') {
        if (existing === undefined) throw new Error('An error occurred (ResourceNotFoundException)')
        return {}
      }

      writes.push({args: args.slice(0, 2), secret: JSON.parse(args[args.indexOf('--secret-string') + 1])})
      return {}
    },
    text(args: string[]) {
      assertAwsReadOnly(args)
      if (existing === null) throw new Error('An error occurred (ResourceNotFoundException): no value for staging label AWSCURRENT')
      return typeof existing === 'string' ? existing : JSON.stringify(existing)
    },
  }
  return {aws, info: (message: string) => messages.push(message), messages, writes}
}

describe('proof token Secret value', () => {
  it('never creates the Secret and points to the infrastructure template', () => {
    const f = fakeSecret()
    expect(() => ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', false, f.info)).to.throw('proof-secret.yaml')
    expect(f.writes).to.deep.equal([])
  })

  it('initializes both tokens in a template-created Secret that has no value yet', () => {
    const f = fakeSecret(null)
    expect(ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', false, f.info)).to.equal('initialized')
    expect(f.writes.map(write => write.args.join(' '))).to.deep.equal(['secretsmanager put-secret-value'])
    expect(Object.keys(f.writes[0].secret).sort()).to.deep.equal(['proof-work-token', 'prover-worker-master'])
    expect(f.writes[0].secret['proof-work-token']).to.match(/^[\da-f]{64}$/)
  })

  it('rotates both tokens and requires Secret synchronization and WP restart', () => {
    const f = fakeSecret({'proof-work-token': 'old-wp', 'prover-worker-master': 'old-master', 'prover-worker-token': 'legacy'})
    expect(ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', true, f.info)).to.equal('rotated')
    expect(Object.keys(f.writes[0].secret).sort()).to.deep.equal(['proof-work-token', 'prover-worker-master'])
    expect(f.writes[0].secret['proof-work-token']).not.to.equal('old-wp')
    expect(f.writes[0].secret['prover-worker-master']).not.to.equal('old-master')
    expect(f.messages.join(' ')).to.include('ExternalSecrets and Kubernetes Secrets to synchronize')
    expect(f.messages.join(' ')).to.include('restart WP, the coordinator and capacity manager')
    expect(f.messages.join(' ')).not.to.include(f.writes[0].secret['prover-worker-master'])
  })

  it('adds a fresh master to a shared-token Secret instead of promoting the shared token', () => {
    const f = fakeSecret({'proof-work-token': 'kept-wp-token', 'prover-worker-token': 'legacy-shared'})
    expect(ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', false, f.info)).to.equal('migrated')
    expect(f.writes).to.have.length(1)
    expect(f.writes[0].secret['proof-work-token']).to.equal('kept-wp-token')
    expect(f.writes[0].secret['prover-worker-master']).to.match(/^[\da-f]{64}$/)
    expect(f.writes[0].secret['prover-worker-master']).not.to.equal('legacy-shared')
  })

  it('never echoes malformed Secret contents', () => {
    const f = fakeSecret('{"proof-work-token": "plaintext-must-not-leak')
    expect(() => ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', false, f.info))
      .to.throw('contents omitted')
      .with.property('message').that.does.not.include('plaintext-must-not-leak')
  })

  it('reuses a Secret that already has a master', () => {
    const f = fakeSecret({'proof-work-token': 'a', 'prover-worker-master': 'b'})
    expect(ensureProofTokenSecret(f.aws, 'us-west-2', 'test/proof', false, f.info)).to.equal('reused')
    expect(f.writes).to.have.length(0)
  })
})

describe('CLI AWS writes', () => {
  it('allows reads, local helpers and explicit content writes only', () => {
    for (const args of [['kms', 'describe-key'], ['s3api', 'get-bucket-policy'], ['iam', 'simulate-principal-policy'], ['eks', 'update-kubeconfig']]) expect(() => assertAwsReadOnly(args)).not.to.throw()
    expect(() => assertAwsReadOnly(['secretsmanager', 'put-secret-value'], 'secret-value')).not.to.throw()
    expect(() => assertAwsReadOnly(['s3api', 'put-object'], 'object')).not.to.throw()
    for (const [args, write] of [
      [['kms', 'create-key'], undefined], [['s3api', 'create-bucket'], undefined], [['s3api', 'put-bucket-policy'], 'object'],
      [['iam', 'put-role-policy'], 'secret-value'], [['secretsmanager', 'put-secret-value'], undefined], [['s3api', 'put-object'], 'secret-value'],
    ] as const) expect(() => assertAwsReadOnly([...args], write), args.join(' ')).to.throw('does not create or change AWS resources')
  })

  it('allows no write at all during the pre-genesis AWS stage', () => {
    const saved = process.env.SCROLLSDK_PREPARATION_STAGE
    process.env.SCROLLSDK_PREPARATION_STAGE = 'aws'
    try {
      expect(() => assertAwsReadOnly(['secretsmanager', 'put-secret-value'], 'secret-value')).to.throw('does not create or change AWS resources')
      expect(() => assertAwsReadOnly(['secretsmanager', 'describe-secret'])).not.to.throw()
    } finally {
      if (saved === undefined) delete process.env.SCROLLSDK_PREPARATION_STAGE
      else process.env.SCROLLSDK_PREPARATION_STAGE = saved
    }
  })
})
