/* eslint-disable @typescript-eslint/no-explicit-any -- AWS response fixtures. */
import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {DeploymentSpec} from '../../src/types/deployment-spec.js'

import {reuseProofAws} from '../../src/utils/preparation-proof-aws.js'
import {readProofAwsConfig} from '../../src/utils/proof-aws-config.js'

describe('existing proof AWS discovery', () => {
  let root: string
  const account = '123456789012'
  const issuer = 'oidc.eks.us-west-2.amazonaws.com/id/TEST'
  const spec = {infrastructure: {aws: {accountId: account, eksClusterName: 'cluster', region: 'us-west-2'}, namespace: 'test'}, metadata: {name: 'test'}, preparation: {proofAws: {action: 'reuse', publicReadMode: 'existing-public-s3'}}} as DeploymentSpec
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-aws-discovery-'))
    fs.mkdirSync(path.join(root, '.data'))
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), '[proofArtifacts.s3]\nbucket="test-proof-bucket"\nregion="us-west-2"\nkeyPrefix="proofs"\n')
  })
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  function response(args: string[]): any {
    switch (args[1]) {
      case 'get-caller-identity': { return {Account: account}
      }

      case 'describe-cluster': { return {cluster: {identity: {oidc: {issuer: `https://${issuer}`}}}}
      }

      case 'get-open-id-connect-provider': case 'head-bucket': { return {}
 }

      case 'get-bucket-location': { return {LocationConstraint: 'us-west-2'}
      }

      case 'describe-secret': { return {Name: 'scroll/test/proof-coordinator-secrets', VersionIdsToStages: {v1: ['AWSCURRENT']}}
      }

      case 'get-role': {
        const sa = args[3].endsWith('wp-proof') ? 'withdrawal-processor' : 'proof-coordinator'
        return {Role: {Arn: `arn:aws:iam::${account}:role/${args[3]}`, AssumeRolePolicyDocument: {Statement: [{Action: 'sts:AssumeRoleWithWebIdentity', Condition: {StringEquals: {[`${issuer}:aud`]: 'sts.amazonaws.com', [`${issuer}:sub`]: `system:serviceaccount:test:${sa}`}}, Effect: 'Allow', Principal: {Federated: `arn:aws:iam::${account}:oidc-provider/${issuer}`}}]}}}
      }

      default: { throw new Error(`Unexpected AWS operation: ${args[1]}`)
      }
    }
  }

  it('discovers role ARNs and secret metadata without AWS writes or secret value reads', () => {
    const calls: string[][] = []
    reuseProofAws(root, spec, {json(args: string[]) {calls.push(args); return response(args)}} as any)
    const {config} = readProofAwsConfig(root)
    expect(config.serviceAccounts.proofCoordinator.roleArn).to.equal(`arn:aws:iam::${account}:role/dogeos-test-cluster-proof-coordinator`)
    expect(config.secret.name).to.equal('scroll/test/proof-coordinator-secrets')
    expect(config.artifactReadTransport.publicStatus).to.equal('operator-managed-unverified')
    expect(calls.map(args => args[1])).to.deep.equal(['get-caller-identity', 'describe-cluster', 'get-open-id-connect-provider', 'head-bucket', 'get-bucket-location', 'get-role', 'get-role', 'describe-secret'])
  })

  for (const scenario of ['account', 'bucket-region', 'trust', 'secret']) {
    it(`rejects mismatched ${scenario} before writing a resource receipt`, () => {
      expect(() => reuseProofAws(root, spec, {json(args: string[]) {
        const result = response(args)
        if (scenario === 'account' && args[1] === 'get-caller-identity') result.Account = '999999999999'
        if (scenario === 'bucket-region' && args[1] === 'get-bucket-location') result.LocationConstraint = 'us-east-1'
        if (scenario === 'trust' && args[1] === 'get-role') result.Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[`${issuer}:sub`] = 'system:serviceaccount:other:proof-coordinator'
        if (scenario === 'secret' && args[1] === 'describe-secret') result.DeletedDate = '2026-01-01'
        return result
      }} as any)).to.throw()
      expect(fs.existsSync(path.join(root, '.data/proof-aws.json'))).to.equal(false)
    })
  }
})
