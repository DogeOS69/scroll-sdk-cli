import {expect} from 'chai'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {ProofReleaseV1} from '../../src/types/proof-release.js'

import {PROOF_RELEASE_SCHEMA} from '../../src/types/proof-release.js'
import {
  discoverProofRelease,
  readProofRelease,
  validateProofRelease,
  verifyProofReleaseMaterials,
  verifyProofTopologyReleaseBinding,
} from '../../src/utils/proof-release.js'
import {buildProofTopologyFromRelease} from '../../src/utils/proof-topology-init.js'

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function fixture(root: string): ProofReleaseV1 {
  const fileContent = new Map([
    ['batch/app.vmexe', 'batch app'],
    ['batch/openvm.toml', 'batch config'],
    ['bin/scroll-runtime-materializer', 'materializer'],
    ['bridge/batch-aggregation.vmexe', 'l2 range aggregation app'],
    ['bridge/batch-aggregation-openvm.toml', 'l2 range aggregation config'],
    ['bridge/bridge-state.vmexe', 'bridge app'],
    ['bridge/openvm.toml', 'bridge config'],
    ['chunk/app.vmexe', 'chunk app'],
    ['chunk/openvm.toml', 'chunk config'],
    ['keys/agg-vk.bin', 'aggregate vk'],
  ])
  for (const [relative, content] of fileContent) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), {recursive: true})
    fs.writeFileSync(target, content)
  }

  fs.mkdirSync(path.join(root, 'witnesses'), {recursive: true})
  const file = (relative: string) => ({path: relative, sha256: digest(fileContent.get(relative)!)})
  const l2Commitment = Buffer.alloc(64, 12)
  return {
    compilerImage: {digest: IMAGE_DIGEST, repository: 'dogeos69/dogeos-proof-topology'},
    profiles: {
      mock: 'withdrawal_mock_prover_real_materialize',
      production: 'real_scroll_withdrawal_full_topology',
    },
    realScroll: {
      defaults: {
        batchBackendProfile: 'scroll-batch-real-topology-prover-v1',
        chunkBackendProfile: 'scroll-chunk-real-topology-prover-v1',
      },
      files: {
        aggVerifyingKey: file('keys/agg-vk.bin'),
        batchAppConfig: file('batch/openvm.toml'),
        batchAppExe: file('batch/app.vmexe'),
        batchMaterializerBinary: file('bin/scroll-runtime-materializer'),
        bridgeAppConfig: file('bridge/openvm.toml'),
        bridgeAppExe: file('bridge/bridge-state.vmexe'),
        chunkAppConfig: file('chunk/openvm.toml'),
        chunkAppExe: file('chunk/app.vmexe'),
        chunkMaterializerBinary: file('bin/scroll-runtime-materializer'),
        l2RangeAggregationAppConfig: file('bridge/batch-aggregation-openvm.toml'),
        l2RangeAggregationAppExe: file('bridge/batch-aggregation.vmexe'),
      },
      identities: {
        batchProgramCommitmentHashHex: `0x${'1'.repeat(64)}`,
        batchProgramCommitmentHex: `0x${'2'.repeat(128)}`,
        batchVerificationKeyHashHex: `0x${'3'.repeat(64)}`,
        bridgeAppCommitRawHex: `0x${'4'.repeat(128)}`,
        bridgeProgramCommitmentHashHex: `0x${'5'.repeat(64)}`,
        bridgeVerificationKeyHashHex: `0x${'6'.repeat(64)}`,
        chunkProgramCommitmentHashHex: `0x${'7'.repeat(64)}`,
        chunkProgramCommitmentHex: `0x${'8'.repeat(128)}`,
        chunkVerificationKeyHashHex: `0x${'9'.repeat(64)}`,
        l2RangeAggregationAppCommitRawHex: `0x${l2Commitment.toString('hex')}`,
        l2RangeAggregationProgramCommitmentHashHex:
          `0x${createHash('sha256').update(l2Commitment).digest('hex')}`,
        l2RangeAggregationVerificationKeyHashHex: `0x${'6'.repeat(64)}`,
      },
    },
    releaseId: 'dogeos-core-test-v1',
    schema: PROOF_RELEASE_SCHEMA,
    workerImages: {
      mock: {digest: `sha256:${'b'.repeat(64)}`, repository: 'dogeos69/prover-worker-mock'},
      production: {digest: `sha256:${'c'.repeat(64)}`, repository: 'dogeos69/prover-worker'},
    },
  }
}

