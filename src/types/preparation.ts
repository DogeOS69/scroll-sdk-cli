/** Inputs to the resumable preparation workflow; credentials are file/env references. */
export interface PreparationConfig {
  archive?: {action: 'configure' | 'create'; awsProfile?: string; writerRoleArn?: string}
  attestationDescriptors: string[]
  bridge: {
    /** Mutable, operator-supplied outpoints; relative to the deployment directory. */
    fundingFile?: string
    /** Approved bridge-genesis-tools image, pinned by digest. */
    image: string
    mode: 'helper' | 'production'
    production?: {
      ethereumAnchor: {blockNumber: number; transactionIndex: number}
      feeWalletKeyEnv: string
      feeWalletPublicKey: string
      recoveryPublicKeys: string[]
      sequencerKeyEnv: string
      sequencerPublicKey: string
    }
  }
  databases?: Array<'blockscout'>
  dstack?: {
    /** Existing asyncpg connection URL; mutually exclusive with database creation. */
    databaseUrlEnv?: string
    gcpProjectId?: string
    gcpServiceAccountFile?: string
    initializeDatabase?: boolean
    mode: 'external' | 'import'
    project?: string
    providers?: Array<'gcp' | 'vastai'>
    vastaiApiKeyFile?: string
  }
  genesis?: {contractsSource?: string}
  /** Other separately produced runtime inputs, copied before final preparation. */
  inputs?: Array<{destination: string; source: string}>
  proofAws?: {
    awsProfile?: string
    publicEndpointUrl?: string
    publicReadMode: 'direct-s3' | 'existing-gateway' | 'existing-public-s3'
  }
  proofMaterials: {
    batchMaterializer?: string
    chunkMaterializer?: string
    mockWorkerImage?: string
    mode: 'existing' | 'mock' | 'real'
    preparationReceipt?: string
    productionWorkerReceipt?: string
    receipt?: string
  }
  proofPublication?: {awsProfile?: string; release: string; releaseSha256: string}
  secretUpload?: {awsPrefix?: string; awsRegion?: string; kubeContext?: string; namespace?: string; provider: 'aws' | 'vault'}
}
