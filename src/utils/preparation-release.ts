import path from 'node:path'

import type {DeploymentSpec} from '../types/deployment-spec.js'

import {parseImmutableProofImage} from './proof-materials.js'
import {readProofSoftwareRelease} from './proof-software-release.js'

/** Read-only release expansion before plan validation; no registry or tool execution. */
export function resolvePreparationProofRelease(spec: DeploymentSpec, output: string): DeploymentSpec {
  const release = spec.preparation?.proofRelease
  if (!release) return spec
  if (!spec.proofTopology) throw new Error('proofRelease requires proofTopology')
  const selected = readProofSoftwareRelease(path.resolve(output, release.manifest), release.sha256)
  const result = structuredClone(spec)
  const topology = result.proofTopology!
  const compiler = parseImmutableProofImage(selected.manifest.images['dogeos-proof-topology'], 'release compiler')
  const worker = parseImmutableProofImage(selected.manifest.images['prover-worker-cuda'], 'release Worker')
  for (const [declared, expected, label] of [[topology.compiler?.image, compiler, 'compiler'], [topology.deployment.productionWorkerImage, worker, 'Worker']] as const) {
    if (declared && (declared.repository !== expected.repository || declared.digest !== expected.digest)) throw new Error(`Explicit ${label} image conflicts with proofRelease`)
  }

  topology.compiler = {image: compiler}
  topology.deployment.productionWorkerImage = worker
  result.preparation!.proofRelease = {manifest: selected.path, sha256: selected.sha256}
  return result
}