describe('proof release manifest', () => {
  let deployment: string
  let resources: string

  beforeEach(() => {
    deployment = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-'))
    resources = path.join(deployment, 'proof-artifacts')
    fs.mkdirSync(resources)
  })

  afterEach(() => {
    fs.rmSync(deployment, {force: true, recursive: true})
  })

  it('strictly reads and verifies release-producer files', () => {
    const release = fixture(resources)
    const manifest = path.join(deployment, 'proof-release-v1.json')
    fs.writeFileSync(manifest, `${JSON.stringify(release, null, 2)}\n`)

    expect(readProofRelease(manifest)).to.deep.equal(release)
    expect(discoverProofRelease(deployment)).to.equal(manifest)
    expect(() => verifyProofReleaseMaterials(release, resources)).not.to.throw()
  })

  it('rejects unknown fields and inconsistent recursive identities', () => {
    const release = fixture(resources) as {typo?: boolean} & ProofReleaseV1
    release.typo = true
    expect(() => validateProofRelease(release, 'release')).to.throw('release.typo is not supported')
    delete release.typo
    release.realScroll.identities.l2RangeAggregationVerificationKeyHashHex = `0x${'d'.repeat(64)}`
    expect(() => validateProofRelease(release, 'release'))
      .to.throw('l2RangeAggregationVerificationKeyHashHex must equal')
  })

  it('rejects changed release material before topology generation', () => {
    const release = fixture(resources)
    fs.writeFileSync(path.join(resources, 'chunk/app.vmexe'), 'tampered')
    expect(() => verifyProofReleaseMaterials(release, resources))
      .to.throw('proof release material digest mismatch')
  })

  it('rejects release material reached through an escaping directory symlink', () => {
    const release = fixture(resources)
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-release-external-'))
    try {
      fs.writeFileSync(path.join(external, 'app.vmexe'), 'chunk app')
      fs.writeFileSync(path.join(external, 'openvm.toml'), 'chunk config')
      fs.rmSync(path.join(resources, 'chunk'), {force: true, recursive: true})
      fs.symlinkSync(external, path.join(resources, 'chunk'), 'dir')
      expect(() => verifyProofReleaseMaterials(release, resources))
        .to.throw('resolves outside resources root')
    } finally {
      fs.rmSync(external, {force: true, recursive: true})
    }
  })

  it('builds both staged profiles while leaving disabled selected', () => {
    const release = fixture(resources)
    const topology = buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'dogeos-testnet-proof-artifacts',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external',
      release,
      runtime: {
        proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com',
        resourcesPersistentVolumeClaim: 'dogeos-proof-release',
        resourcesRoot: 'proof-artifacts',
      },
    })

    expect(topology.mode).to.equal('disabled')
    expect(topology.compiler.image).to.deep.equal(release.compilerImage)
    expect(topology.mock?.profile).to.equal('withdrawal_mock_prover_real_materialize')
    expect(topology.mock?.realScroll).to.deep.equal(topology.production?.realScroll)
    expect(topology.production?.workerLaunch).to.equal('external')
    expect(topology.production?.realScroll.resourcesRoot).to.equal('proof-artifacts')
    expect(topology.deployment?.bridgeStagedAppExe).to.equal('bridge/bridge-state.vmexe')
    expect(topology.deployment?.proverPublicUrl)
      .to.equal('https://proof-coordinator.example.com')
  })

  it('requires a Worker-safe coordinator URL for every staged Worker placement', () => {
    const release = fixture(resources)
    expect(() => buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external',
      release,
    })).to.throw('proof coordinator public URL must be a non-empty string')

    expect(() => buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external',
      release,
      runtime: {proofCoordinatorPublicUrl: 'http://proof-coordinator.dogeos.svc:7788'},
    })).to.throw('must use HTTPS unless it is http://127.0.0.1')
  })

  it('binds generated topology identities and files back to the pinned release', () => {
    const release = fixture(resources)
    const topology = buildProofTopologyFromRelease({
      artifactStore: {
        bucket: 'proofs',
        endpointUrl: 'https://s3.us-west-2.amazonaws.com',
        keyPrefix: 'proof-topology',
        kind: 's3_compatible',
        region: 'us-west-2',
      },
      deploymentDir: deployment,
      deploymentName: 'dogeos-testnet',
      productionWorkerLaunch: 'external',
      release,
      runtime: {proofCoordinatorPublicUrl: 'https://proof-coordinator.example.com'},
    })
    expect(() => verifyProofTopologyReleaseBinding(topology, release, deployment)).not.to.throw()
    topology.production!.realScroll.chunkVerificationKeyHashHex = `0x${'f'.repeat(64)}`
    expect(() => verifyProofTopologyReleaseBinding(topology, release, deployment))
      .to.throw('chunkVerificationKeyHashHex does not match the pinned proof release')
  })
})
