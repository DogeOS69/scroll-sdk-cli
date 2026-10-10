/** Check storage intent before rendering configuration or changing cloud resources. */
export function assertSeparateDaProofBuckets(config: {
  ethereumDa?: {blobArchive?: {s3?: {bucket?: string}}}
  proof_topology?: {active?: {artifactStore?: {bucket?: string}}}
  proofArtifacts?: {s3?: {bucket?: string}}
  proofCoordinator?: {artifactStore?: {bucket?: string}}
  proofDeployment?: {coordinator?: {artifactStore?: {bucket?: string}}}
  proofTopology?: {active?: {artifactStore?: {bucket?: string}}}
}, resolve: (value: string) => string = value => value): void {
  const name = (value: string | undefined): string | undefined => typeof value === 'string' ? resolve(value).trim() : undefined
  const daBucket = name(config.ethereumDa?.blobArchive?.s3?.bucket)
  if (!daBucket) return
  for (const [label, bucket] of [
    ['proofArtifacts.s3.bucket', config.proofArtifacts?.s3?.bucket],
    ['proofTopology.active.artifactStore.bucket', config.proofTopology?.active?.artifactStore?.bucket],
    ['proof_topology.active.artifactStore.bucket', config.proof_topology?.active?.artifactStore?.bucket],
    ['proofCoordinator.artifactStore.bucket', config.proofCoordinator?.artifactStore?.bucket],
    ['proofDeployment.coordinator.artifactStore.bucket', config.proofDeployment?.coordinator?.artifactStore?.bucket],
  ] as const) {
    if (name(bucket) === daBucket) {
      throw new Error(`${label} must differ from ethereumDa.blobArchive.s3.bucket; separate prefixes do not provide separate buckets`)
    }
  }
}
