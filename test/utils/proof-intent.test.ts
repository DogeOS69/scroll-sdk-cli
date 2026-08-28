import {expect} from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {DeploymentSpec, ProofTopologySpec} from '../../src/types/deployment-spec.js'

import {resolveProofIntent} from '../../src/utils/proof-intent.js'

const ENVIRONMENT = {
  DB_ADMIN_PASSWORD: 'test-password',
  DOGECOIN_CLUSTER_RPC_PASSWORD: 'test-password',
  DOGECOIN_CLUSTER_RPC_USERNAME: 'test-user',
  DOGECOIN_EXTERNAL_RPC_PASSWORD: 'test-password',
  DOGECOIN_EXTERNAL_RPC_USERNAME: 'test-user',
  OWNER_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
}

function topology(mode: 'disabled' | 'mock' = 'disabled'): ProofTopologySpec {
  return {
    compiler: {
      image: {
        digest: `sha256:${'a'.repeat(64)}`,
        repository: 'dogeos69/dogeos-proof-topology',
      },
    },
    ...(mode === 'mock'
      ? {
          mock: {
            artifactStore: {kind: 'local_fs' as const},
            profile: 'cheap_scroll_chunk' as const,
            workerImage: {
              digest: `sha256:${'b'.repeat(64)}`,
              repository: 'dogeos69/prover-worker-mock',
            },
          },
        }
      : {}),
    mode,
  }
}

function baseSpec(): DeploymentSpec {
  const examplePath = path.resolve('src/config/deployment-spec.example.yaml')
  return yaml.load(fs.readFileSync(examplePath, 'utf8')) as DeploymentSpec
}

describe('proof intent source resolution', () => {
  let originalEnvironment: NodeJS.ProcessEnv
  let root: string

  beforeEach(() => {
    originalEnvironment = {...process.env}
    Object.assign(process.env, ENVIRONMENT)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-intent-'))
  })

  afterEach(() => {
    process.env = originalEnvironment
    fs.rmSync(root, {force: true, recursive: true})
  })

  function writeSpec(
    proofTopology: ProofTopologySpec,
    file = 'deployment-spec.yaml',
  ): string {
    const spec = baseSpec()
    spec.proofTopology = proofTopology
    if (proofTopology.mode !== 'disabled') {
      spec.proofCoordinator = {
        artifactStore: {bucket: 'proofs', region: 'us-west-2'},
        s3AuthMode: 'ambient',
      }
    }

    const filePath = path.join(root, file)
    fs.writeFileSync(filePath, yaml.dump(spec))
    return filePath
  }

  it('requires a DeploymentSpec', () => {
    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proof topology requires deployment-spec.yaml or deployment-spec.yml')
  })

  it('auto-discovers DeploymentSpec as the only proof intent authority', () => {
    const specPath = writeSpec(topology())
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.source).to.deep.equal({kind: 'deployment-spec', path: specPath})
    expect(resolved.intent).to.deep.equal({mode: 'disabled'})
    expect(resolved.deploymentSpec.proofTopology?.mode).to.equal('disabled')
  })

  it('selects a compiler-backed active profile without flattening dormant data', () => {
    writeSpec(topology('mock'))
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.intent).to.deep.equal({mode: 'mock'})
    expect(resolved.deploymentSpec.proofTopology?.mock?.profile).to.equal('cheap_scroll_chunk')
  })

  it('projects the recovery declaration from proofTopology', () => {
    writeSpec({
      ...topology(),
      recovery: {preTsukiDirectSignMaxEndBatchHeight: 6863},
    })
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.intent).to.deep.equal({
      mode: 'disabled',
      preTsukiDirectSign: {maxEndBatchHeight: 6863},
    })
  })

  it('uses an explicitly selected DeploymentSpec name', () => {
    const specPath = writeSpec(topology(), 'network.yaml')
    const resolved = resolveProofIntent({deploymentDir: root, specPath: 'network.yaml'})
    expect(resolved.source.path).to.equal(specPath)
  })

  it('rejects ambiguous conventional DeploymentSpec names', () => {
    writeSpec(topology(), 'deployment-spec.yaml')
    writeSpec(topology(), 'deployment-spec.yml')
    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('Multiple conventional DeploymentSpec files found')
  })

  it('rejects the removed proofSystem source instead of interpreting it', () => {
    const spec = baseSpec() as {proofSystem?: unknown} & DeploymentSpec
    spec.proofSystem = {mode: 'disabled'}
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump(spec))

    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proofSystem has been removed')
  })
})
