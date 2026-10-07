import type {ProofSoftwareRelease} from '../../src/utils/proof-software-release.js'

import {PROOF_RELEASE_IMAGE_NAMES} from '../../src/utils/proof-software-release.js'

export function releaseFixture(revision = 'a'.repeat(40)): ProofSoftwareRelease {
  return {
    images: Object.fromEntries(PROOF_RELEASE_IMAGE_NAMES.map(name => [name, `example/${name}@sha256:${'b'.repeat(64)}`])) as ProofSoftwareRelease['images'],
    revision,
    schema: 'dogeos/proof-release/v1',
  }
}
