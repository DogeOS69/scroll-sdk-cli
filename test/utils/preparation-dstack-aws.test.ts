/* eslint-disable @typescript-eslint/no-explicit-any -- Resource metadata fixtures. */
import * as toml from '@iarna/toml'
import {expect} from 'chai'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {generateDstackControllerValues} from '../../src/utils/dstack-controller-values.js'
import {DSTACK_AWS_RECORD, bindPreparedDstackAws, dstackAwsIntent, prepareDstackAws, withPreparedDstackAws} from '../../src/utils/preparation-dstack-aws.js'
const roleArn = 'arn:aws:iam::000000000000:role/external/dstack'
function fixture(): DeploymentSpec {
  return {
    dstackController: {enabled: true, serviceAccount: {name: 'fixture-controller'}},
    infrastructure: {aws: {accountId: '000000000000', eksClusterName: 'fixture-cluster', region: 'us-east-1', roles: {dstackController: roleArn}}, namespace: 'fixture', provider: 'aws'},
    metadata: {name: 'fixture'},
    preparation: {bridge: {mode: 'helper'}, dstack: {aws: {awsProfile: 'fixture-profile', vpcIds: {'us-east-1': 'vpc-00000000000000000'}}, mode: 'import', providers: ['aws']}, proofMaterials: {mode: 'existing'}},
  } as unknown as DeploymentSpec
}

describe('external dstack resource references', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstack-refs-')); fs.mkdirSync(path.join(root, '.data')); fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '')})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  it('reads only the role and carries its ARN into production ServiceAccount annotations', () => {
    const spec = fixture(); const calls: string[][] = []
    const aws = {json(args: string[]) {calls.push(args); if (args[1] !== 'get-role') throw new Error('Unexpected policy or network audit'); return {Role: {Arn: roleArn}}}}
    prepareDstackAws(root, spec, aws)
    bindPreparedDstackAws(root, spec)
    const config = toml.parse(fs.readFileSync(path.join(root, '.data/doge-config.toml'), 'utf8')) as any
    const values = yaml.load(generateDstackControllerValues(config.dstackController)!) as any
    expect(values.serviceAccount.annotations['eks.amazonaws.com/role-arn']).eq(roleArn)
    expect(withPreparedDstackAws(root, spec).dstackController?.serviceAccount?.annotations?.['eks.amazonaws.com/role-arn']).eq(roleArn)
    const before = fs.readFileSync(path.join(root, DSTACK_AWS_RECORD), 'utf8')
    prepareDstackAws(root, spec, aws)
    expect(fs.readFileSync(path.join(root, DSTACK_AWS_RECORD), 'utf8')).eq(before)
    expect(calls).length(2)
  })
  it('renders Pod Identity without stale IRSA and disables node metadata fallback', () => {
    const spec = fixture(); spec.infrastructure.aws!.workloadIdentity = 'pod-identity'
    spec.dstackController!.serviceAccount!.annotations = {'eks.amazonaws.com/role-arn': roleArn, 'example.invalid/owner': 'operator'}
    prepareDstackAws(root, spec, {json() {return {Role: {Arn: roleArn}}}})
    bindPreparedDstackAws(root, spec)
    const controller = withPreparedDstackAws(root, spec).dstackController!
    const values = yaml.load(generateDstackControllerValues(controller)!) as any
    expect(values.serviceAccount).include({create: true, name: 'fixture-controller'})
    expect(values.serviceAccount.annotations).deep.eq({'example.invalid/owner': 'operator'})
    expect(values).not.have.property('awsWorkloadIdentity')
    expect(values.extraEnv).deep.include({name: 'AWS_EC2_METADATA_DISABLED', value: 'true'})
  })
  it('retains local required-field checks and redacts resource read errors', () => {
    const spec = fixture()
    expect(() => prepareDstackAws(root, spec, {json() {throw new Error('PRIVATE_PROVIDER_MARKER')}})).throw('Cannot read AWS resource')
    expect(fs.existsSync(path.join(root, DSTACK_AWS_RECORD))).false
    spec.dstackController!.serviceAccount!.create = false
    expect(() => dstackAwsIntent(spec)).throw('serviceAccount.create: false')
  })
})
