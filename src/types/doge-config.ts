export type Network = 'mainnet' | 'regtest' | 'testnet'

export interface CubesignerKey {
  key_id: string
  key_type: string
  material_id: string
  public_key: string
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
  awsSigner?: {
    accountId?: string
    ecsClusterName?: string
    imageSource?: 'dockerhub' | 'ecr' | 'ecr-sync'
    imageUri?: string
    networkAlias?: string
    region?: string
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
  /** Dummy attestation signer runtime provider. This is independent from the Kubernetes infrastructure provider. */
  dummySigner?: {
    provider?: 'aws' | 'local'
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
    signer?: {
      backend?: 'aws_kms' | 'local'
      expectedAddress?: string
      kmsKeyArn?: string
      kmsKeyId?: string
      kmsRegion?: string
      namespace?: string
      serviceAccountName?: string
      serviceAccountRoleArn?: string
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
  rpc?: {
    apiKey?: string
    blockbookAPIUrl?: string
    l2Url?: string
    password?: string // for send/sync on dogocoin
    url?: string // for send/sync on dogocoin like: https://testnet.doge.xyz/
    username?: string // for send/sync on dogocoin
  }
  signerUrls?: string[]
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
