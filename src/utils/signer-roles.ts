export type ManagedSignerKey = 'l1CommitSender' | 'l2GasOracleSender'
export type ManagedSignerBackend = 'aws_kms' | 'local'
export type ManagedSignerService = 'attestation-signer' | 'eth-da-submitter' | 'fee-oracle' | 'sequencer-reth'

export interface ManagedSignerRole {
  accountPrefix: 'L1_COMMIT_SENDER' | 'L2_GAS_ORACLE_SENDER' | 'SEQUENCER_RETH_SIGNER'
  aliasSuffix: string
  configKey: ManagedSignerKey
  defaultServiceAccount: string
  description: string
  expectedAddressEnvKey: string
  kmsKeyIdEnvKey: string
  kmsRegionEnvKey: string
  privateKeyEnvName?: string
  purposeTag: string
  role: string
  roleSuffix: string
  service: ManagedSignerService
  signerBackendEnvKey: string
}

export interface ManagedSignerConfig {
  backend: ManagedSignerBackend
  eksCluster?: string
  expectedAddress?: string
  kmsKeyArn?: string
  kmsKeyId?: string
  kmsRegion?: string
  namespace?: string
  networkAlias?: string
  role: string
  service: ManagedSignerService
  serviceAccountName?: string
  serviceAccountRoleArn?: string
}

export const MANAGED_SIGNER_ROLES = {
  l1CommitSender: {
    accountPrefix: 'L1_COMMIT_SENDER',
    aliasSuffix: 'eth-da-submitter',
    configKey: 'l1CommitSender',
    defaultServiceAccount: 'eth-da-submitter',
    description: 'DogeOS eth-da-submitter EIP-4844 blob transaction signer',
    expectedAddressEnvKey: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_EXPECTED_ADDRESS',
    kmsKeyIdEnvKey: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_KEY_ID',
    kmsRegionEnvKey: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__KMS_REGION',
    purposeTag: 'ethereum-da',
    role: 'L1_COMMIT_SENDER',
    roleSuffix: 'eth-da-submitter-kms',
    service: 'eth-da-submitter',
    signerBackendEnvKey: 'DOGEOS_ETH_DA_SUBMITTER_ETHEREUM__SIGNER_BACKEND',
  },
  l2GasOracleSender: {
    accountPrefix: 'L2_GAS_ORACLE_SENDER',
    aliasSuffix: 'fee-oracle',
    configKey: 'l2GasOracleSender',
    defaultServiceAccount: 'fee-oracle',
    description: 'DogeOS fee-oracle L2 gas oracle update signer',
    expectedAddressEnvKey: 'DOGEOS_FEE_ORACLE_WALLET__KMS_EXPECTED_ADDRESS',
    kmsKeyIdEnvKey: 'DOGEOS_FEE_ORACLE_WALLET__KMS_KEY_ID',
    kmsRegionEnvKey: 'DOGEOS_FEE_ORACLE_WALLET__KMS_REGION',
    privateKeyEnvName: 'DOGEOS_FEE_ORACLE_PRIVATE_KEY',
    purposeTag: 'fee-oracle',
    role: 'L2_GAS_ORACLE_SENDER',
    roleSuffix: 'fee-oracle-kms',
    service: 'fee-oracle',
    signerBackendEnvKey: 'DOGEOS_FEE_ORACLE_WALLET__SIGNER_BACKEND',
  },
} as const satisfies Record<ManagedSignerKey, ManagedSignerRole>

export const MANAGED_SIGNER_KEYS = Object.keys(MANAGED_SIGNER_ROLES) as ManagedSignerKey[]

export const LEGACY_ACCOUNT_KEYS = [
  'L1_FINALIZE_SENDER_ADDR',
  'L1_FINALIZE_SENDER_PRIVATE_KEY',
  'L1_GAS_ORACLE_SENDER_ADDR',
  'L1_GAS_ORACLE_SENDER_PRIVATE_KEY',
] as const

export function accountAddressKey(role: ManagedSignerRole): string {
  return `${role.accountPrefix}_ADDR`
}

export function accountPrivateKeyKey(role: ManagedSignerRole): string {
  return `${role.accountPrefix}_PRIVATE_KEY`
}

export function buildLocalSignerConfig(role: ManagedSignerRole): ManagedSignerConfig {
  return {
    backend: 'local',
    role: role.role,
    service: role.service,
  }
}

export function getManagedSignerConfig(config: any, key: ManagedSignerKey): ManagedSignerConfig | undefined {
  return config?.signers?.[key] as ManagedSignerConfig | undefined
}

export function getRequiredManagedSignerConfig(config: any, key: ManagedSignerKey): ManagedSignerConfig {
  const signer = getManagedSignerConfig(config, key)
  if (!signer?.backend) {
    const role = MANAGED_SIGNER_ROLES[key]
    throw new Error(
      `Missing [signers.${key}]. Run setup ${role.service} to create ${role.role} signer configuration.`
    )
  }

  return signer
}

export function isAwsKmsSigner(signer: ManagedSignerConfig | undefined): boolean {
  return signer?.backend === 'aws_kms'
}

export function isLocalSigner(signer: ManagedSignerConfig | undefined): boolean {
  return signer?.backend === 'local'
}
