import type {DeploymentSpec, ProofCoordinatorConfig} from '../types/deployment-spec.js'
import type {ProofTopologySpec} from '../types/proof-topology.js'

/** Expand the one operator-owned proof store into consumer configuration.
 * Keep these projections out of the source spec and saved plan intent.
 */
export function resolveSpecProofStorage(spec: DeploymentSpec): {
  proofCoordinator?: ProofCoordinatorConfig
  proofTopology?: ProofTopologySpec
} {
  const s3 = spec.proofArtifacts?.s3
  const region = s3?.region ?? spec.infrastructure?.aws?.region
  const endpointUrl = s3?.endpointUrl ?? (region ? `https://s3.${region}.amazonaws.com` : undefined)
  const coordinates = {
    bucket: s3?.bucket ?? '',
    keyPrefix: s3?.keyPrefix ?? '',
    region: region ?? '',
    ...(endpointUrl ? {endpointUrl} : {}),
    forcePathStyle: s3?.forcePathStyle ?? Boolean(s3?.endpointUrl),
  }
  const coordinator = spec.proofCoordinator
  const topology = spec.proofTopology
  return {
    ...(coordinator ? {proofCoordinator: {
      ...coordinator,
      artifactStore: {...coordinates, ...coordinator.artifactStore},
    }} : {}),
    ...(topology ? {proofTopology: {
      ...topology,
      active: topology.active ? {
        ...topology.active,
        artifactStore: {
          ...(topology.active.artifactStore?.kind === undefined || topology.active.artifactStore.kind === 's3_compatible'
            ? {bucket: coordinates.bucket, endpointUrl, forcePathStyle: coordinates.forcePathStyle, region: coordinates.region} : {}),
          kind: 's3_compatible' as const,
          ...topology.active.artifactStore,
        },
      } : undefined,
      deployment: {...topology.deployment, artifactKeyPrefix: s3?.keyPrefix ?? `${spec.metadata.name}/proofs`},
    }} : {}),
  }
}
