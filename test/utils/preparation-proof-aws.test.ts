/* eslint-disable @typescript-eslint/no-explicit-any -- Offline provider fixtures. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {reuseProofAws} from '../../src/utils/preparation-proof-aws.js'
import {readProofAwsConfig} from '../../src/utils/proof-aws-config.js'

const spec = {infrastructure: {aws: {accountId: '123456789012', eksClusterName: 'cluster', region: 'us-west-2'}, namespace: 'test'}, metadata: {name: 'test'}, preparation: {proofAws: {action: 'reuse', publicReadMode: 'existing-public-s3'}}} as DeploymentSpec
function provider() {
  const calls: string[][] = []
  const data: Record<string, any> = {
    'describe-secret': {Name: 'scroll/test/proof-coordinator-secrets', VersionIdsToStages: {}}, 'get-bucket-lifecycle-configuration': {Rules: []}, 'get-bucket-location': {LocationConstraint: 'us-west-2'},
    'get-bucket-policy': {Policy: JSON.stringify({Statement: [{Action: 's3:GetObject', Effect: 'Allow', Principal: '*', Resource: 'arn:aws:s3:::test-proof-bucket/proofs/*', Sid: 'OperatorGrant'}]})},
    'get-caller-identity': {Account: '123456789012'},
    'get-public-access-block': {PublicAccessBlockConfiguration: {BlockPublicPolicy: false, RestrictPublicBuckets: false}},
    'head-bucket': {},
  }
  return {calls, data, json(args: string[]) {calls.push(args); if (!(args[1] in data)) throw new Error('Unexpected AWS call'); return data[args[1]]}, run(args: string[]) {calls.push(args); if (args[1] !== 'head-bucket') throw new Error('Write forbidden'); return ''}, text(args: string[]) {calls.push(args); if (args[1] !== 'get-caller-identity') throw new Error('Unexpected read'); return '123456789012'}}
}

describe('external proof AWS discovery', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-discovery-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[proofArtifacts.s3]\nbucket="test-proof-bucket"\nregion="us-west-2"\nkeyPrefix="proofs"\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('accepts externally named policy rules and an empty Secret before genesis, read-only', () => {
    const aws = provider()
    reuseProofAws(root, spec, aws as any)
    const before = fs.readFileSync(path.join(root, '.data/proof-aws.json'), 'utf8')
    reuseProofAws(root, spec, aws as any)
    expect(fs.readFileSync(path.join(root, '.data/proof-aws.json'), 'utf8')).eq(before)
    expect(readProofAwsConfig(root).config.artifactReadTransport.publicStatus).eq('operator-managed-unverified')
    expect(aws.calls.every(args => /^(get|head|describe)-/.test(args[1]) && args[1] !== 'get-secret-value')).true
    expect(aws.calls.map(args => args[1])).deep.eq(['get-bucket-location', 'describe-secret', 'get-bucket-location', 'describe-secret'])
  })
  for (const scenario of ['account', 'region', 'deleted-secret', 'public-read', 'retention', 'public-block']) it(`reads configuration without auditing ${scenario}`, () => {
    const aws = provider()
    if (scenario === 'account') aws.data['get-caller-identity'].Account = '999999999999'
    if (scenario === 'region') aws.data['get-bucket-location'].LocationConstraint = 'us-east-1'
    if (scenario === 'deleted-secret') aws.data['describe-secret'].DeletedDate = 1
    if (scenario === 'public-read') aws.data['get-bucket-policy'].Policy = '{"Statement":[]}'
    if (scenario === 'retention') aws.data['get-bucket-lifecycle-configuration'].Rules = [{Expiration: {Days: 30}, Filter: {Prefix: 'proofs/'}, Status: 'Enabled'}]
    if (scenario === 'public-block') aws.data['get-public-access-block'].PublicAccessBlockConfiguration.RestrictPublicBuckets = true
    expect(() => reuseProofAws(root, spec, aws as any)).not.throw()
    expect(fs.existsSync(path.join(root, '.data/proof-aws.json'))).true
  })
})
