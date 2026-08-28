import { expect } from 'chai'
import * as yaml from 'js-yaml'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  assertProofIntentOverrideAllowed,
  resolveProofIntent,
} from '../../src/utils/proof-intent.js'

describe('proof intent source resolution', () => {
  let root: string
  const dogeConfigPath = (): string => path.join(root, '.data', 'doge-config.toml')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-intent-'))
    fs.mkdirSync(path.join(root, '.data'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true })
  })

  it('keeps deployment spec optional and uses doge-config as a first-class intent source', () => {
    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {
        proofSystem: {
          artifactReadBaseUrl: 'https://proofs.example.com/topology/',
          mode: 'mock',
        },
      },
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.source).to.deep.equal({
      kind: 'doge-config',
      path: dogeConfigPath(),
    })
    expect(resolved.intent).to.deep.equal({
      artifactReadBaseUrl: 'https://proofs.example.com/topology',
      mode: 'mock',
    })
  })

  it('auto-discovers a matching deployment spec as the authoritative source', () => {
    const specPath = path.join(root, 'deployment-spec.yaml')
    fs.writeFileSync(specPath, yaml.dump({
      proofSystem: {
        artifactReadBaseUrl: 'https://proofs.example.com/releases/v1',
        mode: 'production',
        release: './proof-releases/v1',
        signerPolicy: { sourceSet: './configs/source-set.toml' },
      },
      version: '1.0',
    }))
    const proofSystem = {
      artifactReadBaseUrl: 'https://proofs.example.com/releases/v1',
      mode: 'production' as const,
      release: './proof-releases/v1',
      signerPolicy: { sourceSet: './configs/source-set.toml' },
    }

    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: { proofSystem },
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.source).to.deep.equal({
      kind: 'deployment-spec',
      path: specPath,
    })
    expect(resolved.intent).to.deep.equal(proofSystem)
  })

  it('lets an existing spec-backed deployment adopt proof intent before doge-config is regenerated', () => {
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump({
      proofSystem: {
        artifactReadBaseUrl: 'https://proofs.example.com',
        mode: 'mock',
      },
      version: '1.0',
    }))

    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {},
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.intent).to.deep.equal({
      artifactReadBaseUrl: 'https://proofs.example.com',
      mode: 'mock',
    })
    expect(resolved.source.kind).to.equal('deployment-spec')
  })

  it('selects compiler-backed proofTopology without flattening dormant profiles', () => {
    const specPath = path.join(root, 'deployment-spec.yaml')
    fs.writeFileSync(specPath, yaml.dump({
      proofTopology: {
        compiler: {
          image: {
            digest: `sha256:${'a'.repeat(64)}`,
            repository: 'dogeos69/dogeos-proof-topology',
          },
        },
        mock: {
          artifactStore: {kind: 'local_fs'},
          profile: 'cheap_scroll_chunk',
          workerImage: {
            digest: `sha256:${'b'.repeat(64)}`,
            repository: 'dogeos69/prover-worker-mock',
          },
        },
        mode: 'mock',
      },
      version: '1.0',
    }))
    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {proofSystem: {mode: 'mock'}},
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.intent).to.deep.equal({mode: 'mock'})
    expect(resolved.deploymentSpec?.proofTopology?.mock?.profile)
      .to.equal('cheap_scroll_chunk')
    expect(resolved.source).to.deep.equal({kind: 'deployment-spec', path: specPath})
  })

  it('defaults to disabled when neither source declares proof intent', () => {
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), 'version: "1.0"\n')

    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {},
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.intent).to.deep.equal({ mode: 'disabled' })
    expect(resolved.source.kind).to.equal('deployment-spec')
  })

  it('preserves prepared proof resources and the temporary pin in disabled intent', () => {
    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {
        proofSystem: {
          artifactReadBaseUrl: 'https://proofs.example.com/releases/v1/',
          mode: 'disabled',
          preTsukiDirectSign: {maxEndBatchHeight: 6863},
          release: './proof-releases/v1',
          signerPolicy: {sourceSet: './configs/source-set.toml'},
        },
      },
      dogeConfigPath: dogeConfigPath(),
    })

    expect(resolved.intent).to.deep.equal({
      artifactReadBaseUrl: 'https://proofs.example.com/releases/v1',
      mode: 'disabled',
      preTsukiDirectSign: {maxEndBatchHeight: 6863},
      release: './proof-releases/v1',
      signerPolicy: {sourceSet: './configs/source-set.toml'},
    })
  })

  it('rejects the temporary pin outside disabled mode or the u32 range', () => {
    for (const proofSystem of [
      {mode: 'mock', preTsukiDirectSign: {maxEndBatchHeight: 6863}},
      {mode: 'disabled', preTsukiDirectSign: {maxEndBatchHeight: 0}},
      {mode: 'disabled', preTsukiDirectSign: {maxEndBatchHeight: 1.5}},
      {mode: 'disabled', preTsukiDirectSign: {maxEndBatchHeight: 4_294_967_296}},
    ]) {
      expect(() => resolveProofIntent({
        deploymentDir: root,
        dogeConfig: {proofSystem: proofSystem as any},
        dogeConfigPath: dogeConfigPath(),
      })).to.throw('preTsukiDirectSign')
    }
  })

  it('treats a direct-sign pin mismatch as an intent-source conflict', () => {
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump({
      proofSystem: {
        mode: 'disabled',
        preTsukiDirectSign: {maxEndBatchHeight: 6863},
      },
      version: '1.0',
    }))

    expect(() => resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {
        proofSystem: {
          mode: 'disabled',
          preTsukiDirectSign: {maxEndBatchHeight: 6862},
        },
      },
      dogeConfigPath: dogeConfigPath(),
    })).to.throw('Proof intent conflict')
  })

  it('fails closed when spec and doge-config disagree', () => {
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), yaml.dump({
      proofSystem: { mode: 'disabled' },
      version: '1.0',
    }))

    expect(() => resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {
        proofSystem: {
          artifactReadBaseUrl: 'https://proofs.example.com',
          mode: 'mock',
        },
      },
      dogeConfigPath: dogeConfigPath(),
    })).to.throw('Proof intent conflict')
  })

  it('rejects one-run overrides for a spec-backed deployment', () => {
    const specPath = path.join(root, 'custom.yaml')
    fs.writeFileSync(specPath, yaml.dump({
      proofSystem: {
        artifactReadBaseUrl: 'https://proofs.example.com',
        mode: 'production',
      },
      version: '1.0',
    }))
    const resolved = resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {
        proofSystem: {
          artifactReadBaseUrl: 'https://proofs.example.com',
          mode: 'production',
        },
      },
      dogeConfigPath: dogeConfigPath(),
      specPath: 'custom.yaml',
    })

    expect(() => assertProofIntentOverrideAllowed({
      mode: 'mock',
      resolved,
    })).to.throw('update the DeploymentSpec')
    expect(() => assertProofIntentOverrideAllowed({
      artifactReadBaseUrl: 'https://different.example.com',
      resolved,
    })).to.throw('update the DeploymentSpec')
    expect(() => assertProofIntentOverrideAllowed({
      artifactReadBaseUrl: 'https://proofs.example.com/',
      mode: 'production',
      resolved,
    })).not.to.throw()
  })

  it('rejects ambiguous conventional spec files', () => {
    fs.writeFileSync(path.join(root, 'deployment-spec.yaml'), 'version: "1.0"\n')
    fs.writeFileSync(path.join(root, 'deployment-spec.yml'), 'version: "1.0"\n')

    expect(() => resolveProofIntent({
      deploymentDir: root,
      dogeConfig: {},
      dogeConfigPath: dogeConfigPath(),
    })).to.throw('Multiple conventional DeploymentSpec files found')
  })
})
