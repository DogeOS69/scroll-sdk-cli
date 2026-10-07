import {expect} from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {prepareProofConfig, publishProofConfig} from '../../src/utils/proof-config-transaction.js'
import {proofFileHash} from '../../src/utils/proof-software-release.js'
import {releaseFixture} from '../helpers/proof-software-release.js'

describe('proof configuration transaction', () => {
  let root: string
  beforeEach(() => {root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-config-transaction-'))})
  afterEach(() => fs.rmSync(root, {force: true, recursive: true}))
  const request = {deploymentName: 'test-deployment', enforcement: 'observe' as const, generation: 'real' as const, mode: 'active' as const, runtime: {observeRealProofDeadlineMs: 1_800_000, proofCoordinatorPublicUrl: 'https://pc.example.com', rpcWitnessUrl: 'http://l2:8545'}}
  it('keeps active inputs intact and removes the candidate/lock when native preparation fails', () => {
    fs.mkdirSync(path.join(root, '.data'))
    fs.mkdirSync(path.join(root, 'values'))
    fs.writeFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'image: {repository: original}\n')
    fs.writeFileSync(path.join(root, '.data/protocol_context.json'), '{}')
    fs.writeFileSync(path.join(root, '.data/doge-config.toml'), 'network = "regtest"\n[ethereumDa.blobArchive.s3]\nenabled=true\nbucket="dogeos-proof-artifacts"\nregion="us-east-1"\nkeyPrefix="devnet/instance"\n')
    fs.writeFileSync(path.join(root, '.data/proof-aws.json'), JSON.stringify({
      artifactReadTransport: {publicEndpointUrl: 'https://s3.us-east-1.amazonaws.com', publicReadMode: 'existing-public-s3', publicStatus: 'operator-managed-unverified'}, artifactStore: {bucket: 'dogeos-proof-artifacts', keyPrefix: 'devnet/instance', region: 'us-east-1'},
      kubernetes: {awsRegion: 'us-east-1', deploymentAlias: 'devnet', eksCluster: 'cluster', namespace: 'default'}, schema: 'dogeos/proof-aws/v4',
      secret: {name: 'scroll/devnet/proof', region: 'us-east-1'}, serviceAccounts: {proofCoordinator: {name: 'proof-coordinator', roleArn: 'arn:aws:iam::123456789012:role/proof-coordinator'}, withdrawalProcessor: {name: 'withdrawal-processor', roleArn: 'arn:aws:iam::123456789012:role/withdrawal-processor'}},
    }))
    const release = path.join(root, 'release.json')
    fs.writeFileSync(release, JSON.stringify(releaseFixture()))
    const before = proofFileHash(path.join(root, '.data/doge-config.toml'))
    let called = false
    expect(() => prepareProofConfig({deploymentDir: root, output: 'candidate', prepareReal(options) {
      called = true
      expect(options.deploymentDir).not.to.equal(root)
      fs.writeFileSync(path.join(options.deploymentDir, 'values/proof-coordinator-production.yaml'), 'changed: true\n')
      throw new Error('native preparation failed')
    }, release, releaseSha256: proofFileHash(release), request})).to.throw('native preparation failed')
    expect(called).to.equal(true)
    expect(proofFileHash(path.join(root, '.data/doge-config.toml'))).to.equal(before)
    expect(fs.readFileSync(path.join(root, 'values/proof-coordinator-production.yaml'), 'utf8')).to.include('original')
    expect(fs.existsSync(path.join(root, 'candidate'))).to.equal(false)
    expect(fs.readdirSync(root).some(name => name.includes('.proof-config-') || name.endsWith('.prepare-lock'))).to.equal(false)
  })
  it('rejects changed prepared inputs before any publication or receipt is written', async () => {
    fs.writeFileSync(path.join(root, 'input.json'), '{}')
    const prepared = path.join(root, 'proof-config-prepared.json')
    fs.writeFileSync(prepared, JSON.stringify({files: {'input.json': {sha256: proofFileHash(path.join(root, 'input.json')), sizeBytes: 2}}, publicationPlan: {}, schema: 'scrollsdk/proof-config-prepared/v1'}))
    const sha = proofFileHash(prepared)
    fs.writeFileSync(path.join(root, 'input.json'), '{"changed":true}')
    try { await publishProofConfig({apply: true, receipt: prepared, receiptSha256: sha}); expect.fail('must reject input drift') }
    catch (error) { expect(String(error)).to.include('Prepared input changed') }

    expect(fs.readdirSync(root).sort()).to.deep.equal(['input.json', 'proof-config-prepared.json'])
  })
})
