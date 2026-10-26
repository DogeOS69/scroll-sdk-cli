/** Inputs to the resumable preparation workflow; credentials are file/env references. */
export interface PreparationConfig {
  archive?: {action: 'configure' | 'create'; awsProfile?: string; publicRead?: boolean; writerRoleArn?: string}
  bridge: {
    /** Mutable, operator-supplied outpoints; relative to the deployment directory. */
    fundingFile?: string
    /** Approved bridge-genesis-tools image, pinned by digest. */
    image: string
    mode: 'helper' | 'production'
    production?: {
      /** Resolve finalized once on apply, or select an explicit historical boundary. */
      ethereumAnchor: {blockNumber?: number; blockTag?: 'finalized'; transactionIndex?: number}
      /** New plans default to helper distribution; external retains manual wallet funding. */
      funding?: 'external' | 'helper'
      /** Local signing inputs; mutually exclusive with sequencerKms. */
      sequencerKeyEnv?: string
      /** Apply resolves and pins the public key; no exported private key is needed. */
      sequencerKms?: {
        action: 'create' | 'reuse'
        awsProfile?: string
        keyId?: string
        region?: string
        /** Defaults to the proof AWS withdrawal role when selected. */
        roleArn?: string
      }
      sequencerPublicKey?: string
    }
  }
  databases?: Array<'blockscout'>
  /** Explicit S3 publication owns only deployment-kits/<version>/ reads; omission keeps manual publication. */
  deploymentKitPublication?: {awsProfile?: string; mode: 'manual' | 's3'}
  dstack?: {
    /** Existing AWS networking; controller uses its workload role, never static access keys. */
    aws?: {
      /** Operator profile for controller role preparation; the controller itself uses IRSA. */
      awsProfile?: string
      /** Created role name; defaults to a deployment/cluster-derived name. An existing role is selected by its annotation. */
      controllerRoleName?: string
      iamInstanceProfile?: string
      publicIps?: boolean
      vpcIds: Record<string, string>
    }
    /** Existing asyncpg connection URL; mutually exclusive with database creation. */
    databaseUrlEnv?: string
    gcpProjectId?: string
    gcpServiceAccountFile?: string
    initializeDatabase?: boolean
    mode: 'external' | 'import'
    project?: string
    providers?: Array<'aws' | 'gcp' | 'vastai'>
    /** Name of an environment variable; mutually exclusive with vastaiApiKeyFile. */
    vastaiApiKeyEnv?: string
    vastaiApiKeyFile?: string
  }
  genesis?: {contractsSource?: string}
  /** Other separately produced runtime inputs, copied before final preparation. */
  inputs?: Array<{destination: string; source: string}>
  proofAws?: {
    action: 'create' | 'reuse'
    awsProfile?: string
    /** Existing role names; omitted names are derived from deployment alias and cluster. */
    coordinatorRoleName?: string
    publicEndpointUrl?: string
    publicReadMode: 'direct-s3' | 'existing-gateway' | 'existing-public-s3'
    secretName?: string
    withdrawalRoleName?: string
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
  proofPublication?: {awsProfile?: string; release?: string; releaseSha256?: string}
  /** Approved software release; plan validates the manifest and derives image pins. */
  proofRelease?: {manifest?: string; sha256?: string; version?: string}
  secretUpload?: {awsPrefix?: string; awsRegion?: string; kubeContext?: string; namespace?: string; provider: 'aws' | 'vault'}
  /** Discover and pin TSO ALB subnets and render their CIDRs during final chart preparation. */
  tsoAlbEdge?: {awsProfile?: string; enabled: boolean; ingressName?: string}
}
