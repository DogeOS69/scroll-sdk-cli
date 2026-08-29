import * as toml from '@iarna/toml'
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
            profile: 'withdrawal_mock_prover' as const,
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

  function writeDogeConfig(proofTopology: ProofTopologySpec): string {
    const filePath = path.join(root, '.data/doge-config.toml')
    fs.mkdirSync(path.dirname(filePath), {recursive: true})
    fs.writeFileSync(filePath, toml.stringify({
      network: 'testnet',
      proof_topology: proofTopology,
      wallet: {path: '.data/doge-wallet-testnet.json'},
    } as unknown as toml.JsonMap))
    return filePath
  }

  it('requires one proof topology authority', () => {
    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proof topology is not configured')
  })

  it('auto-discovers DeploymentSpec as the only proof intent authority', () => {
    const specPath = writeSpec(topology())
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.source).to.deep.include({kind: 'deployment-spec', path: specPath})
    expect(resolved.source.sha256).to.match(/^[\da-f]{64}$/)
    expect(resolved.intent).to.deep.equal({mode: 'disabled'})
    expect(resolved.proofTopology.mode).to.equal('disabled')
  })

  it('selects a compiler-backed active profile without flattening dormant data', () => {
    writeSpec(topology('mock'))
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.intent).to.deep.equal({mode: 'mock'})
    expect(resolved.proofTopology.mock?.profile).to.equal('withdrawal_mock_prover')
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
      .to.throw('Multiple conventional DeploymentSpec proof authorities found')
  })

  it('rejects the removed proofSystem source instead of interpreting it', () => {
    const spec = baseSpec() as {proofSystem?: unknown} & DeploymentSpec
    spec.proofSystem = {mode: 'disabled'}
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump(spec))

    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proofSystem has been removed')
  })

  it('rejects the harness-only cheap_scroll_chunk profile even while dormant', () => {
    const invalid = topology()
    invalid.mock = {
      artifactStore: {kind: 'local_fs'},
      profile: 'cheap_scroll_chunk',
      workerImage: {
        digest: `sha256:${'b'.repeat(64)}`,
        repository: 'dogeos69/prover-worker-mock',
      },
    } as unknown as NonNullable<ProofTopologySpec['mock']>
    writeDogeConfig(invalid)
    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('mock.profile must be a deployable withdrawal mock profile')
  })

  it('uses doge-config [proof_topology] without a DeploymentSpec', () => {
    const configured = topology('mock')
    configured.deployment = {coordinatorId: 'dogeos-dev0829-proof-coordinator'}
    const configPath = writeDogeConfig(configured)
    const resolved = resolveProofIntent({deploymentDir: root})

    expect(resolved.source).to.deep.include({kind: 'doge-config', path: configPath})
    expect(resolved.proofTopology.mock?.profile).to.equal('withdrawal_mock_prover')
    expect(resolved.intent.mode).to.equal('mock')
    expect(resolved.network).to.equal('testnet')
    expect(resolved.deploymentName).to.equal('dogeos-dev0829')
  })

  it('fails when doge-config and DeploymentSpec both declare proof topology', () => {
    writeDogeConfig(topology())
    writeSpec(topology())

    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('Conflicting proof topology sources')
  })

  it('normalizes doge-config and DeploymentSpec into the same compiler topology', () => {
    const expected = topology('mock')
    const specPath = writeSpec(expected)
    const fromSpec = resolveProofIntent({deploymentDir: root})
    fs.rmSync(specPath)
    writeDogeConfig(expected)
    const fromDogeConfig = resolveProofIntent({deploymentDir: root})

    expect(fromDogeConfig.proofTopology).to.deep.equal(fromSpec.proofTopology)
  })

  it('rejects unknown doge-config proof fields instead of dropping them', () => {
    writeDogeConfig({
      ...topology(),
      typoMode: 'mock',
    } as unknown as ProofTopologySpec)

    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proof_topology.typoMode is not supported')
  })

  it('rejects a changed release manifest recorded by doge-config initialization', () => {
    const configPath = writeDogeConfig(topology())
    const manifestPath = path.join(root, '.data/proof-release-v1.json')
    fs.writeFileSync(manifestPath, '{}\n')
    const config = toml.parse(fs.readFileSync(configPath, 'utf8')) as toml.JsonMap
    config.proof_release = {
      manifestPath: '.data/proof-release-v1.json',
      manifestSha256: '0'.repeat(64),
      releaseId: 'release-v1',
    }
    fs.writeFileSync(configPath, toml.stringify(config))

    expect(() => resolveProofIntent({deploymentDir: root}))
      .to.throw('proof release manifest changed')
  })

  it('allows callers to detect an unconfigured proof topology', () => {
    expect(resolveProofIntent({deploymentDir: root, required: false})).to.equal(undefined)
  })
})
