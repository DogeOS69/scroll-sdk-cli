import {createHash} from 'node:crypto'

import type {ProofSoftwareRelease} from '../../src/utils/proof-software-release.js'

import {PROOF_PUBLICATION_FILES, PROOF_RELEASE_IMAGE_NAMES} from '../../src/utils/proof-software-release.js'

export function releaseFixture(revision = 'a'.repeat(40)): ProofSoftwareRelease {
  return {
    createdAt: '2026-09-21T00:00:00Z',
    cuda: {architectures: ['86']},
    genericBundle: {
      files: Object.fromEntries(['chunk/app.vmexe', 'chunk/openvm.toml', 'batch/app.vmexe', 'batch/openvm.toml', 'verifier/aggregate-vk'].map(name => [name, {
        asset: name.replaceAll('/', '-'), sha256: createHash('sha256').update(name).digest('hex'), sizeBytes: name.length, url: 'https://example.com/' + name,
      }])),
      openvmVersion: '1.7.0', rustToolchain: 'nightly-2026-03-17', schema: 'dogeos/scroll-program-bundle/v1',
      sourceRepository: 'https://github.com/DogeOS69/scroll-zkvm-prover', sourceRevision: 'c'.repeat(40),
      upstreamManifest: {sha256: 'd'.repeat(64), url: 'https://example.com/manifest.json'},
    },
    images: Object.fromEntries(PROOF_RELEASE_IMAGE_NAMES.map(name => [name, {coreRevision: revision, reference: `example/${name.toLowerCase()}@sha256:${'b'.repeat(64)}`}])) as ProofSoftwareRelease['images'],
    producer: {contract: 'prepare-real-v1'},
    publisher: {contract: 'v1-11-files', files: PROOF_PUBLICATION_FILES.map(([prefix, relativePath]) => ({prefix, relativePath}))},
    schema: 'dogeos/proof-release/v1',
    source: {repository: 'https://github.com/DogeOS69/dogeos-core', revision},
    toolchain: {openvm: '1.7.0', rust: 'nightly-2026-03-17', scrollRevision: 'c'.repeat(40)},
  }
}
