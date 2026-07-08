import * as toml from '@iarna/toml'
import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { DogeConfig } from '../../src/types/doge-config.js'

import { JsonOutputContext } from '../../src/utils/json-output.js'
import {
  getDefaultKmsAlias,
  getDefaultKmsRoleName,
  resolveKmsSignerInput,
  setupManagedSigner,
} from '../../src/utils/managed-signer-setup.js'
import { MANAGED_SIGNER_ROLES } from '../../src/utils/signer-roles.js'

describe('managed signer setup', () => {
  let originalCwd: string
  let tempDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-signer-setup-'))
    process.chdir(tempDir)
    fs.mkdirSync('.data', { recursive: true })
    fs.writeFileSync('config.toml', '[accounts]\nOWNER_ADDR = "0x0000000000000000000000000000000000000001"\n')
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { force: true, recursive: true })
  })

  function baseDogeConfig(): DogeConfig {
    return {
      network: 'testnet',
      wallet: { path: '.data/doge-wallet-testnet.json' },
    }
  }

  function signerCommandOptions(flags: Record<string, unknown> = {}) {
    return {
      dogeConfig: baseDogeConfig(),
      dogeConfigPath: path.join(tempDir, '.data', 'doge-config.toml'),
      flags,
      hasFlag: (name: string) => Object.hasOwn(flags, name),
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: false,
      signerKey: 'l1CommitSender' as const,
    }
  }

  it('writes eth-da-submitter local signer settings to doge-config', async () => {
    const dogeConfigPath = path.join(tempDir, '.data', 'doge-config.toml')
    const dogeConfig = baseDogeConfig()

    const result = await setupManagedSigner({
      dogeConfig,
      dogeConfigPath,
      flags: { 'signer-backend': 'local' },
      hasFlag: () => false,
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: true,
      signerKey: 'l1CommitSender',
    })

    const parsed = toml.parse(fs.readFileSync(dogeConfigPath, 'utf8')) as any
    expect(result.signerConfig.backend).to.equal('local')
    expect(parsed.signers.l1CommitSender.backend).to.equal('local')
    expect(parsed.accounts.L1_COMMIT_SENDER_ADDR).to.match(/^0x[\dA-Fa-f]{40}$/)
    expect(parsed.accounts.L1_COMMIT_SENDER_PRIVATE_KEY).to.match(/^0x[\dA-Fa-f]{64}$/)
    expect(parsed.accounts.L1_COMMIT_SENDER_ADDR).to.equal(result.address)
  })

  it('records eth-da-submitter S3 archive settings with a local signer', async () => {
    const dogeConfigPath = path.join(tempDir, '.data', 'doge-config.toml')
    const dogeConfig = baseDogeConfig()

    await setupManagedSigner({
      dogeConfig,
      dogeConfigPath,
      flags: {
        'archive-bucket': 'dogeos-da',
        'archive-key-prefix': 'devnet/eth-da/blobs/v1',
        'archive-region': 'us-east-1',
        'signer-backend': 'local',
      },
      hasFlag: () => false,
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: true,
      signerKey: 'l1CommitSender',
    })

    const parsed = toml.parse(fs.readFileSync(dogeConfigPath, 'utf8')) as any
    expect(parsed.ethereumDa.blobArchive.s3.enabled).to.equal(true)
    expect(parsed.ethereumDa.blobArchive.s3.bucket).to.equal('dogeos-da')
    expect(parsed.ethereumDa.blobArchive.s3.region).to.equal('us-east-1')
    expect(parsed.ethereumDa.blobArchive.s3.keyPrefix).to.equal('devnet/eth-da/blobs/v1')
    expect(parsed.ethereumDa.blobArchive.s3.publicBaseUrl).to.equal('https://dogeos-da.s3.us-east-1.amazonaws.com')
  })

  it('syncs fee-oracle local signer address to config.toml accounts.L2_GAS_ORACLE_SENDER_ADDR', async () => {
    const dogeConfigPath = path.join(tempDir, '.data', 'doge-config.toml')
    const dogeConfig = baseDogeConfig()

    const result = await setupManagedSigner({
      dogeConfig,
      dogeConfigPath,
      flags: { 'signer-backend': 'local' },
      hasFlag: () => false,
      jsonCtx: new JsonOutputContext('test', true),
      jsonMode: true,
      nonInteractive: true,
      signerKey: 'l2GasOracleSender',
    })

    const dogeParsed = toml.parse(fs.readFileSync(dogeConfigPath, 'utf8')) as any
    const configParsed = toml.parse(fs.readFileSync('config.toml', 'utf8')) as any

    expect(result.updatedConfigToml).to.equal(true)
    expect(dogeParsed.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(result.address)
    expect(dogeParsed.accounts.L2_GAS_ORACLE_SENDER_PRIVATE_KEY).to.match(/^0x[\dA-Fa-f]{64}$/)
    expect(configParsed.accounts.L2_GAS_ORACLE_SENDER_ADDR).to.equal(result.address)
  })

  it('does not reuse existing eth-da-submitter KMS resources when identity changes', () => {
    const role = MANAGED_SIGNER_ROLES.l1CommitSender
    const identity = {
      awsRegion: 'us-west-2',
      eksCluster: 'dogeos-testnet-cluster',
      namespace: 'default',
      networkAlias: 'prod',
    }
    const input = resolveKmsSignerInput(
      signerCommandOptions(),
      role,
      identity,
      {
        backend: 'aws_kms',
        expectedAddress: '0x0000000000000000000000000000000000000001',
        kmsKeyId: 'alias/dogeos/shutest/dogeos-devnet-cluster/eth-da-submitter',
        kmsRegion: 'us-west-2',
        role: 'L1_COMMIT_SENDER',
        service: 'eth-da-submitter',
        serviceAccountName: 'eth-da-submitter',
        serviceAccountRoleArn: 'arn:aws:iam::074120976575:role/dogeos-shutest-dogeos-devnet-cluster-eth-da-submitter-kms',
      }
    )

    expect(input.kmsKeyId).to.equal(undefined)
    expect(input.roleArn).to.equal(undefined)
    expect(getDefaultKmsAlias(role, identity)).to.equal('alias/dogeos/prod/dogeos-testnet-cluster/eth-da-submitter')
    expect(getDefaultKmsRoleName(role, identity)).to.equal('dogeos-prod-dogeos-testnet-cluster-eth-da-submitter-kms')
  })

  it('reuses existing eth-da-submitter KMS resources when identity matches', () => {
    const role = MANAGED_SIGNER_ROLES.l1CommitSender
    const identity = {
      awsRegion: 'us-west-2',
      eksCluster: 'dogeos-testnet-cluster',
      namespace: 'default',
      networkAlias: 'prod',
    }
    const kmsKeyId = 'alias/dogeos/prod/dogeos-testnet-cluster/eth-da-submitter'
    const roleArn = 'arn:aws:iam::074120976575:role/dogeos-prod-dogeos-testnet-cluster-eth-da-submitter-kms'
    const input = resolveKmsSignerInput(
      signerCommandOptions(),
      role,
      identity,
      {
        backend: 'aws_kms',
        expectedAddress: '0x0000000000000000000000000000000000000001',
        kmsKeyId,
        kmsRegion: 'us-west-2',
        role: 'L1_COMMIT_SENDER',
        service: 'eth-da-submitter',
        serviceAccountName: 'eth-da-submitter',
        serviceAccountRoleArn: roleArn,
      }
    )

    expect(input.kmsKeyId).to.equal(kmsKeyId)
    expect(input.roleArn).to.equal(roleArn)
  })

  it('uses explicit eth-da-submitter KMS flags even when existing resources belong to another identity', () => {
    const role = MANAGED_SIGNER_ROLES.l1CommitSender
    const identity = {
      awsRegion: 'us-west-2',
      eksCluster: 'dogeos-testnet-cluster',
      namespace: 'default',
      networkAlias: 'prod',
    }
    const explicitKmsKeyId = 'alias/custom/eth-da-submitter'
    const explicitRoleArn = 'arn:aws:iam::074120976575:role/custom-eth-da-submitter-kms'
    const input = resolveKmsSignerInput(
      signerCommandOptions({
        'kms-key-id': explicitKmsKeyId,
        'role-arn': explicitRoleArn,
      }),
      role,
      identity,
      {
        backend: 'aws_kms',
        expectedAddress: '0x0000000000000000000000000000000000000001',
        kmsKeyId: 'alias/dogeos/shutest/dogeos-devnet-cluster/eth-da-submitter',
        kmsRegion: 'us-west-2',
        role: 'L1_COMMIT_SENDER',
        service: 'eth-da-submitter',
        serviceAccountName: 'eth-da-submitter',
        serviceAccountRoleArn: 'arn:aws:iam::074120976575:role/dogeos-shutest-dogeos-devnet-cluster-eth-da-submitter-kms',
      }
    )

    expect(input.kmsKeyId).to.equal(explicitKmsKeyId)
    expect(input.roleArn).to.equal(explicitRoleArn)
  })

  it('does not reuse existing fee-oracle KMS resources when identity changes', () => {
    const role = MANAGED_SIGNER_ROLES.l2GasOracleSender
    const identity = {
      awsRegion: 'us-west-2',
      eksCluster: 'dogeos-testnet-cluster',
      namespace: 'default',
      networkAlias: 'prod',
    }
    const input = resolveKmsSignerInput(
      {
        ...signerCommandOptions(),
        signerKey: 'l2GasOracleSender',
      },
      role,
      identity,
      {
        backend: 'aws_kms',
        expectedAddress: '0x0000000000000000000000000000000000000001',
        kmsKeyId: 'alias/dogeos/shutest/dogeos-devnet-cluster/fee-oracle',
        kmsRegion: 'us-west-2',
        role: 'L2_GAS_ORACLE_SENDER',
        service: 'fee-oracle',
        serviceAccountName: 'fee-oracle',
        serviceAccountRoleArn: 'arn:aws:iam::074120976575:role/dogeos-shutest-dogeos-devnet-cluster-fee-oracle-kms',
      }
    )

    expect(input.kmsKeyId).to.equal(undefined)
    expect(input.roleArn).to.equal(undefined)
    expect(getDefaultKmsAlias(role, identity)).to.equal('alias/dogeos/prod/dogeos-testnet-cluster/fee-oracle')
    expect(getDefaultKmsRoleName(role, identity)).to.equal('dogeos-prod-dogeos-testnet-cluster-fee-oracle-kms')
  })
})
