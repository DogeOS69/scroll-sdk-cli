export type Network = 'mainnet' | 'regtest' | 'testnet'

export interface CubesignerKey {
  key_id: string
  key_type: string
  material_id: string
  /** CubeSigner CLI/API output preserved verbatim for operator reconciliation. */
  public_key: string
  /** dogeos-core canonical 33-byte compressed SEC1 representation. */
  public_key_compressed?: string
  purpose: string
}

export interface CubesignerRole {
  keys: CubesignerKey[]
  name: string
  role_id: string
}

export interface DogeConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
  accounts?: {
    L1_COMMIT_SENDER_ADDR?: string
    L1_COMMIT_SENDER_PRIVATE_KEY?: string
    L2_GAS_ORACLE_SENDER_ADDR?: string
    L2_GAS_ORACLE_SENDER_PRIVATE_KEY?: string
  }
  attestationSigner?: {
    activeSignerIds: string[]
    /** Legacy in-cluster provisioning only; absent for external signers. */
    backend?: 'aws_kms' | 'local'
    /**
     * Partner-operated signers imported from attestation-signer descriptors.
     * The bridge operator never deploys these; endpoints are wired into TSO
     * and publicKeys into the bridge redeem script.
     */
    external?: Array<{
      endpoint: string
      id: string
      publicKey: string
    }>
    /** Legacy in-cluster provisioning only; absent for external signers. */
    instances?: Array<{
      expectedSignerId: string
      id: string
      index: number
      kmsKeyId?: string
      releaseName: string
      roleArn?: string
      serviceAccount: string
    }>
    kms?: {
      awsProfile?: string
      eksCluster?: string
      instances: Array<{
        expectedSignerId: string
        index: number
        kmsKeyId: string
        roleArn: string
        serviceAccount: string
      }>
      namespace?: string
      networkAlias?: string
      region: string
    }
    /** 'external' = partner-operated signers (descriptor-imported); legacy in-cluster configs omit this. */
    mode?: 'external'
    /** Legacy in-cluster provisioning only; absent for external signers. */
    profile?: 'production-kms' | 'staging-kms' | 'staging-local'
    threshold: number
  }
  bootnodeReth?: {
    instances?: Array<{
      enodeUrl?: string
      index: number
      nodekey?: {
        privateKey?: string
        secretMode?: 'external-secret' | 'plain'
      }
    }>
  }
  cubesigner?: {
    roles: CubesignerRole[]
  }
  da?: {
    celestiaIndexerStartBlock: string,
    celestiaMnemonic: string,
    daNamespace: string,
    signerAddress: string,
    // rpcUrl: string,
    tendermintRpcUrl: string,
  }
  defaults?: {
    dogecoinIndexerStartHeight?: string
    ethereumDaEmbeddedIndexerStartBlock?: string
    l1GenesisBlock?: string
    l2BootstrapNextStartingBlockHeight?: string
  }
  dogecoinClusterRpc?: {
    password?: string // for dogecoin that deploy on cluster
    username?: string // for dogecoin that deploy on cluster
  }

  ethereumDa?: {
    batch?: {
      compression?: 'auto' | 'none'
      cutover?: {
        lastBatchHash: string
        lastBatchIndex: number | string
        nextRelayedDepositIndex: number | string
        nextWithdrawIndex: number | string
        relayedDepositQueueHash: string
        stateRoot: string
        withdrawRoot: string
      }
      genesisBatchHash?: string
      genesisNextRelayedDepositIndex?: number | string
      genesisNextWithdrawIndex?: number | string
      genesisRelayedDepositQueueHash?: string
      genesisStateRoot?: string
      genesisWithdrawRoot?: string
      initialBatchSidecarJson?: string
      maxBlocksPerChunk?: number | string
      maxChunksPerBatch?: number | string
      maxL2GasPerChunk?: number | string
      maxUncompressedBatchBytesSize?: number | string
      minCodecVersion?: number | string
    }
    beaconRpcUrl?: string
    blobArchive?: {
      s3?: {
        bucket?: string
        enabled?: boolean | string
        endpointUrl?: string
        forcePathStyle?: boolean | string
        initialBackoffMs?: number | string
        keyPrefix?: string
        maxBackoffMs?: number | string
        maxRetries?: number | string
        pollIntervalMs?: number | string
        publicBaseUrl?: string
        region?: string
        timeoutMs?: number | string
        treatForbiddenAsMissing?: boolean | string
        uploadingTimeoutMs?: number | string
      }
    }
    chain?: 'devnet' | 'mainnet' | 'sepolia'
    chainId?: string
    l2StartBlockNumber?: number | string
    minFinality?: 'finalized' | 'safe'
    publish?: {
      allowLivenessBudgetOverride?: boolean | string
      budgetWindow?: string
      highBacklogThreshold?: number | string
      maxBatchWait?: string
      maxBlobsPerTx?: number | string
      maxLivenessDelay?: string
      maxPendingBlobTxs?: number | string
      targetBlobsPerTx?: number | string
    }
    submitterRpcUrl?: string
  }
  frontend?: {
    bridgeUrl?: string
    l2Explorer?: string
    l2Url?: string
  }
  kubernetes?: {
    blockbookPublicPort?: number
    blockbookServiceName?: string
    p2pPort?: number
    rpcPort?: number
    serviceName?: string
    zmqHashBlockPort?: number
    zmqHashTxPort?: number
    zmqRawBlockPort?: number
    zmqRawTxPort?: number
  }
  localSigners?: {
    signers?: Array<{
      index: number
      port: number
    }>
  }
  network: Network
  /**
   * Deployment-wide proof posture. `mock` generates the dev_dummy topology
   * (deterministic non-cryptographic proofs via prover-worker-mock) across
   * every proof-config-managed artifact; `production` (default) requires the
   * released proof artifacts. Persisted by `setup proof-config --proving-mode`.
   */
  proofSystem?: {
    provingMode?: 'mock' | 'production'
  }
  rpc?: {
    apiKey?: string
    blockbookAPIUrl?: string
    l2Url?: string
    password?: string // for send/sync on dogocoin
    url?: string // for send/sync on dogocoin like: https://testnet.doge.xyz/
    username?: string // for send/sync on dogocoin
  }
  sequencerReth?: {
    instances?: Array<{
      enodeUrl?: string
      index: number
      nodekey?: {
        privateKey?: string
        secretMode?: 'external-secret' | 'plain'
      }
      signer?: {
        address?: string
        eksCluster?: string
        kmsKeyArn?: string
        kmsKeyId?: string
        kmsRegion?: string
        mode?: 'aws_kms' | 'external_secret' | 'plain'
        namespace?: string
        networkAlias?: string
        privateKey?: string
        serviceAccountName?: string
        serviceAccountRoleArn?: string
      }
    }>
  }
  signerUrls?: string[]
  signers?: {
    l1CommitSender?: {
      backend: 'aws_kms' | 'local'
      eksCluster?: string
      expectedAddress?: string
      kmsKeyArn?: string
      kmsKeyId?: string
      kmsRegion?: string
      namespace?: string
      networkAlias?: string
      role: string
      service: 'eth-da-submitter' | 'fee-oracle'
      serviceAccountName?: string
      serviceAccountRoleArn?: string
    }
    l2GasOracleSender?: {
      backend: 'aws_kms' | 'local'
      eksCluster?: string
      expectedAddress?: string
      kmsKeyArn?: string
      kmsKeyId?: string
      kmsRegion?: string
      namespace?: string
      networkAlias?: string
      role: string
      service: 'eth-da-submitter' | 'fee-oracle'
      serviceAccountName?: string
      serviceAccountRoleArn?: string
    }
  }
  test?: {
    mockFinalizeEnabled?: boolean
    mockFinalizeTimeout?: number
  }
  wallet: {
    path: string
  }
}

export interface DogeWallet {
  address: string
  network?: Network
  privateKey: string
  utxos: DogeUTXO[]
}

export interface DogeUTXO {
  satoshis: number
  script: string
  txid: string
  vout: number
}
